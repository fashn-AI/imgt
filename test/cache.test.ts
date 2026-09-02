import assert from "node:assert/strict";
import test from "node:test";

import { cacheControl, effectiveMaxAge, maxAgeMetadata, originMaxAge, remainingMaxAge } from "../src/cache";
import { MIN_CACHE_TTL_SECONDS } from "../src/constants";

test("reads shared and browser cache lifetimes", () => {
  assert.equal(originMaxAge("public, max-age=3600"), 3600);
  assert.equal(originMaxAge('max-age="3600", s-maxage="7200"'), 7200);
  assert.equal(originMaxAge("no-store"), 0);
  assert.equal(originMaxAge("max-age=invalid"), 0);
});

test("applies the minimum derivative cache lifetime", () => {
  assert.equal(effectiveMaxAge("max-age=60"), MIN_CACHE_TTL_SECONDS);
  assert.equal(effectiveMaxAge("max-age=86400"), 86400);
  assert.equal(effectiveMaxAge(null), MIN_CACHE_TTL_SECONDS);
});

test("calculates the remaining R2 derivative lifetime", () => {
  const uploaded = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date("2026-01-01T00:30:00.000Z").getTime();
  assert.equal(remainingMaxAge(uploaded, maxAgeMetadata(3600), now), 1800);
  assert.equal(remainingMaxAge(uploaded, undefined, now), 0);
  assert.equal(remainingMaxAge(uploaded, maxAgeMetadata(60), now), 0);
});

test("creates a cacheable derivative response policy", () => {
  assert.equal(cacheControl(3600), "public, max-age=3600, must-revalidate");
});
