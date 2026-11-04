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

const ERROR_FLAGS = [
  "retryable",
  "overloaded",
  "remote",
  "durableObjectReset",
] as const;
const MAX_STACK_LENGTH = 2000;

export interface ErrorDetails {
  name?: string;
  message: string;
  stack?: string;
  retryable?: boolean;
  overloaded?: boolean;
  remote?: boolean;
  durableObjectReset?: boolean;
  cause?: ErrorDetails;
}

// Logged errors keep their name and message as fields. Passing an Error to
// console.error can leave Workers Logs with only part of the stack.
export function describeError(cause: unknown, depth = 0): ErrorDetails {
  if (!(cause instanceof Error)) return { message: String(cause) };
  const details: ErrorDetails = { name: cause.name, message: cause.message };
  if (cause.stack) details.stack = cause.stack.slice(0, MAX_STACK_LENGTH);
  for (const flag of ERROR_FLAGS) {
    const value = (cause as unknown as Record<string, unknown>)[flag];
    if (typeof value === "boolean") details[flag] = value;
  }
  if (cause.cause !== undefined && depth < 2)
    details.cause = describeError(cause.cause, depth + 1);
  return details;
}

export function logError(event: string, cause: unknown): void {
  console.error(JSON.stringify({ event, error: describeError(cause) }));
}

export function failureResponse(cause: unknown): Response {
  if (cause instanceof ImageError)
    return errorResponse(cause.message, cause.status, cause.retryAfter);
  logError("image_request_failed", cause);
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
