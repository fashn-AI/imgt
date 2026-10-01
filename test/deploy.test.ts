import assert from "node:assert/strict";
import test from "node:test";
import {
  gatedDeploy,
  shardSources,
  verifyProbe,
  withDeadline,
} from "../scripts/deploy.mts";
import { DERIVATIVE_PREFIX } from "../src/constants";
import { containerNameForKey } from "../src/jobs";
import { derivativeKey } from "../src/options";

const previous = "11111111-1111-1111-1111-111111111111";
const candidate = "22222222-2222-2222-2222-222222222222";
const promoted = "33333333-3333-3333-3333-333333333333";

test("deployment probes expire even when an underlying operation ignores cancellation", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    withDeadline((value) => {
      signal = value;
      return new Promise(() => {});
    }, 10),
    /exceeded 10ms/,
  );
  assert.equal(signal?.aborted, true);
});

function harness(fail?: "legacy" | "native" | "promotion") {
  const commands: string[][] = [];
  const warms: { version: string; backend: string; attempts: number }[] = [];
  let waited = false;
  return {
    commands,
    warms,
    tools: {
      async run(args: string[]) {
        commands.push(args);
        return `Worker Version ID: ${args[0] === "deploy" ? promoted : candidate}`;
      },
      async wait(ms: number) {
        assert.equal(ms, 145000);
        waited = true;
      },
      async warm(
        version: string,
        backend: "legacy" | "native",
        attempts: number,
      ) {
        warms.push({ version, backend, attempts });
        if (backend === "native")
          assert.ok(
            waited,
            "Old compute must idle before initializing the new image",
          );
        if (backend === fail || (fail === "promotion" && version === promoted))
          throw Error("unavailable");
      },
    },
  };
}

test("promotion reuses the initialized image and requires both backend checks", async () => {
  const h = harness();
  assert.equal(await gatedDeploy(previous, h.tools, "nonce"), promoted);
  assert.deepEqual(h.warms, [
    { version: candidate, backend: "legacy", attempts: 4 },
    { version: candidate, backend: "native", attempts: 4 },
    { version: promoted, backend: "native", attempts: 1 },
  ]);
  assert.deepEqual(h.commands[1], [
    "versions",
    "deploy",
    `${previous}@100`,
    `${candidate}@0`,
    "--yes",
  ]);
  assert.ok(
    h.commands[3].includes("none"),
    "Promotion must not build another image",
  );
});

for (const fail of ["legacy", "native", "promotion"] as const) {
  test(`a failed ${fail} check retains a verified production route`, async () => {
    const h = harness(fail);
    await assert.rejects(
      gatedDeploy(previous, h.tools, "nonce"),
      /unavailable/,
    );
    assert.deepEqual(h.commands.at(-1), [
      "versions",
      "deploy",
      `${fail === "legacy" ? previous : candidate}@100`,
      "--yes",
    ]);
    if (fail !== "promotion")
      assert.ok(!h.commands.some((args) => args[0] === "deploy"));
  });
}

test("fresh preflight inputs cover each configured deterministic shard", async () => {
  const sources = await shardSources(
    "https://images.unsplash.com/test.jpg",
    "nonce-phase",
    true,
  );
  for (const [shard, sourceUrl] of sources.entries()) {
    assert.ok(
      new URL(sourceUrl).searchParams
        .get("imgt_native_eval")
        ?.startsWith("nonce-"),
    );
    const key = await derivativeKey(DERIVATIVE_PREFIX, {
      sourceUrl,
      width: 640,
      quality: 77,
    });
    assert.equal(containerNameForKey(key, 2), `instance-v3-${shard}`);
  }
});

test("a cached response or wrong Worker version cannot pass native readiness", async () => {
  const body = Buffer.from("webp");
  const headers = {
    "x-imgt-worker-version": candidate,
    "x-imgt-container-backend": "native",
    "x-imgt-renderer": "v3",
    "x-imgt-cache": "MISS",
    "server-timing": 'container_boot;desc="abcd"',
  };
  assert.equal(
    await verifyProbe(
      new Response(body, { headers }),
      body,
      candidate,
      "native",
    ),
    "abcd",
  );
  await assert.rejects(
    verifyProbe(
      new Response(body, { headers: { ...headers, "x-imgt-cache": "EDGE" } }),
      body,
      candidate,
      "native",
    ),
  );
  await assert.rejects(
    verifyProbe(new Response(body, { headers }), body, promoted, "native"),
  );
  const expected = Buffer.alloc(70000, 1);
  const actual = Buffer.alloc(70000, 2);
  await assert.rejects(
    verifyProbe(
      new Response(actual, { headers }),
      expected,
      candidate,
      "native",
    ),
    (error: Error) => {
      assert.match(
        error.message,
        /expected 70000 bytes [a-f0-9]{64}, received 70000 bytes [a-f0-9]{64}/,
      );
      assert.ok(error.message.length < 300);
      return true;
    },
  );
});
