// Aggregate measurements only. Raw runs and image sources stay in research.
export const profiles = [
  { id: "four-1cpu", name: "4 × 1 CPU", detail: "12 GiB RAM", live: true },
  { id: "two-2cpu", name: "2 × 2 CPUs", detail: "12 GiB RAM", live: true },
  { id: "two-1cpu", name: "2 × 1 CPU", detail: "6 GiB RAM", live: true },
  {
    id: "four-basic",
    name: "4 × basic",
    detail: "4 GiB RAM · local only",
    live: false,
  },
  {
    id: "eight-basic",
    name: "8 × basic",
    detail: "8 GiB RAM · local only",
    live: false,
  },
];

export const recommendedProfile = "four-1cpu";
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

export const measurements = {
  local: {
    "two-2cpu": {
      "gallery-50": {
        p95Ms: 2080,
        ok: 50,
        count: 50,
      },
      "burst-200": {
        p95Ms: 6702,
        ok: 200,
        count: 200,
      },
      "steady-3": {
        p95Ms: 217,
        ok: 180,
        count: 180,
      },
      "steady-10": {
        p95Ms: 227,
        ok: 300,
        count: 300,
      },
      "stress-20": {
        p95Ms: 339,
        ok: 600,
        count: 600,
      },
    },
    "two-1cpu": {
      "gallery-50": {
        p95Ms: 3636,
        ok: 50,
        count: 50,
      },
      "burst-200": {
        p95Ms: 12291,
        ok: 200,
        count: 200,
      },
      "steady-3": {
        p95Ms: 202,
        ok: 180,
        count: 180,
      },
      "steady-10": {
        p95Ms: 296,
        ok: 300,
        count: 300,
      },
      "stress-20": {
        p95Ms: 7501,
        ok: 600,
        count: 600,
      },
    },
    "four-basic": {
      "gallery-50": {
        p95Ms: 7480,
        ok: 50,
        count: 50,
      },
      "burst-200": {
        p95Ms: 24090,
        ok: 200,
        count: 200,
      },
      "steady-3": {
        p95Ms: 1071,
        ok: 180,
        count: 180,
      },
      "steady-10": {
        p95Ms: 10067,
        ok: 300,
        count: 300,
      },
      "stress-20": {
        p95Ms: 43184,
        ok: 600,
        count: 600,
      },
    },
    "eight-basic": {
      "gallery-50": {
        p95Ms: 4373,
        ok: 50,
        count: 50,
      },
      "burst-200": {
        p95Ms: 13097,
        ok: 200,
        count: 200,
      },
      "steady-3": {
        p95Ms: 911,
        ok: 180,
        count: 180,
      },
      "steady-10": {
        p95Ms: 2209,
        ok: 300,
        count: 300,
      },
      "stress-20": {
        p95Ms: 10767,
        ok: 600,
        count: 600,
      },
    },
    "four-1cpu": {
      "gallery-50": {
        p95Ms: 2092,
        ok: 50,
        count: 50,
      },
      "burst-200": {
        p95Ms: 7475,
        ok: 200,
        count: 200,
      },
      "steady-3": {
        p95Ms: 203,
        ok: 180,
        count: 180,
      },
      "steady-10": {
        p95Ms: 243,
        ok: 300,
        count: 300,
      },
      "stress-20": {
        p95Ms: 440,
        ok: 600,
        count: 600,
      },
    },
  },
  live: {
    "two-2cpu": {
      "gallery-50": {
        p95Ms: 2460,
        ok: 50,
        count: 50,
      },
      "steady-3": {
        p95Ms: 1063,
        ok: 180,
        count: 180,
      },
      "steady-10": {
        p95Ms: 968,
        ok: 600,
        count: 600,
      },
      "stress-20": {
        p95Ms: 1282,
        ok: 3600,
        count: 3600,
      },
      "burst-200": {
        p95Ms: 7703,
        ok: 200,
        count: 200,
      },
    },
    vercel: {
      "gallery-50": {
        p95Ms: 1100,
        ok: 50,
        count: 50,
      },
      "steady-3": {
        p95Ms: 1273,
        ok: 180,
        count: 180,
      },
      "steady-10": {
        p95Ms: 1252,
        ok: 600,
        count: 600,
      },
      "stress-20": {
        p95Ms: 1219,
        ok: 600,
        count: 600,
      },
      "burst-200": {
        p95Ms: 2044,
        ok: 200,
        count: 200,
      },
    },
    "two-1cpu": {
      "steady-3": {
        p95Ms: 990,
        ok: 180,
        count: 180,
      },
      "steady-10": {
        p95Ms: 1122,
        ok: 600,
        count: 600,
      },
      "stress-20": {
        p95Ms: 19857,
        ok: 612,
        count: 619,
        target: 3600,
      },
      "burst-200": {
        p95Ms: 17321,
        ok: 200,
        count: 200,
      },
      "gallery-50": {
        p95Ms: 4954,
        ok: 50,
        count: 50,
      },
    },
    "four-1cpu": {
      "steady-3": {
        p95Ms: 934,
        ok: 180,
        count: 180,
      },
      "steady-10": {
        p95Ms: 942,
        ok: 600,
        count: 600,
      },
      "stress-20": {
        p95Ms: 1046,
        ok: 3600,
        count: 3600,
      },
      "burst-200": {
        p95Ms: 6836,
        ok: 200,
        count: 200,
      },
      "gallery-50": {
        p95Ms: 2402,
        ok: 50,
        count: 50,
      },
    },
  },
};

export function latencyRows(environment, workload) {
  const selected =
    environment === "live"
      ? profiles.filter((profile) => profile.live)
      : profiles;
  if (environment === "live")
    selected.push({
      id: "vercel",
      name: "Vercel",
      detail: "Managed optimizer",
    });
  return selected.map((profile) => {
    const result = measurements[environment][profile.id]?.[workload];
    return {
      ...profile,
      value: Number.isFinite(result?.p95Ms) ? result.p95Ms / 1000 : null,
      emptyLabel: result ? "No successes" : "Not tested",
      status: result
        ? `${result.ok}/${result.count} succeeded${result.count > result.ok ? ` · ${result.count - result.ok} failed` : ""}${result.target > result.count ? " · stopped early" : ""}${result.fallbacks ? ` · ${result.fallbacks} originals` : ""}`
        : "Not measured",
      recommended: profile.id === recommendedProfile,
    };
  });
}

export function latencyNote(environment, workload) {
  return environment === "live"
    ? "Live services, measured October 6 from Brazil. Bars show successful-response p95; success counts include every dispatched request."
    : "Local ARM64 Docker, production Rust image with enforced CPU/RAM quotas. Basic is unavailable through the current native Cloudflare API." +
        (workload === "stress-20"
          ? " Basic profiles kept processing after the 30-second arrival window; they did not sustain 20/second."
          : "");
}
