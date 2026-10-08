import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

function configuredLimit(value: string) {
  // A fresh process evaluates the edited configuration before module constants.
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    const { config } = await import('./imgt.config.ts');
    config.transforms.maxSourceBytes = ${value};
    const { MAX_SOURCE_BYTES, DERIVATIVE_PREFIX } = await import('./src/constants.ts');
    const { containerNameForShard } = await import('./src/jobs.ts');
    const { derivativeKey } = await import('./src/options.ts');
    console.log(JSON.stringify({
      limit: MAX_SOURCE_BYTES,
      shard: containerNameForShard(0),
      key: await derivativeKey(DERIVATIVE_PREFIX, {
        sourceUrl: 'https://cdn.example.com/image.png', width: 640, quality: 77,
      }),
    }));
  `,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url).href),
      encoding: "utf8",
    },
  );
}

test("source-limit changes rotate containers and preserve derivative cache keys", () => {
  const before = configuredLimit("1024");
  const after = configuredLimit("2048");
  assert.equal(before.status, 0, before.stderr);
  assert.equal(after.status, 0, after.stderr);
  const first = JSON.parse(before.stdout);
  const second = JSON.parse(after.stdout);
  assert.equal(first.limit, 1024);
  assert.equal(second.limit, 2048);
  assert.notEqual(first.shard, second.shard);
  assert.equal(first.key, second.key);
});

test("invalid source limits fail before serving requests", () => {
  for (const value of [
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "9007199254740992",
  ]) {
    const result = configuredLimit(value);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /maxSourceBytes must be a positive safe integer/,
    );
  }
});
