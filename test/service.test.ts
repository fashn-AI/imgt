import assert from "node:assert/strict";
import test from "node:test";
import {
  DERIVATIVE_PREFIX,
  MAX_ACTIVE_JOBS_PER_SHARD,
  MAX_DISTINCT_JOBS_PER_SHARD,
} from "../src/constants";
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

test("a miss delayed past another request's persistence rechecks R2 instead of transforming again", async () => {
  const h = createHarness();
  const readStarted = deferred();
  const releaseRead = deferred();
  const getObject = h.bucket.get.bind(h.bucket);
  let delayFirstRead = true;
  h.bucket.get = async (key) => {
    const object = await getObject(key);
    if (delayFirstRead) {
      delayFirstRead = false;
      readStarted.resolve();
      await releaseRead.promise;
    }
    return object;
  };
  const delayed = h.gateway(imageRequest());
  await readStarted.promise;
  const first = await h.gateway(imageRequest());
  await h.drain();
  releaseRead.resolve();
  const resumed = await delayed;
  assert.equal(resumed.status, 200);
  assert.equal(resumed.headers.get("x-imgt-cache"), "R2");
  assert.equal(await resumed.text(), await first.text());
  assert.equal(h.downloads, 1);
  assert.equal(h.transforms, 1);
});

test("oversized origin lifetimes persist safe deadlines and remain reusable", async () => {
  const h = createHarness({
    sourceFetch: async () =>
      new Response("source", {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "max-age=9007199254740991",
        },
      }),
  });
  assert.equal((await h.gateway(imageRequest())).status, 200);
  await h.drain();
  assert.equal(h.bucket.objects.size, 1);
  for (const value of h.bucket.objects.values()) {
    assert.ok(Number.isSafeInteger(Number(value.customMetadata.freshUntil)));
    assert.ok(Number.isSafeInteger(Number(value.customMetadata.staleUntil)));
  }
  assert.equal(
    (await h.gateway(imageRequest())).headers.get("x-imgt-cache"),
    "R2",
  );
  assert.equal(h.transforms, 1);
});

test("container startup overlaps origin fetch and fresh derivatives skip both", async () => {
  const originStarted = deferred();
  const startupStarted = deferred();
  const originReady = deferred<Response>();
  const startupReady = deferred();
  let starts = 0;
  const h = createHarness({
    sourceFetch: async () => {
      originStarted.resolve();
      return originReady.promise;
    },
    prepare: async () => {
      starts++;
      startupStarted.resolve();
      await startupReady.promise;
    },
  });
  const pending = h.gateway(imageRequest());
  // Neither operation can finish until both have demonstrably started.
  await Promise.all([originStarted.promise, startupStarted.promise]);
  originReady.resolve(
    new Response("source", { headers: { "content-type": "image/jpeg" } }),
  );
  assert.equal(h.transforms, 0);
  startupReady.resolve();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.match(response.headers.get("server-timing")!, /startup;dur=/);
  await h.drain();
  assert.equal(
    (await h.gateway(imageRequest())).headers.get("x-imgt-cache"),
    "R2",
  );
  assert.equal(starts, 1);
  assert.equal(h.downloads, 1);
});

test("startup failure aborts the concurrent source and releases the job for retry", async () => {
  const originStarted = deferred();
  let originSignal: AbortSignal | undefined;
  let fail = true;
  const h = createHarness({
    prepare: async () => {
      await originStarted.promise;
      if (fail) throw new Error("startup failed");
    },
    sourceFetch: async (_url, init) => {
      originSignal = init.signal as AbortSignal;
      originStarted.resolve();
      if (fail)
        await new Promise((_, reject) =>
          originSignal!.addEventListener(
            "abort",
            () => reject(originSignal!.reason),
            {
              once: true,
            },
          ),
        );
      return new Response("source", {
        headers: { "content-type": "image/jpeg" },
      });
    },
  });
  assert.equal((await h.gateway(imageRequest())).status, 500);
  assert.equal(originSignal?.aborted, true);
  assert.equal(h.transforms, 0);
  fail = false;
  assert.equal((await h.gateway(imageRequest())).status, 200);
  await h.drain();
});

test("waiting for startup does not extend the source's remaining freshness", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const starting = deferred();
  const ready = deferred();
  const h = createHarness({
    sourceFetch: async () =>
      new Response("source", {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=14400",
          age: "14399",
        },
      }),
    prepare: async () => {
      starting.resolve();
      await ready.promise;
    },
  });
  const request = h.gateway(imageRequest());
  await starting.promise;
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(2000);
  ready.resolve();
  const response = await request;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  await h.drain();
  assert.equal(h.bucket.objects.size, 0);
});

test("the shared deadline cancels startup and an origin body waiting for it", async () => {
  let startupAborted = false;
  let bodyCancelled = false;
  const h = createHarness({
    timeoutMs: 30,
    sourceFetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            bodyCancelled = true;
          },
        }),
        {
          headers: { "content-type": "image/jpeg" },
        },
      ),
    prepare: async (signal) =>
      new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            startupAborted = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      ),
  });
  assert.equal((await h.gateway(imageRequest())).status, 504);
  assert.equal(startupAborted, true);
  assert.equal(bodyCancelled, true);
  assert.equal(h.transforms, 0);
});

test("concurrent misses and arrivals during persistence share one transform", async () => {
  const transformed = deferred();
  const releaseTransform = deferred();
  const persistence = deferred();
  const h = createHarness({
    transform: async (body) => {
      await new Response(body).arrayBuffer();
      transformed.resolve();
      await releaseTransform.promise;
      return new Response("same bytes");
    },
  });
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
  assert.equal(
    responses[0].headers.get("etag"),
    responses[1].headers.get("etag"),
  );
  persistence.resolve();
  await h.drain();
});

test("failed persistence releases deduplication and later requests can retry", async () => {
  const h = createHarness();
  h.bucket.failPuts = true;
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
  const original = await h.gateway(imageRequest());
  await h.drain();
  const oldTag = original.headers.get("etag")!;
  assert.equal(
    (
      await h.gateway(
        imageRequest("", { "if-none-match": `"other", W/${oldTag}` }),
      )
    ).status,
    304,
  );
  expire(h);
  assert.equal(
    (await h.gateway(imageRequest())).headers.get("x-imgt-cache"),
    "STALE",
  );
  await h.drain();
  const replacement = await h.gateway(
    imageRequest("", { "if-none-match": oldTag }),
  );
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.headers.get("etag"), oldTag);
  assert.equal(await replacement.text(), "webp-2");
});

test("stale delivery ends at its deadline despite repeated temporary refresh failures", async () => {
  let status = 200;
  const h = createHarness({
    sourceFetch: async () =>
      new Response("source", {
        status,
        headers: { "content-type": "image/jpeg" },
      }),
  });
  await h.gateway(imageRequest());
  await h.drain();
  expire(h, 1500);
  status = 503;
  const stale = await h.gateway(imageRequest());
  assert.equal(stale.headers.get("x-imgt-cache"), "STALE");
  assert.equal(
    stale.headers.get("cache-control"),
    "public, max-age=1, must-revalidate",
  );
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
    const h = createHarness({
      sourceFetch: async () =>
        new Response("source", {
          status: deleted ? status : 200,
          headers: { "content-type": "image/jpeg" },
        }),
    });
    await h.gateway(imageRequest());
    await h.drain();
    expire(h);
    deleted = true;
    assert.equal(
      (await h.gateway(imageRequest())).headers.get("x-imgt-cache"),
      "STALE",
    );
    await h.drain();
    assert.equal(h.bucket.objects.size, 0);
    assert.equal((await h.gateway(imageRequest())).status, status);
  });
}

test("private and no-store origins are rejected; no-cache output is never retained", async () => {
  for (const policy of ["private, max-age=86400", "no-store", "no-cache"]) {
    const h = createHarness({
      sourceFetch: async () =>
        new Response("source", {
          headers: { "cache-control": policy, "content-type": "image/jpeg" },
        }),
    });
    const response = await h.gateway(imageRequest());
    await h.drain();
    assert.equal(response.status, policy === "no-cache" ? 200 : 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(h.bucket.objects.size, 0);
  }
});

test("a transition to no-cache removes a previously retained derivative", async () => {
  let policy = "public, max-age=86400";
  const h = createHarness({
    sourceFetch: async () =>
      new Response("source", {
        headers: { "cache-control": policy, "content-type": "image/jpeg" },
      }),
  });
  assert.equal((await h.gateway(imageRequest())).status, 200);
  await h.drain();
  assert.equal(h.bucket.objects.size, 1);
  expire(h);
  policy = "no-cache";
  await h.gateway(imageRequest());
  await h.drain();
  assert.equal(h.bucket.objects.size, 0);
});

for (const status of [400, 429, 503]) {
  test(`a no-cache transition removes retained data despite transform ${status}`, async () => {
    let policy = "public, max-age=86400";
    let failed = false;
    const h = createHarness({
      sourceFetch: async () =>
        new Response("source", {
          headers: { "cache-control": policy, "content-type": "image/jpeg" },
        }),
      transform: async (body) => {
        await new Response(body).arrayBuffer();
        return failed
          ? new Response("transform failed", { status })
          : new Response("webp");
      },
    });
    assert.equal((await h.gateway(imageRequest())).status, 200);
    await h.drain();
    expire(h);
    policy = "no-cache";
    failed = true;
    assert.equal(
      (await h.gateway(imageRequest())).headers.get("x-imgt-cache"),
      "STALE",
    );
    await h.drain();
    assert.equal(h.bucket.objects.size, 0);
    const response = await h.gateway(imageRequest());
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    await h.drain();
  });
}

test("a no-cache transition removes retained data despite startup failure", async () => {
  let policy = "public, max-age=86400";
  let failStartup = false;
  const deleting = deferred();
  const releaseDeletion = deferred();
  const h = createHarness({
    sourceFetch: async () =>
      new Response("source", {
        headers: { "cache-control": policy, "content-type": "image/jpeg" },
      }),
    prepare: async () => {
      if (failStartup) {
        await deleting.promise;
        throw new Error("startup failed");
      }
    },
  });
  assert.equal((await h.gateway(imageRequest())).status, 200);
  await h.drain();
  const deleteObject = h.bucket.delete.bind(h.bucket);
  h.bucket.delete = async (key) => {
    deleting.resolve();
    await releaseDeletion.promise;
    await deleteObject(key);
  };
  expire(h);
  policy = "no-cache";
  failStartup = true;
  assert.equal(
    (await h.gateway(imageRequest())).headers.get("x-imgt-cache"),
    "STALE",
  );
  await deleting.promise;
  let drained = false;
  const draining = h.drain().then(() => {
    drained = true;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    assert.equal(
      (await h.gateway(imageRequest())).headers.get("x-imgt-cache"),
      "STALE",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.downloads, 2);
  } finally {
    releaseDeletion.resolve();
    await draining;
  }
  assert.equal(h.bucket.objects.size, 0);
  assert.equal(h.transforms, 1);
  assert.equal((await h.gateway(imageRequest())).status, 500);
  await h.drain();
});

for (const phase of ["startup", "encoding"]) {
  test(`slow no-cache invalidation does not extend the ${phase} deadline`, async () => {
    let policy = "public, max-age=86400";
    let timingOut = false;
    const deleting = deferred();
    const releaseDeletion = deferred();
    const h = createHarness({
      timeoutMs: 30,
      sourceFetch: async () =>
        new Response("source", {
          headers: { "cache-control": policy, "content-type": "image/jpeg" },
        }),
      prepare:
        phase === "startup"
          ? async (signal) => {
              if (timingOut)
                await new Promise<void>((_, reject) => {
                  signal.throwIfAborted();
                  signal.addEventListener(
                    "abort",
                    () => reject(signal.reason),
                    {
                      once: true,
                    },
                  );
                });
            }
          : undefined,
      transform: async (body, _job, signal) => {
        await new Response(body).arrayBuffer();
        if (timingOut)
          await new Promise<void>((_, reject) => {
            signal.throwIfAborted();
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        return new Response("webp");
      },
    });
    assert.equal((await h.gateway(imageRequest())).status, 200);
    await h.drain();
    const deleteObject = h.bucket.delete.bind(h.bucket);
    h.bucket.delete = async (key) => {
      deleting.resolve();
      await releaseDeletion.promise;
      await deleteObject(key);
    };
    expire(h, -1000);
    policy = "no-cache";
    timingOut = true;
    const pending = h.gateway(imageRequest());
    await deleting.promise;
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          guard = setTimeout(
            () => reject(new Error("deadline waited for R2 invalidation")),
            150,
          );
        }),
      ]);
      assert.equal(response.status, 504);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(h.bucket.objects.size, 1, "deletion is still pending");
      assert.equal((await h.gateway(imageRequest())).status, 504);
      assert.equal(
        h.downloads,
        2,
        "duplicates share failed work during cleanup",
      );
    } finally {
      clearTimeout(guard);
      releaseDeletion.resolve();
      await h.drain();
    }
    assert.equal(h.bucket.objects.size, 0);
  });
}

test("full shard rejects distinct jobs while accepting duplicates", async () => {
  const release = deferred();
  const allStarted = deferred();
  let started = 0;
  const h = createHarness({
    transform: async (body) => {
      await new Response(body).arrayBuffer();
      if (++started === MAX_ACTIVE_JOBS_PER_SHARD) allStarted.resolve();
      await release.promise;
      return new Response("webp");
    },
  });
  const requests = Array.from(
    { length: MAX_DISTINCT_JOBS_PER_SHARD },
    (_, id) => h.gateway(imageRequest(`?v=${id}`)),
  );
  await allStarted.promise;
  assert.equal(h.downloads, MAX_ACTIVE_JOBS_PER_SHARD);
  const rejected = await h.gateway(
    imageRequest(`?v=${MAX_DISTINCT_JOBS_PER_SHARD}`),
  );
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get("retry-after"), "1");
  const duplicate = h.gateway(imageRequest("?v=0"));
  release.resolve();
  assert.ok(
    (await Promise.all([...requests, duplicate])).every(
      (r) => r.status === 200,
    ),
  );
  await h.drain();
  assert.equal(h.transforms, MAX_DISTINCT_JOBS_PER_SHARD);
});

test("a 100-image burst runs concurrently without waiting for R2 writes and still deduplicates", async (t) => {
  const persistence = deferred();
  let active = 0;
  let peak = 0;
  const h = createHarness({
    transform: async (body) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Response(body).arrayBuffer();
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return new Response("webp");
    },
  });
  h.bucket.putGate = persistence.promise;
  t.after(async () => {
    persistence.resolve();
    await h.drain();
  });
  const responses = await Promise.all(
    Array.from({ length: 100 }, (_, id) => h.gateway(imageRequest(`?v=${id}`))),
  );
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(peak, MAX_ACTIVE_JOBS_PER_SHARD);
  assert.equal(h.downloads, 100);
  assert.equal(h.transforms, 100);
  assert.equal(h.bucket.objects.size, 0);
  assert.equal((await h.gateway(imageRequest("?v=0"))).status, 200);
  assert.equal(h.transforms, 100);
});

test("queued jobs expire within the original deadline without downloading their source", async () => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const h = createHarness({
    timeoutMs: 80,
    transform: async (body) => {
      await new Response(body).arrayBuffer();
      if (++calls === MAX_ACTIVE_JOBS_PER_SHARD) started.resolve();
      await release.promise;
      return new Response("webp");
    },
  });
  const active = Array.from({ length: MAX_ACTIVE_JOBS_PER_SHARD }, (_, id) =>
    h.gateway(imageRequest(`?v=${id}`)),
  );
  await started.promise;
  const expired = await h.gateway(imageRequest("?v=queued"));
  assert.equal(expired.status, 504);
  assert.equal(h.downloads, MAX_ACTIVE_JOBS_PER_SHARD);
  release.resolve();
  await Promise.all(active);
  assert.equal((await h.gateway(imageRequest("?v=after"))).status, 200);
  await h.drain();
  assert.equal(h.downloads, MAX_ACTIVE_JOBS_PER_SHARD + 1);
});

test("transformation timeout aborts work and permits a later retry", async () => {
  let shouldTimeout = true;
  const h = createHarness({
    timeoutMs: 30,
    transform: async (body, _job, signal, deadline) => {
      await new Response(body).arrayBuffer();
      assert.ok(deadline <= Date.now() + 30);
      if (!shouldTimeout) return new Response("recovered");
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return new Response("unreachable");
    },
  });
  assert.equal((await h.gateway(imageRequest())).status, 504);
  shouldTimeout = false;
  assert.equal((await h.gateway(imageRequest())).status, 200);
  await h.drain();
});

test("the routed image service rejects mismatched output keys before storage or origin access", async () => {
  const h = createHarness();
  const options = parseImageOptions(new URL(imageRequest().url), [
    "images.unsplash.com",
  ]);
  const outputKey = await derivativeKey(DERIVATIVE_PREFIX, {
    ...options,
    width: 1920,
  });
  const response = await h.imageJob(
    new Request("http://container/job", {
      method: "POST",
      body: JSON.stringify({ ...options, outputKey }),
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(h.downloads, 0);
  assert.equal(h.bucket.reads, 0);
});

test("rollout rejects old renderer bytes without caching and recovers on the new renderer", async () => {
  let current = false;
  let cancelled = false;
  const h = createHarness({
    rendererVersion: "v4",
    transform: async (body) => {
      await new Response(body).arrayBuffer();
      if (!current)
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "x-imgt-renderer": "v3" } },
        );
      return new Response("new renderer", {
        headers: { "x-imgt-renderer": "v4" },
      });
    },
  });
  const rejected = await h.gateway(imageRequest());
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get("retry-after"), "5");
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  assert.equal(cancelled, true);
  await h.drain();
  assert.equal(h.bucket.objects.size, 0);
  current = true;
  const accepted = await h.gateway(imageRequest());
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "new renderer");
  await h.drain();
  assert.equal(h.bucket.objects.size, 1);
});
