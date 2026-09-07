import { RENDERER_VERSION } from "../container/renderer";
import { cacheControl } from "./cache";

export class ImageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}

export function errorResponse(
  message: string,
  status = 400,
  retryAfter?: string,
): Response {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(message, { status, headers });
}

export function failureResponse(cause: unknown): Response {
  if (cause instanceof ImageError)
    return errorResponse(cause.message, cause.status, cause.retryAfter);
  console.error("image request failed", cause);
  return errorResponse("image request failed", 500);
}

export function imageResponse(
  body: BodyInit | null,
  etag: string,
  cacheStatus: "R2" | "MISS" | "STALE",
  maxAge: number,
  serverTiming?: string,
): Response {
  const headers = new Headers({
    "content-type": "image/webp",
    "cache-control": cacheControl(maxAge),
    etag,
    "x-imgt-cache": cacheStatus,
    "x-imgt-renderer": RENDERER_VERSION,
  });
  if (serverTiming) headers.set("server-timing", serverTiming);
  return new Response(body, { headers });
}

// Evaluate conditions after the inner cache lookup. A client-specific 304 must
// never replace the shared, full representation in the image entrypoint cache.
export async function conditionalResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  const condition = request.headers.get("if-none-match");
  const etag = response.headers.get("etag");
  if (response.status !== 200 || !condition || !etag) return response;
  const tags = condition.match(/(?:W\/)?"[^"]*"|\*/g) ?? [];
  if (
    !tags.some(
      (tag) =>
        tag === "*" || tag.replace(/^W\//, "") === etag.replace(/^W\//, ""),
    )
  ) {
    return response;
  }
  await response.body?.cancel();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(null, { status: 304, headers });
}
