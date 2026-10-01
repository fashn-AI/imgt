# Performance

imgt uses Sharp/libvips in a one-vCPU container, with two routed shards and a
two-minute idle timeout. These defaults balance processing time and idle cost.
Image results persist in R2 and Workers Cache; Cloudflare Images is not required.

## Native Container scheduling

On October 1, 2026, a production trial deployed Cloudflare's native `ctx.container`
API and `durable_object` scheduling policy. Routing was restored to legacy after
the first native transform timed out. The encoder, renderer namespace,
two shards, 1-vCPU/3-GiB/2,000-MB allocation and two-minute inactivity timeout
remain the same. The retained legacy application supports a configuration
rollback; see the [deployment migration notes](deployment.md).

Cloudflare's [announcement](https://blog.cloudflare.com/faster-agent-sandboxes/)
reports faster sandbox allocation under a concurrent sandbox workload. That
measurement does not establish a corresponding improvement in image encoding,
warm transformations or cache-hit delivery. The relevant IMGT measurement is
container startup on a derivative miss after its shard has become idle.

The comparison used the personal production endpoint from a Brazil Mac, with
all requests observed at GRU. The legacy baseline completed 42 new transformations:
six verified cold starts after three 135-second idle periods, and 36 warm misses.
Each miss was followed by an edge-cache repeat. The native run stopped on its
first cold candidate, which returned HTTP 504 after 21.177 seconds. The source
was a retained
3,840 × 5,760 JPEG (3,292,435 bytes); every uniquely keyed origin response was
checked against its SHA-256 before requesting a transform. Output settings were
WebP quality 77, effort 2, with widths 640, 1,920 and 3,840. Every output was
checked byte-for-byte against the local production encoder. The native run
was pinned to successful Worker version `1b234287-4327-4523-849c-4a1131d65ff7`
(commit `e3506fc`).

Baseline medians, measured through complete response-body receipt:

| Output width | Cold miss (2 samples) | Warm miss (12 samples) | Edge hit (14 samples) |
| --- | --- | --- | --- |
| 640 | 3,820 ms | 940 ms | 36 ms |
| 1,920 | 3,623 ms | 1,567 ms | 40 ms |
| 3,840 | 4,612 ms | 2,996 ms | 49 ms |

The baseline startup-span median was 1,586 ms across six cold requests. All
42 outputs and 42 edge repeats matched the expected encoder bytes. The native
failure reached `ImgtNativeImageTransformer` and exhausted the 20-second job
deadline. Dashboard logs show the container listening on port 8080 after the
HTTP timeout. This suggests slow initial provisioning, but does not identify
the allocation or readiness root cause. No native speedup is established.

Rollback commit `9b0bf34` deployed successfully. Public health reported legacy
version `a52042a6-ffce-4d4d-819a-514ed2398fda`; the exact failed source then
passed the smoke test (MISS 3,132 ms, EDGE 46 ms, ETag 304). Native startup must
be diagnosed and verified with a controlled canary before another traffic switch.

Results are sequential small samples on one scene and one client location.
The baseline has two cold observations and twelve warm observations per width,
and fourteen edge repeats per width. These samples do not establish p95,
load capacity, US performance, R2-hit latency or a change in bills. The
`Server-Timing` startup span includes readiness and is nested within the job
duration; it is not an independent term to add to total response time.

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
