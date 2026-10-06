import assert from "node:assert/strict";
import test from "node:test";
import { fetchSource, parseSourceValidator } from "../src/source";
import { ImageError } from "../src/http";
import { MAX_SOURCE_BYTES } from "../src/constants";

const source = "https://images.unsplash.com/photo.jpg";

test("source validators require bounded strong ETags and bounded cache metadata", () => {
  for (const etag of [
    null,
    "unquoted",
    'W/"weak"',
    '"bad\nvalue"',
    `"${"a".repeat(512)}"`,
    `"${"é".repeat(256)}"`,
  ]) {
    assert.equal(parseSourceValidator(etag, null), undefined);
  }
  assert.equal(parseSourceValidator('"valid"', "é".repeat(257)), undefined);
  assert.deepEqual(parseSourceValidator('"valid"', null), {
    etag: '"valid"',
    cacheControl: null,
  });
});

test("changed redirect targets never persist a validator from their final URL", async () => {
  let calls = 0;
  const result = await fetchSource(
    source,
    new AbortController().signal,
    ["images.unsplash.com"],
    async () =>
      ++calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "/other.jpg" },
          })
        : new Response("image", {
            headers: { "content-type": "image/jpeg", etag: '"other"' },
          }),
  );
  assert.equal(await new Response(result.body).text(), "image");
  assert.equal(result.validator, undefined);
});

test("strong ETags revalidate direct origins and inherit absent 304 cache policy", async () => {
  const result = await fetchSource(
    source,
    new AbortController().signal,
    ["images.unsplash.com"],
    async (_url, init) => {
      assert.equal(
        new Headers(init.headers).get("if-none-match"),
        '"original"',
      );
      return new Response(null, { status: 304, headers: { age: "60" } });
    },
    { etag: '"original"', cacheControl: "public, max-age=86400" },
  );
  assert.equal(result.body, null);
  assert.equal(result.maxAge, 86340);
  assert.deepEqual(result.validator, {
    etag: '"original"',
    cacheControl: "public, max-age=86400",
  });
});

test("redirects drop source validators and unexpected 304 responses fail", async () => {
  for (const conditional of [false, true]) {
    let calls = 0;
    await assert.rejects(
      fetchSource(
        source,
        new AbortController().signal,
        ["images.unsplash.com"],
        async (_url, init) => {
          calls++;
          const condition = new Headers(init.headers).get("if-none-match");
          if (conditional && calls === 1) {
            assert.equal(condition, '"original"');
            return new Response(null, {
              status: 302,
              headers: { location: "/other.jpg" },
            });
          }
          assert.equal(condition, null);
          return new Response(null, { status: 304 });
        },
        conditional ? { etag: '"original"', cacheControl: null } : undefined,
      ),
      (cause) => cause instanceof ImageError && cause.status === 502,
    );
    assert.equal(calls, conditional ? 2 : 1);
  }
});

test("redirects validate every destination and cancel discarded bodies", async () => {
  let calls = 0;
  let canceled = false;
  await assert.rejects(
    fetchSource(
      source,
      new AbortController().signal,
      ["images.unsplash.com"],
      async () => {
        calls += 1;
        return new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          {
            status: 302,
            headers: { location: "https://untrusted.example/image.jpg" },
          },
        );
      },
    ),
    (cause) => cause instanceof ImageError && cause.status === 502,
  );
  assert.equal(calls, 1);
  assert.equal(canceled, true);
});

test("allowed relative redirects succeed and redirect loops terminate", async () => {
  const seen: string[] = [];
  const result = await fetchSource(
    source,
    new AbortController().signal,
    ["images.unsplash.com"],
    async (url) => {
      seen.push(url);
      return seen.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "/other.jpg" },
          })
        : new Response("image", { headers: { "content-type": "image/jpeg" } });
    },
  );
  assert.equal(await new Response(result.body).text(), "image");
  assert.equal(seen[1], "https://images.unsplash.com/other.jpg");
  let calls = 0;
  await assert.rejects(
    fetchSource(
      source,
      new AbortController().signal,
      ["images.unsplash.com"],
      async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "/loop" },
        });
      },
    ),
    /too many times/,
  );
  assert.equal(calls, 4);
});

test("rejects oversized and unsupported responses before invoking the encoder", async () => {
  const cases: Record<string, string>[] = [
    { "content-length": String(MAX_SOURCE_BYTES + 1) },
    { "content-type": "text/html" },
  ];
  for (const headers of cases) {
    await assert.rejects(
      fetchSource(
        source,
        new AbortController().signal,
        ["images.unsplash.com"],
        async () => new Response("bad", { headers }),
      ),
      ImageError,
    );
  }
});

for (const status of [500, 502, 503, 504, "network"] as const) {
  test(`retries a temporary source ${status} once before returning the body`, async () => {
    let calls = 0;
    let canceled = false;
    const result = await fetchSource(
      source,
      new AbortController().signal,
      ["images.unsplash.com"],
      async () => {
        if (++calls === 1) {
          if (status === "network") throw new Error("connection reset");
          return new Response(
            new ReadableStream({
              cancel() {
                canceled = true;
              },
            }),
            { status },
          );
        }
        return new Response("image", {
          headers: { "content-type": "image/jpeg" },
        });
      },
    );
    assert.equal(calls, 2);
    assert.equal(canceled, status !== "network");
    assert.equal(await new Response(result.body).text(), "image");
  });
}

test("one source retry budget is shared across validated redirects", async () => {
  let calls = 0;
  await assert.rejects(
    fetchSource(
      source,
      new AbortController().signal,
      ["images.unsplash.com"],
      async () => {
        calls++;
        if (calls === 2)
          return new Response(null, {
            status: 302,
            headers: { location: "/other.jpg" },
          });
        return new Response("temporary failure", { status: 500 });
      },
    ),
    /source image returned HTTP 500/,
  );
  assert.equal(calls, 3);
});

test("aborting a source retry delay prevents a second fetch", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    fetchSource(
      source,
      controller.signal,
      ["images.unsplash.com"],
      async () => {
        calls++;
        setTimeout(() => controller.abort(), 10);
        return new Response("temporary failure", { status: 500 });
      },
    ),
    (cause) => cause instanceof ImageError && cause.status === 504,
  );
  assert.equal(calls, 1);
});

test("permanent errors, rate limits, and Retry-After do not trigger a source retry", async () => {
  for (const status of [403, 404, 410, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(
      fetchSource(
        source,
        new AbortController().signal,
        ["images.unsplash.com"],
        async () => {
          calls++;
          return new Response("error", {
            status,
            headers: status >= 500 ? { "retry-after": "60" } : {},
          });
        },
      ),
      ImageError,
    );
    assert.equal(calls, 1);
  }
});

test("a successful retry still enforces private-source policy", async () => {
  let calls = 0;
  await assert.rejects(
    fetchSource(
      source,
      new AbortController().signal,
      ["images.unsplash.com"],
      async () =>
        ++calls === 1
          ? new Response("error", { status: 500 })
          : new Response("private", {
              headers: {
                "content-type": "image/jpeg",
                "cache-control": "private",
              },
            }),
    ),
    (cause) => cause instanceof ImageError && cause.status === 403,
  );
  assert.equal(calls, 2);
});
