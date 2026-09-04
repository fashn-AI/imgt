import { remainingSeconds } from "./cache";
import { DERIVATIVE_PREFIX, STALE_CACHE_TTL_SECONDS } from "./constants";
import { errorResponse, failureResponse, imageResponse } from "./http";
import { type ResizeJob } from "./jobs";
import { derivativeKey, parseImageOptions } from "./options";
import { DerivativeStore } from "./store";

interface ImageServiceDependencies {
  store: DerivativeStore;
  resize: (job: ResizeJob) => Promise<Response>;
  waitUntil: (promise: Promise<void>) => void;
}

async function refresh(job: ResizeJob, resize: ImageServiceDependencies["resize"]): Promise<void> {
  const response = await resize(job);
  if (!response.ok) console.error(`background image refresh failed: ${response.status} ${await response.text()}`);
  else await response.body?.cancel();
}

export async function handleImage(request: Request, deps: ImageServiceDependencies): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/image") return errorResponse("not found", 404);
  try {
    const options = parseImageOptions(url);
    const outputKey = await derivativeKey(DERIVATIVE_PREFIX, options);
    const job = { outputKey, ...options };
    const stored = await deps.store.get(outputKey);
    if (stored) {
      const maxAge = remainingSeconds(stored.freshUntil);
      if (maxAge > 0) return imageResponse(stored.body, stored.etag, "R2", maxAge);
      const staleTtl = Math.min(STALE_CACHE_TTL_SECONDS, remainingSeconds(stored.staleUntil));
      if (staleTtl > 0) {
        deps.waitUntil(refresh(job, deps.resize).catch((cause) => console.error("background image refresh failed", cause)));
        return imageResponse(stored.body, stored.etag, "STALE", staleTtl);
      }
      await stored.body.cancel();
    }
    return await deps.resize(job);
  } catch (cause) {
    return failureResponse(cause);
  }
}
