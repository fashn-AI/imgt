import { sourceMaxAge } from "./cache";
import { MAX_SOURCE_BYTES, MAX_SOURCE_REDIRECTS } from "./constants";
import { ImageError } from "./http";
import { normalizeSourceUrl } from "./options";

const ALLOWED_SOURCE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
export type SourceFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function fetchSource(
  sourceUrl: string,
  signal: AbortSignal,
  fetcher: SourceFetch = fetch,
): Promise<{ body: ReadableStream<Uint8Array>; maxAge: number }> {
  let currentUrl = normalizeSourceUrl(sourceUrl);
  for (let redirects = 0; redirects <= MAX_SOURCE_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      response = await fetcher(currentUrl, {
        redirect: "manual", signal,
        headers: { accept: "image/avif,image/webp,image/png,image/jpeg" },
      });
    } catch {
      throw new ImageError(signal.aborted ? "source image timed out" : "failed to fetch source image", signal.aborted ? 504 : 502);
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new ImageError("source redirect has no location", 502);
        if (redirects === MAX_SOURCE_REDIRECTS) throw new ImageError("source redirected too many times", 502);
        try {
          currentUrl = normalizeSourceUrl(new URL(location, currentUrl).toString());
        } catch {
          throw new ImageError("source redirect target is not allowed", 502);
        }
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        const status = [403, 404, 410].includes(response.status) ? response.status : 502;
        throw new ImageError(`source image returned HTTP ${response.status}`, status);
      }
      // This deployment serves public images, not private assets.
      const maxAge = sourceMaxAge(response.headers.get("cache-control"), Number(response.headers.get("age")));
      if (maxAge === null) throw new ImageError("source image does not allow public caching", 403);
      if (Number(response.headers.get("content-length")) > MAX_SOURCE_BYTES) throw new ImageError("source image is too large", 413);
      const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (type && !ALLOWED_SOURCE_TYPES.has(type)) throw new ImageError("unsupported source image type", 415);
      if (!response.body) throw new ImageError("source image has an empty body", 502);
      return { body: response.body, maxAge };
    } catch (cause) {
      await response.body?.cancel();
      throw cause;
    }
  }
  throw new ImageError("source redirected too many times", 502);
}
