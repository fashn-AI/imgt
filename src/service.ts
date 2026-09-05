import { remainingSeconds } from "./cache";
import { DERIVATIVE_PREFIX, STALE_CACHE_TTL_SECONDS } from "./constants";
import { errorResponse, failureResponse, imageResponse } from "./http";
import { type ResizeJob } from "./jobs";
import { derivativeKey, parseImageOptions } from "./options";
import { DerivativeStore } from "./store";

interface ImageServiceDependencies {
  allowedHosts: readonly string[];
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
    const options = parseImageOptions(url, deps.allowedHosts);
    const outputKey = await derivativeKey(DERIVATIVE_PREFIX, options);
    const job = { outputKey, ...options };
    const r2Started = Date.now();
    const stored = await deps.store.get(outputKey);
    const r2Ms = Date.now() - r2Started;
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
    const resizeStarted = Date.now();
    const response = await deps.resize(job);
    const measured = new Response(response.body, response);
    // resize includes the remote coordinator's job span plus routing/transfer.
    measured.headers.append("server-timing", `r2;dur=${r2Ms}, resize;dur=${Date.now() - resizeStarted}`);
    return measured;
  } catch (cause) {
    return failureResponse(cause);
  }
}
