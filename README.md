![imgt](public/logo.svg)

Self-hosted image optimization on Cloudflare. Serve resized WebP images from
your own account using Sharp, Workers Cache, and a private R2 bucket.

Maintained by [FASHN AI](https://github.com/fashn-AI).

[Use with Next.js](docs/nextjs.md) · [Configuration](docs/configuration.md) ·
[Deployment guide](docs/deployment.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fashn-AI/imgt)

<!-- dash-content-start -->

Give imgt a public image URL and a width. It transforms the image once, stores
the derivative in R2, and serves subsequent requests through Workers Cache.
Works with Next.js custom loaders or any client that can request an image URL.
Original images are never stored. No Cloudflare Images subscription is needed.
<!-- dash-content-end -->

## Deploy to your Cloudflare account

You need a GitHub account, Cloudflare Workers Paid, and R2 enabled. Workers Paid
starts at $5/month; container, storage, and request usage can add charges.
The deploy button requires a public source repository. See
[deployment requirements and costs](docs/deployment.md).

Prefer working with an agent? Use the [setup prompt](docs/setup-prompt.md).

1. Click **Deploy to Cloudflare** above. Select your account and create your own
   repository. Cloudflare provisions the R2 bucket and Durable Object, then
   builds the Worker and Docker image through Workers Builds.
2. In Cloudflare **Workers & Pages → your Worker → Settings → Variables and
   Secrets**, add a **Text** variable named `ALLOWED_HOSTS` with your
   comma-separated source image domains, then select **Deploy**. Include
   `images.unsplash.com` for the sample image. New installations deny image
   requests until this is set; see the [configuration guide](docs/configuration.md#allowed-source-hosts).

3. Run another production GitHub build after saving the variable. Dashboard
   variable deployments can drop native Container image references; Workers
   Builds restores them while preserving your hosts. See the
   [deployment guide](docs/deployment.md#github-integration).
4. Open the deployed Worker URL to try the Unsplash demo. Choose a width and
   quality, then compare original and optimized file sizes. The demo starts at
   1200 px and quality 85; run it again to see a cache hit. The demo requires
   `images.unsplash.com` in your allowlist. Allow several minutes for first-time
   container provisioning.
5. Complete storage setup: in **R2 → imgt → Settings → Object Lifecycle Rules**,
   add an enabled rule to **delete objects with prefix `derivatives/` after
   30 days**. Deployment creates the private bucket but does not add this rule.
   Without it, unused cached images accumulate. See
   [storage cleanup](docs/deployment.md#storage-cleanup).

Future pushes to your production branch deploy automatically through the
GitHub integration. Docker is only needed for local development or CLI deploys.
Each deploy runs typecheck and tests before uploading the Worker.
`keep_vars: true` preserves dashboard variables across code deployments.

For multiple deployments in one account, choose distinct Worker, container and
bucket names and a separate rate-limit namespace ID. See [deployment names](docs/deployment.md#deployment-names).

## Use it

Build a URL with your deployed endpoint and a public source image:

```js
const image = new URL("/image", "https://imgt.YOUR-SUBDOMAIN.workers.dev");
image.search = new URLSearchParams({
  url: "https://cdn.example.com/photo.jpg",
  w: "640",
  q: "77",
});
// Use image.href as an <img> src or fetch it directly.
```

| Parameter | Meaning                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `url`     | Absolute HTTPS source URL on an allowed host. `URLSearchParams` encodes it.        |
| `w`       | Width: any integer from 1 to 3840 pixels.                                          |
| `q`       | Quality: any integer from 1 to 100. Defaults to 77.                                |

Each width and quality combination has its own cached derivative.

Output is WebP, with orientation corrected and aspect ratio preserved. Small
sources are not enlarged. Supported inputs: JPEG, PNG, WebP, and AVIF, up to
25 MiB and 50 megapixels. Animated images are not preserved as animations.

`ALLOWED_HOSTS` contains the original image's host. Include your frontend domain
if it serves the originals.
See [allowed source hosts](docs/configuration.md#allowed-source-hosts) for exact
and wildcard matching, redirects and URL requirements.

## Next.js

Use a custom loader so `<Image>` generates responsive URLs for your imgt
deployment. The [Next.js guide](docs/nextjs.md) includes copyable configuration,
loader, and page examples, plus notes for local assets. imgt accepts responsive
widths up to 3840 pixels.

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
cp .env.example .env
npm run check
npm run dev
```

Edit `.env` for local source hosts; it is not uploaded to production.
Local R2 is emulated; no separate development bucket is required. For a manual
deploy, run `npx wrangler login`, select the intended account, then
`npm run deploy`. Configure production [source hosts](docs/configuration.md#allowed-source-hosts)
in the dashboard, then verify a fresh image with the [smoke check](docs/deployment.md#updates).
Wrangler provisions the configured R2 bucket when needed.

## Defaults and operations

The starter configuration uses two container shards, each with 2 vCPUs and
6 GiB RAM. Shards start on demand and stop after two idle minutes once foreground
requests and background image refreshes finish. Native scheduling permits only
the configured shard IDs, with an application limit of eight shards. Each container
uploads at most eight images at once and processes up to two at a time. Each shard
accepts up to 128 distinct jobs, waiting for upload capacity within the existing
deadline. See
[performance decisions](docs/performance.md).

The public endpoint limits each client IP to approximately 10,000 image requests
per minute. Source `private`/`no-store` responses are rejected; `no-cache` images
are transformed without storage. Freshness follows the source cache headers
with a four-hour minimum and a bounded 24-hour stale window.

Renderer changes version both R2 and edge cache keys. During an incompatible
container rollout, fresh misses can briefly return a retryable 503 until the new
renderer is ready. Changing `transforms.webpEffort` also requires a renderer
version bump; see [native image updates](docs/deployment.md#native-image-updates).

- [Configuration and allowed source hosts](docs/configuration.md)
- [Deployment, costs, updates, and troubleshooting](docs/deployment.md)
- [Architecture and cache semantics](docs/architecture.md)
- [Performance decisions](docs/performance.md)
- [Benchmarks and pricing](https://imgt.fashn.ai/benchmarks)
- [Contributing](CONTRIBUTING.md)
- [MIT license](LICENSE)

For coding agents, each deployment serves a guide index at `YOUR_ENDPOINT/llms.txt`
and the combined documentation at `YOUR_ENDPOINT/llms-full.txt`. The
[source manifest](https://github.com/fashn-AI/imgt/blob/main/public/llms.txt) is kept
in this repository; its guide URLs are relative to your deployed endpoint.
