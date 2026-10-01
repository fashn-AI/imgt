# imgt

Self-hosted image optimization on Cloudflare. Serve resized WebP images from
your own account using Sharp, Workers Cache, and a private R2 bucket.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/relferreira/imgt)

<!-- dash-content-start -->
Give imgt a public image URL and a width. It transforms the image once, stores
the derivative in R2, and serves subsequent requests through Workers Cache.
Works with Next.js custom loaders or any client that can request an image URL.
Original images are never stored. No Cloudflare Images subscription is needed.
<!-- dash-content-end -->

## Deploy to your Cloudflare account

You need a GitHub account, Cloudflare Workers Paid, and R2 enabled. Workers Paid
starts at $5/month; container, storage, and request usage can add charges.
See [costs and configuration](docs/deployment.md#costs).

1. Click **Deploy to Cloudflare** above. Select your account and create your own
   repository. Cloudflare provisions the R2 bucket and Durable Object, then
   builds the Worker and Docker image through Workers Builds.
2. Set `ALLOWED_HOSTS` to the domains that host your source images. The default
   `images.unsplash.com` enables the sample image. Configure it during setup if
   offered, or edit `vars.ALLOWED_HOSTS` in your new repository's
   `wrangler.jsonc` and push to `main`:

   ```json
   "vars": {
     "ALLOWED_HOSTS": "cdn.example.com,*.images.example.com"
   }
   ```

3. Open the deployed Worker URL to try the Unsplash demo. Choose a width and
   optimize the photo; run it again to see a cache hit. The demo requires
   `images.unsplash.com` in your allowlist. Allow several minutes for first-time
   container provisioning.
4. Add an R2 lifecycle rule to expire derivatives after 30 days; see
   [storage cleanup](docs/deployment.md#storage-cleanup).

Future pushes to your production branch deploy automatically through the
GitHub integration. Docker is only needed for local development or CLI deploys.
Each deploy runs typecheck and tests before uploading the Worker.

For multiple deployments in one account, choose distinct Worker, container,
bucket, and rate-limit namespace names. See [deployment names](docs/deployment.md#deployment-names).

## Use it

```text
https://imgt.YOUR-SUBDOMAIN.workers.dev/image?url=https%3A%2F%2Fcdn.example.com%2Fphoto.jpg&w=640&q=77
```

| Parameter | Meaning |
| --- | --- |
| `url` | Absolute HTTPS source URL on an allowed host. URL-encode it. |
| `w` | Width: 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840. |
| `q` | Quality: 60, 75, 77, or 85. Defaults to 77. |

Output is WebP, with orientation corrected and aspect ratio preserved. Small
sources are not enlarged. Supported inputs: JPEG, PNG, WebP, and AVIF, up to
25 MiB and 50 megapixels. Animated images are not preserved as animations.

An exact allowed host matches only itself. `*.example.com` matches subdomains,
not `example.com`. An empty `ALLOWED_HOSTS` denies all source images. Do not
include schemes, paths, ports, IP addresses, or a bare `*`.

## Next.js

Create `image-loader.js` with your deployed endpoint:

```js
'use client';

export default function imageLoader({ src, width, quality = 77 }) {
  const query = new URLSearchParams({ url: src, w: String(width), q: String(quality) });
  return `https://imgt.YOUR-SUBDOMAIN.workers.dev/image?${query}`;
}
```

Configure `next.config.js`:

```js
export default {
  images: {
    loader: 'custom',
    loaderFile: './image-loader.js',
    qualities: [60, 75, 77, 85],
  },
};
```

Use absolute source URLs with `<Image>`. The default imgt widths match the
standard Next.js sizes; keep them aligned if you customize either application.

## Verify a deployment

The homepage provides an interactive image demo. For image, cache, and ETag
verification, run this from a checkout with dependencies installed:

```bash
npm run smoke -- https://imgt.YOUR-SUBDOMAIN.workers.dev https://cdn.example.com/photo.jpg
```

This verifies a decodable WebP response, content hash/ETag, canonical edge cache
hit, and conditional `304`. The source must permit public caching. Add `--fresh`
to append a unique source query parameter and exercise a cache miss; only use
that option when the source accepts extra parameters (it can break signed URLs).
Omitting the source uses the Unsplash sample, which must still be allowed.

`/health` reports Worker availability and whether hosts are configured; it does
not start a container or prove the entire image pipeline is ready. A completed
build can precede container readiness. Retry the smoke test after provisioning
or rollout finishes before diagnosing a deployment failure.

## Develop locally

Use Node.js 24 and a running Docker-compatible engine:

```bash
npm ci
npm run check
npm run dev
```

Local R2 is emulated; no separate development bucket is required. For a manual
deploy, run `npx wrangler login`, select the intended account, then
`npm run deploy`. After deployment, verify a fresh image with the
[smoke check](docs/deployment.md#updates).
Wrangler provisions the configured R2 bucket when needed.

## Defaults and operations

The starter configuration uses two container shards, each with 1 vCPU and
3 GiB RAM, and sleeps after two idle minutes. Shards start on demand. This
routes work to two containers instead of four and reduces the idle timeout
from ten minutes to two. The platform cap remains four to accommodate existing
instance records during upgrades. Each container admits four jobs and processes
one image at a time. See [performance decisions](docs/performance.md).

The public endpoint limits each client IP to approximately 120 image requests
per minute. Source `private`/`no-store` responses are rejected; `no-cache` images
are transformed without storage. Freshness follows the source cache headers
with a four-hour minimum and a bounded 24-hour stale window.

Renderer changes version both R2 and edge cache keys. During an incompatible
container rollout, fresh misses can briefly return a retryable 503 until the new
renderer is ready.

- [Configuration, costs, updates, and troubleshooting](docs/deployment.md)
- [Architecture and cache semantics](docs/architecture.md)
- [Performance decisions and benchmarking](docs/performance.md)
- [Contributing](CONTRIBUTING.md)
- [MIT license](LICENSE)
