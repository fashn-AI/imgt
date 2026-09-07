import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { RENDERER_VERSION } from "../container/renderer.ts";

const [base, suppliedSource] = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--"));
if (!base) {
  console.error(
    "Usage: npm run smoke -- https://imgt.YOUR-SUBDOMAIN.workers.dev [https://your-cdn/image.jpg] [--fresh]",
  );
  process.exit(1);
}
const source = new URL(
  suppliedSource ??
    "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&w=1920&q=90",
);
// Explicit opt-in: adding query parameters can invalidate signed origin URLs.
if (process.argv.includes("--fresh"))
  source.searchParams.set("imgt_smoke", String(Date.now()));
const imageUrl = new URL("/image", base);
imageUrl.search = new URLSearchParams({ url: source.href, w: "640", q: "77" });
async function request(url, headers) {
  const start = performance.now();
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  return { response, body, ms: Math.round(performance.now() - start) };
}

try {
  const health = await request(new URL("/health", base));
  assert.equal(health.response.status, 200, "Worker health");
  assert.equal(JSON.parse(health.body).ok, true);
  const first = await request(imageUrl);
  assert.equal(
    first.response.status,
    200,
    `Image: ${first.body.toString().slice(0, 200)}`,
  );
  assert.equal(
    first.response.headers.get("x-imgt-renderer"),
    RENDERER_VERSION,
    "Expected current renderer version",
  );
  const metadata = await sharp(first.body).metadata();
  assert.equal(metadata.format, "webp");
  assert.ok(
    metadata.width > 0 && metadata.width <= 640,
    "Output must fit the requested width",
  );
  const etag = first.response.headers.get("etag");
  assert.equal(
    etag,
    '"' + createHash("sha256").update(first.body).digest("hex") + '"',
  );
  if (first.response.headers.get("x-imgt-cache") === "MISS") {
    assert.match(
      first.response.headers.get("server-timing") ?? "",
      /queue;dur=/,
      "Expected current container timing; rollout may still be completing",
    );
  }
  const alias = new URL("/image", base);
  alias.search = new URLSearchParams({
    ignored: "smoke",
    q: "77",
    w: "640",
    url: source.href,
  });
  const repeat = await request(alias);
  assert.equal(repeat.response.status, 200);
  assert.deepEqual(repeat.body, first.body);
  assert.equal(
    repeat.response.headers.get("x-imgt-cache"),
    "EDGE",
    "Canonical edge cache hit (source must permit public caching)",
  );
  const conditional = await request(imageUrl, { "if-none-match": etag });
  assert.equal(conditional.response.status, 304);
  assert.equal(conditional.body.length, 0);
  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoint: imageUrl.origin,
        image: {
          width: metadata.width,
          height: metadata.height,
          bytes: first.body.length,
        },
        first: {
          ms: first.ms,
          cache: first.response.headers.get("x-imgt-cache"),
        },
        repeat: {
          ms: repeat.ms,
          cache: repeat.response.headers.get("x-imgt-cache"),
        },
        conditional: conditional.response.status,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("Smoke test failed:", error.message);
  console.error(
    "Check ALLOWED_HOSTS, the source caching policy, and Workers Builds/container rollout status. A successful build can precede container readiness.",
  );
  process.exitCode = 1;
}
