# Configuration

Configure production source hosts in Cloudflare and keep application and resource
settings in your repository.

| Location                | What belongs here                                                                 |
| ----------------------- | --------------------------------------------------------------------------------- |
| Cloudflare dashboard    | Production `ALLOWED_HOSTS` and optional `CONTAINER_LOCATION_HINT` text variables, and the R2 lifecycle cleanup rule. |
| `.env`                  | Local source hosts; copy `.env.example` to get started.                           |
| `wrangler.jsonc`        | Worker/container/bucket names, Cloudflare bindings, rate limiter and `keep_vars`. |
| `imgt.config.ts`        | Encoding defaults, source-file size limit, container sizes, idle times and cache lifetimes. |
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

The default R2 bucket is `imgt`, bound as `DERIVATIVES`. Complete production
setup by adding an enabled lifecycle rule that deletes the `derivatives/`
prefix after 30 days; deployment does not create this rule. Keep the bucket
private and use Standard storage. See the [storage cleanup steps](deployment.md#storage-cleanup).

## Application defaults

Edit `imgt.config.ts` to change these settings:

| Setting                     | Default                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `transforms.defaultQuality` | 77; must be an integer from 1 to 100.                                                                         |
| `transforms.maxSourceBytes` | 104,857,600 bytes (100 MiB); must be a positive safe integer. |
| `transforms.webpEffort`     | 4; accepted range 0–6.                                                                                        |
| `containers.primary`        | `{ vcpu: 1, idleTimeoutMs: 120000 }`; the container every transform tries first.                                                                                           |
| `containers.overflow`       | `{ vcpu: 3, idleTimeoutMs: 30000, wakeAtQueuedJobs: 4 }`; started when that many jobs wait for the primary, or `null` to disable.                                          |
| `cache.minFreshSeconds`     | 14,400 seconds (4 hours).                                                                                     |
| `cache.maxStaleSeconds`     | 86,400 seconds (24 hours).                                                                                    |

Freshness follows source `s-maxage` or `max-age`, with the configured minimum;
upstream `Age` is subtracted. The stale interval starts after freshness expires.
Direct origins with strong ETags use conditional refreshes: unchanged originals
renew the existing derivative without container work. Changed sources, redirects
and sources without strong validators follow the regular transform path.
R2 object expiration uses separate [storage cleanup](deployment.md#storage-cleanup).
Each container's `vcpu` is an integer from 1 to 4, allocated with 3 GiB RAM
per vCPU. Its idle time must be a positive integer number of milliseconds, up
to 21,600,000 (6 hours); compute stops after foreground requests and background
refreshes finish and the idle interval passes. Requests accept integer widths from 1 to 3840 pixels and integer
qualities from 1 to 100. Each width and quality combination creates a separate
cached derivative.

Review `RENDERER_VERSION` in `container/renderer.ts` whenever output pixels or
encoding defaults change. WebP effort is part of the R2 and Workers Cache keys,
so changing it re-encodes every cached image once. Changing a container's
`vcpu` starts a fresh container for that role at the new size; cached images
stay valid. See [capacity and rollout](deployment.md#capacity).

## Container sizes

Memory is most of the container bill. Cloudflare bills 3 GiB per vCPU for every
second a container is awake, busy or not; CPU is billed only while it is used.
The primary's size is therefore the main fixed cost whenever traffic keeps it
awake, and the overflow costs money only while it is running.

At WebP effort 4 an image takes roughly 110 ms of CPU, so each vCPU sustains
about eight cache misses per second. Cache hits from Workers Cache or R2 do not
use a container.

1. Start with the defaults: a 1-vCPU primary and a 3-vCPU overflow. For low
   traffic without bursts, `overflow: null` is enough.
2. After a few days, check the `overflow_wake` and `overflow_ready` logs and
   each container's awake time in the Cloudflare Containers dashboard.
3. Adjust:
   - The overflow is awake most of the day: steady traffic outgrows the
     primary. Raise `primary.vcpu`.
   - Bursts are slow, or return `429` or `504`: raise `overflow.vcpu` or
     lower `wakeAtQueuedJobs`.
   - The overflow rarely wakes: `overflow: null` removes it.

If one container is awake all day anyway, a single larger primary with
`overflow: null` is simpler. Two tiers cost less when bursts are short and
rare. The largest setup is a 4-vCPU primary plus a 4-vCPU overflow; one
coordinator Durable Object handles every cache miss. See the
[November 2026 replay](performance.md#primary-and-overflow-containers-november-2026)
for measured latency and cost.

## Container location

Containers start near the request that first creates them unless you give a
location hint. Set the optional **Text** variable `CONTAINER_LOCATION_HINT` to
the Cloudflare region nearest your original images and R2 bucket: `wnam`,
`enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr` or `me`. Set it in the
same place as `ALLOWED_HOSTS`, then run a production build. An invalid value
fails image requests with a configuration error.

Changing the hint starts new containers in that region automatically; cached
images stay valid. Cloudflare treats the hint as a preference, not a guarantee.
See [Durable Object location hints](https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint).

## Source image size

`transforms.maxSourceBytes` limits the original file downloaded from your image
host, before resizing. A small requested width does not reduce that input size.
To change the limit, edit `imgt.config.ts` and push through your GitHub deployment:

```ts
maxSourceBytes: 100 * 1024 * 1024, // 100 MiB per original image
```

This is a repository setting, not a dashboard environment variable. The Worker
checks declared source sizes and the container checks actual uploaded bytes,
including chunked inputs without `Content-Length`. Exceeding the limit returns
HTTP `413` with `Cache-Control: no-store`; the browser may show a broken image.
Declared-size rejections log `source_too_large` with the source and configured
byte counts, without logging the source URL.

Changing this setting automatically routes misses to new containers with the
updated limit. Existing derivatives retain their cache keys. Buffered inputs share a
1 GiB budget per vCPU, or the source limit if larger, in addition to decoded
pixels and encoder memory; uploads beyond it fail fast with retryable `503`. Raise the limit only after checking capacity with your largest images.
The separate 50-megapixel limit and 60-second job deadline still apply.

## Fixed limits

These limits keep the service bounded; they are not additional deployment knobs:

- JPEG, PNG, WebP and AVIF inputs; WebP output; 50 megapixels per input.
- Output width up to 3840 pixels; smaller sources are not enlarged.
- Three source redirects and a 1,024-character source URL.
- A 60-second deadline per job attempt for admission, fetch, startup, upload, queueing and encoding.
- Up to 512 distinct jobs, with 96 active downloads/uploads/transforms and a 1 GiB-per-vCPU buffered-input budget.
- One active native encoder per vCPU; waiting jobs share the 60-second deadline.

libvips concurrency is fixed at one thread per image.
Read [request recovery behavior](architecture.md#slow-requests-and-errors) for
bounded source retries, Durable Object resets and errors.

Each container gets 3 GiB RAM per vCPU and 2,000 MB disk (`src/tiers.ts`).
The smaller `basic` and `lite` profiles did not pass the large-image workload;
keep at least 1 vCPU unless you validate a replacement.
See [performance decisions](performance.md) and [deployment costs](deployment.md#costs).
