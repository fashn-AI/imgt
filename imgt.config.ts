export interface ImgtConfig {
  sources: {
    allowedHosts: readonly string[];
  };
  transforms: {
    widths: readonly number[];
    qualities: readonly number[];
    defaultQuality: number;
  };
  containers: {
    shards: number;
  };
}

export const config = {
  sources: {
    // Exact hosts and wildcard subdomains are supported, for example:
    // "cdn.example.com", "*.images.example.com"
    allowedHosts: [],
  },
  transforms: {
    widths: [32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    qualities: [60, 75, 85],
    defaultQuality: 75,
  },
  containers: {
    // Routing count. Keep this at or below max_instances in wrangler.jsonc.
    shards: 4,
  },
} satisfies ImgtConfig;
