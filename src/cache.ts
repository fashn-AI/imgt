import { config } from "../imgt.config";

for (const [name, value] of Object.entries(config.cache)) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`cache.${name} must be a nonnegative integer`);
}

// A null lifetime means the source forbids public storage. Zero permits
// transformation, but the result must be returned without caching.
export function sourceMaxAge(cacheControl: string | null, age = 0): number | null {
  const values = new Map<string, string>();
  for (const part of (cacheControl ?? "").split(",")) {
    const [name, value = ""] = part.trim().split("=", 2);
    if (name) values.set(name.trim().toLowerCase(), value.trim().replace(/^"|"$/g, ""));
  }
  if (values.has("private") || values.has("no-store")) return null;
  if (values.has("no-cache")) return 0;

  let originAge = 0;
  for (const name of ["s-maxage", "max-age"]) {
    const value = values.get(name);
    if (value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
      originAge = Number(value);
      break;
    }
  }
  const lifetime = Math.max(originAge, config.cache.minFreshSeconds);
  return Math.max(0, lifetime - (Number.isSafeInteger(age) && age > 0 ? age : 0));
}

export function remainingSeconds(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.floor((deadline - now) / 1000));
}

export function cacheControl(maxAge: number): string {
  return maxAge > 0 ? `public, max-age=${Math.floor(maxAge)}, must-revalidate` : "no-store";
}
