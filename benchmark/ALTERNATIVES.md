# Alternatives to the Sharp container

**Historical screening.** The broader investigation and controlled x86 results
are now in [ENGINE_DECISION.md](ENGINE_DECISION.md). The imgproxy recommendation
below is superseded: it remains a comparison reference, not the chosen backend.

Exploratory local comparison on 2026-09-05 UTC. The production encoder remains
Sharp. A language change alone does not identify the performance improvement:
[Sharp](https://sharp.pixelplumbing.com/performance/) and
[imgproxy](https://github.com/imgproxy/imgproxy) both use the C libvips engine.

## Go: imgproxy

Tested the Apache-2.0 imgproxy v4.0.3 Docker image on native Linux/ARM64, with
one worker, a three-request queue, WebP quality 77 and effort 2. CPU and memory
quotas, source images, widths, and sample counts match the
[Sharp comparison](SMALLER_CONTAINERS.md).

| Allocation | Server | Portrait → 640 | Portrait → 1920 | Portrait → 3840 | Peak container memory |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 vCPU / 3 GiB | Sharp | 308 ms | 856 ms | 1,373 ms | 861 MiB |
| 1 vCPU / 3 GiB | imgproxy | 210 ms | 466 ms | 1,321 ms | 252 MiB |
| ¼ vCPU / 1 GiB | Sharp | 1,407 ms | 4,696 ms | 8,108 ms | 825 MiB |
| ¼ vCPU / 1 GiB | imgproxy | 1,100 ms | 2,896 ms | 7,504 ms | 236 MiB |

imgproxy has a promising memory advantage in this test. Full-size WebP encoding
remains CPU-heavy. Its basic-tier four-request burst completed three requests in
5.81, 11.64 and 18.43 seconds; the fourth exceeded the client's 21-second limit.
Sharp completed two before its 20-second deadline. Neither passed the complete
burst within our production deadline, which also includes origin download and
container startup.

On `lite` (¹⁄₁₆ vCPU / 256 MiB), imgproxy completed the 640px portrait in
7.60 seconds and the 1920px portrait in 19.49 seconds. The full-size portrait
exceeded the 21-second client limit, ending that profile. Docker reported no
OOM kill. Unlike Sharp, it survived the tested memory limit, but did not meet
the latency requirement. Peak memory was not collected for the aborted profile.

These are screening results, not an equivalent end-to-end migration benchmark:

- imgproxy reads a read-only local file; Sharp receives an HTTP upload. The
  imgproxy measurements omit upload work and do not exercise our origin policy.
- Both use quality 77 / effort 2, but resized outputs differ. For example,
  imgproxy's 640px portrait is 69,008 bytes. Matching parameter names does not
  establish identical visual quality, resampling, orientation, or color handling.
- imgproxy's processing timeout and queue semantics differ from our absolute
  deadline. Its client is capped at 21 seconds; a timeout is reported explicitly.
- Peak memory covers the complete workload and includes cgroup-accounted memory,
  not just the language runtime. imgproxy's idle memory was about 17 MiB.
- Measurements use local ARM64 Docker quotas, not Cloudflare AMD64 hardware.

Raw results and the image identity are in [imgproxy-containers.json](imgproxy-containers.json).
Reproduce after pulling the native architecture's image:

```bash
docker pull --platform linux/arm64 ghcr.io/imgproxy/imgproxy:v4.0.3
BENCH_ENGINE=imgproxy npm run benchmark
```

The harness uses temporary source files outside the repository and removes them
after each profile. It never replaces the production image. Use Linux/AMD64 on
an x86 host for a representative Cloudflare CPU comparison.

## Rust and direct C

- [fast_image_resize](https://github.com/Cykooz/fast_image_resize) offers SIMD
  resizing in Rust. Its published resize-only numbers exclude the complete
  JPEG-decode/WebP-encode pipeline. A service would still need codecs, orientation,
  color/alpha handling, pixel limits, bounded queues, and cancellation.
- [Imageflow](https://github.com/imazen/imageflow) is an existing Rust image
  engine with a C ABI. Its AGPL/commercial licensing differs from this project's
  permissive distribution model; evaluate that choice before adopting it.
- Direct libvips in C could remove Node overhead while retaining the engine, but
  would add a custom native HTTP/lifecycle implementation to maintain. imgproxy
  is a more useful existing-server candidate to qualify first.

## Next decision

Benchmark imgproxy behind an adapter matching the existing upload and absolute
deadline contract, including malformed inputs, redirects, transparent images,
EXIF orientation, AVIF, and queued cancellation. Compare output quality and run
on native AMD64 before changing the production encoder or instance allocation.
A different encoder must use a new derivative namespace so cached outputs do
not mix across versions. The current open-source starter retains Sharp and
reduces fleet size and idle time instead.
