# Benchmark summary

Benchmarked on 2026-09-01 using native `linux/arm64` Docker containers on an
Apple Silicon host. Each container was limited to 1 vCPU, 3 GiB RAM, and one
libvips worker. Results are directional; Cloudflare runs `linux/amd64`, so the
production deployment still needs measurements on Cloudflare hardware with a
sample of real source images.

## Container choice

| Strategy | Image stack | Weighted WebP CPU/request | 1920px RPS | 640px RPS | Peak memory | Startup | Image size |
|---|---|---:|---:|---:|---:|---:|---:|
| Sharp | libvips 8.18.6, WebP 1.6.0 | **315.8 ms** | **1.99** | 4.73 | **896 MiB** | 200 ms | 86.2 MiB |
| govips | libvips 8.14.1, WebP 1.2.4 | 447.9 ms | 1.46 | **5.08** | 1071 MiB | **161 ms** | 80.6 MiB |
| Native C++ | libvips 8.14.1, WebP 1.2.4 | 436.1 ms | 1.45 | 4.83 | 1020 MiB | 164 ms | **78.5 MiB** |

Sharp used 27.6% less weighted WebP CPU than direct C++ and 29.5% less than
govips. The advantage came from Sharp's maintained native libvips and codec
bundle, not from processing pixels in JavaScript. A custom C++ image did not
provide enough benefit to justify maintaining codec builds and ABI updates.

WebP is the initial output format. AVIF was substantially more CPU-intensive
and should only be added later as an explicitly requested, persistently cached
derivative.

## One-vCPU 4K concurrency

Source: 3840x2160 progressive JPEG, WebP quality 75. Every measured request
completed successfully.

| In flight | 1920px RPS | 1920px p95 | 3840px RPS | 3840px p95 | Peak memory |
|---:|---:|---:|---:|---:|---:|
| 1 | 3.05 | 357 ms | 1.24 | 838 ms | 657 MiB |
| 2 | 2.90 | 713 ms | 1.15 | 1.85 s | 813 MiB |
| 4 | 2.91 | 1.46 s | 1.15 | 3.61 s | 829 MiB |
| 8 | 2.89 | 2.82 s | 1.15 | 7.07 s | 769 MiB |
| 16 | 2.87 | 5.72 s | 1.15 | 14.01 s | 784 MiB |
| 32 | 2.94 | 10.93 s | 1.15 | 27.97 s | 858 MiB |

Additional parallel Sharp work did not improve throughput on one vCPU; it only
increased latency. The production container therefore runs one CPU-active
transform at a time and bounds each shard to four distinct active or waiting
misses. Identical derivative requests do not consume another slot because the
Container Durable Object coalesces them into one in-flight job.

## Cloudflare production timing

Measured on 2026-09-02 with native Worker tracing and container timing. The
source was a 3840x5760 JPEG: 22.1 megapixels and 3.3 MB. These are cache-miss
times from a client in Brazil after the container was warm.

| Stage | 1920px output | 3840px output |
|---|---:|---:|
| R2 miss check | 96 ms | 101 ms |
| Origin headers and body | 564 ms | 73 ms |
| Sharp | **2461 ms** | **4535 ms** |
| Container call, including Sharp | 2684 ms | 4649 ms |
| R2 write | 455 ms | 520 ms |
| Durable Object job | 3611 ms | 5285 ms |
| Client-observed total | 4356 ms | 6160 ms |

A cold 1920px request took 6215 ms. Sharp was nearly unchanged at 2565 ms,
while the container call grew from 2684 ms to 4324 ms, putting observed cold
startup overhead around 1.7 seconds.

The production bottleneck is WebP work on the unusually tall 22MP source, not
the source download. A follow-up one-vCPU comparison measured WebP effort
levels against both that source and a conventional 3840x2160 crop:

| Source and output | Effort 0 | Effort 2 | Effort 4 |
|---|---:|---:|---:|
| 22MP → 1920px | 832 ms / 612 KB | 1006 ms / 508 KB | 1384 ms / 486 KB |
| 22MP → 3840px | 1397 ms / 1677 KB | 1987 ms / 1338 KB | 3305 ms / 1210 KB |
| 8MP → 1920px | 159 ms / 270 KB | 191 ms / 231 KB | 328 ms / 221 KB |
| 8MP → 3840px | 232 ms / 673 KB | 402 ms / 549 KB | 918 ms / 517 KB |

Effort 2 used 27–56% less transform time than effort 4 while producing files
only 4–11% larger. It remains an available latency/size tradeoff, but it is not
the default because effort 4 matched Vercel's WebP output exactly in the
comparison below. Against a lossless resize, effort 2 versus effort 4 measured
0.963 versus 0.965 SSIM at 1920px and 0.974 versus 0.976 at 3840px.

## Vercel comparison

Measured from Brazil on 2026-09-02 against the public Next.js deployment at
https://gagan-image-gallery.vercel.app. Both services received the same
3840x5760 JPEG source, `Accept: image/webp`, and quality 75. A unique source
query was used for each of three cache-miss runs. These are end-to-end
measurements of the deployed services, not a controlled comparison of their
underlying CPUs.

| Output | Vercel miss median | imgt miss median |
|---|---:|---:|
| 1920px | 2.23 s | 3.71 s |
| 3840px | 3.55 s | 5.66 s |

One of the three 1920px imgt requests paid a container cold start. On warm
cache delivery, five repeated 3840px requests had a 135ms median on Vercel and
a 105ms median on imgt.

A follow-up test routed six distinct misses at each width to the same imgt
shard, keeping one container warm throughout. Median client time was 3.71s at
1920px and 5.16s at 3840px. Median Sharp time was 1.70s and 2.90s respectively;
the synchronous R2 write then added about 0.5s and the remaining response path
after the Durable Object job added roughly 0.8–0.9s. This exposed response-path
latency rather than a multi-container cold-start problem.

The Worker now forwards the Durable Object response body as a stream and starts
the R2 write in the background, while retaining the single-flight entry until
that write settles. This removes those waits from the client path without
allowing a second resize during persistence. Production timing still needs to
be repeated after this version is deployed.

At quality 75 and WebP effort 4, Vercel and imgt produced byte-identical files
for both the 22MP portrait source and a 3840x2160 crop. This does not guarantee
that every input will be identical, but it confirms that the current settings
match Vercel's default quality and compression behavior for the tested JPEGs.
Vercel documents 75 as the default image quality:
https://vercel.com/docs/build-output-api/configuration

## CPU allocation

The 22MP source was also tested locally with the same Sharp, libvips, and WebP
versions. Values are medians of three transforms at quality 75 and effort 4 on
native Apple Silicon Docker; they measure relative CPU scaling, not Cloudflare
absolute performance.

| Allocation | Sharp concurrency | 1920px | 3840px |
|---|---:|---:|---:|
| 1 vCPU | 1 | 1118 ms | 2425 ms |
| 2 vCPU | 2 | 1070 ms | 2276 ms |
| 4 vCPU | 4 | 1057 ms | 2262 ms |

Two vCPUs improved single-image latency by only 4–6%, and four vCPUs provided
almost no further benefit. The WebP encode is predominantly single-core. On
Cloudflare, custom instances require at least 3 GiB of memory per vCPU, so a
2-vCPU instance would also require 6 GiB of provisioned memory:
https://developers.cloudflare.com/containers/platform/limits/

## Decision

Use Node.js 24 with Sharp 0.35.4, quality 75 and WebP effort 4, one active
transform per 1-vCPU/3-GiB container, four deterministic container shards,
R2-backed derivatives, and single-flight deduplication in each Container
Durable Object. Four is the maximum instance count, not a permanently running
fleet; instances sleep after inactivity. Cloudflare Images is not part of the
request path.
