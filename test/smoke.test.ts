import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import sharp from "sharp";
import { RENDERER_VERSION } from "../container/renderer";

test("smoke rejects WebP with valid metadata but corrupt pixels", async (t) => {
  const bytes = await sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: 12, g: 50, b: 90 },
    },
  })
    .webp()
    .toBuffer();
  // Corrupt the VP8 payload while preserving the readable format and dimensions.
  bytes[30] ^= 2;
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 640);
  await assert.rejects(sharp(bytes).raw().toBuffer());
  const etag = '"' + createHash("sha256").update(bytes).digest("hex") + '"';
  let imageRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "image/webp",
      etag,
      "x-imgt-renderer": RENDERER_VERSION,
      "x-imgt-cache": imageRequests++ === 0 ? "R2" : "EDGE",
    });
    response.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const child = spawn(
    process.execPath,
    [
      "scripts/smoke.mjs",
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  assert.deepEqual(await once(child, "close"), [1, null]);
  assert.match(stderr, /Smoke test failed:/);
  assert.doesNotMatch(stdout, /"ok": true/);
});
