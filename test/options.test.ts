import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalCacheRequest,
  derivativeKey,
  normalizeSourceUrl,
  parseImageOptions,
  withPrefix,
} from "../src/options";

const ALLOWED_HOSTS = ["cdn.example.com", "*.images.example.com"];

function imageUrl(source: string, suffix = "&w=1920&q=75"): URL {
  return new URL(
    `https://img.example/image?url=${encodeURIComponent(source)}${suffix}`,
  );
}

test("parses an allowlisted HTTPS image URL", () => {
  assert.deepEqual(
    parseImageOptions(
      imageUrl("https://cdn.example.com/products/shoe.jpg"),
      ALLOWED_HOSTS,
    ),
    {
      sourceUrl: "https://cdn.example.com/products/shoe.jpg",
      width: 1920,
      quality: 75,
    },
  );
});

test("denies every source when the configured allowlist is empty", () => {
  assert.throws(() =>
    parseImageOptions(imageUrl("https://cdn.example.com/photo.jpg"), []),
  );
});

test("supports wildcard subdomains but not the parent host", () => {
  assert.equal(
    normalizeSourceUrl("https://a.images.example.com/photo.jpg", ALLOWED_HOSTS),
    "https://a.images.example.com/photo.jpg",
  );
  assert.throws(() =>
    normalizeSourceUrl("https://images.example.com/photo.jpg", ALLOWED_HOSTS),
  );
});

test("normalizes source URLs and removes fragments", () => {
  assert.equal(
    normalizeSourceUrl(
      "https://CDN.EXAMPLE.COM:443/photo.jpg?version=2#ignored",
      ALLOWED_HOSTS,
    ),
    "https://cdn.example.com/photo.jpg?version=2",
  );
});

test("uses the configured default quality", () => {
  assert.equal(
    parseImageOptions(
      imageUrl("https://cdn.example.com/photo.jpg", "&w=640"),
      ALLOWED_HOSTS,
    ).quality,
    77,
  );
});

test("accepts every integer quality from 1 to 100", () => {
  for (let quality = 1; quality <= 100; quality++) {
    assert.equal(
      parseImageOptions(
        imageUrl("https://cdn.example.com/photo.jpg", `&w=640&q=${quality}`),
        ALLOWED_HOSTS,
      ).quality,
      quality,
    );
  }
});

test("rejects empty, nonnumeric, fractional, and out-of-range quality", () => {
  for (const quality of [
    "",
    "abc",
    "NaN",
    "Infinity",
    "-1",
    "0",
    "101",
    "75.5",
  ]) {
    assert.throws(
      () =>
        parseImageOptions(
          imageUrl("https://cdn.example.com/photo.jpg", `&w=640&q=${quality}`),
          ALLOWED_HOSTS,
        ),
      { message: "q must be an integer from 1 to 100", status: 400 },
    );
  }
});

test("accepts every integer width from 1 to 3840", () => {
  for (let width = 1; width <= 3840; width++) {
    assert.equal(
      parseImageOptions(
        imageUrl("https://cdn.example.com/photo.jpg", `&w=${width}`),
        ALLOWED_HOSTS,
      ).width,
      width,
    );
  }
});

test("rejects missing, empty, invalid, and out-of-range widths", () => {
  for (const suffix of [
    "",
    "&w=",
    "&w=abc",
    "&w=NaN",
    "&w=Infinity",
    "&w=-1",
    "&w=0",
    "&w=3841",
    "&w=640.5",
  ]) {
    assert.throws(
      () =>
        parseImageOptions(
          imageUrl("https://cdn.example.com/photo.jpg", suffix),
          ALLOWED_HOSTS,
        ),
      { message: "w must be an integer from 1 to 3840", status: 400 },
    );
  }
});

test("rejects unsafe sources and unbounded variants", () => {
  assert.throws(() =>
    parseImageOptions(imageUrl("https://other.example/x.jpg"), ALLOWED_HOSTS),
  );
  assert.throws(() =>
    parseImageOptions(imageUrl("http://cdn.example.com/x.jpg"), ALLOWED_HOSTS),
  );
  assert.throws(() =>
    parseImageOptions(
      imageUrl("https://user:pass@cdn.example.com/x.jpg"),
      ALLOWED_HOSTS,
    ),
  );
  assert.throws(() =>
    parseImageOptions(
      imageUrl("https://cdn.example.com:8443/x.jpg"),
      ALLOWED_HOSTS,
    ),
  );
});

test("derivative identity changes with source URL and options", async () => {
  const firstOptions = parseImageOptions(
    imageUrl("https://cdn.example.com/x.jpg?version=1", "&w=640&q=75"),
    ALLOWED_HOSTS,
  );
  const secondOptions = parseImageOptions(
    imageUrl("https://cdn.example.com/x.jpg?version=2", "&w=640&q=75"),
    ALLOWED_HOSTS,
  );
  const first = await derivativeKey("derived/v1", firstOptions);
  const second = await derivativeKey("derived/v1", secondOptions);
  assert.match(first, /^derived\/v1\/[a-f0-9]{64}\.webp$/);
  assert.notEqual(first, second);
});

test("each quality has its own R2 and canonical cache key", async () => {
  const request = new Request(imageUrl("https://cdn.example.com/photo.jpg"));
  const first = {
    sourceUrl: "https://cdn.example.com/photo.jpg",
    width: 640,
    quality: 76,
  };
  const second = { ...first, quality: 77 };
  assert.notEqual(
    await derivativeKey("derivatives/v4", first),
    await derivativeKey("derivatives/v4", second),
  );
  assert.notEqual(
    canonicalCacheRequest(request, first).url,
    canonicalCacheRequest(request, second).url,
  );
});

test("arbitrary widths have separate R2 and canonical cache keys", async () => {
  const request = new Request(imageUrl("https://cdn.example.com/photo.jpg"));
  const first = {
    sourceUrl: "https://cdn.example.com/photo.jpg",
    width: 641,
    quality: 77,
  };
  const second = { ...first, width: 642 };
  assert.notEqual(
    await derivativeKey("derivatives/v4", first),
    await derivativeKey("derivatives/v4", second),
  );
  assert.notEqual(
    canonicalCacheRequest(request, first).url,
    canonicalCacheRequest(request, second).url,
  );
});

test("normalizes R2 prefixes", () => {
  assert.equal(
    withPrefix("/derivatives/v1/", "image.webp"),
    "derivatives/v1/image.webp",
  );
  assert.equal(withPrefix("", "image.webp"), "image.webp");
});

test("canonicalizes Workers Cache keys to normalized public parameters", () => {
  const options = parseImageOptions(
    imageUrl("https://cdn.example.com/x.jpg", "&w=640&q=75"),
    ALLOWED_HOSTS,
  );
  const cacheRequest = canonicalCacheRequest(
    new Request(
      "https://img.example/image?q=75&w=640&url=https%3A%2F%2Fcdn.example.com%2Fx.jpg&ignored=value",
    ),
    options,
  );
  const cacheUrl = new URL(cacheRequest.url);
  assert.equal(cacheUrl.pathname, "/image");
  assert.deepEqual(
    [...cacheUrl.searchParams],
    [
      ["url", "https://cdn.example.com/x.jpg"],
      ["w", "640"],
      ["q", "75"],
      ["e", "4"],
      ["v", "derivatives/v4"],
    ],
  );
});
