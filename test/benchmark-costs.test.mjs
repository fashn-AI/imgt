import assert from "node:assert/strict";
import test from "node:test";
import {
  allocations,
  defaultScenario,
  estimateCosts,
} from "../public/benchmark-costs.js";

test("cost estimates distinguish awake memory from consumed CPU", () => {
  const vertical = estimateCosts(allocations[2]);
  const horizontal = estimateCosts(allocations[3]);
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
