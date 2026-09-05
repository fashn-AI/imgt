export default {
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  images: {
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
