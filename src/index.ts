import { Container, getContainer } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import { config } from "../imgt.config";
import { cacheControl, effectiveMaxAge, maxAgeMetadata, remainingMaxAge } from "./cache";
import {
  DERIVATIVE_PREFIX,
  MAX_DISTINCT_JOBS_PER_SHARD,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_REDIRECTS,
  OUTPUT_FORMAT,
  STALE_CACHE_TTL_SECONDS,
  TRANSFORM_TIMEOUT_MS,
} from "./constants";
import { containerNameForKey, type ResizeJob, SingleFlight } from "./jobs";
import {
  ALLOWED_QUALITIES,
  ALLOWED_WIDTHS,
  canonicalCacheRequest,
  derivativeKey,
  normalizeSourceUrl,
  parseImageOptions,
  withPrefix,
} from "./options";

interface Env {
  IMGT_TRANSFORMER: DurableObjectNamespace<ImgtImageTransformer>;
  DERIVATIVES: R2Bucket;
}

const ALLOWED_SOURCE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const CDN_CACHE_HIT_STATUSES = new Set(["HIT", "STALE", "UPDATING", "REVALIDATED"]);

interface ResizeResult {
  body: ArrayBuffer;
  etag: string;
  maxAge: number;
  cacheStatus: "R2" | "MISS";
  serverTiming?: string;
  persistence?: Promise<void>;
}

class ResizeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}

export class ImgtImageTransformer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = false;
  envVars = {
    MAX_INPUT_BYTES: String(MAX_SOURCE_BYTES),
    MAX_IN_FLIGHT: String(MAX_DISTINCT_JOBS_PER_SHARD),
    VIPS_CONCURRENCY: "1",
    WEBP_EFFORT: String(config.transforms.webpEffort),
  };
  readonly #singleFlight = new SingleFlight<ResizeResult>();

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/job") {
      return error("not found", 404);
    }

    let job: ResizeJob;
    try {
      const value: unknown = await request.json();
      if (!this.isResizeJob(value)) throw new Error("invalid resize job");
      job = value;
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : "invalid resize job");
    }

    if (
      !this.#singleFlight.has(job.outputKey) &&
      this.#singleFlight.size >= MAX_DISTINCT_JOBS_PER_SHARD
    ) {
      return error("transform queue is full", 429, { "retry-after": "1" });
    }

    const promise = this.#singleFlight.run(
      job.outputKey,
      () => this.resize(job),
      (result) => result.persistence,
    );
    try {
      const result = await promise;
      const headers = new Headers({
        "content-type": "image/webp",
        "content-length": String(result.body.byteLength),
        etag: result.etag,
        "x-imgt-max-age": String(result.maxAge),
        "x-imgt-cache": result.cacheStatus,
      });
      if (result.serverTiming) headers.set("server-timing", result.serverTiming);
      return new Response(result.body, { headers });
    } catch (cause) {
      if (cause instanceof ResizeError) {
        return error(
          cause.message,
          cause.status,
          cause.retryAfter ? { "retry-after": cause.retryAfter } : undefined,
        );
      }
      return error(cause instanceof Error ? cause.message : "image transformation failed", 500);
    }
  }

  private isResizeJob(value: unknown): value is ResizeJob {
    if (!value || typeof value !== "object") return false;
    const job = value as Partial<ResizeJob>;
    if (
      typeof job.outputKey !== "string" ||
      !job.outputKey.startsWith(withPrefix(DERIVATIVE_PREFIX, "")) ||
      typeof job.sourceUrl !== "string" ||
      typeof job.width !== "number" ||
      !ALLOWED_WIDTHS.has(job.width) ||
      typeof job.quality !== "number" ||
      !ALLOWED_QUALITIES.has(job.quality)
    ) {
      return false;
    }

    try {
      return normalizeSourceUrl(job.sourceUrl) === job.sourceUrl;
    } catch {
      return false;
    }
  }

  private async fetchSource(sourceUrl: string, signal: AbortSignal): Promise<Response> {
    let currentUrl = sourceUrl;
    for (let redirects = 0; redirects <= MAX_SOURCE_REDIRECTS; redirects += 1) {
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          redirect: "manual",
          signal,
          headers: { accept: "image/avif,image/webp,image/png,image/jpeg" },
        });
      } catch {
        if (signal.aborted) throw new ResizeError("source image timed out", 504);
        throw new ResizeError("failed to fetch source image", 502);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new ResizeError("source redirect has no location", 502);
        if (redirects === MAX_SOURCE_REDIRECTS) {
          throw new ResizeError("source redirected too many times", 502);
        }
        try {
          currentUrl = normalizeSourceUrl(new URL(location, currentUrl).toString());
        } catch {
          throw new ResizeError("source redirect target is not allowed", 502);
        }
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new ResizeError(
          `source image returned HTTP ${response.status}`,
          response.status === 404 ? 404 : 502,
        );
      }
      return response;
    }
    throw new ResizeError("source redirected too many times", 502);
  }

  private async resize(job: ResizeJob): Promise<ResizeResult> {
    const jobStarted = performance.now();
    const r2Started = performance.now();
    const stored = await this.env.DERIVATIVES.get(job.outputKey);
    const r2Ms = performance.now() - r2Started;
    const storedMaxAge = stored ? remainingMaxAge(stored.uploaded, stored.customMetadata) : 0;
    if (stored && storedMaxAge > 0) {
      return {
        body: await stored.arrayBuffer(),
        etag: derivativeEtag(job.outputKey),
        maxAge: storedMaxAge,
        cacheStatus: "R2",
      };
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), TRANSFORM_TIMEOUT_MS);
    try {
      const originStarted = performance.now();
      const source = await this.fetchSource(job.sourceUrl, abortController.signal);
      const originHeadersMs = performance.now() - originStarted;
      const contentLengthHeader = source.headers.get("content-length");
      const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
      if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
        await source.body?.cancel();
        throw new ResizeError("source image is too large", 413);
      }
      const sourceType = source.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (sourceType && !ALLOWED_SOURCE_TYPES.has(sourceType)) {
        await source.body?.cancel();
        throw new ResizeError("unsupported source image type", 415);
      }
      if (!source.body) throw new ResizeError("source image has an empty body", 502);
      const maxAge = effectiveMaxAge(source.headers.get("cache-control"));

      const containerStarted = performance.now();
      const transform = await this.containerFetch(
        new Request(
          `http://container/transform?w=${job.width}&q=${job.quality}`,
          { method: "POST", body: source.body, signal: abortController.signal },
        ),
      );
      if (abortController.signal.aborted) throw new ResizeError("image transformation timed out", 504);
      if (!transform.ok) {
        throw new ResizeError(
          (await transform.text()) || "image transformation failed",
          transform.status,
          transform.headers.get("retry-after") ?? undefined,
        );
      }

      const body = await transform.arrayBuffer();
      const containerMs = performance.now() - containerStarted;
      clearTimeout(timeout);
      const persistence = this.env.DERIVATIVES
        .put(job.outputKey, body, {
          httpMetadata: { contentType: "image/webp", cacheControl: cacheControl(maxAge) },
          customMetadata: maxAgeMetadata(maxAge),
        })
        .then(() => undefined)
        .catch((cause) => {
          console.error("failed to persist transformed image", cause);
        });
      const serverTiming = [
        `do_r2;dur=${r2Ms.toFixed(1)}`,
        `origin_headers;dur=${originHeadersMs.toFixed(1)}`,
        transform.headers.get("server-timing"),
        `container;dur=${containerMs.toFixed(1)}`,
        `job;dur=${(performance.now() - jobStarted).toFixed(1)}`,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        body,
        etag: derivativeEtag(job.outputKey),
        maxAge,
        cacheStatus: "MISS",
        serverTiming,
        persistence,
      };
    } catch (cause) {
      if (abortController.signal.aborted) throw new ResizeError("image transformation timed out", 504);
      throw cause;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function error(message: string, status = 400, additionalHeaders?: HeadersInit): Response {
  const headers = new Headers(additionalHeaders);
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(message, { status, headers });
}

function derivativeEtag(outputKey: string): string {
  return `"${outputKey.split("/").at(-1)?.replace(".webp", "")}"`;
}

function imageResponse(
  body: BodyInit | null,
  etag: string,
  cacheStatus: "R2" | "MISS" | "STALE",
  maxAge: number,
  serverTiming?: string,
): Response {
  const headers = new Headers({
    "content-type": `image/${OUTPUT_FORMAT}`,
    "cache-control": cacheControl(maxAge),
    etag,
    "x-imgt-cache": cacheStatus,
  });
  if (serverTiming) headers.set("server-timing", serverTiming);
  return new Response(body, { headers });
}

function resizeJob(outputKey: string, options: ReturnType<typeof parseImageOptions>): ResizeJob {
  return {
    outputKey,
    sourceUrl: options.sourceUrl,
    width: options.width,
    quality: options.quality,
  };
}

async function requestResize(job: ResizeJob, env: Env): Promise<Response> {
  const containerName = containerNameForKey(job.outputKey, config.containers.shards);
  const container = getContainer(env.IMGT_TRANSFORMER, containerName);
  return container.fetch(
    new Request("http://container/job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
    }),
  );
}

async function responseFromResize(jobResponse: Response, outputKey: string): Promise<Response> {
  if (!jobResponse.ok) {
    const message = await jobResponse.text();
    const retryAfter = jobResponse.headers.get("retry-after");
    return error(
      message || "image transformation failed",
      jobResponse.status,
      retryAfter ? { "retry-after": retryAfter } : undefined,
    );
  }

  const etag = jobResponse.headers.get("etag") ?? derivativeEtag(outputKey);
  const maxAge = Number(jobResponse.headers.get("x-imgt-max-age"));
  if (!Number.isSafeInteger(maxAge) || maxAge < 1) return error("invalid transformation cache metadata", 500);
  const cacheStatus = jobResponse.headers.get("x-imgt-cache") === "R2" ? "R2" : "MISS";
  return imageResponse(
    jobResponse.body,
    etag,
    cacheStatus,
    maxAge,
    jobResponse.headers.get("server-timing") ?? undefined,
  );
}

async function refreshDerivative(job: ResizeJob, env: Env): Promise<void> {
  const response = await responseFromResize(await requestResize(job, env), job.outputKey);
  if (!response.ok) {
    console.error(`background image refresh failed: ${response.status} ${await response.text()}`);
    return;
  }
  await response.body?.cancel();
}

async function handleImage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let options;
  try {
    options = parseImageOptions(new URL(request.url));
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "invalid image options");
  }

  const outputKey = await derivativeKey(DERIVATIVE_PREFIX, options);
  const job = resizeJob(outputKey, options);
  const stored = await env.DERIVATIVES.get(outputKey);
  if (stored) {
    const maxAge = remainingMaxAge(stored.uploaded, stored.customMetadata);
    if (maxAge === 0) {
      const response = imageResponse(
        stored.body,
        derivativeEtag(outputKey),
        "STALE",
        STALE_CACHE_TTL_SECONDS,
      );
      ctx.waitUntil(
        refreshDerivative(job, env).catch((cause) =>
          console.error("background image refresh failed", cause),
        ),
      );
      return response;
    }

    return imageResponse(stored.body, derivativeEtag(outputKey), "R2", maxAge);
  }

  return responseFromResize(await requestResize(job, env), outputKey);
}

export class ImgtImageCache extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/image") {
      return Promise.resolve(error("not found", 404));
    }
    return handleImage(request, this.env, this.ctx);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method !== "GET" || url.pathname !== "/image") {
      return error("not found", 404);
    }

    let options;
    try {
      options = parseImageOptions(url);
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : "invalid image options");
    }

    const imageCache = (ctx.exports as unknown as { ImgtImageCache: Fetcher }).ImgtImageCache;
    const response = await imageCache.fetch(canonicalCacheRequest(request, options));
    if (!CDN_CACHE_HIT_STATUSES.has(response.headers.get("cf-cache-status") ?? "")) {
      return response;
    }

    const cached = new Response(response.body, response);
    cached.headers.set("x-imgt-cache", "EDGE");
    cached.headers.delete("server-timing");
    return cached;
  },
} satisfies ExportedHandler<Env>;
