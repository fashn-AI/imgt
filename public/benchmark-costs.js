// USD rates checked against provider documentation on 2026-10-06.
// An overflow container is billed only while awake; production measured
// about 18% in November 2026 (4.6 GiB average memory with a 3 GiB primary).
export const allocations = [
  { name: "1 × 1 CPU", shards: 1, cpu: 1, memory: 3, disk: 2 },
  { name: "2 × 1 CPU", shards: 2, cpu: 1, memory: 3, disk: 2 },
  { name: "2 × 2 CPUs", shards: 2, cpu: 2, memory: 6, disk: 2 },
  { name: "4 × 2 CPUs", shards: 4, cpu: 2, memory: 6, disk: 2 },
  { name: "8 × 1 CPU", shards: 8, cpu: 1, memory: 3, disk: 2 },
  { name: "4 × 1 CPU", shards: 4, cpu: 1, memory: 3, disk: 2 },
  { name: "4 × basic", shards: 4, cpu: 0.25, memory: 1, disk: 4 },
  { name: "8 × basic", shards: 8, cpu: 0.25, memory: 1, disk: 4 },
  {
    name: "1 CPU + 3 CPU overflow",
    shards: 1,
    cpu: 1,
    memory: 3,
    disk: 2,
    overflow: { cpu: 3, memory: 9, disk: 2, awakePercent: 18 },
  },
];

export const defaultScenario = {
  transforms: 2_000_000,
  requests: 3_000_000,
  outputKiB: 120,
  readUnits: 8_000_000,
  cpuSeconds: 0.14,
  awakePercent: 100,
  region: "iad1",
  included: true,
};

const excess = (usage, included) => Math.max(0, usage - included);
const units = (usage, included, size) =>
  Math.ceil(excess(usage, included) / size);

export function estimateCosts(allocation, scenario = defaultScenario) {
  const {
    transforms,
    requests,
    outputKiB,
    readUnits,
    cpuSeconds,
    awakePercent,
    region,
    included,
  } = scenario;
  // Each shard has its own awake time. CPU billing uses consumed CPU seconds.
  const seconds = 30 * 24 * 60 * 60;
  const cpuUsage = transforms * cpuSeconds;
  const overflow = allocation.overflow;
  const overflowSeconds = overflow
    ? (seconds * overflow.awakePercent) / 100
    : 0;
  // Work the overflow can absorb while awake does not keep shards awake.
  const overflowCapacity = overflow ? overflow.cpu * overflowSeconds : 0;
  const minimumAwake =
    Math.max(0, cpuUsage - overflowCapacity) /
    (allocation.shards * allocation.cpu * seconds);
  const awake = Math.min(1, Math.max(awakePercent / 100, minimumAwake));
  const shardSeconds = allocation.shards * seconds * awake;
  const runningSeconds = shardSeconds + overflowSeconds;
  const memorySeconds =
    shardSeconds * allocation.memory +
    overflowSeconds * (overflow?.memory ?? 0);
  const diskSeconds =
    shardSeconds * allocation.disk + overflowSeconds * (overflow?.disk ?? 0);
  const allowance = (value) => (included ? value : 0);
  // Conservative: every request misses the edge, so it reaches the DO and R2.
  const r2Reads = requests + transforms;
  const retainedGB = (transforms * outputKiB * 1024) / 1e9;
  const cloudflare = {
    plan: 5,
    memory: excess(memorySeconds, allowance(90_000)) * 0.0000025,
    cpu: excess(cpuUsage, allowance(22_500)) * 0.00002,
    disk: excess(diskSeconds, allowance(720_000)) * 0.00000007,
    objects:
      units(runningSeconds * 0.128, allowance(400_000), 1_000_000) * 12.5 +
      units(requests, allowance(1_000_000), 1_000_000) * 0.15,
    r2:
      units(transforms, allowance(1_000_000), 1_000_000) * 4.5 +
      units(r2Reads, allowance(10_000_000), 1_000_000) * 0.36 +
      units(retainedGB, allowance(10), 1) * 0.015,
    // The gateway and cached ctx.exports entrypoint are both billed invocations.
    // The assumed 7 ms CPU is their combined CPU per external image request.
    worker:
      (excess(requests * 2, allowance(10_000_000)) / 1_000_000) * 0.3 +
      (excess(requests * 7, allowance(30_000_000)) / 1_000_000) * 0.02,
    // Assume North American containers and output transfer only.
    transfer: excess(retainedGB, allowance(1_000)) * 0.025,
  };
  const rates = region === "gru1" ? [0.0812, 6.4, 0.64] : [0.05, 4, 0.4];
  const writeUnits = transforms * Math.ceil(outputKiB / 8);
  const vercel = {
    transforms: (transforms / 1_000) * rates[0],
    writes: (writeUnits / 1_000_000) * rates[1],
    reads: (readUnits / 1_000_000) * rates[2],
  };
  const total = (parts) =>
    Object.values(parts).reduce((sum, value) => sum + value, 0);
  return {
    cloudflare,
    vercel,
    imgtTotal: total(cloudflare),
    vercelTotal: total(vercel),
    effectiveAwakePercent: awake * 100,
    feasible: minimumAwake <= 1,
  };
}
