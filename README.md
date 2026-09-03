# imgt

Lean, self-hosted image optimization on Cloudflare. There is no Cloudflare
Images path or fallback.

```text
GET /image?url=https://cdn.example.com/photo.jpg&w=1920&q=77
             │
             ├─ normalized, tiered Workers Cache
             ├─ persistent R2 derivative
             └─ fetch remote original → deterministic container shard
```

Only generated derivatives and their cache lifetime are stored in the private
R2 bucket:

```text
derivatives/v1/ab/ab…ef.webp
```

Sources must be absolute HTTPS URLs on a host configured in
[`imgt.config.ts`](imgt.config.ts). Redirect destinations are checked against
the same allowlist. Originals are streamed to the transformer and are never
written to R2.

The output is always WebP, widths are restricted to common Next.js sizes, and
quality is restricted to `60`, `75`, `77`, or `85`. These limits bound cache
cardinality and keep the public API small.

## Caching

The public entrypoint validates and normalizes the transform parameters, then
calls a cache-enabled image entrypoint. Cloudflare's Workers Cache sits in
front of that entrypoint, so a CDN hit skips the R2 and transformation path.
The gateway remains uncached because it canonicalizes equivalent public URLs
to one cache key.

The source image's `s-maxage` or `max-age` controls the derivative lifetime,
with a four-hour minimum. Fresh derivatives are served from the local Cloudflare
edge cache or R2 without starting a container.

When an R2 derivative expires, imgt serves it immediately for a 60-second stale
window and refreshes it in the background. Requests for the same derivative are
coalesced by the Durable Object, so only one refresh downloads and transforms
the source. If refresh fails, the stale derivative remains available and the
next stale window tries again.

R2 remains private and acts as the persistent global backing store. A CDN miss
reads an existing derivative from R2 and repopulates Workers Cache; only an R2
miss starts a transform. Workers Cache uses tiered caching and can return hits
without invoking the image entrypoint. Cache entries are shared across Worker
versions because the canonical key includes the derivative version and encoder
effort.

## Resize coordination

The derivative key is hashed to one of four stable Container Durable Objects.
Each object keeps an in-memory single-flight map, so concurrent misses for the
same derivative share one resize. The transformed response starts immediately;
its single-flight entry remains registered until the one background R2 write
finishes. Unrelated derivatives remain parallel across shards.

Within each Linux container, Sharp runs one CPU-active resize at a time. Up to
four distinct misses may be active or waiting; excess misses receive `429` with
`Retry-After: 1`. Cache hits never enter a container.

The fixed shard count is configured in `imgt.config.ts`. It must not exceed
`max_instances` in `wrangler.jsonc`; keep it stable between deployments to
preserve deterministic routing. The queue limit and other safety limits are
internal defaults rather than deployment configuration. See
[`benchmark/RESULTS.md`](benchmark/RESULTS.md) for the container comparison and
one-vCPU concurrency measurements.

## Setup

First, configure the source hosts that this deployment may fetch:

```ts
// imgt.config.ts
sources: {
  allowedHosts: [
    "cdn.example.com",
    "*.images.example.com",
  ],
},
transforms: {
  // Keep the widths array from the checked-in config.
  qualities: [60, 75, 77, 85],
  defaultQuality: 77,
  webpEffort: 2,
},
```

An exact entry matches only that host. A `*.` entry matches its subdomains but
not the parent host. Keep this list explicit so a deployment cannot be used as
an open image proxy accidentally.

`webpEffort` accepts `0` through `6`: lower values encode faster, while higher
values spend more CPU reducing file size. The default quality-77/effort-2
profile scored slightly higher than Vercel's quality-75 output across the test
set, with somewhat larger files. Source size, redirect, timeout, cache, and
queue limits use conservative internal defaults.

Create the derivative buckets named in `wrangler.jsonc`:

```bash
npx wrangler r2 bucket create imgt-derivatives
npx wrangler r2 bucket create imgt-derivatives-dev
```

Then deploy:

```bash
npm run deploy
```

The default configuration includes `images.unsplash.com` so this fixed source
can be used for a production smoke test. It is a 3840 x 5760 JPEG covered by the
[Unsplash License](https://unsplash.com/license):

```bash
curl --get 'https://imgt.relferreira.workers.dev/image' \
  --data-urlencode 'url=https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&q=90&w=3840' \
  --data 'w=640' \
  --data 'q=77' \
  --dump-header - \
  --output test.webp
```

Replace `images.unsplash.com` with the real source hosts before exposing your
deployment to production traffic.

Derivative identity includes the complete normalized source URL and transform
options. Replacing an origin image at the same URL becomes visible after its
cache lifetime and background refresh. Changing a query parameter such as
`?v=2` creates a new derivative immediately.

Before exposing the endpoint publicly, apply a Cloudflare rate-limit rule to
`/image`. The host allowlist prevents open-proxy use, but arbitrary query-string
variations on an allowed source can still create new transformations.

For a Next.js custom loader:

```ts
export default function imageLoader({ src, width, quality = 77 }) {
  // src must be an absolute URL on a host allowed by imgt.config.ts.
  const query = new URLSearchParams({ url: src, w: String(width), q: String(quality) });
  return `https://images.example.com/image?${query}`;
}
```

Point Next.js at that file and mirror the API quality allowlist:

```ts
const nextConfig = {
  images: {
    loader: "custom",
    loaderFile: "./image-loader.ts",
    qualities: [60, 75, 77, 85],
  },
};
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev
```

The Worker is in [`src/index.ts`](src/index.ts), the transformer is in
[`container/server.ts`](container/server.ts), and the benchmark decision is
documented in [`benchmark/RESULTS.md`](benchmark/RESULTS.md).
