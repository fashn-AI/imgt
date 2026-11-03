import assert from "node:assert/strict";
import test from "node:test";
import { parseAllowedHosts, parseLocationHint } from "../src/settings";
import { handleGateway } from "../src/gateway";
import { createHarness } from "./helpers";

test("the container location hint is optional and must be a Cloudflare region", () => {
  for (const value of [undefined, "", "  "])
    assert.equal(parseLocationHint(value), undefined);
  assert.equal(parseLocationHint(" ENAM "), "enam");
  for (const value of ["us-east", "enam,weur", "*"])
    assert.throws(() => parseLocationHint(value), /CONTAINER_LOCATION_HINT/);
});

test("deployment hosts normalize and empty configuration denies image access", async () => {
  assert.deepEqual(
    parseAllowedHosts(
      " CDN.EXAMPLE.COM, *.images.example.com\ncdn.example.com ",
    ),
    ["cdn.example.com", "*.images.example.com"],
  );
  for (const value of [undefined, "", "   , "])
    assert.deepEqual(parseAllowedHosts(value), []);
  for (const value of [
    "*",
    "https://example.com",
    "example.com/path",
    "127.0.0.1",
    "cdn.*.example.com",
  ]) {
    assert.throws(() => parseAllowedHosts(value), /ALLOWED_HOSTS/);
  }
  const response = await handleGateway(
    new Request(
      "https://img.example/image?url=https://images.unsplash.com/x.jpg&w=640",
    ),
    {
      allowedHosts: [],
      rateLimiter: { limit: async () => ({ success: true }) },
      imageCache: {
        fetch: async () => {
          throw new Error("disallowed hosts must not reach even a warm cache");
        },
      },
    },
  );
  assert.equal(response.status, 400);
});

test("custom hosts reach the coordinator and redirect checks use that same configuration", async () => {
  const h = createHarness({
    allowedHosts: ["cdn.example.com"],
    sourceFetch: async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://images.unsplash.com/x.jpg" },
      }),
  });
  const response = await h.gateway(
    new Request(
      "https://img.example/image?url=https://cdn.example.com/x.jpg&w=640",
    ),
  );
  assert.equal(response.status, 502);
  assert.equal(h.downloads, 1);
  assert.equal(h.transforms, 0);
  const allowed = createHarness({ allowedHosts: ["cdn.example.com"] });
  assert.equal(
    (
      await allowed.gateway(
        new Request(
          "https://img.example/image?url=https://cdn.example.com/x.jpg&w=640",
        ),
      )
    ).status,
    200,
  );
  await allowed.drain();
});

test("health is uncached and does not read images or start transformations", async () => {
  const h = createHarness();
  const health = await h.gateway(
    new Request("https://my-images.example/health"),
  );
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.deepEqual(await health.json(), { ok: true, configured: true });
  assert.equal(h.downloads, 0);
  assert.equal(h.bucket.reads, 0);
  assert.equal(h.transforms, 0);
});
