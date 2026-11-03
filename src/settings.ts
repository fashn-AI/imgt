// Deployment-specific settings come from Wrangler vars, not application code.

// Cloudflare Durable Object regions; see the locationHint documentation.
export const LOCATION_HINTS = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
] as const;
export type LocationHint = (typeof LOCATION_HINTS)[number];

// Unset lets Cloudflare place containers near their first request.
export function parseLocationHint(
  value: string | undefined,
): LocationHint | undefined {
  const hint = value?.trim().toLowerCase();
  if (!hint) return undefined;
  if (!(LOCATION_HINTS as readonly string[]).includes(hint))
    throw new Error(
      `CONTAINER_LOCATION_HINT must be one of ${LOCATION_HINTS.join(", ")}`,
    );
  return hint as LocationHint;
}
export function parseAllowedHosts(
  value: string | undefined,
): readonly string[] {
  const hosts = [
    ...new Set(
      (value ?? "")
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((host) => host.toLowerCase()),
    ),
  ];
  if (
    hosts.length > 100 ||
    hosts.some((host) => {
      const domain = host.replace(/^\*\./, "");
      return (
        domain.length > 253 ||
        /^\d+(\.\d+){3}$/.test(domain) ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
          domain,
        )
      );
    })
  )
    throw new Error(
      "ALLOWED_HOSTS must contain DNS hostnames such as cdn.example.com or *.images.example.com",
    );
  return hosts;
}
