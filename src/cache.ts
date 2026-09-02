import { MIN_CACHE_TTL_SECONDS } from "./constants";

const MAX_AGE_METADATA = "maxAge";

export function originMaxAge(cacheControl: string | null): number {
  if (!cacheControl) return 0;

  const directives = new Map<string, string>();
  for (const part of cacheControl.split(",")) {
    const [rawName, rawValue] = part.trim().split("=", 2);
    if (rawName && rawValue) directives.set(rawName.toLowerCase(), rawValue.replace(/^"|"$/g, ""));
  }

  for (const name of ["s-maxage", "max-age"]) {
    const value = directives.get(name);
    if (!value || !/^\d+$/.test(value)) continue;
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds)) return seconds;
  }
  return 0;
}

export function effectiveMaxAge(cacheControl: string | null): number {
  return Math.max(originMaxAge(cacheControl), MIN_CACHE_TTL_SECONDS);
}

export function maxAgeMetadata(maxAge: number): Record<string, string> {
  return { [MAX_AGE_METADATA]: String(maxAge) };
}

export function remainingMaxAge(
  uploaded: Date,
  metadata: Record<string, string> | undefined,
  now = Date.now(),
): number {
  const value = metadata?.[MAX_AGE_METADATA];
  if (!value || !/^\d+$/.test(value)) return 0;
  const maxAge = Number(value);
  if (!Number.isSafeInteger(maxAge)) return 0;
  return Math.max(0, Math.ceil((uploaded.getTime() + maxAge * 1000 - now) / 1000));
}

export function cacheControl(maxAge: number): string {
  return `public, max-age=${Math.max(0, Math.floor(maxAge))}, must-revalidate`;
}
