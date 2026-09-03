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
  return new URL(`https://img.example/image?url=${encodeURIComponent(source)}${suffix}`);
}

test("parses an allowlisted HTTPS image URL", () => {
  assert.deepEqual(parseImageOptions(imageUrl("https://cdn.example.com/products/shoe.jpg"), ALLOWED_HOSTS), {
    sourceUrl: "https://cdn.example.com/products/shoe.jpg",
    width: 1920,
    quality: 75,
  });
});

test("denies every source when the configured allowlist is empty", () => {
  assert.throws(() => parseImageOptions(imageUrl("https://cdn.example.com/photo.jpg"), []));
});

test("supports wildcard subdomains but not the parent host", () => {
  assert.equal(
    normalizeSourceUrl("https://a.images.example.com/photo.jpg", ALLOWED_HOSTS),
    "https://a.images.example.com/photo.jpg",
  );
  assert.throws(() => normalizeSourceUrl("https://images.example.com/photo.jpg", ALLOWED_HOSTS));
});

test("normalizes source URLs and removes fragments", () => {
  assert.equal(
    normalizeSourceUrl("https://CDN.EXAMPLE.COM:443/photo.jpg?version=2#ignored", ALLOWED_HOSTS),
    "https://cdn.example.com/photo.jpg?version=2",
  );
});

test("uses the configured default quality", () => {
  assert.equal(
    parseImageOptions(imageUrl("https://cdn.example.com/photo.jpg", "&w=640"), ALLOWED_HOSTS).quality,
    77,
  );
});

test("accepts the small widths emitted by the Next.js default srcset", () => {
  assert.equal(
    parseImageOptions(imageUrl("https://cdn.example.com/icon.png", "&w=32&q=75"), ALLOWED_HOSTS).width,
    32,
  );
});

test("rejects unsafe sources and unbounded variants", () => {
  assert.throws(() => parseImageOptions(imageUrl("https://other.example/x.jpg"), ALLOWED_HOSTS));
  assert.throws(() => parseImageOptions(imageUrl("http://cdn.example.com/x.jpg"), ALLOWED_HOSTS));
  assert.throws(() => parseImageOptions(imageUrl("https://user:pass@cdn.example.com/x.jpg"), ALLOWED_HOSTS));
  assert.throws(() => parseImageOptions(imageUrl("https://cdn.example.com:8443/x.jpg"), ALLOWED_HOSTS));
  assert.throws(() => parseImageOptions(imageUrl("https://cdn.example.com/x.jpg", "&w=641"), ALLOWED_HOSTS));
  assert.throws(() => parseImageOptions(imageUrl("https://cdn.example.com/x.jpg", "&w=640&q=76"), ALLOWED_HOSTS));
});

test("derivative identity changes with source URL and options", async () => {
  const firstOptions = parseImageOptions(imageUrl("https://cdn.example.com/x.jpg?version=1", "&w=640&q=75"), ALLOWED_HOSTS);
  const secondOptions = parseImageOptions(imageUrl("https://cdn.example.com/x.jpg?version=2", "&w=640&q=75"), ALLOWED_HOSTS);
  const first = await derivativeKey("derived/v1", firstOptions);
  const second = await derivativeKey("derived/v1", secondOptions);
  assert.match(first, /^derived\/v1\/[a-f0-9]{64}\.webp$/);
  assert.notEqual(first, second);
});

test("normalizes R2 prefixes", () => {
  assert.equal(withPrefix("/derivatives/v1/", "image.webp"), "derivatives/v1/image.webp");
  assert.equal(withPrefix("", "image.webp"), "image.webp");
});

test("canonicalizes Workers Cache keys to normalized public parameters", () => {
  const options = parseImageOptions(imageUrl("https://cdn.example.com/x.jpg", "&w=640&q=75"), ALLOWED_HOSTS);
  const cacheRequest = canonicalCacheRequest(
    new Request("https://img.example/image?q=75&w=640&url=https%3A%2F%2Fcdn.example.com%2Fx.jpg&ignored=value"),
    options,
  );
  const cacheUrl = new URL(cacheRequest.url);
  assert.equal(cacheUrl.pathname, "/image");
  assert.deepEqual([...cacheUrl.searchParams], [
    ["url", "https://cdn.example.com/x.jpg"],
    ["w", "640"],
    ["q", "75"],
    ["e", "2"],
    ["v", "derivatives/v1"],
  ]);
});
