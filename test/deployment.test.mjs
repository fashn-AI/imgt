import assert from "node:assert/strict";
import test from "node:test";
import { unstable_readConfig as readConfig } from "wrangler";

test("staging resolves with isolated resources and the production scheduling policy", () => {
  const path = new URL("../wrangler.jsonc", import.meta.url).pathname;
  const production = readConfig({ config: path });
  const staging = readConfig({ config: path, env: "staging" });
  assert.notEqual(staging.name, production.name);
  assert.notEqual(staging.containers[0].name, production.containers[0].name);
  assert.notEqual(
    staging.r2_buckets[0].bucket_name,
    production.r2_buckets[0].bucket_name,
  );
  assert.notEqual(
    staging.ratelimits[0].namespace_id,
    production.ratelimits[0].namespace_id,
  );
  assert.deepEqual(staging.durable_objects, production.durable_objects);
  assert.deepEqual(staging.version_metadata, production.version_metadata);
  assert.equal(staging.containers[0].scheduling_policy, "durable_object");
  assert.equal(
    staging.containers[0].class_name,
    production.containers[0].class_name,
  );
  assert.ok(staging.vars.ALLOWED_HOSTS);
});
