import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import { createTransformServer, type ServerOptions } from "../container/app";
import { encodeImage } from "../container/transform";
import { deferred } from "./helpers";

async function serve(t: TestContext, encode?: typeof encodeImage, options: Partial<ServerOptions> = {}) {
  const server = createTransformServer({ maxInputBytes: 1024 * 1024, maxInFlight: 4, timeoutMs: 2000, effort: 2, ...options }, encode);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const post = (body: BodyInit, deadline = Date.now() + 2000) => fetch(`${url}/transform?w=32&q=77`, {
    method: "POST", body, headers: { "x-imgt-deadline": String(deadline) },
  });
  const health = () => fetch(`${url}/health`).then((response) => response.json()) as Promise<Record<string, number | boolean>>;
  return { server, port, url, post, health };
}

async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a complete image encodes while an earlier upload is stalled", async (t) => {
  const app = await serve(t);
  const input = await sharp({ create: { width: 16, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  const slow = http.request({ hostname: "127.0.0.1", port: app.port, path: "/transform?w=32&q=77", method: "POST",
    headers: { "content-length": input.length, "x-imgt-deadline": String(Date.now() + 2000) } }, (response) => response.resume());
  slow.on("error", () => {}); t.after(() => slow.destroy());
  slow.write(input.subarray(0, 1));
  await until(async () => (await app.health()).uploading === 1);
  const fast = await app.post(input);
  assert.equal(fast.status, 200);
  assert.equal(fast.headers.get("x-imgt-renderer"), "v3");
  assert.match(fast.headers.get("server-timing")!, /queue;dur=/);
  const metadata = await sharp(Buffer.from(await fast.arrayBuffer())).metadata();
  assert.equal(metadata.format, "webp"); assert.equal(metadata.width, 16);
  assert.equal((await app.health()).uploading, 1);
  slow.end(input.subarray(1));
  await until(async () => (await app.health()).inFlight === 0);
});

test("upload deadlines release admission without blocking subsequent images", async (t) => {
  const app = await serve(t, async () => Buffer.from("webp"), { maxInFlight: 1 });
  const received = deferred<number>();
  const slow = http.request({ hostname: "127.0.0.1", port: app.port, path: "/transform?w=32&q=77", method: "POST",
    headers: { "content-length": 10, "x-imgt-deadline": String(Date.now() + 80) } }, (response) => {
      response.resume(); received.resolve(response.statusCode!);
    });
  slow.on("error", () => {}); t.after(() => slow.destroy()); slow.write("x");
  assert.equal(await received.promise, 504);
  await until(async () => (await app.health()).inFlight === 0);
  assert.equal((await app.post("complete")).status, 200);
});

test("expired queued jobs never encode, and an active job retains its slot until processing settles", async (t) => {
  const started = deferred(); const release = deferred();
  let calls = 0;
  const app = await serve(t, async () => { calls += 1; started.resolve(); await release.promise; return Buffer.from("webp"); });
  const first = app.post("first"); await started.promise;
  const queued = await app.post("second", Date.now() + 80);
  assert.equal(queued.status, 504); assert.equal(calls, 1);
  await until(async () => (await app.health()).queued === 0);
  assert.equal((await app.health()).active, true);
  release.resolve(); assert.equal((await first).status, 200);
});

test("active processing timeout returns 504 but does not admit overlapping native work", async (t) => {
  const started = deferred(); const release = deferred(); let calls = 0;
  const app = await serve(t, async (_input, _options, _deadline, signal) => {
    calls += 1; started.resolve(); await release.promise; signal.throwIfAborted(); return Buffer.from("webp");
  }, { maxInFlight: 1 });
  const first = app.post("first", Date.now() + 80); await started.promise;
  assert.equal((await first).status, 504);
  assert.equal((await app.post("rejected")).status, 429);
  assert.equal(calls, 1);
  release.resolve();
  await until(async () => (await app.health()).inFlight === 0);
});

test("disconnected queued requests are removed before their turn", async (t) => {
  const started = deferred(); const release = deferred(); let calls = 0;
  const app = await serve(t, async () => { calls += 1; started.resolve(); await release.promise; return Buffer.from("webp"); });
  const first = app.post("first"); await started.promise;
  const controller = new AbortController();
  const second = fetch(`${app.url}/transform?w=32&q=77`, { method: "POST", body: "queued", signal: controller.signal,
    headers: { "x-imgt-deadline": String(Date.now() + 2000) } });
  const rejected = assert.rejects(second);
  await until(async () => (await app.health()).queued === 1);
  controller.abort(); await rejected;
  await until(async () => (await app.health()).queued === 0);
  release.resolve(); await first;
  assert.equal(calls, 1);
});

test("bounds admission and rejects invalid, expired, and oversized input", async (t) => {
  const started = deferred(); const release = deferred();
  const app = await serve(t, async () => { started.resolve(); await release.promise; return Buffer.from("webp"); }, { maxInFlight: 1, maxInputBytes: 8 });
  assert.equal((await app.post("input", Date.now() - 1)).status, 504);
  assert.equal((await app.post("0123456789")).status, 413);
  const first = app.post("input"); await started.promise;
  const full = await app.post("input"); assert.equal(full.status, 429); assert.equal(full.headers.get("retry-after"), "1");
  release.resolve(); assert.equal((await first).status, 200);
});

test("chunked uploads enforce the byte limit without trusting Content-Length", async (t) => {
  const app = await serve(t, async () => Buffer.from("webp"), { maxInputBytes: 8 });
  const result = deferred<number>();
  const request = http.request({ hostname: "127.0.0.1", port: app.port, path: "/transform?w=32&q=77", method: "POST",
    headers: { "x-imgt-deadline": String(Date.now() + 2000) } }, (response) => { response.resume(); result.resolve(response.statusCode!); });
  request.on("error", result.reject); t.after(() => request.destroy());
  request.write("0123456789"); request.end();
  assert.equal(await result.promise, 413);
});

test("disconnecting during upload releases admission without an unhandled stream error", async (t) => {
  const app = await serve(t, async () => Buffer.from("webp"), { maxInFlight: 1 });
  const slow = http.request({ hostname: "127.0.0.1", port: app.port, path: "/transform?w=32&q=77", method: "POST",
    headers: { "content-length": 100, "x-imgt-deadline": String(Date.now() + 2000) } });
  slow.on("error", () => {}); t.after(() => slow.destroy()); slow.write("x");
  await until(async () => (await app.health()).uploading === 1);
  slow.destroy();
  await until(async () => (await app.health()).inFlight === 0);
  assert.equal((await app.post("new image")).status, 200);
});

test("an active disconnect is not later counted as a timeout", async (t) => {
  const started = deferred(); const release = deferred();
  const app = await serve(t, async () => {
    started.resolve(); await release.promise; return Buffer.from("webp");
  });
  const controller = new AbortController();
  const response = fetch(`${app.url}/transform?w=32&q=77`, {
    method: "POST", body: "image", signal: controller.signal,
    headers: { "x-imgt-deadline": String(Date.now() + 100) },
  });
  const canceled = assert.rejects(response);
  await started.promise;
  controller.abort(); await canceled;
  await until(async () => (await app.health()).disconnected === 1);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const health = await app.health();
  assert.equal(health.timedOut, 0);
  assert.equal(health.active, true);
  release.resolve();
  await until(async () => (await app.health()).inFlight === 0);
});
