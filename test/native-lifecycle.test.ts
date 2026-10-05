import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { RENDERER_VERSION } from "../container/renderer";
import { config } from "../imgt.config";
import { DERIVATIVE_PREFIX } from "../src/constants";
import { containerNameForKey, jobRequest } from "../src/jobs";
import { derivativeKey, parseImageOptions } from "../src/options";
import { DerivativeStore } from "../src/store";
import { deferred, imageRequest, MemoryBucket } from "./helpers";

// The application uses only these Durable Object base classes from the runtime.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`
          export class DurableObject {
            constructor(ctx, env) { this.ctx = ctx; this.env = env; }
          }
          export class WorkerEntrypoint {}
        `)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { ImgtNativeImageTransformer } = await import("../src/index").finally(
  () => hooks.deregister(),
);

test("a cold stale refresh defers idle alarms while active and schedules shutdown after completion", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let running = false;
  let starts = 0;
  let stops = 0;
  const alarms: number[] = [];
  const background: Promise<unknown>[] = [];
  const refreshRead = deferred();
  const encodingStarted = deferred();
  const finishEncoding = deferred();
  const exit = deferred();

  // Cloudflare accepts streamed uploads without Node's duplex option.
  const OriginalRequest = Request;
  globalThis.Request = class extends OriginalRequest {
    constructor(input: URL | RequestInfo, init?: RequestInit) {
      super(input, { ...init, duplex: "half" } as RequestInit);
    }
  } as typeof Request;
  t.after(async () => {
    refreshRead.resolve();
    finishEncoding.resolve();
    exit.resolve();
    await Promise.allSettled(background);
    globalThis.Request = OriginalRequest;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("source", { headers: { "content-type": "image/jpeg" } }),
  );

  const bucket = new MemoryBucket();
  const originalGet = bucket.get.bind(bucket);
  let reads = 0;
  t.mock.method(bucket, "get", async (key: string) => {
    // The foreground lookup returns stale bytes before refresh starts compute.
    if (++reads === 2) await refreshRead.promise;
    return originalGet(key);
  });
  const container = {
    get running() {
      return running;
    },
    images: { sharp: "registry.cloudflare.com/test/sharp@sha256:fixed" },
    start() {
      starts += 1;
      running = true;
    },
    monitor: () => exit.promise,
    async inspect() {
      return null;
    },
    async setInactivityTimeout() {},
    async destroy() {
      stops += 1;
      running = false;
      exit.resolve();
    },
    getTcpPort() {
      return {
        async fetch(request: Request) {
          if (request.method === "GET") return new Response("healthy");
          await request.arrayBuffer();
          encodingStarted.resolve();
          await finishEncoding.promise;
          return new Response("new-webp", {
            headers: { "x-imgt-renderer": RENDERER_VERSION },
          });
        },
      } as Fetcher;
    },
  };
  const options = parseImageOptions(new URL(imageRequest().url), [
    "images.unsplash.com",
  ]);
  const job = {
    ...options,
    outputKey: await derivativeKey(DERIVATIVE_PREFIX, options),
  };
  const name = containerNameForKey(job.outputKey, config.containers.shards);
  const transformer = new ImgtNativeImageTransformer(
    {
      id: { toString: () => name },
      container,
      storage: {
        async setAlarm(timestamp: number) {
          alarms.push(timestamp);
        },
      },
      blockConcurrencyWhile: (work: () => Promise<void>) => work(),
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    } as unknown as DurableObjectState,
    {
      ALLOWED_HOSTS: "images.unsplash.com",
      DERIVATIVES: bucket,
      IMGT_NATIVE_TRANSFORMER: {
        idFromName: (value: string) => ({ toString: () => value }),
      },
    } as unknown as ConstructorParameters<typeof ImgtNativeImageTransformer>[1],
  );
  await new DerivativeStore(bucket).put(
    job.outputKey,
    await new Response("old-webp").arrayBuffer(),
    `"${"a".repeat(64)}"`,
    Date.now() - 1000,
  );

  const stale = await transformer.fetch(jobRequest(job));
  assert.equal(stale.headers.get("x-imgt-cache"), "STALE");
  assert.equal(await stale.text(), "old-webp");
  assert.equal(running, false);
  assert.deepEqual(alarms, []);
  const refresh = background.at(-1)!;

  refreshRead.resolve();
  await encodingStarted.promise;
  assert.equal(starts, 1);
  t.mock.timers.tick(120000);
  await transformer.alarm();
  assert.equal(stops, 0, "background encoding must keep its container alive");

  t.mock.timers.tick(1000);
  finishEncoding.resolve();
  await refresh;
  assert.equal(alarms.at(-1), Date.now() + 120000);
  t.mock.timers.tick(119999);
  await transformer.alarm();
  assert.equal(stops, 0);
  t.mock.timers.tick(1);
  await transformer.alarm();
  assert.equal(stops, 1);

  const fresh = await transformer.fetch(jobRequest(job));
  assert.equal(fresh.headers.get("x-imgt-cache"), "R2");
  assert.equal(await fresh.text(), "new-webp");
  assert.equal(starts, 1, "fresh R2 data must not restart compute");
});

test("a stalled connection restore does not block fresh R2 delivery", async (t) => {
  const restore = deferred();
  const background: Promise<unknown>[] = [];
  let initialization = Promise.resolve();
  let starts = 0;
  const bucket = new MemoryBucket();
  const options = parseImageOptions(new URL(imageRequest().url), [
    "images.unsplash.com",
  ]);
  const job = {
    ...options,
    outputKey: await derivativeKey(DERIVATIVE_PREFIX, options),
  };
  const name = containerNameForKey(job.outputKey, config.containers.shards);
  await new DerivativeStore(bucket).put(
    job.outputKey,
    await new Response("cached-webp").arrayBuffer(),
    `"${"a".repeat(64)}"`,
    Date.now() + 60000,
  );
  const transformer = new ImgtNativeImageTransformer(
    {
      id: { toString: () => name },
      container: {
        running: true,
        async setInactivityTimeout() {
          await restore.promise;
          throw new Error("connection unavailable");
        },
        start() {
          starts += 1;
        },
      },
      storage: { async setAlarm() {} },
      // Model the runtime gate: initialization work blocks subsequent events.
      blockConcurrencyWhile: (work: () => Promise<void>) =>
        (initialization = work()),
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    } as unknown as DurableObjectState,
    {
      ALLOWED_HOSTS: "images.unsplash.com",
      DERIVATIVES: bucket,
      IMGT_NATIVE_TRANSFORMER: {
        idFromName: (value: string) => ({ toString: () => value }),
      },
    } as unknown as ConstructorParameters<typeof ImgtNativeImageTransformer>[1],
  );
  t.after(async () => {
    restore.resolve();
    await Promise.allSettled(background);
  });
  const response = await Promise.race([
    initialization.then(() => transformer.fetch(jobRequest(job))),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("cache read blocked by restore")),
        1000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-imgt-cache"), "R2");
  assert.equal(await response.text(), "cached-webp");
  assert.equal(starts, 0);
});
