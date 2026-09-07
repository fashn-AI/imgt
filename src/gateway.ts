import { canonicalCacheRequest, parseImageOptions } from "./options";
import { conditionalResponse, errorResponse, failureResponse } from "./http";

const CDN_CACHE_HIT_STATUSES = new Set([
  "HIT",
  "STALE",
  "UPDATING",
  "REVALIDATED",
]);
interface GatewayDependencies {
  allowedHosts: readonly string[];
  imageCache: { fetch(request: Request): Promise<Response> };
  rateLimiter: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

export async function handleGateway(
  request: Request,
  deps: GatewayDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health")
    return Response.json(
      { ok: true, configured: deps.allowedHosts.length > 0 },
      { headers: { "cache-control": "no-store" } },
    );
  if (request.method !== "GET" || url.pathname !== "/image")
    return errorResponse("not found", 404);
  try {
    const key = `imgt:image:${request.headers.get("cf-connecting-ip") ?? "local"}`;
    if (!(await deps.rateLimiter.limit({ key })).success)
      return errorResponse("image request rate limit exceeded", 429, "60");
    const options = parseImageOptions(url, deps.allowedHosts);
    // Authentication, cookies, and client conditions are not part of the shared
    // image fetch. Conditions are applied to the resulting representation below.
    const cacheStarted = Date.now();
    let response = await deps.imageCache.fetch(
      canonicalCacheRequest(request, options),
    );
    const cacheMs = Date.now() - cacheStarted;
    if (
      CDN_CACHE_HIT_STATUSES.has(response.headers.get("cf-cache-status") ?? "")
    ) {
      response = new Response(response.body, response);
      response.headers.set("x-imgt-cache", "EDGE");
      response.headers.delete("server-timing");
    } else {
      response = new Response(response.body, response);
      response.headers.append("server-timing", `cache_fetch;dur=${cacheMs}`);
    }
    return await conditionalResponse(request, response);
  } catch (cause) {
    return failureResponse(cause);
  }
}
