import { config } from "../imgt.config";
import { MAX_SOURCE_URL_LENGTH, OUTPUT_FORMAT } from "./constants";

export const ALLOWED_WIDTHS = new Set<number>(config.transforms.widths);
export const ALLOWED_QUALITIES = new Set<number>(config.transforms.qualities);

if (!ALLOWED_QUALITIES.has(config.transforms.defaultQuality)) {
  throw new Error("defaultQuality must be included in transforms.qualities");
}
if (!Number.isInteger(config.transforms.webpEffort) || config.transforms.webpEffort < 0 || config.transforms.webpEffort > 6) {
  throw new Error("webpEffort must be an integer from 0 to 6");
}

export interface ImageOptions {
  sourceUrl: string;
  width: number;
  quality: number;
}

function hostMatches(hostname: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === normalized;
}

export function normalizeSourceUrl(
  rawSource: string,
  allowedHosts: readonly string[] = config.sources.allowedHosts,
): string {
  if (rawSource.length > MAX_SOURCE_URL_LENGTH) throw new Error("source URL is too long");

  let source: URL;
  try {
    source = new URL(rawSource);
  } catch {
    throw new Error("url must be an absolute HTTPS URL");
  }
  if (source.protocol !== "https:") throw new Error("url must use HTTPS");
  if (source.username || source.password) throw new Error("url must not include credentials");
  if (source.port) throw new Error("url must use the default HTTPS port");
  if (!allowedHosts.some((pattern) => hostMatches(source.hostname, pattern))) {
    throw new Error(`source host is not allowed: ${source.hostname}`);
  }

  source.hash = "";
  return source.toString();
}

export function parseImageOptions(
  url: URL,
  allowedHosts: readonly string[] = config.sources.allowedHosts,
): ImageOptions {
  const rawSource = url.searchParams.get("url");
  if (!rawSource) throw new Error("url is required");
  const sourceUrl = normalizeSourceUrl(rawSource, allowedHosts);

  const width = Number(url.searchParams.get("w"));
  if (!Number.isInteger(width) || !ALLOWED_WIDTHS.has(width)) {
    throw new Error(`w must be one of: ${[...ALLOWED_WIDTHS].join(", ")}`);
  }

  const qualityValue = url.searchParams.get("q");
  const quality = qualityValue === null ? config.transforms.defaultQuality : Number(qualityValue);
  if (!Number.isInteger(quality) || !ALLOWED_QUALITIES.has(quality)) {
    throw new Error(`q must be one of: ${[...ALLOWED_QUALITIES].join(", ")}`);
  }

  return { sourceUrl, width, quality };
}

export function withPrefix(prefix: string, key: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  return normalized ? `${normalized}/${key}` : key;
}

export async function derivativeKey(prefix: string, options: ImageOptions): Promise<string> {
  const identity = [
    options.sourceUrl,
    options.width,
    options.quality,
    OUTPUT_FORMAT,
    config.transforms.webpEffort,
  ].join("\0");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return withPrefix(prefix, `${hex.slice(0, 2)}/${hex}.${OUTPUT_FORMAT}`);
}

export function canonicalCacheRequest(request: Request, options: ImageOptions): Request {
  const url = new URL(request.url);
  url.pathname = "/image";
  url.search = new URLSearchParams({
    url: options.sourceUrl,
    w: String(options.width),
    q: String(options.quality),
    e: String(config.transforms.webpEffort),
  }).toString();
  return new Request(url, { method: "GET" });
}
