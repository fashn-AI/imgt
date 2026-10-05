# Configuration

Configure production source hosts in Cloudflare and keep application and resource
settings in your repository.

| Location                | What belongs here                                                                 |
| ----------------------- | --------------------------------------------------------------------------------- |
| Cloudflare dashboard    | Production `ALLOWED_HOSTS` text variable.                                         |
| `.env`                  | Local source hosts; copy `.env.example` to get started.                           |
| `wrangler.jsonc`        | Worker/container/bucket names, Cloudflare bindings, rate limiter and `keep_vars`. |
| `imgt.config.ts`        | Encoding defaults, shard count, idle time and cache lifetimes.                   |
| `src/` and `container/` | Fixed resource and safety limits; these are implementation constraints.           |

## Allowed source hosts

The `ALLOWED_HOSTS` Worker environment variable lists the hosts of the
**original images** imgt fetches.
For `https://cdn.example.com/photo.jpg`, allow `cdn.example.com`. Your frontend
domain belongs here only if it serves the originals. The Worker hostname does
not need to be listed just because it serves optimized images. This setting
does not restrict which websites can display the results.

In Cloudflare **Workers & Pages → your Worker → Settings → Variables and
Secrets**, add or edit a **Text** variable named `ALLOWED_HOSTS`. Set its value
to comma-separated domains such as
`images.unsplash.com,cdn.example.com,*.images.example.com`, then select **Deploy**.
See [Cloudflare's dashboard instructions](https://developers.cloudflare.com/workers/configuration/environment-variables/#add-environment-variables-via-the-dashboard).

After saving the variable, run a production build through your connected GitHub
repository before testing images. Dashboard variable deployments can omit native
Container image metadata; the GitHub deployment restores it while keeping the
saved value. See [deployment setup](deployment.md#github-integration).

For local development, run `cp .env.example .env` and edit `.env`:

```bash
ALLOWED_HOSTS="images.unsplash.com,cdn.example.com,*.images.example.com"
```

`.env` is local-only and is not uploaded to production.
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

The checked-in `keep_vars: true` preserves dashboard variables across code
deployments. `ALLOWED_HOSTS` is intentionally absent from Wrangler's `vars`.
If you choose to manage it in Git, add `vars.ALLOWED_HOSTS` to `wrangler.jsonc`;
that explicit value overrides the dashboard's value even with `keep_vars` enabled.
See [Cloudflare's variable persistence behavior](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth).
After changing source hosts, [verify an image](deployment.md#updates) from each
intended host. A new installation denies all sources until the variable is set.

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
| `transforms.defaultQuality` | 77; must be an integer from 1 to 100.                                                                         |
| `transforms.webpEffort`     | 2; accepted range 0–6.                                                                                        |
| `containers.shards`         | 2; supported range 1–4.                                                                                       |
| `containers.idleTimeoutMs`  | 120,000 milliseconds (2 minutes); compute stops after foreground requests and background refreshes finish and the idle interval passes. |
| `cache.minFreshSeconds`     | 14,400 seconds (4 hours).                                                                                     |
| `cache.maxStaleSeconds`     | 86,400 seconds (24 hours).                                                                                    |

Freshness follows source `s-maxage` or `max-age`, with the configured minimum;
upstream `Age` is subtracted. The stale interval starts after freshness expires.
R2 object expiration uses separate [storage cleanup](deployment.md#storage-cleanup).
Idle time must be a positive integer number of milliseconds, up to 21,600,000
(6 hours). Requests accept integer widths from 1 to 3840 pixels and integer
qualities from 1 to 100. Each width and quality combination creates a separate
cached derivative.

Review `RENDERER_VERSION` in `container/renderer.ts` whenever output pixels or
encoding defaults change. Changing WebP effort requires a version bump so
running containers cannot write old encoder output under new keys. Changing
shards alters routing during rollout; see [capacity and rollout](deployment.md#capacity).

## Fixed limits

These limits keep the service bounded; they are not additional deployment knobs:

- JPEG, PNG, WebP and AVIF inputs; WebP output; 25 MiB and 50 megapixels per input.
- Output width up to 3840 pixels; smaller sources are not enlarged.
- Three source redirects and a 1,024-character source URL.
- A 20-second deadline for fetch, startup, upload, queueing and encoding.
- Four distinct admitted jobs per shard, with one active encoder per container.

Sharp/libvips concurrency is fixed at one.

`CONTAINER_RESOURCES` in `src/native-container.ts` allocates 1 vCPU, 3 GiB RAM
and 2,000 MB disk per shard. The smaller `basic` and `lite` profiles did not pass
the large-image workload; keep this allocation unless you validate a replacement.
See [performance decisions](performance.md) and [deployment costs](deployment.md#costs).
