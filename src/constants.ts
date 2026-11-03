// Internal implementation and safety limits. Deployment choices belong in imgt.config.ts.
import { RENDERER_VERSION } from "../container/renderer";
import { config } from "../imgt.config";
export const DERIVATIVE_PREFIX = `derivatives/${RENDERER_VERSION}`;
// One coordinator handles every cache miss, so these cover all traffic.
export const MAX_DISTINCT_JOBS = 512;
// Active jobs mostly wait on R2 and origins. The tier dispatcher separately
// bounds how many reach the containers.
export const MAX_ACTIVE_JOBS = 96;
// Runtime and allocation changes need fresh containers, retaining cached images.
export const CONTAINER_RUNTIME_VERSION = "v17";
export const MAX_SOURCE_BYTES = config.transforms.maxSourceBytes;
if (!Number.isSafeInteger(MAX_SOURCE_BYTES) || MAX_SOURCE_BYTES < 1)
  throw new Error("transforms.maxSourceBytes must be a positive safe integer");
export const MAX_SOURCE_REDIRECTS = 3;
export const MAX_SOURCE_URL_LENGTH = 1024;
export const MAX_OUTPUT_WIDTH = 3840;
export const OUTPUT_FORMAT = "webp" as const;
export const STALE_CACHE_TTL_SECONDS = 60;
export const TRANSFORM_TIMEOUT_MS = 60_000;
