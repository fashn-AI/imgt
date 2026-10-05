import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTAINER_RESOURCES,
  isConfiguredShard,
  NativeContainerTransport,
} from "../src/native-container";
import { deferred } from "./helpers";

function harness(
  health: (request: Request) => Promise<Response>,
  readinessTimeoutMs = 1000,
  idleTimeoutMs = 120000,
) {
  let running = false;
  let starts = 0;
  let posts = 0;
  const timeouts: number[] = [];
  const monitors: ReturnType<typeof deferred<void>>[] = [];
  let labels: Record<string, string> = {};
  const api = {
    get running() {
      return running;
    },
    images: { sharp: "registry.cloudflare.com/test/sharp@sha256:fixed" },
    start(options?: ContainerStartupOptions) {
      assert.deepEqual(options?.instance, CONTAINER_RESOURCES);
      assert.equal(options?.enableInternet, false);
      assert.equal(options?.image, api.images.sharp);
      starts += 1;
      labels = options?.labels ?? {};
      running = true;
    },
    monitor() {
      const monitor = deferred<void>();
      monitors.push(monitor);
      return monitor.promise;
    },
    async inspect() {
      return running ? { image: api.images.sharp, labels } : null;
    },
    async setInactivityTimeout(ms: number | bigint) {
      timeouts.push(Number(ms));
    },
    getTcpPort(port: number) {
      assert.equal(port, 8080);
      return {
        async fetch(request: Request) {
          if (request.method === "POST") {
            posts += 1;
            return new Response(await request.text());
          }
          return health(request);
        },
      } as Fetcher;
    },
  };
  const stopped: unknown[] = [];
  const transport = new NativeContainerTransport(api, {
    idleTimeoutMs,
    env: {},
    waitUntil: () => {},
    stopped: (error) => stopped.push(error),
    readinessTimeoutMs,
  });
  return {
    transport,
    api,
    timeouts,
    stopped,
    monitors,
    get starts() {
      return starts;
    },
    get posts() {
      return posts;
    },
    setRunning(value: boolean) {
      running = value;
    },
    stop() {
      running = false;
      monitors.at(-1)!.resolve();
    },
  };
}

test("concurrent misses share readiness; aborting one waiter does not cancel another", async () => {
  const gate = deferred<Response>();
  const h = harness(async () => gate.promise);
  const aborted = new AbortController();
  const first = h.transport.prepare(aborted.signal);
  const failed = assert.rejects(first, { name: "AbortError" });
  const second = h.transport.prepare(new AbortController().signal);
  aborted.abort();
  gate.resolve(new Response("healthy"));
  await Promise.all([failed, second]);
  assert.equal(h.starts, 1);
  assert.deepEqual(h.timeouts, [120000]);
});

test("readiness times out even when a port fetch ignores its abort signal", async () => {
  const h = harness(() => new Promise(() => {}), 30);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(h.transport.prepare(new AbortController().signal), {
      status: 503,
    });
    assert.equal(h.starts, 1);
    assert.equal(h.posts, 0);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("port readiness retries; a warm request does not restart or poll health", async () => {
  let polls = 0;
  const h = harness(async () => {
    if (++polls === 1) throw Error("connection refused");
    return new Response("healthy");
  });
  await h.transport.prepare(new AbortController().signal);
  const response = await h.transport.fetch(
    new Request("http://container/transform", {
      method: "POST",
      body: "image",
    }),
  );
  assert.equal(await response.text(), "image");
  assert.equal(polls, 2);
  assert.equal(h.starts, 1);
  assert.equal(h.posts, 1);
  assert.match(
    response.headers.get("server-timing")!,
    /container_boot;desc="[a-f0-9-]+"/,
  );
});

test("container exit clears readiness and the next request restores its idle timeout", async () => {
  let polls = 0;
  const h = harness(async () => {
    polls += 1;
    return new Response("healthy");
  });
  await h.transport.prepare(new AbortController().signal);
  h.stop();
  await Promise.resolve();
  await h.transport.prepare(new AbortController().signal);
  assert.equal(h.starts, 2);
  assert.equal(polls, 2);
  assert.deepEqual(h.timeouts, [120000, 120000]);
  assert.equal(h.stopped.length, 1);
});

test("a reconstructed Durable Object resets timeout without starting new compute", async () => {
  const h = harness(async () => new Response("healthy"));
  h.setRunning(true);
  await h.transport.restore();
  await h.transport.prepare(new AbortController().signal);
  assert.equal(h.starts, 0);
  assert.deepEqual(h.timeouts, [120000]);
});

test("an already canceled job does not start a container", async () => {
  const h = harness(async () => new Response("healthy"));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(h.transport.prepare(aborted.signal), {
    name: "AbortError",
  });
  assert.equal(h.starts, 0);
});

test("idle timeout accepts positive integer milliseconds up to six hours", () => {
  for (const value of [1, 120000, 21600000]) {
    const h = harness(async () => new Response("healthy"), 1000, value);
    assert.equal(h.starts, 0);
  }
  for (const value of [0, -1, 0.5, NaN, Infinity, 21600001]) {
    assert.throws(
      () => harness(async () => new Response("healthy"), 1000, value),
      {
        message:
          "container idleTimeoutMs must be an integer from 1 to 21600000",
      },
    );
  }
});

test("only configured shard identities can start native compute", () => {
  const name = (shard: number) => `id-${shard}`;
  assert.equal(isConfiguredShard("id-0", 2, name), true);
  assert.equal(isConfiguredShard("id-1", 2, name), true);
  assert.equal(isConfiguredShard("id-2", 2, name), false);
  assert.equal(isConfiguredShard("arbitrary", 2, name), false);
  assert.equal(isConfiguredShard("id-7", 8, name), true);
  assert.equal(isConfiguredShard("id-8", 8, name), false);
  assert.equal(isConfiguredShard("id-8", 9, name), false);
  assert.equal(isConfiguredShard("id-0", 0, name), false);
});

test("a delayed old exit does not clear the replacement container readiness", async () => {
  let polls = 0;
  const h = harness(async () => {
    polls += 1;
    return new Response("healthy");
  });
  await h.transport.prepare(new AbortController().signal);
  h.setRunning(false);
  await h.transport.prepare(new AbortController().signal);
  h.monitors[0].resolve();
  await Promise.resolve();
  await h.transport.prepare(new AbortController().signal);
  assert.equal(h.starts, 2);
  assert.equal(h.monitors.length, 2);
  assert.equal(polls, 2);
});

test("a failed reconnect restore leaves mandatory readiness usable", async () => {
  let polls = 0;
  const h = harness(async () => {
    polls += 1;
    return new Response("healthy");
  });
  h.setRunning(true);
  h.api.setInactivityTimeout = async () => {
    throw new Error("container connection temporarily unavailable");
  };
  await h.transport.restore();
  await h.transport.prepare(new AbortController().signal);
  assert.equal(polls, 1);
  assert.equal(h.starts, 0);
});
