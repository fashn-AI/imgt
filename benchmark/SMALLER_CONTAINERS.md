# Smaller container configuration

Measured 2026-09-05 UTC (2026-09-04 in Brazil), using native Linux/ARM64 Docker
on Apple Silicon. These are controlled local CPU-quota measurements, not
Cloudflare measurements; Cloudflare runs Linux/AMD64. The same current Docker
image, Sharp 0.35.4, quality 77, WebP effort 2, one active encoder, four admitted
jobs, and a 20-second request deadline were used for every profile.

Sources: a 3840×5760 (22.1MP) Unsplash JPEG, and a 3840×2160 (8.3MP) JPEG crop
of that image. Uploads came from the local client, so origin download and R2
latency are excluded. Each normal cell is the median of three requests, except
`lite`, which had one successful request before running out of memory. Peak
memory is the container's cgroup `memory.peak`, not host RSS. Swap was disabled.

## Results

| Profile | Allocation | Portrait → 640 | Portrait → 1920 | Portrait → 3840 | Landscape → 1920 | Landscape → 3840 | Peak memory |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Current custom | 1 vCPU / 3 GiB | 308 ms | 856 ms | 1,373 ms | 210 ms | 452 ms | 861 MiB |
| `basic` | ¼ vCPU / 1 GiB | 1,407 ms | 4,696 ms | 8,108 ms | 1,288 ms | 3,019 ms | 825 MiB |
| `lite` | ¹⁄₁₆ vCPU / 256 MiB | 12,005 ms | OOM / disconnected | Not run | Not run | Not run | Limit exhausted |

For a burst of four distinct 3840px portrait transforms admitted to one
container, the custom profile completed all four in 1.35–5.21 seconds. `basic`
completed two in 8.51 and 16.99 seconds; the other two returned HTTP 504 at the
20-second deadline. Its HTTP health endpoint remained available. `lite` was
confirmed `OOMKilled` by Docker; the rest of that profile was stopped.

These timings include request upload, queueing, and processing. Files produced
successfully by both profiles had the same byte lengths. The benchmark decodes
successful outputs and records their widths, but is not an image-quality study.
Raw results, including status and per-stage timings, are in
[smaller-containers.json](smaller-containers.json).

## Starter default

An exploratory [Go/imgproxy comparison](ALTERNATIVES.md) uses substantially less
memory, but does not yet qualify as a drop-in replacement. The default below
applies to the current Sharp implementation.

Keep **1 vCPU / 3 GiB per container**, reduce request routing from **four to
two shards**, and reduce idle sleep from **ten to two minutes**.

- Smaller per-container tiers are a poor default for the supported large-image
  workload. `basic` had little memory headroom and missed queued deadlines;
  `lite` could not complete it.
- Two shards cap simultaneous native encodes at two rather than four. This
  reduces maximum aggregate throughput; each individual transform retains its
  CPU allocation. Users with more concurrent cache misses can restore four
  shards using the documented configuration.
- Two running shards allocate 6 GiB. The platform cap remains four instances
  (12 GiB) for existing-installation compatibility. Idle timeout drops by 80%,
  with more cold starts as the tradeoff. Neither figure is a predicted bill
  reduction: traffic, cache hit rate, and CPU usage determine actual charges.
- Cloudflare custom instances require at least 1 vCPU and 3 GiB per vCPU;
  a custom 1-vCPU/1-GiB alternative is not available. See
  [instance constraints](https://developers.cloudflare.com/containers/platform/limits/).

Production qualification found that lowering `max_instances` to two blocked
starts even after the application reported ready, while four stopped instance
records remained. The platform cap was restored to four; routing stays at two.
A fresh-account cap of two has not been qualified.

This benchmark compares individual container allocations; it does not measure
aggregate two-shard versus four-shard throughput or long-term production spend.
No claim is made about all images up to the API's 50MP/25MiB limits. Deployment
smoke checks on Cloudflare remain necessary after applying the new defaults.

## Reproduce

Use native architecture for meaningful CPU comparisons. On Apple Silicon:

```bash
npm ci
docker build --platform linux/arm64 -t imgt-benchmark:current container
npm run benchmark
```

On an x86 Linux machine, use `--platform linux/amd64`. The script records the
image architecture and writes `benchmark/smaller-containers.json`. Override
`BENCH_IMAGE`, `BENCH_PROFILE` (`custom-1cpu`, `basic`, or `lite`), or
`BENCH_OUTPUT` as needed. Containers bind only to localhost and are removed at
the end of each profile. The run downloads the source into memory, does not
store originals in Git, and performs no Cloudflare deployments.
