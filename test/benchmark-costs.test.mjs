import assert from "node:assert/strict";
import test from "node:test";
import {
  allocations,
  defaultScenario,
  estimateCosts,
} from "../public/benchmark-costs.js";
import {
  comparisonRows,
  verdict,
  workloads,
} from "../public/benchmark-data.js";

test("fractional horizontal scaling includes its extra memory and objects", () => {
  const small = estimateCosts(allocations.find((a) => a.name === "2 × 1 CPU"));
  const fractional = estimateCosts(
    allocations.find((a) => a.name === "8 × basic"),
  );
  assert.equal(small.cloudflare.cpu, fractional.cloudflare.cpu);
  assert.ok(fractional.cloudflare.memory > small.cloudflare.memory);
  assert.ok(fractional.cloudflare.objects > small.cloudflare.objects);
  assert.ok(fractional.imgtTotal > small.imgtTotal);
});

test("comparison verdicts ignore small differences and never show failures as fast", () => {
  assert.equal(verdict(1.28, 1.219).label, "About the same");
  assert.deepEqual(verdict(11.711, 2.044), {
    winner: "vercel",
    label: "Vercel 5.7× faster",
  });
  assert.equal(verdict(1, 2).label, "imgt 2.0× faster");
  const before = workloads[0].imgt;
  try {
    workloads[0].imgt = { p95Ms: null, ok: 0, count: 180 };
    const [failed] = comparisonRows();
    assert.equal(failed.values.imgt, null);
    assert.equal(failed.allSucceeded, false);
    assert.equal(failed.statuses.imgt, "0/180 succeeded · 180 failed");
    assert.equal(failed.verdict.winner, null);
  } finally {
    workloads[0].imgt = before;
  }
});

test("cost estimates distinguish awake memory from consumed CPU", () => {
  const vertical = estimateCosts(allocations[3]);
  const horizontal = estimateCosts(allocations[4]);
  assert.equal(vertical.cloudflare.memory, horizontal.cloudflare.memory);
  assert.equal(vertical.cloudflare.cpu, horizontal.cloudflare.cpu);
  assert.ok(horizontal.cloudflare.objects > vertical.cloudflare.objects);
  assert.equal(vertical.cloudflare.memory.toFixed(2), "155.30");
  assert.equal(vertical.imgtTotal.toFixed(2), "187.69");
});

test("Vercel meters use rounded 8 KiB writes and supplied read units", () => {
  const scenario = {
    ...defaultScenario,
    transforms: 1_000,
    outputKiB: 8.1,
    readUnits: 1_000_000,
  };
  const iad = estimateCosts(allocations[0], scenario);
  assert.deepEqual(iad.vercel, { transforms: 0.05, writes: 0.008, reads: 0.4 });
  const gru = estimateCosts(allocations[0], { ...scenario, region: "gru1" });
  assert.deepEqual(gru.vercel, {
    transforms: 0.0812,
    writes: 0.0128,
    reads: 0.64,
  });
});

test("shared included usage is optional and rounded excess is billed", () => {
  const unused = estimateCosts(allocations[0], {
    ...defaultScenario,
    transforms: 0,
    requests: 0,
    awakePercent: 0,
    readUnits: 0,
  });
  assert.equal(unused.imgtTotal, 5);
  assert.equal(unused.vercelTotal, 0);
  const charged = estimateCosts(allocations[0], {
    ...defaultScenario,
    included: false,
  });
  assert.equal(charged.cloudflare.memory.toFixed(2), "19.44");
  const justAbove = estimateCosts(allocations[0], {
    ...defaultScenario,
    transforms: 1_000_001,
    requests: 1_000_001,
    outputKiB: 1,
  });
  assert.equal(justAbove.cloudflare.r2, 4.5);
  assert.equal(justAbove.cloudflare.objects, 0.15);
});

test("awake-time estimates cannot hide required CPU capacity", () => {
  const minimum = estimateCosts(allocations[0], {
    ...defaultScenario,
    awakePercent: 0,
  });
  assert.ok(minimum.effectiveAwakePercent > 10);
  assert.ok(minimum.feasible);
  const overloaded = estimateCosts(allocations[0], {
    ...defaultScenario,
    transforms: 100_000_000,
  });
  assert.equal(overloaded.feasible, false);
  assert.equal(overloaded.effectiveAwakePercent, 100);
});

test("Worker request pricing includes the cached loopback invocation", () => {
  const cost = estimateCosts(allocations[0], {
    ...defaultScenario,
    requests: 8_000_000,
  });
  // 16M billed invocations minus 10M included, plus 56M CPU ms minus 30M included.
  assert.equal(cost.cloudflare.worker.toFixed(2), "2.32");
});

test("an overflow container adds cost only for its awake share", () => {
  const tiered = allocations.find((a) => a.overflow);
  const single = allocations[0];
  const scenario = { ...defaultScenario, included: false };
  const asleep = estimateCosts(
    { ...tiered, overflow: { ...tiered.overflow, awakePercent: 0 } },
    scenario,
  );
  assert.equal(asleep.imgtTotal, estimateCosts(single, scenario).imgtTotal);
  const awake = estimateCosts(tiered, scenario);
  const share = tiered.overflow.awakePercent / 100;
  const extraMemory = 30 * 24 * 60 * 60 * share * tiered.overflow.memory;
  assert.equal(
    (awake.cloudflare.memory - asleep.cloudflare.memory).toFixed(4),
    (extraMemory * 0.0000025).toFixed(4),
  );
  assert.equal(awake.effectiveAwakePercent, 100);
  assert.ok(awake.feasible);
});
