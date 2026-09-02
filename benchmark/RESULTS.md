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
only 4–11% larger. It is the best candidate if miss latency matters more than
the last few percent of derivative size.

## Decision

Use Node.js 24 with Sharp 0.35.4, one active transform per 1-vCPU container,
four deterministic container shards, WebP output, R2-backed derivatives, and
single-flight deduplication in each Container Durable Object. Cloudflare Images
is not part of the request path.
