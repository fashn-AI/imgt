import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../imgt.config";
import { cacheControl, sourceMaxAge, remainingSeconds } from "../src/cache";

test("prefers shared cache lifetimes and falls back on invalid values", () => {
  assert.equal(sourceMaxAge("public, max-age=86400"), 86400);
  assert.equal(sourceMaxAge('max-age="86400", s-maxage="72000"'), 72000);
  assert.equal(sourceMaxAge("s-maxage=invalid, max-age=86400"), 86400);
  assert.equal(sourceMaxAge("max-age=invalid"), config.cache.minFreshSeconds);
});

test("applies the configured minimum and subtracts upstream Age", () => {
  assert.equal(sourceMaxAge("max-age=60"), config.cache.minFreshSeconds);
  assert.equal(sourceMaxAge("max-age=86400", 100), 86300);
  assert.equal(sourceMaxAge(null), config.cache.minFreshSeconds);
  assert.equal(sourceMaxAge("max-age=86400", 86400), 0);
});

test("distinguishes private sources from public sources that require revalidation", () => {
  assert.equal(sourceMaxAge("private, max-age=86400"), null);
  assert.equal(sourceMaxAge("no-store"), null);
  assert.equal(sourceMaxAge("NO-CACHE, max-age=86400"), 0);
  assert.equal(cacheControl(0), "no-store");
});

test("rounds deadlines down so a downstream cache never extends them", () => {
  assert.equal(remainingSeconds(1500, 1000), 0);
  assert.equal(remainingSeconds(3000, 1000), 2);
  assert.equal(remainingSeconds(500, 1000), 0);
  assert.equal(cacheControl(3600), "public, max-age=3600, must-revalidate");
});
