import assert from "node:assert/strict";
import test from "node:test";
import { handleGateway } from "../src/gateway";
import { imageRequest } from "./helpers";

test("rate limiting runs before cache access and never caches a rejection", async () => {
  let cacheCalls = 0;
  const response = await handleGateway(imageRequest("", { "cf-connecting-ip": "192.0.2.1" }), {
    allowedHosts: ["images.unsplash.com"],
    imageCache: { fetch: async () => { cacheCalls += 1; return new Response("image"); } },
    rateLimiter: { limit: async ({ key }) => { assert.equal(key, "imgt:image:192.0.2.1"); return { success: false }; } },
  });
  assert.equal(response.status, 429); assert.equal(cacheCalls, 0);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("edge responses honor client ETags after canonical fetching without leaking client headers", async () => {
  const response = await handleGateway(imageRequest("", {
    "if-none-match": 'W/"content"', cookie: "session=private", authorization: "Bearer secret",
  }), {
    allowedHosts: ["images.unsplash.com"],
    imageCache: { fetch: async (request) => {
      assert.equal(request.headers.get("if-none-match"), null);
      assert.equal(request.headers.get("cookie"), null);
      assert.equal(request.headers.get("authorization"), null);
      return new Response("webp", { headers: {
        etag: '"content"', "cf-cache-status": "HIT", "cache-control": "public, max-age=60", "content-length": "4", "server-timing": "old",
      } });
    } },
    rateLimiter: { limit: async () => ({ success: true }) },
  });
  assert.equal(response.status, 304); assert.equal(await response.text(), "");
  assert.equal(response.headers.get("x-imgt-cache"), "EDGE");
  assert.equal(response.headers.get("server-timing"), null);
  assert.equal(response.headers.get("content-length"), null);
});

test("invalid public parameters return 400 through the shared error handler", async () => {
  const response = await handleGateway(new Request("https://img.example/image?w=640"), {
    allowedHosts: ["images.unsplash.com"],
    imageCache: { fetch: async () => { throw new Error("must not reach the cache"); } },
    rateLimiter: { limit: async () => ({ success: true }) },
  });
  assert.equal(response.status, 400);
  assert.equal(await response.text(), "url is required");
  assert.equal(response.headers.get("cache-control"), "no-store");
});
