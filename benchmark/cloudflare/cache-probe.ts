import { WorkerEntrypoint } from "cloudflare:workers";

// Bounded synthetic cache experiment; no origin fetch, R2 or container start.
// Expiry prevents an abandoned experiment from remaining active indefinitely.
export const CACHE_PROBE_UNTIL = Date.parse("2026-09-05T04:10:00Z");
const payload = Uint8Array.from({ length: 65536 }, (_, index) => index % 251);
function generatedResponse(): Response {
  return new Response(payload, { headers: {
    "content-type": "application/octet-stream", "cache-control": "public, max-age=300",
    "x-probe-generation": crypto.randomUUID(),
  } });
}

export class ProbeCache extends WorkerEntrypoint {
  fetch(): Response {
    return generatedResponse();
  }
}

export async function cacheProbe(request: Request, ctx: ExecutionContext): Promise<Response> {
  if (Date.now() >= CACHE_PROBE_UNTIL) return new Response("probe disabled", { status: 410 });
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  const key = url.searchParams.get("key");
  if (!key || !/^[a-zA-Z0-9-]{1,80}$/.test(key) || !["tiered", "local"].includes(mode ?? "")) {
    return new Response("invalid probe options", { status: 400 });
  }
  const cacheRequest = new Request(`${url.origin}/cache-probe-v1/${mode}/${key}`);
  const started = Date.now();
  let response: Response;
  let status: string;
  if (mode === "tiered") {
    const binding = (ctx.exports as unknown as { ProbeCache: Fetcher }).ProbeCache;
    response = await binding.fetch(cacheRequest);
    status = response.headers.get("cf-cache-status") ?? "UNKNOWN";
  } else {
    const stored = await caches.default.match(cacheRequest);
    status = stored ? "HIT" : "MISS";
    response = stored ?? generatedResponse();
    if (!stored) ctx.waitUntil(caches.default.put(cacheRequest, response.clone()));
  }
  const result = new Response(response.body, response);
  result.headers.set("x-probe-cache", status);
  result.headers.set("server-timing", `cache;dur=${Date.now() - started}`);
  result.headers.set("cache-control", "no-store");
  return result;
}
