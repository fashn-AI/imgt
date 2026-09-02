// Internal implementation and safety limits. Deployment choices belong in imgt.config.ts.
export const DERIVATIVE_PREFIX = "derivatives/v1";
export const MAX_DISTINCT_JOBS_PER_SHARD = 4;
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const MAX_SOURCE_REDIRECTS = 3;
export const MAX_SOURCE_URL_LENGTH = 1024;
export const MIN_CACHE_TTL_SECONDS = 4 * 60 * 60;
export const OUTPUT_FORMAT = "webp" as const;
export const STALE_CACHE_TTL_SECONDS = 60;
export const TRANSFORM_TIMEOUT_MS = 20_000;
