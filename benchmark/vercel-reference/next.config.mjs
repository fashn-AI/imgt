export default {
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  images: {
    // Opt in only during an owned benchmark; keep public transformation off otherwise.
    unoptimized: process.env.IMGT_BENCHMARK_ENABLED !== '1',
    formats: ['image/webp'],
    deviceSizes: [640, 1920, 3840],
    imageSizes: [],
    qualities: [75],
    minimumCacheTTL: 14400,
    remotePatterns: [{
      protocol: 'https',
      hostname: 'images.unsplash.com',
      port: '',
      pathname: '/photo-1500530855697-b586d89ba3ee',
      // Benchmark IDs create independent variants; only this fixture is allowed.
    }],
  },
};
