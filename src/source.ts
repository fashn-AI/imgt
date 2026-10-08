import { sourceMaxAge } from "./cache";
import { MAX_SOURCE_BYTES, MAX_SOURCE_REDIRECTS } from "./constants";
import { ImageError } from "./http";
import { normalizeSourceUrl } from "./options";

const ALLOWED_SOURCE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);
export type SourceFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SourceValidator {
  etag: string;
  cacheControl: string | null;
}

// Keep R2 metadata small and use strong validators for exact source identity.
export function parseSourceValidator(
  etag: string | null,
  cacheControl: string | null,
): SourceValidator | undefined {
  if (
    etag &&
    new TextEncoder().encode(etag).byteLength <= 512 &&
    /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag) &&
    (cacheControl === null ||
      new TextEncoder().encode(cacheControl).byteLength <= 512)
  )
    return { etag, cacheControl };
}

// Retry only the origin GET, before its body is uploaded. Share the job's
// deadline and retry budget across redirects; never replay container work.
async function requestSource(
  url: string,
  signal: AbortSignal,
  fetcher: SourceFetch,
  retry: { available: boolean },
  validator?: SourceValidator,
): Promise<Response> {
  for (;;) {
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await fetcher(url, {
        redirect: "manual",
        signal,
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg",
          ...(validator ? { "if-none-match": validator.etag } : {}),
        },
      });
    } catch (cause) {
      if (!retry.available || signal.aborted) throw cause;
    }
    if (
      response &&
      (!retry.available ||
        ![500, 502, 503, 504].includes(response.status) ||
        response.headers.has("retry-after"))
    ) {
      return response;
    }
    retry.available = false;
    await response?.body?.cancel();
    console.warn(
      JSON.stringify({ event: "source_retry", status: response?.status }),
    );
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const canceled = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", canceled);
        resolve();
      }, 100);
      signal.addEventListener("abort", canceled, { once: true });
    });
  }
}

export async function fetchSource(
  sourceUrl: string,
  signal: AbortSignal,
  allowedHosts: readonly string[],
  fetcher: SourceFetch = fetch,
  validator?: SourceValidator,
): Promise<{
  body: ReadableStream<Uint8Array> | null;
  maxAge: number;
  validator?: SourceValidator;
}> {
  let currentUrl = normalizeSourceUrl(sourceUrl, allowedHosts);
  const retry = { available: true };
  for (let redirects = 0; redirects <= MAX_SOURCE_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      response = await requestSource(
        currentUrl,
        signal,
        fetcher,
        retry,
        redirects === 0 ? validator : undefined,
      );
    } catch {
      throw new ImageError(
        signal.aborted
          ? "source image timed out"
          : "failed to fetch source image",
        signal.aborted ? 504 : 502,
      );
    }
    try {
      if (response.status === 304) {
        if (!validator || redirects !== 0)
          throw new ImageError("source returned an unexpected HTTP 304", 502);
        const cacheControl =
          response.headers.get("cache-control") ?? validator.cacheControl;
        const maxAge = sourceMaxAge(
          cacheControl,
          Number(response.headers.get("age")),
        );
        if (maxAge === null)
          throw new ImageError(
            "source image does not allow public caching",
            403,
          );
        await response.body?.cancel();
        return {
          body: null,
          maxAge,
          validator: parseSourceValidator(
            response.headers.get("etag") ?? validator.etag,
            cacheControl,
          ),
        };
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location)
          throw new ImageError("source redirect has no location", 502);
        if (redirects === MAX_SOURCE_REDIRECTS)
          throw new ImageError("source redirected too many times", 502);
        try {
          currentUrl = normalizeSourceUrl(
            new URL(location, currentUrl).toString(),
            allowedHosts,
          );
        } catch {
          throw new ImageError("source redirect target is not allowed", 502);
        }
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        const status = [403, 404, 410].includes(response.status)
          ? response.status
          : 502;
        throw new ImageError(
          `source image returned HTTP ${response.status}`,
          status,
        );
      }
      // This deployment serves public images, not private assets.
      const maxAge = sourceMaxAge(
        response.headers.get("cache-control"),
        Number(response.headers.get("age")),
      );
      if (maxAge === null)
        throw new ImageError("source image does not allow public caching", 403);
      const sourceBytes = Number(response.headers.get("content-length"));
      if (sourceBytes > MAX_SOURCE_BYTES) {
        console.warn(
          JSON.stringify({
            event: "source_too_large",
            sourceBytes,
            maxSourceBytes: MAX_SOURCE_BYTES,
          }),
        );
        throw new ImageError(
          `source image exceeds the ${MAX_SOURCE_BYTES}-byte limit`,
          413,
        );
      }
      const type = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (type && !ALLOWED_SOURCE_TYPES.has(type))
        throw new ImageError("unsupported source image type", 415);
      if (!response.body)
        throw new ImageError("source image has an empty body", 502);
      return {
        body: response.body,
        maxAge,
        // Redirect targets can change independently of their ETag. Revalidate
        // direct sources only; redirects retain the unconditional path.
        validator:
          redirects === 0
            ? parseSourceValidator(
                response.headers.get("etag"),
                response.headers.get("cache-control"),
              )
            : undefined,
      };
    } catch (cause) {
      await response.body?.cancel();
      throw cause;
    }
  }
  throw new ImageError("source redirected too many times", 502);
}
