import { remainingSeconds } from "./cache";
import { DERIVATIVE_PREFIX, STALE_CACHE_TTL_SECONDS } from "./constants";
import { errorResponse, failureResponse, imageResponse } from "./http";
import { parseResizeJob, type ResizeJob } from "./jobs";
import { derivativeKey, parseImageOptions } from "./options";
import { DerivativeStore } from "./store";

interface ImageRouterDependencies {
  allowedHosts: readonly string[];
  resize: (job: ResizeJob) => Promise<Response>;
}

interface ImageServiceDependencies extends ImageRouterDependencies {
  store: DerivativeStore;
  waitUntil: (promise: Promise<void>) => void;
}

async function refresh(job: ResizeJob, resize: ImageServiceDependencies["resize"]): Promise<void> {
  const response = await resize(job);
  if (!response.ok) console.error(`background image refresh failed: ${response.status} ${await response.text()}`);
  else await response.body?.cancel();
}

export async function handleImageJob(request: Request, deps: ImageServiceDependencies): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/job") return errorResponse("not found", 404);
  let job: ResizeJob;
  try { job = await parseResizeJob(await request.json(), deps.allowedHosts); }
  catch { return errorResponse("invalid resize job"); }
  return serveImage(job, deps);
}

export async function routeImage(request: Request, deps: ImageRouterDependencies): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/image") return errorResponse("not found", 404);
  try {
    const options = parseImageOptions(url, deps.allowedHosts);
    const outputKey = await derivativeKey(DERIVATIVE_PREFIX, options);
    const job = { outputKey, ...options };
    return await deps.resize(job);
  } catch (cause) {
    return failureResponse(cause);
  }
}

// Run alongside the coordinator so R2 reads do not add a separate edge-to-R2 trip.
// Fresh/stale derivatives still skip container startup entirely.
async function serveImage(job: ResizeJob, deps: ImageServiceDependencies): Promise<Response> {
  try {
    const r2Started = Date.now();
    const stored = await deps.store.get(job.outputKey);
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
    // resize includes the local coordinator's job span. Remote routing is timed by the caller.
    measured.headers.append("server-timing", `r2;dur=${r2Ms}, resize;dur=${Date.now() - resizeStarted}`);
    return measured;
  } catch (cause) {
    return failureResponse(cause);
  }
}
