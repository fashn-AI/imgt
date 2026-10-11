import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import { createTransformServer, type ServerOptions } from "../container/app";
import { RENDERER_VERSION } from "../container/renderer";
import { encodeImage } from "../container/transform";
import { MAX_ACTIVE_JOBS_PER_SHARD } from "../src/constants";
import { createHarness, deferred, imageRequest } from "./helpers";

async function serve(
  t: TestContext,
  encode?: typeof encodeImage,
  options: Partial<ServerOptions> = {},
) {
  const server = createTransformServer(
    {
      maxInputBytes: 1024 * 1024,
      maxInFlight: 4,
      timeoutMs: 2000,
      effort: 2,
      ...options,
    },
    encode,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const post = (body: BodyInit, deadline = Date.now() + 2000) =>
    fetch(`${url}/transform?w=32&q=77`, {
      method: "POST",
      body,
      headers: { "x-imgt-deadline": String(deadline) },
    });
  const health = () =>
    fetch(`${url}/health`).then((response) => response.json()) as Promise<
      Record<string, number | boolean>
    >;
  return { server, port, url, post, health };
}

async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a 100-image gallery passes through the Worker, HTTP uploads, Sharp and R2", async (t) => {
  const app = await serve(t, undefined, {
    maxInFlight: MAX_ACTIVE_JOBS_PER_SHARD,
    concurrency: 2,
  });
  const input = await sharp({
    create: { width: 64, height: 32, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const h = createHarness({
    sourceFetch: async () =>
      new Response(input, { headers: { "content-type": "image/png" } }),
    transform: (body, job, signal, deadline) =>
      fetch(`${app.url}/transform?w=${job.width}&q=${job.quality}`, {
        method: "POST",
        body,
        signal,
        headers: { "x-imgt-deadline": String(deadline) },
        duplex: "half",
      } as RequestInit),
  });
  const responses = await Promise.all(
    Array.from({ length: 100 }, (_, id) => h.gateway(imageRequest(`?v=${id}`))),
  );
  assert.ok(responses.every((response) => response.status === 200));
  const output = Buffer.from(await responses[0].arrayBuffer());
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 64);
  assert.equal(metadata.height, 32);
  await h.drain();
  assert.equal(h.bucket.objects.size, 100);
  const cached = await h.gateway(imageRequest("?v=0"));
  assert.equal(cached.headers.get("x-imgt-cache"), "R2");
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), output);
  assert.equal(h.transforms, 100);
});

test("a complete image encodes while an earlier upload is stalled", async (t) => {
  const app = await serve(t);
  const input = await sharp({
    create: { width: 16, height: 8, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const slow = http.request(
    {
      hostname: "127.0.0.1",
      port: app.port,
      path: "/transform?w=32&q=77",
      method: "POST",
      headers: {
        "content-length": input.length,
        "x-imgt-deadline": String(Date.now() + 2000),
      },
    },
    (response) => response.resume(),
  );
  slow.on("error", () => {});
  t.after(() => slow.destroy());
  slow.write(input.subarray(0, 1));
  await until(async () => (await app.health()).uploading === 1);
  const fast = await app.post(input);
  assert.equal(fast.status, 200);
  assert.equal(fast.headers.get("x-imgt-renderer"), RENDERER_VERSION);
  assert.match(fast.headers.get("server-timing")!, /queue;dur=/);
  const metadata = await sharp(
    Buffer.from(await fast.arrayBuffer()),
  ).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 16);
  assert.equal((await app.health()).uploading, 1);
  slow.end(input.subarray(1));
  await until(async () => (await app.health()).inFlight === 0);
});

test("upload deadlines release admission without blocking subsequent images", async (t) => {
  const app = await serve(t, async () => Buffer.from("webp"), {
    maxInFlight: 1,
  });
  const received = deferred<number>();
  const slow = http.request(
    {
      hostname: "127.0.0.1",
      port: app.port,
      path: "/transform?w=32&q=77",
      method: "POST",
      headers: {
        "content-length": 10,
        "x-imgt-deadline": String(Date.now() + 80),
      },
    },
    (response) => {
      response.resume();
      received.resolve(response.statusCode!);
    },
  );
  slow.on("error", () => {});
  t.after(() => slow.destroy());
  slow.write("x");
  assert.equal(await received.promise, 504);
  await until(async () => (await app.health()).inFlight === 0);
  assert.equal((await app.post("complete")).status, 200);
});

test("expired queued jobs never encode, and an active job retains its slot until processing settles", async (t) => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const app = await serve(t, async () => {
    calls += 1;
    started.resolve();
    await release.promise;
    return Buffer.from("webp");
  });
  const first = app.post("first");
  await started.promise;
  const queued = await app.post("second", Date.now() + 80);
  assert.equal(queued.status, 504);
  assert.equal(calls, 1);
  await until(async () => (await app.health()).queued === 0);
  assert.equal((await app.health()).active, true);
  release.resolve();
  assert.equal((await first).status, 200);
});

test("active processing timeout returns 504 but does not admit overlapping native work", async (t) => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const app = await serve(
    t,
    async (_input, _options, _deadline, signal) => {
      calls += 1;
      started.resolve();
      await release.promise;
      signal.throwIfAborted();
      return Buffer.from("webp");
    },
    { maxInFlight: 1 },
  );
  const first = app.post("first", Date.now() + 80);
  await started.promise;
  assert.equal((await first).status, 504);
  assert.equal((await app.post("rejected")).status, 429);
  assert.equal(calls, 1);
  release.resolve();
  await until(async () => (await app.health()).inFlight === 0);
});

test("disconnected queued requests are removed before their turn", async (t) => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const app = await serve(t, async () => {
    calls += 1;
    started.resolve();
    await release.promise;
    return Buffer.from("webp");
  });
  const first = app.post("first");
  await started.promise;
  const controller = new AbortController();
  const second = fetch(`${app.url}/transform?w=32&q=77`, {
    method: "POST",
    body: "queued",
    signal: controller.signal,
    headers: { "x-imgt-deadline": String(Date.now() + 2000) },
  });
  const rejected = assert.rejects(second);
  await until(async () => (await app.health()).queued === 1);
  controller.abort();
  await rejected;
  await until(async () => (await app.health()).queued === 0);
  release.resolve();
  await first;
  assert.equal(calls, 1);
});

test("bounds admission and rejects invalid, expired, and oversized input", async (t) => {
  const started = deferred();
  const release = deferred();
  const app = await serve(
    t,
    async () => {
      started.resolve();
      await release.promise;
      return Buffer.from("webp");
    },
    { maxInFlight: 1, maxInputBytes: 8 },
  );
  assert.equal((await app.post("input", Date.now() - 1)).status, 504);
  assert.equal((await app.post("0123456789")).status, 413);
  const first = app.post("input");
  await started.promise;
  const full = await app.post("input");
  assert.equal(full.status, 429);
  assert.equal(full.headers.get("retry-after"), "1");
  release.resolve();
  assert.equal((await first).status, 200);
});

test("chunked uploads enforce the byte limit without trusting Content-Length", async (t) => {
  const app = await serve(t, async () => Buffer.from("webp"), {
    maxInputBytes: 8,
  });
  const result = deferred<number>();
  const request = http.request(
    {
      hostname: "127.0.0.1",
      port: app.port,
      path: "/transform?w=32&q=77",
      method: "POST",
      headers: { "x-imgt-deadline": String(Date.now() + 2000) },
    },
    (response) => {
      response.resume();
      result.resolve(response.statusCode!);
    },
  );
  request.on("error", result.reject);
  t.after(() => request.destroy());
  request.write("0123456789");
  request.end();
  assert.equal(await result.promise, 413);
});

test("disconnecting during upload releases admission without an unhandled stream error", async (t) => {
  const app = await serve(t, async () => Buffer.from("webp"), {
    maxInFlight: 1,
  });
  const slow = http.request({
    hostname: "127.0.0.1",
    port: app.port,
    path: "/transform?w=32&q=77",
    method: "POST",
    headers: {
      "content-length": 100,
      "x-imgt-deadline": String(Date.now() + 2000),
    },
  });
  slow.on("error", () => {});
  t.after(() => slow.destroy());
  slow.write("x");
  await until(async () => (await app.health()).uploading === 1);
  slow.destroy();
  await until(async () => (await app.health()).inFlight === 0);
  assert.equal((await app.post("new image")).status, 200);
});

test("an active disconnect retains native work through its original deadline", async (t) => {
  const started = deferred();
  const release = deferred();
  const disconnected = deferred();
  let signal: AbortSignal | undefined;
  const app = await serve(
    t,
    async (_input, _options, _deadline, processingSignal) => {
      signal = processingSignal;
      started.resolve();
      signal.addEventListener("abort", () => disconnected.resolve(), {
        once: true,
      });
      await release.promise;
      signal.throwIfAborted();
      return Buffer.from("webp");
    },
  );
  const controller = new AbortController();
  const response = fetch(`${app.url}/transform?w=32&q=77`, {
    method: "POST",
    body: "image",
    signal: controller.signal,
    headers: { "x-imgt-deadline": String(Date.now() + 100) },
  });
  const canceled = assert.rejects(response);
  await started.promise;
  controller.abort();
  await canceled;
  await disconnected.promise;
  await new Promise((resolve) => setTimeout(resolve, 120));
  const health = await app.health();
  assert.equal(health.active, true);
  assert.equal(health.inFlight, 1);
  assert.equal(signal!.reason.message, "client disconnected");
  release.resolve();
  await until(async () => (await app.health()).inFlight === 0);
});

test("two encoders retain timed-out native slots and remove expired queued work", async (t) => {
  const gates = [deferred(), deferred()];
  let calls = 0;
  let active = 0;
  let peak = 0;
  const app = await serve(
    t,
    async () => {
      const index = calls++;
      active += 1;
      peak = Math.max(peak, active);
      if (index < 2) await gates[index].promise;
      active -= 1;
      return Buffer.from("webp");
    },
    { concurrency: 2 },
  );
  t.after(() => gates.forEach((gate) => gate.resolve()));
  const first = app.post("first", Date.now() + 150);
  const second = app.post("second", Date.now() + 150);
  await until(async () => calls === 2);
  const expired = await app.post("expired", Date.now() + 60);
  assert.equal(expired.status, 504);
  assert.equal((await first).status, 504);
  assert.equal((await second).status, 504);
  const next = app.post("next");
  await until(async () => (await app.health()).queued === 1);
  assert.equal(calls, 2);
  gates[0].resolve();
  assert.equal((await next).status, 200);
  assert.equal(calls, 3);
  assert.equal(peak, 2);
  gates[1].resolve();
  await until(async () => !(await app.health()).active);
});

test("container encoder concurrency rejects invalid settings", () => {
  for (const concurrency of [0, -1, 1.5, NaN]) {
    assert.throws(
      () =>
        createTransformServer({
          maxInputBytes: 1024,
          maxInFlight: 8,
          timeoutMs: 1000,
          effort: 4,
          concurrency,
        }),
      /invalid transform concurrency/,
    );
  }
});
