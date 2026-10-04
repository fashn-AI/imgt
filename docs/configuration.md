# Configuration

Keep configuration in your repository so every deployment uses the same settings.

| File                    | What belongs here                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `wrangler.jsonc`        | Source hosts, Worker/container/bucket names, Cloudflare bindings and rate limiter.           |
| `imgt.config.ts`        | Allowed widths and qualities, encoding defaults, shard count, idle time and cache lifetimes. |
| `src/` and `container/` | Fixed resource and safety limits; these are implementation constraints.                      |

## Allowed source hosts

`vars.ALLOWED_HOSTS` lists the hosts of the **original images** imgt fetches.
For `https://cdn.example.com/photo.jpg`, allow `cdn.example.com`. Your frontend
domain belongs here only if it serves the originals. The Worker hostname does
not need to be listed just because it serves optimized images. This setting
does not restrict which websites can display the results.

Merge this `vars` object into `wrangler.jsonc`, keeping the rest of the file:

```json
{
  "vars": {
    "ALLOWED_HOSTS": "images.unsplash.com,cdn.example.com,*.images.example.com"
  }
}
```

Keep `images.unsplash.com` to use the demo and default smoke image. Replace the
other examples with your own source domains, separated by commas.

| Entry                                     | Matches                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `cdn.example.com`                         | That exact host only.                                                                                        |
| `*.images.example.com`                    | `shop.images.example.com`, `a.shop.images.example.com`, and other subdomains; excludes `images.example.com`. |
| `images.example.com,*.images.example.com` | The parent host and all its subdomains.                                                                      |

An empty or missing value denies all sources. The list accepts up to 100 unique
host patterns; a malformed entry rejects the whole list with a configuration
error. Entries are case-insensitive DNS hostnames; do not include schemes,
paths, ports, IP addresses or a bare `*`. Source URLs
must be public HTTPS URLs without embedded credentials or custom ports. imgt
does not forward a visitor's cookies or authorization headers. Each redirect
destination must also match the allowlist. `private` and `no-store` sources are
rejected; see [cache policy](architecture.md#cache-policy).

Commit your changes and push to the configured production branch (`main` by
default). Workers Builds runs the checks and deploys automatically. Dashboard-only
variable edits can be overwritten by later deployments. After the build finishes,
[verify an image](deployment.md#updates) from each intended source host.

## Deployment settings

Resource names in `wrangler.jsonc` belong to your Cloudflare installation. A
second installation in the same account needs distinct Worker, container and
bucket names and a separate rate-limit namespace ID; see [deployment names](deployment.md#deployment-names).
Keep the binding names `DERIVATIVES`, `IMGT_NATIVE_TRANSFORMER` and
`IMAGE_RATE_LIMITER`, Durable Object class names and migration history intact.
Preserve existing resource names when upgrading an installation.

## Application defaults

Edit `imgt.config.ts` to change these settings:

| Setting                     | Default                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `transforms.widths`         | 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840 pixels.                            |
| `transforms.qualities`      | 60, 75, 77, 85.                                                                                               |
| `transforms.defaultQuality` | 77; must be one of the allowed qualities.                                                                     |
| `transforms.webpEffort`     | 2; accepted range 0–6.                                                                                        |
| `containers.shards`         | 2; supported range 1–4.                                                                                       |
| `containers.sleepAfter`     | `"2m"`; compute stops after foreground requests and background refreshes finish and the idle interval passes. |
| `cache.minFreshSeconds`     | 14,400 seconds (4 hours).                                                                                     |
| `cache.maxStaleSeconds`     | 86,400 seconds (24 hours).                                                                                    |

Freshness follows source `s-maxage` or `max-age`, with the configured minimum;
upstream `Age` is subtracted. The stale interval starts after freshness expires.
R2 object expiration uses separate [storage cleanup](deployment.md#storage-cleanup).
Idle time accepts a positive integer with an `ms`, `s`, `m` or `h` suffix, up to
six hours. Keep widths and qualities aligned with your [Next.js configuration](nextjs.md)
if you customize them.

Review `RENDERER_VERSION` in `container/renderer.ts` whenever output pixels or
encoding defaults change. Changing WebP effort requires a version bump so
running containers cannot write old encoder output under new keys. Changing
shards alters routing during rollout; see [capacity and rollout](deployment.md#capacity).

## Fixed limits

These limits keep the service bounded; they are not additional deployment knobs:

- JPEG, PNG, WebP and AVIF inputs; WebP output; 25 MiB and 50 megapixels per input.
- Three source redirects and a 1,024-character source URL.
- A 20-second deadline for fetch, startup, upload, queueing and encoding.
- Four distinct admitted jobs per shard, with one active encoder per container.

`CONTAINER_RESOURCES` in `src/native-container.ts` allocates 1 vCPU, 3 GiB RAM
and 2,000 MB disk per shard. The smaller `basic` and `lite` profiles did not pass
the large-image workload; keep this allocation unless you validate a replacement.
See [performance decisions](performance.md) and [deployment costs](deployment.md#costs).
