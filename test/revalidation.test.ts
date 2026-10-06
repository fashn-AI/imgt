import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import { createTransformServer } from "../container/app";
import { RENDERER_VERSION } from "../container/renderer";
import { config } from "../imgt.config";
import { createHarness, imageRequest } from "./helpers";

async function listen(t: TestContext, server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("HTTP origin, Sharp, R2 and client validators survive unchanged and changed refreshes", async (t) => {
  const inputs = await Promise.all(
    ["red", "blue"].map((background) =>
      sharp({
        create: { width: 64, height: 40, channels: 3, background },
      })
        .png()
        .toBuffer(),
    ),
  );
  let revision = 0;
  let removed = false;
  const conditions: (string | undefined)[] = [];
  const origin = await listen(
    t,
    createServer((request, response) => {
      const condition = request.headers["if-none-match"] as string | undefined;
      conditions.push(condition);
      const etag = `"source-${revision}"`;
      if (removed) {
        response.writeHead(404).end();
      } else if (condition === etag) {
        response
          .writeHead(304, { etag, "cache-control": "max-age=86400", age: "60" })
          .end();
      } else {
        response
          .writeHead(200, {
            etag,
            "content-type": "image/png",
            "cache-control": "max-age=14400",
          })
          .end(inputs[revision]);
      }
    }),
  );
  const container = await listen(
    t,
    createTransformServer({
      maxInputBytes: 1024 * 1024,
      maxInFlight: 8,
      timeoutMs: 2000,
      effort: config.transforms.webpEffort,
    }),
  );
  let computeAllowed = true;
  let starts = 0;
  const h = createHarness({
    rendererVersion: RENDERER_VERSION,
    prepare: async () => {
      assert.ok(computeAllowed, "unchanged originals must not start compute");
      starts++;
    },
    // Real HTTP transport; the harness maps the validated source host to the
    // local test origin without changing the production allowlist rules.
    sourceFetch: (url, init) =>
      fetch(`${origin}${new URL(url).pathname}`, init),
    transform: (body, job, signal, deadline) =>
      fetch(`${container}/transform?w=${job.width}&q=${job.quality}`, {
        method: "POST",
        body,
        signal,
        duplex: "half",
        headers: { "x-imgt-deadline": String(deadline) },
      } as RequestInit),
  });
  const expire = () => {
    for (const object of h.bucket.objects.values()) {
      object.customMetadata.freshUntil = String(Date.now() - 1000);
      object.customMetadata.staleUntil = String(Date.now() - 500);
    }
  };
  const first = await h.gateway(imageRequest());
  const original = Buffer.from(await first.arrayBuffer());
  assert.equal(first.status, 200);
  assert.equal((await sharp(original).metadata()).format, "webp");
  await h.drain();
  computeAllowed = false;
  expire();
  const refreshes = await Promise.all(
    Array.from({ length: 20 }, () => h.gateway(imageRequest())),
  );
  for (const response of refreshes) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-imgt-cache"), "R2");
    assert.equal(response.headers.get("etag"), first.headers.get("etag"));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  }
  await h.drain();
  assert.equal(h.transforms, 1);
  assert.equal(starts, 1);
  assert.deepEqual(conditions, [undefined, '"source-0"']);
  const conditional = await h.gateway(
    imageRequest("", { "if-none-match": first.headers.get("etag")! }),
  );
  assert.equal(conditional.status, 304);
  assert.equal((await conditional.arrayBuffer()).byteLength, 0);
  computeAllowed = true;
  revision = 1;
  expire();
  const changed = await h.gateway(
    imageRequest("", { "if-none-match": first.headers.get("etag")! }),
  );
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), first.headers.get("etag"));
  const changedBytes = Buffer.from(await changed.arrayBuffer());
  const expected = await sharp(inputs[revision])
    .rotate()
    .resize({ width: 640, withoutEnlargement: true })
    .webp({ quality: 77, effort: config.transforms.webpEffort })
    .toBuffer();
  assert.deepEqual(changedBytes, expected);
  await h.drain();
  assert.equal(h.transforms, 2);
  removed = true;
  expire();
  assert.equal((await h.gateway(imageRequest())).status, 404);
  await h.drain();
  assert.equal(h.bucket.objects.size, 0);
  assert.equal(h.transforms, 2);
});
