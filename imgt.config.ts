export type WebpEffort = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ImgtConfig {
  sources: {
    allowedHosts: readonly string[];
  };
  transforms: {
    widths: readonly number[];
    qualities: readonly number[];
    defaultQuality: number;
    webpEffort: WebpEffort;
  };
  containers: {
    shards: number;
  };
}

export const config = {
  sources: {
    // Exact hosts and wildcard subdomains are supported, for example:
    // "cdn.example.com", "*.images.example.com"
    allowedHosts: ["images.unsplash.com"],
  },
  transforms: {
    widths: [32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    qualities: [60, 75, 77, 85],
    // 0 is fastest and 6 is smallest. Effort 2 plus quality 77 retained at
    // least the measured quality of Vercel's quality-75 output while encoding faster.
    defaultQuality: 77,
    webpEffort: 2,
  },
  containers: {
    // Routing count. Keep this at or below max_instances in wrangler.jsonc.
    shards: 4,
  },
} satisfies ImgtConfig;
