# Performance

imgt uses Sharp/libvips in a one-vCPU container, with two routed shards and a
two-minute idle timeout. These defaults balance processing time and idle cost.
Image results persist in R2 and Workers Cache; Cloudflare Images is not required.

## Native Container scheduling

The October 1, 2026 migration moved production to the native `ctx.container`
API with `durable_object` scheduling. Sharp, WebP quality 77/effort 2, the
`derivatives/v3` namespace, two shards and each shard's 1-vCPU/3-GiB/2,000-MB
allocation stayed unchanged. A durable alarm enforces shutdown two minutes
after the last completed request, defers shutdown during active work, and
serializes stopping against new requests. Boot labels in MISS `Server-Timing`
distinguish an actual Linux restart from a repeated readiness check.

Cloudflare's [announcement](https://blog.cloudflare.com/faster-agent-sandboxes/)
measures concurrent agent sandbox startup. IMGT's relevant measurement is
startup on an uncached derivative after its shard has stopped; image encoding
and cache-hit delivery are separate measurements.

A sequential legacy/native comparison used one 3,840 × 5,760 photographic scene
from a Brazil Mac at GRU. Outputs were checked against the production encoder.
The legacy baseline had 42 transforms and 42 EDGE repeats, including six cold
starts and twelve warm misses per output width. After correcting native idle
shutdown, 18 transforms and 18 EDGE repeats passed, including four cold starts
with changed boot IDs and four warm misses per width. Earlier idle probes with
unchanged boot IDs were excluded from cold-start comparisons.

| Measurement | Legacy median | Native median | Samples per backend |
| --- | --- | --- | --- |
| Startup span | 1,586 ms | 1,248 ms | 6 legacy / 4 native |
| Cold 640px complete response | 3,820 ms | 2,083 ms | 2 |
| Cold 3,840px complete response | 4,612 ms | 4,219 ms | 2 |

The startup median reduction was approximately 21%; it is not an end-to-end
speedup. There was no verified post-fix cold comparison at 1,920px. Warm medians
at 640/1,920/3,840px were 940/1,567/2,996 ms for legacy and 783/1,463/2,821 ms
for native. These sequential samples can differ in host placement and do not
establish a causal speedup, p95, load capacity, cost savings or a 6x improvement.
Timing spans overlap and must not be added to complete response time.

Some first allocations exceeded the public 20-second deadline. A temporary
migration gate initialized and checked both shards behind legacy traffic before
native promotion. Registry errors and verification-script errors also prolonged
that migration; their cause must not be attributed to the encoder. The final
application commit was `cd03c8484d78dd2873855624128fb0f0938704aa`, deployed as
Worker `c592f32f-63f7-4c72-b579-6e6b6c69a8c7`; both preflight checks passed
before promotion and promotion retained their boot IDs.

Final public validation made four fresh 640px transformations, four EDGE repeats
and four ETag 304 checks, all passing. Each reference used the exact source URL's
bytes because Unsplash query variants can differ. After a 135-second idle wait,
both containers had new boot IDs; complete requests took 2,225/2,252 ms and their
startup spans were 1,204/1,303 ms. This was correctness/lifecycle validation,
with no new paired legacy baseline. Initial allocation's underlying delay remains
unmeasured, and success does not guarantee every future start meets the deadline.

Routine deployment now uses Wrangler and the existing smoke command; the
migration-only gate and canary routing have been removed. See the
[deployment guide](deployment.md#updates) for native image update behavior.

## Why these defaults

### Local startup image experiment

An October 1 experiment compared fresh processes in cached local Docker images
on an ARM64 Mac, using Node 24.21.0, one CPU and 3 GiB of memory. Each comparison
alternated 12 starts per image. A smaller final runtime reduced Docker's reported
image size from 382 to 349 MB, but process-to-listening medians of 118 versus
114 ms did not establish an initialization improvement. Keeping that runtime
and stripping TypeScript at build time reduced the median from 124 to 68 ms;
separate encoder-module import probes fell from 53.3 to 0.54 ms.

Baseline and candidate outputs matched exactly across 19 format, color,
orientation, transparency and size fixtures on both ARM64 and AMD64. These
measurements exclude Cloudflare allocation, image transfer and public response
delivery. The candidate's production cold-start benefit is not yet measured.

### Allocation and encoding

- **Sharp/libvips:** the tested C++ adapter did not show a consistent advantage
  over optimized Sharp. The Rust prototype was promising on large x86 JPEGs but
  lacked the ICC and AVIF support needed by the public API. Go wrappers and
  full image servers add dependencies without a demonstrated overall win here.
- **One CPU and one encoder thread:** a 216-output CPU screen found nearly no
  thumbnail improvement from two CPUs; larger images gained about 5–6% with two
  threads, at higher CPU usage and provisioned memory. Smaller `basic` and `lite`
  allocations missed deadlines or ran out of memory in the local large-image test.
- **Late ICC conversion:** eligible RGB inputs resize before explicit sRGB
  conversion. Other color/depth cases retain the original path. Tests cover
  supported formats, all EXIF orientations, color profiles, and transparency.
- **Quality 77, WebP effort 2:** higher encoding effort reduced file size but
  roughly doubled full-size encoding time in the screen. Changing this tradeoff
  requires a new comparison and a renderer/cache version review.
- **Cache and routing:** R2 lookups run beside the transform coordinator. In a
  small Brazil before/after sample, the lookup median fell from 148–158 ms to
  97–98 ms. Tiered Workers Cache remains useful for sharing results across regions.

## What was measured

September 2026 comparisons against an owned Vercel reference found competitive
cache-hit delivery: roughly 30–44 ms in Brazil and 19–36 ms from a US runner
across both services. imgt's first-use thumbnails were slower. Larger-image
medians were closer, but startup and rollout delays affected the slowest requests.

**Broad Vercel parity is not established.** The service comparison used one
photographic scene, ten pairs per width, and different encoder settings. imgt
outputs were 13–23% larger. The quality proxy was not perceptual equivalence,
and there was no multi-region p95 load test. Local Docker timings should not be
presented as Cloudflare latency, and separate runs can vary with host placement.

The [archived research](https://github.com/relferreira/imgt/tree/b5761868f5a8f93a7a938a31c599e6f12d29d0fc/benchmark)
contains the full methodology, raw reports, engine prototypes, and lab configs.
It remains in Git history so the normal checkout can stay focused on imgt.

## Run the retained benchmark

Use a deployment with the current renderer/configuration and
`images.unsplash.com` in `ALLOWED_HOSTS`:

```bash
npm ci
npm run benchmark -- https://imgt.YOUR-SUBDOMAIN.workers.dev
```

This prewarms a fixed 3840px Unsplash JPEG and requests two new variants at each
of 640, 1920, and 3840px, alternating the configured shards. Every image is
checked against the local production encoder, followed by an exact-byte edge
repeat and an ETag `304` check. The default run makes six transforms and twelve
repeat/conditional requests against your deployment, plus origin prewarming.

The report goes to ignored `.benchmark-results/production.json`. Set
`BENCH_SAMPLES` to 1–10 for observations per width, or `BENCH_OUTPUT` to another
report path. A failed check records an error and exits unsuccessfully.

Read `status`, response POPs, output sizes, and `Server-Timing` alongside the
wall-clock measurements. Startup and origin fetch overlap; timing spans are
nested and must not be added together. This is a bounded correctness/latency
sample, not a p95 or concurrency benchmark. Let rollouts settle before comparing
runs. For a quick deployment check with your own source, use
`npm run smoke -- YOUR_ENDPOINT YOUR_SOURCE_URL` instead.
