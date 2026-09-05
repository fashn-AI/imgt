import assert from "node:assert/strict";
import test from "node:test";
import { fetchSource } from "../src/source";
import { ImageError } from "../src/http";
import { MAX_SOURCE_BYTES } from "../src/constants";

const source = "https://images.unsplash.com/photo.jpg";

test("redirects validate every destination and cancel discarded bodies", async () => {
  let calls = 0; let canceled = false;
  await assert.rejects(fetchSource(source, new AbortController().signal, ["images.unsplash.com"], async () => {
    calls += 1;
    return new Response(new ReadableStream({ cancel() { canceled = true; } }), {
      status: 302, headers: { location: "https://untrusted.example/image.jpg" },
    });
  }), (cause) => cause instanceof ImageError && cause.status === 502);
  assert.equal(calls, 1); assert.equal(canceled, true);
});

test("allowed relative redirects succeed and redirect loops terminate", async () => {
  const seen: string[] = [];
  const result = await fetchSource(source, new AbortController().signal, ["images.unsplash.com"], async (url) => {
    seen.push(url);
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: "/other.jpg" } }) : new Response("image", { headers: { "content-type": "image/jpeg" } });
  });
  assert.equal(await new Response(result.body).text(), "image");
  assert.equal(seen[1], "https://images.unsplash.com/other.jpg");
  let calls = 0;
  await assert.rejects(fetchSource(source, new AbortController().signal, ["images.unsplash.com"], async () => {
    calls += 1; return new Response(null, { status: 302, headers: { location: "/loop" } });
  }), /too many times/);
  assert.equal(calls, 4);
});

test("rejects oversized and unsupported responses before invoking the encoder", async () => {
  const cases: Record<string, string>[] = [{ "content-length": String(MAX_SOURCE_BYTES + 1) }, { "content-type": "text/html" }];
  for (const headers of cases) {
    await assert.rejects(fetchSource(source, new AbortController().signal, ["images.unsplash.com"], async () => new Response("bad", { headers })), ImageError);
  }
});
