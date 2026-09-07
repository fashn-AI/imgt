export type WebpEffort = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ImgtConfig {
  transforms: {
    widths: readonly number[];
    qualities: readonly number[];
    defaultQuality: number;
    webpEffort: WebpEffort;
  };
  containers: {
    shards: number;
    sleepAfter: string;
  };
  cache: {
    minFreshSeconds: number;
    maxStaleSeconds: number;
  };
}

export const config = {
  transforms: {
    widths: [32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    qualities: [60, 75, 77, 85],
    // 0 is fastest and 6 is smallest. Effort 2 / quality 77 balanced encoding
    // time and the measured SSIM proxy; see docs/performance.md.
    defaultQuality: 77,
    webpEffort: 2,
  },
  containers: {
    // Routing count. Keep this at or below max_instances in wrangler.jsonc.
    shards: 2,
    sleepAfter: "2m",
  },
  cache: {
    minFreshSeconds: 4 * 60 * 60,
    maxStaleSeconds: 24 * 60 * 60,
  },
} satisfies ImgtConfig;
