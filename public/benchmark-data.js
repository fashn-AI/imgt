// Aggregate measurements only. Raw runs and image sources stay in research.
// Other container sizes and local Docker runs are in docs/benchmarks.md.
export const imgtAllocation = "1 CPU + 3 CPU overflow";

export const costScenario = {
  transforms: 2_250_000,
  requests: 10_000_000,
  outputKiB: 120,
  readUnits: 8_570_000,
  cpuSeconds: 0.14,
  awakePercent: 100,
  region: "iad1",
  included: true,
};

// Live complete-response p95 from one client in Brazil. imgt is the default
// configuration on production, November 5, 2026. Vercel ran October 6, 2026
// with a different set of 50 FASHN images.
export const workloads = [
  {
    id: "steady-3",
    name: "3 new images per second",
    detail: "Steady traffic, like FASHN's busiest 15 minutes",
    imgt: { p95Ms: 1280, ok: 180, count: 180 },
    vercel: { p95Ms: 1273, ok: 180, count: 180 },
  },
  {
    id: "steady-10",
    name: "10 new images per second",
    detail: "Steady traffic, over 3× that peak",
    imgt: { p95Ms: 1239, ok: 600, count: 600 },
    vercel: { p95Ms: 1252, ok: 600, count: 600 },
  },
  {
    id: "stress-20",
    name: "20 new images per second",
    detail: "Heavy traffic for 30 seconds",
    imgt: { p95Ms: 1282, ok: 600, count: 600 },
    vercel: { p95Ms: 1219, ok: 600, count: 600 },
  },
  {
    id: "gallery-50",
    name: "50 new images at once",
    detail: "A visitor opens a gallery nobody has seen",
    imgt: { p95Ms: 3525, ok: 50, count: 50 },
    vercel: { p95Ms: 1100, ok: 50, count: 50 },
  },
  {
    id: "burst-200",
    name: "200 new images at once",
    detail: "A large new catalog page or a crawler",
    imgt: { p95Ms: 11711, ok: 200, count: 200 },
    vercel: { p95Ms: 2044, ok: 200, count: 200 },
  },
];

// The same 200 images requested again after the burst.
export const cachedP95Ms = 215;

const seconds = (result) =>
  result?.ok > 0 && Number.isFinite(result.p95Ms) ? result.p95Ms / 1000 : null;

export function status(result) {
  if (!result) return "Not measured";
  const failed = result.count - result.ok;
  return `${result.ok}/${result.count} succeeded${failed ? ` · ${failed} failed` : ""}`;
}

// Differences under 10% are within run-to-run noise for a single client.
export function verdict(imgt, vercel) {
  if (imgt === null || vercel === null) return { winner: null, label: "" };
  const ratio = Math.max(imgt, vercel) / Math.min(imgt, vercel);
  if (ratio < 1.1) return { winner: "tie", label: "About the same" };
  const winner = imgt < vercel ? "imgt" : "vercel";
  return {
    winner,
    label: `${winner === "imgt" ? "imgt" : "Vercel"} ${ratio.toFixed(1)}× faster`,
  };
}

export function comparisonRows() {
  return workloads.map((workload) => {
    const imgt = seconds(workload.imgt);
    const vercel = seconds(workload.vercel);
    return {
      ...workload,
      values: { imgt, vercel },
      statuses: {
        imgt: status(workload.imgt),
        vercel: status(workload.vercel),
      },
      allSucceeded: [workload.imgt, workload.vercel].every(
        (result) => result && result.ok === result.count,
      ),
      verdict: verdict(imgt, vercel),
    };
  });
}
