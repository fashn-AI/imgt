import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import { config } from "../imgt.config";
import { createTransformServer } from "../container/app";
import { RENDERER_VERSION } from "../container/renderer";
import { createHarness, imageRequest } from "./helpers";

async function serve(t: TestContext, failFirstSource = false) {
  let sourceCalls = 0;
  const pixels = Buffer.from(
    Array.from({ length: 64 * 40 * 3 }, (_, i) => (i * 73 + (i >> 5)) % 256),
  );
  const input = await sharp(pixels, {
    raw: { width: 64, height: 40, channels: 3 },
  })
    .png()
    .toBuffer();
  let endpoint = process.env.IMGT_CONTAINER_URL;
  if (!endpoint) {
    const server = createTransformServer({
      maxInputBytes: 1024 * 1024,
      maxInFlight: 4,
      timeoutMs: 2000,
      effort: config.transforms.webpEffort,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const h = createHarness({
    rendererVersion: RENDERER_VERSION,
    sourceFetch: async () =>
      failFirstSource && ++sourceCalls === 1
        ? new Response("temporary origin failure", { status: 500 })
        : new Response(input, {
            headers: {
              "content-type": "image/png",
              "cache-control": "max-age=14400",
            },
          }),
    transform: async (body, job, signal, deadline) =>
      fetch(`${endpoint}/transform?w=${job.width}&q=${job.quality}`, {
        method: "POST",
        body: await new Response(body).arrayBuffer(),
        signal,
        headers: { "x-imgt-deadline": String(deadline) },
      }),
  });
  const request = (
    width: number | string = 32,
    quality?: number,
    headers?: HeadersInit,
  ) => {
    const url = new URL(imageRequest().url);
    url.searchParams.set("w", String(width));
    if (quality !== undefined) url.searchParams.set("q", String(quality));
    return new Request(url, { headers });
  };
  return { h, input, request };
}

test("integer qualities reach the encoder unchanged and retain separate, reusable derivatives", async (t) => {
  const { h, input, request } = await serve(t);
  let defaultBytes: Buffer | undefined;
  let defaultEtag: string | null = null;
  for (const quality of [1, 76, 77, 100]) {
    const first = await h.gateway(request(32, quality));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-imgt-cache"), "MISS");
    assert.equal(first.headers.get("content-type"), "image/webp");
    const bytes = Buffer.from(await first.arrayBuffer());
    const expected = await sharp(input)
      .rotate()
      .resize({ width: 32, withoutEnlargement: true, fit: "inside" })
      .webp({ quality, effort: config.transforms.webpEffort })
      .toBuffer();
    assert.deepEqual(bytes, expected, `quality ${quality} must not be snapped`);
    assert.equal((await sharp(bytes).metadata()).format, "webp");
    const { info } = await sharp(bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 32);
    assert.equal(info.height, 20);
    await h.drain();
    assert.equal(h.bucket.objects.size, h.transforms);
    const transforms: number = h.transforms;
    const cached = await h.gateway(request(32, quality));
    assert.equal(cached.headers.get("x-imgt-cache"), "R2");
    assert.deepEqual(Buffer.from(await cached.arrayBuffer()), bytes);
    assert.equal(cached.headers.get("etag"), first.headers.get("etag"));
    assert.equal(h.transforms, transforms);
    if (quality === 77) {
      defaultBytes = bytes;
      defaultEtag = first.headers.get("etag");
    }
  }
  assert.equal(h.bucket.objects.size, 4);
  const omitted = await h.gateway(request());
  assert.equal(omitted.headers.get("x-imgt-cache"), "R2");
  assert.deepEqual(Buffer.from(await omitted.arrayBuffer()), defaultBytes);
  assert.equal(omitted.headers.get("etag"), defaultEtag);
  assert.ok(defaultEtag);
  const conditional = await h.gateway(
    request(32, undefined, { "if-none-match": defaultEtag }),
  );
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get("etag"), defaultEtag);
  assert.equal((await conditional.arrayBuffer()).byteLength, 0);
  assert.equal(h.downloads, 4);
  assert.equal(h.transforms, 4);
  assert.equal(h.bucket.puts, 4);
});

test("integer widths resize exactly, never upscale, and keep distinct cached derivatives", async (t) => {
  const { h, input, request } = await serve(t);
  for (const width of [0, -1, 3841, 37.5, "bad", ""]) {
    assert.equal((await h.gateway(request(width))).status, 400);
  }
  assert.equal(h.downloads, 0);
  assert.equal(h.bucket.reads, 0);
  assert.equal(h.transforms, 0);
  for (const [width, outputWidth, outputHeight] of [
    [1, 1, 1],
    [37, 37, 23],
    [641, 64, 40],
    [3840, 64, 40],
  ]) {
    const first = await h.gateway(request(width, 77));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-imgt-cache"), "MISS");
    const bytes = Buffer.from(await first.arrayBuffer());
    const expected = await sharp(input)
      .rotate()
      .resize({ width, withoutEnlargement: true, fit: "inside" })
      .webp({ quality: 77, effort: config.transforms.webpEffort })
      .toBuffer();
    assert.deepEqual(bytes, expected, `width ${width} must not be snapped`);
    assert.equal((await sharp(bytes).metadata()).format, "webp");
    const { info } = await sharp(bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.width, outputWidth);
    assert.equal(info.height, outputHeight);
    await h.drain();
    assert.equal(h.bucket.objects.size, h.transforms);
    const transforms: number = h.transforms;
    const cached = await h.gateway(request(width, 77));
    assert.equal(cached.headers.get("x-imgt-cache"), "R2");
    assert.deepEqual(Buffer.from(await cached.arrayBuffer()), bytes);
    assert.equal(cached.headers.get("etag"), first.headers.get("etag"));
    assert.equal(h.transforms, transforms);
  }
  assert.equal(h.bucket.objects.size, 4);
  assert.equal(h.downloads, 4);
  assert.equal(h.transforms, 4);
  assert.equal(h.bucket.puts, 4);
});

// Independent standard Sharp options reproduce the Vercel WebP path.
// Omitting effort here detects a regression to the former effort-2 tradeoff.
test("current encoding matches standard Sharp WebP output at client quality 75", async (t) => {
  const { h, input, request } = await serve(t);
  const response = await h.gateway(request(32, 75));
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const resized = sharp(input)
    .rotate()
    .resize({ width: 32, withoutEnlargement: true });
  const standard = await resized.clone().webp({ quality: 75 }).toBuffer();
  const previous = await resized
    .clone()
    .webp({ quality: 75, effort: 2 })
    .toBuffer();
  assert.notDeepEqual(
    standard,
    previous,
    "fixture must distinguish encoding effort",
  );
  assert.deepEqual(bytes, standard);
  await h.drain();
});

test("concurrent images recover one origin failure with one HTTP transform and reusable output", async (t) => {
  const { h, request } = await serve(t, true);
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => h.gateway(request())),
  );
  const bodies = [];
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-imgt-cache"), "MISS");
    const body = Buffer.from(await response.arrayBuffer());
    const { info } = await sharp(body)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 32);
    assert.equal(info.height, 20);
    bodies.push(body);
  }
  for (const body of bodies) assert.deepEqual(body, bodies[0]);
  assert.equal(h.downloads, 2);
  assert.equal(h.transforms, 1);
  await h.drain();
  const cached = await h.gateway(request());
  assert.equal(cached.headers.get("x-imgt-cache"), "R2");
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), bodies[0]);
  assert.equal(h.downloads, 2);
  assert.equal(h.transforms, 1);
});
