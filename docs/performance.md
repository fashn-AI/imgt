# Performance

imgt uses Sharp/libvips in a one-vCPU container, with two routed shards and a
two-minute idle timeout. These defaults balance processing time and idle cost.
Image results persist in R2 and Workers Cache; Cloudflare Images is not required.

## Why these defaults

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
