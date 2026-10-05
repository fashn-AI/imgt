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
    // 0 is fastest and 6 is smallest. Effort 2 / quality 77 balanced encoding
    // time and the measured SSIM proxy; see docs/performance.md.
    defaultQuality: 77,
    // Bump the renderer version when changing effort so running containers and
    // the new cache keys cannot use different encoder settings.
    webpEffort: 2,
  },
  containers: {
    // Routing count. Native scheduling permits up to four configured shards.
    shards: 4,
    idleTimeoutMs: 120_000,
  },
  cache: {
    minFreshSeconds: 4 * 60 * 60,
    maxStaleSeconds: 24 * 60 * 60,
  },
} satisfies ImgtConfig;
