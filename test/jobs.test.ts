import assert from "node:assert/strict";
import test from "node:test";

import {
  containerBackend,
  containerNameForKey,
  SingleFlight,
} from "../src/jobs";

test("native canary routing is limited to the configured source-query prefix", () => {
  const source =
    "https://images.unsplash.com/photo?imgt_native_eval=run-1-cold-0";
  assert.equal(containerBackend(source, "legacy", "run-1"), "native");
  assert.equal(containerBackend(source, "legacy", "run"), "native");
  assert.equal(containerBackend(source, "legacy", "run-2"), "legacy");
  assert.equal(containerBackend(source, "legacy", "run-1-cold-01"), "legacy");
  assert.equal(containerBackend(source, "legacy", ""), "legacy");
  assert.equal(
    containerBackend("https://images.unsplash.com/photo", "legacy", "run-1"),
    "legacy",
  );
  assert.equal(containerBackend("invalid", "legacy", "run-1"), "legacy");
  assert.equal(containerBackend(null, "legacy", "run-1"), "legacy");
  assert.equal(containerBackend(source, "native"), "native");
});

test("routes a derivative key to a stable container shard", () => {
  const key = "derivatives/v1/abcdef.webp";
  assert.equal(containerNameForKey(key, 4), containerNameForKey(key, 4));
  assert.match(containerNameForKey(key, 4), /^instance-v3-[0-3]$/);

  const shards = new Set(
    Array.from({ length: 64 }, (_, index) =>
      containerNameForKey(`derivative-${index}`, 4),
    ),
  );
  assert.deepEqual(
    shards,
    new Set([
      "instance-v3-0",
      "instance-v3-1",
      "instance-v3-2",
      "instance-v3-3",
    ]),
  );
});

test("rejects an invalid container shard count", () => {
  assert.throws(() => containerNameForKey("key", 0));
  assert.throws(() => containerNameForKey("key", 1.5));
});

test("coalesces concurrent work with the same key", async () => {
  const singleFlight = new SingleFlight<string>();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = singleFlight.run("same-key", async () => {
    calls += 1;
    await gate;
    return "result";
  });
  const second = singleFlight.run("same-key", async () => {
    calls += 1;
    return "duplicate";
  });

  assert.equal(singleFlight.size, 1);
  assert.equal(singleFlight.has("same-key"), true);
  assert.strictEqual(first, second);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["result", "result"]);
  assert.equal(calls, 1);
  assert.equal(singleFlight.size, 0);

  const afterCompletion = singleFlight.run("same-key", async () => {
    calls += 1;
    return "next";
  });
  assert.equal(await afterCompletion, "next");
  assert.equal(calls, 2);
});

test("clears failed work so it can be retried", async () => {
  const singleFlight = new SingleFlight<string>();
  const failed = singleFlight.run("key", async () => {
    throw new Error("failed");
  });
  await assert.rejects(failed, /failed/);

  const retry = singleFlight.run("key", async () => "recovered");
  assert.equal(await retry, "recovered");
});

test("keeps completed work coalesced until background persistence finishes", async () => {
  const singleFlight = new SingleFlight<string>();
  let calls = 0;
  let releasePersistence!: () => void;
  const persistence = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });

  assert.equal(
    await singleFlight.run(
      "key",
      async () => {
        calls += 1;
        return "result";
      },
      () => persistence,
    ),
    "result",
  );
  assert.equal(singleFlight.size, 1);

  assert.equal(
    await singleFlight.run("key", async () => {
      calls += 1;
      return "duplicate";
    }),
    "result",
  );
  assert.equal(calls, 1);

  releasePersistence();
  await persistence;
  await Promise.resolve();
  assert.equal(singleFlight.size, 0);
});
