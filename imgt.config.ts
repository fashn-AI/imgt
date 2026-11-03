export type WebpEffort = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// Cloudflare custom allocations: 1-4 vCPU, billed for 3 GiB RAM per vCPU.
export interface ContainerTier {
  vcpu: 1 | 2 | 3 | 4;
  idleTimeoutMs: number;
}

export interface ImgtConfig {
  transforms: {
    defaultQuality: number;
    webpEffort: WebpEffort;
    maxSourceBytes: number;
  };
  containers: {
    primary: ContainerTier;
    overflow: (ContainerTier & { wakeAtQueuedJobs: number }) | null;
  };
  cache: {
    minFreshSeconds: number;
    maxStaleSeconds: number;
  };
}

export const config = {
  transforms: {
    // Match Sharp's standard WebP encoding effort; see docs/performance.md.
    defaultQuality: 77,
    // Effort is part of the R2 and edge cache keys: changing it re-encodes
    // every cached image once.
    webpEffort: 4,
    // Original-file limit, shared by the Worker and container (100 MiB).
    maxSourceBytes: 100 * 1024 * 1024,
  },
  containers: {
    // Every cache miss goes to the primary first. Steady traffic keeps it
    // awake, so its size is the main fixed cost.
    primary: { vcpu: 1, idleTimeoutMs: 120_000 },
    // A larger container that starts when this many jobs wait for the
    // primary, and stops soon after the burst. null disables it, for example
    // with a 3-vCPU primary instead.
    overflow: { vcpu: 3, idleTimeoutMs: 30_000, wakeAtQueuedJobs: 4 },
    // Container region is the CONTAINER_LOCATION_HINT Worker variable.
  },
  cache: {
    minFreshSeconds: 4 * 60 * 60,
    maxStaleSeconds: 24 * 60 * 60,
  },
} satisfies ImgtConfig;
