import assert from "node:assert/strict";
import test from "node:test";
import { DERIVATIVE_PREFIX } from "../src/constants";
import { derivativeKey, parseImageOptions } from "../src/options";
import { createHarness, deferred, imageRequest } from "./helpers";

function expire(harness: ReturnType<typeof createHarness>, staleMs = 60_000) {
  for (const value of harness.bucket.objects.values()) {
    value.customMetadata.freshUntil = String(Date.now() - 1000);
    value.customMetadata.staleUntil = String(Date.now() + staleMs);
  }
}

test("miss persists once, fresh R2 skips transformation, and content validators survive storage", async () => {
  const h = createHarness();
  const first = await h.gateway(imageRequest());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-imgt-cache"), "MISS");
  await h.drain();
  const stored = await h.gateway(imageRequest());
  assert.equal(stored.headers.get("x-imgt-cache"), "R2");
  assert.equal(stored.headers.get("etag"), first.headers.get("etag"));
  assert.equal(await stored.text(), await first.text());
  assert.equal(h.transforms, 1);
});

test("concurrent misses and arrivals during persistence share one transform", async () => {
  const transformed = deferred();
  const releaseTransform = deferred();
  const persistence = deferred();
  const h = createHarness({ transform: async (body) => {
    await new Response(body).arrayBuffer(); transformed.resolve();
    await releaseTransform.promise; return new Response("same bytes");
  } });
  h.bucket.putGate = persistence.promise;
  const first = h.gateway(imageRequest());
  await transformed.promise;
  const second = h.gateway(imageRequest());
  releaseTransform.resolve();
  const responses = await Promise.all([first, second]);
  assert.equal(h.transforms, 1);
  assert.equal(h.bucket.puts, 1);
  const duringPersistence = await h.gateway(imageRequest());
  assert.equal(await duringPersistence.text(), "same bytes");
  assert.equal(h.transforms, 1);
  assert.equal(responses[0].headers.get("etag"), responses[1].headers.get("etag"));
  persistence.resolve(); await h.drain();
});

test("failed persistence releases deduplication and later requests can retry", async () => {
  const h = createHarness(); h.bucket.failPuts = true;
  assert.equal((await h.gateway(imageRequest())).status, 200);
  await h.drain();
  assert.equal(h.bucket.objects.size, 0);
  h.bucket.failPuts = false;
  assert.equal((await h.gateway(imageRequest())).status, 200);
  await h.drain();
  assert.equal(h.transforms, 2);
  assert.equal(h.bucket.objects.size, 1);
});

test("refresh changes the content ETag and conditional requests match only current bytes", async () => {
  const h = createHarness();
  const original = await h.gateway(imageRequest()); await h.drain();
  const oldTag = original.headers.get("etag")!;
  assert.equal((await h.gateway(imageRequest("", { "if-none-match": `"other", W/${oldTag}` }))).status, 304);
  expire(h);
  assert.equal((await h.gateway(imageRequest())).headers.get("x-imgt-cache"), "STALE");
  await h.drain();
  const replacement = await h.gateway(imageRequest("", { "if-none-match": oldTag }));
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.headers.get("etag"), oldTag);
  assert.equal(await replacement.text(), "webp-2");
});

test("stale delivery ends at its deadline despite repeated temporary refresh failures", async () => {
  let status = 200;
  const h = createHarness({ sourceFetch: async () => new Response("source", { status, headers: { "content-type": "image/jpeg" } }) });
  await h.gateway(imageRequest()); await h.drain(); expire(h, 1500);
  status = 503;
  const stale = await h.gateway(imageRequest());
  assert.equal(stale.headers.get("x-imgt-cache"), "STALE");
  assert.equal(stale.headers.get("cache-control"), "public, max-age=1, must-revalidate");
  await h.drain();
  assert.equal(h.bucket.objects.size, 1);
  expire(h, -1000);
  const expired = await h.gateway(imageRequest());
  assert.equal(expired.status, 502);
  assert.equal(expired.headers.get("cache-control"), "no-store");
});

for (const status of [403, 404, 410]) {
  test(`source ${status} invalidates stale R2 data`, async () => {
    let deleted = false;
    const h = createHarness({ sourceFetch: async () => new Response("source", { status: deleted ? status : 200, headers: { "content-type": "image/jpeg" } }) });
    await h.gateway(imageRequest()); await h.drain(); expire(h);
    deleted = true;
    assert.equal((await h.gateway(imageRequest())).headers.get("x-imgt-cache"), "STALE");
    await h.drain();
    assert.equal(h.bucket.objects.size, 0);
    assert.equal((await h.gateway(imageRequest())).status, status);
  });
}

test("private and no-store origins are rejected; no-cache output is never retained", async () => {
  for (const policy of ["private, max-age=86400", "no-store", "no-cache"]) {
    const h = createHarness({ sourceFetch: async () => new Response("source", { headers: { "cache-control": policy, "content-type": "image/jpeg" } }) });
    const response = await h.gateway(imageRequest()); await h.drain();
    assert.equal(response.status, policy === "no-cache" ? 200 : 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(h.bucket.objects.size, 0);
  }
});

test("a transition to no-cache removes a previously retained derivative", async () => {
  let policy = "public, max-age=86400";
  const h = createHarness({ sourceFetch: async () => new Response("source", { headers: { "cache-control": policy, "content-type": "image/jpeg" } }) });
  assert.equal((await h.gateway(imageRequest())).status, 200); await h.drain();
  assert.equal(h.bucket.objects.size, 1); expire(h);
  policy = "no-cache";
  await h.gateway(imageRequest()); await h.drain();
  assert.equal(h.bucket.objects.size, 0);
});

test("full shard rejects distinct jobs while accepting duplicates", async () => {
  const release = deferred();
  const allStarted = deferred(); let started = 0;
  const h = createHarness({ transform: async (body) => {
    await new Response(body).arrayBuffer();
    if (++started === 4) allStarted.resolve();
    await release.promise; return new Response("webp");
  } });
  const requests = [0, 1, 2, 3].map((id) => h.gateway(imageRequest(`?v=${id}`)));
  await allStarted.promise;
  const rejected = await h.gateway(imageRequest("?v=4"));
  assert.equal(rejected.status, 429); assert.equal(rejected.headers.get("retry-after"), "1");
  const duplicate = h.gateway(imageRequest("?v=0"));
  release.resolve();
  assert.ok((await Promise.all([...requests, duplicate])).every((r) => r.status === 200));
  await h.drain(); assert.equal(h.transforms, 4);
});

test("transformation timeout aborts work and permits a later retry", async () => {
  let shouldTimeout = true;
  const h = createHarness({ timeoutMs: 30, transform: async (body, _job, signal, deadline) => {
    await new Response(body).arrayBuffer();
    assert.ok(deadline <= Date.now() + 30);
    if (!shouldTimeout) return new Response("recovered");
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return new Response("unreachable");
  } });
  assert.equal((await h.gateway(imageRequest())).status, 504);
  shouldTimeout = false;
  assert.equal((await h.gateway(imageRequest())).status, 200); await h.drain();
});

test("coordinator rejects mismatched output keys before storage or origin access", async () => {
  const h = createHarness();
  const options = parseImageOptions(new URL(imageRequest().url));
  const outputKey = await derivativeKey(DERIVATIVE_PREFIX, { ...options, width: 1920 });
  const response = await h.coordinator.fetch(new Request("http://coordinator/job", {
    method: "POST", body: JSON.stringify({ ...options, outputKey }),
  }));
  assert.equal(response.status, 400); assert.equal(h.downloads, 0); assert.equal(h.bucket.reads, 0);
});
