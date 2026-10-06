export type WebpEffort = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ImgtConfig {
  transforms: {
    defaultQuality: number;
    webpEffort: WebpEffort;
  };
  containers: {
    shards: number;
    idleTimeoutMs: number;
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
    // Bump the renderer version when changing effort so running containers and
    // the new cache keys cannot use different encoder settings.
    webpEffort: 4,
  },
  containers: {
    // Routing count. Up to eight configured shards; see docs/performance.md.
    shards: 2,
    idleTimeoutMs: 120_000,
  },
  cache: {
    minFreshSeconds: 4 * 60 * 60,
    maxStaleSeconds: 24 * 60 * 60,
  },
} satisfies ImgtConfig;
