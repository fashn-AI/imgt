// Deployment-specific settings come from Wrangler vars, not application code.
export function parseAllowedHosts(value: string | undefined): readonly string[] {
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
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain)
      );
    })
  )
    throw new Error(
      "ALLOWED_HOSTS must contain DNS hostnames such as cdn.example.com or *.images.example.com",
    );
  return hosts;
}
