import { ImageError } from "./http";
import { config } from "../imgt.config";
import {
  DERIVATIVE_PREFIX,
  MAX_OUTPUT_WIDTH,
  MAX_SOURCE_URL_LENGTH,
  OUTPUT_FORMAT,
} from "./constants";

export function isValidWidth(width: number): boolean {
  return Number.isInteger(width) && width >= 1 && width <= MAX_OUTPUT_WIDTH;
}

export function isValidQuality(quality: number): boolean {
  return Number.isInteger(quality) && quality >= 1 && quality <= 100;
}

const { widths, qualities, defaultQuality } = config.transforms;
const ascending = (values: readonly number[]) =>
  values.length > 0 &&
  values.every((value, i) => i === 0 || value > values[i - 1]);
if (!ascending(widths) || !widths.every(isValidWidth)) {
  throw new Error(
    `widths must be ascending integers from 1 to ${MAX_OUTPUT_WIDTH}`,
  );
}
if (!ascending(qualities) || !qualities.every(isValidQuality)) {
  throw new Error("qualities must be ascending integers from 1 to 100");
}
if (!qualities.includes(defaultQuality)) {
  throw new Error("defaultQuality must be one of qualities");
}

// Rounds up to the next configured width, or the largest one.
export function snapWidth(width: number): number {
  return widths.find((allowed) => allowed >= width) ?? widths.at(-1)!;
}

// Picks the nearest configured quality; ties choose the higher quality.
export function snapQuality(quality: number): number {
  return qualities.reduce((best, allowed) =>
    Math.abs(allowed - quality) <= Math.abs(best - quality) ? allowed : best,
  );
}
if (
  !Number.isInteger(config.transforms.webpEffort) ||
  config.transforms.webpEffort < 0 ||
  config.transforms.webpEffort > 6
) {
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
  allowedHosts: readonly string[],
): string {
  if (rawSource.length > MAX_SOURCE_URL_LENGTH)
    throw new ImageError("source URL is too long", 400);

  let source: URL;
  try {
    source = new URL(rawSource);
  } catch {
    throw new ImageError("url must be an absolute HTTPS URL", 400);
  }
  if (source.protocol !== "https:")
    throw new ImageError("url must use HTTPS", 400);
  if (source.username || source.password)
    throw new ImageError("url must not include credentials", 400);
  if (source.port)
    throw new ImageError("url must use the default HTTPS port", 400);
  if (!allowedHosts.some((pattern) => hostMatches(source.hostname, pattern))) {
    throw new ImageError(`source host is not allowed: ${source.hostname}`, 400);
  }

  source.hash = "";
  return source.toString();
}

export function parseImageOptions(
  url: URL,
  allowedHosts: readonly string[],
): ImageOptions {
  const rawSource = url.searchParams.get("url");
  if (!rawSource) throw new ImageError("url is required", 400);
  const sourceUrl = normalizeSourceUrl(rawSource, allowedHosts);

  const width = Number(url.searchParams.get("w"));
  if (!isValidWidth(width)) {
    throw new ImageError(
      `w must be an integer from 1 to ${MAX_OUTPUT_WIDTH}`,
      400,
    );
  }

  const qualityValue = url.searchParams.get("q");
  const quality =
    qualityValue === null
      ? config.transforms.defaultQuality
      : Number(qualityValue);
  if (!isValidQuality(quality)) {
    throw new ImageError("q must be an integer from 1 to 100", 400);
  }

  return {
    sourceUrl,
    width: snapWidth(width),
    quality: snapQuality(quality),
  };
}

export function withPrefix(prefix: string, key: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  return normalized ? `${normalized}/${key}` : key;
}

export async function derivativeKey(
  prefix: string,
  options: ImageOptions,
): Promise<string> {
  const identity = [
    options.sourceUrl,
    options.width,
    options.quality,
    OUTPUT_FORMAT,
    config.transforms.webpEffort,
  ].join("\0");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return withPrefix(prefix, `${hex}.${OUTPUT_FORMAT}`);
}

export function canonicalCacheRequest(
  request: Request,
  options: ImageOptions,
): Request {
  const url = new URL(request.url);
  url.pathname = "/image";
  url.search = new URLSearchParams({
    url: options.sourceUrl,
    w: String(options.width),
    q: String(options.quality),
    e: String(config.transforms.webpEffort),
    v: DERIVATIVE_PREFIX,
  }).toString();
  return new Request(url, { method: "GET" });
}
