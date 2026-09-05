# Engine investigation

Measured September 5, 2026 UTC. Goal: minimize complete image delivery time on
Cloudflare while keeping imgt independently deployable. Cloudflare Images is
excluded as a production dependency by the project's cost requirement. An engine's language,
Docker image size, resize-only benchmark, or matching quality number is not
enough to decide this.

## Decision and qualified evidence

Keep Sharp/libvips. The strongest replacement candidate's resize improvement can
be obtained in the existing Sharp pipeline by deferring embedded ICC conversion
until after resize for 8-bit RGB inputs. CMYK, grayscale and higher-depth inputs
retain the original path. Conversion is explicit; profiles are not ignored in
the output. This avoids adopting a competing image server or maintaining a new
Rust/C++ service just to access a different operation order.

The reproducible [common-input harness](engines/README.md) runs each engine in
its own native-architecture container with 1 CPU, 3 GiB RAM and no swap. The
latest AMD64 run used an AMD EPYC 7763 GitHub runner and five samples per case.
Results include decode, orientation, resize and WebP encode, excluding HTTP,
origin, Cloudflare startup and output-file writes. These are medians, not tails.

| Engine | 22 MP portrait → 640 | → 1920 | → 3840 | Peak cgroup memory |
| --- | ---: | ---: | ---: | ---: |
| Sharp, cache disabled, original pipeline | 279 ms | 1,438 ms | 1,369 ms | 332 MiB |
| Sharp, cache disabled, late ICC | 241 ms | 592 ms | 1,371 ms | 329 MiB |
| Direct libvips, explicit sRGB output | 260 ms | 596 ms | 1,370 ms | 259 MiB |

[Latest x86 results](engines-late-amd64.json),
[quality/hash results](engines-quality-late-amd64.json),
[CI execution](https://github.com/relferreira/imgt/actions/runs/33937835267).
All three use libvips 8.18.6 and WebP 1.6.0. On ARM, the paired 1920px medians
were 789 ms original, 580 ms late ICC and 588 ms native
([local results](engines-late-local.json)). The measured resize improvement was
26% on ARM and 59% in this x86 run; host variance and a fixed microbenchmark
profile order mean these are not universal speedup guarantees. The previous
x86 original-pipeline measurement was 975 ms, illustrating that variance.

Every common-fixture output hash matched between original and optimized Sharp,
including WebP/AVIF inputs, alpha on white/black and EXIF rotation. Regression
tests also cover all eight orientations, CMYK, grayscale, 16-bit input, P3
interior colors, limits and cancellation. P3 resize boundaries can differ because
color conversion and filtering do not commute. A renderer/cache version change
is therefore required; do not claim universal byte or perceptual equivalence.

Earlier [operation-cache measurements](engines-amd64.json) showed a 64% peak
memory reduction when disabling libvips' intermediate-image cache. R2 and edge
caches retain completed derivatives independently. This already-deployed change
preserved all tested output hashes but does not reduce provisioned-memory billing.

The initial native prototype omitted an explicit output profile. Its apparently
large full-size advantage disappeared after correcting color handling. Use the
[color-corrected results](engines-color-amd64.json), not the preliminary native
numbers, to evaluate it. P3/CMYK resized outputs still differ from Sharp's old
pipeline; see [qualification](native-compatibility-local.json).

Rust was fast on large x86 JPEGs but its prototype lacks AVIF and ICC conversion,
and was slower for thumbnails on ARM. Its WebP-input SSIM was approximately
0.005 below the old renderer reference. It is not a qualified replacement.
The existing Sharp lossless resize is the SSIM reference, which favors that
resampling behavior and does not establish perceptual quality equivalence.

## Cloudflare engine validation

[Raw interleaved results](cloudflare-engines.json) contain 27 sequential requests
on one fixed-source, 1 CPU / 3 GiB lab instance, three per engine/width. Every
response carried the expected `late-icc-v2` build marker. Earlier attempts from
an old instance returned `late-icc-v1` and were excluded; creating a fresh lab
instance resolved the discrepancy. Successful build/control-plane status alone
had not proved the response was from the expected renderer.

| Engine | 640 transform | 1920 transform | 3840 transform |
| --- | ---: | ---: | ---: |
| Original Sharp, cache disabled | 470 ms | 1,304 ms | 1,620 ms |
| Optimized Sharp, cache disabled | 328 ms | 835 ms | 1,711 ms |
| C++ libvips subprocess | 470 ms | 761 ms | 2,064 ms |

These are `sharp` Server-Timing medians (the label also covers the native
adapter), not complete delivery times. Native includes subprocess/file overhead.
Optimized Sharp preserved the baseline output hashes at all three widths.
The measured 30%/36% reductions on thumbnails/mid-size images support adopting
the existing-library optimization. Full-size output showed no benefit and a
small regression in this sample. Native was another 9% faster at 1920 but slower
at full size and produced different thumbnail bytes. This does not justify a
service rewrite on current evidence. Three samples, one fixture and one region
are not p95 or a universal ranking.

Origin-body transfer was bimodal (~250/~670 ms) and remains an important part of
miss latency. The first lab request may include boot; do not use it as a warm
end-to-end comparison. The lab has no R2/derivative cache and cannot stand in for
the production gateway's cache-hit path.

## The options

These cover the relevant engine families and Cloudflare execution choices.
Only candidates explicitly marked measured have been benchmarked here.

| Option | Assessment for imgt | Status / decision |
| --- | --- | --- |
| [Sharp](https://sharp.pixelplumbing.com/performance/) + libvips | Mature format/color support; existing tested HTTP admission and cancellation. Tune cache, load/resize pipeline and encoder settings before replacing it. | Measured; preferred implementation with cache disabled and late ICC conversion. |
| Direct libvips in C/C++ | Same codecs without adopting another image server. Its thumbnail pipeline exposed the operation-order improvement now available in Sharp. A small adapter can preserve imgt's gateway, R2 and queue. | Measured; late-ICC Sharp matches its qualified speed without a new service. |
| [Go govips](https://github.com/davidbyttow/govips) / [bimg](https://github.com/h2non/bimg) | Bindings to libvips, not independent image engines. Can access the same thumbnail path and offer a convenient HTTP implementation. Adds Go/cgo and still distributes native libraries. | Reviewed; no evidence that rewriting the wrapper alone beats direct libvips. |
| [Rust image](https://github.com/image-rs/image) + [fast_image_resize](https://github.com/Cykooz/fast_image_resize) + [libwebp binding](https://github.com/jaredforth/webp) | Independent SIMD resizing with promising x86 throughput. Must assemble color management, codecs and bounded cancellation correctly. libwebp remains a C dependency. | Measured prototype; faster large-image candidate, incomplete compatibility. |
| [imgproxy](https://github.com/imgproxy/imgproxy) / [imagor](https://github.com/cshum/imagor) | Complete competing servers around libvips. Their APIs, origin fetching, caching and queueing duplicate parts of imgt. Upstream ownership is a maintenance preference, not a speed measurement. | imgproxy screened earlier; keep as external reference, do not adopt as imgt's core. |
| [Imageflow](https://github.com/imazen/imageflow) | Purpose-built image engine with Rust/C ABI. Another organization-backed project; AGPL/commercial distribution differs from imgt's intended permissive starter. | Reviewed; not the first dependency choice. No imgt performance claim. |
| [ImageMagick](https://github.com/ImageMagick/ImageMagick) / [GraphicsMagick](http://www.graphicsmagick.org/) | Broad general image tooling. Useful compatibility references, but much more functionality than this fixed WebP resize endpoint needs. | Reviewed; no measured reason to replace the proven libvips pipeline with these. |
| [Pillow-SIMD](https://github.com/uploadcare/pillow-simd) | Accelerates selected operations; still needs Python, codecs and HTTP/lifecycle code. Resize-only results do not establish complete WebP throughput. | Reviewed; lower priority than the measured native candidates. |
| [FFmpeg](https://github.com/FFmpeg/FFmpeg) | Strong multimedia tooling, including scaling/codecs; imgt currently processes still images with color/orientation semantics. | Reviewed; a video-thumbnail feature could justify it, current evidence does not. |
| Custom [libjpeg-turbo](https://github.com/libjpeg-turbo/libjpeg-turbo) + resizer + libwebp | Tight control over decode scaling, SIMD and encoder allocation. Essentially assembling a new engine, with non-JPEG and ICC support to maintain. | Rust prototype partly explores this family; defer a fully bespoke C engine. |
| WebAssembly inside a Worker | Removes the container, but a 50 MP RGBA buffer alone needs ~191 MiB, beyond the documented [128 MiB Worker memory limit](https://developers.cloudflare.com/workers/platform/limits/), before extra buffers/codecs. | Reviewed; unsuitable as a general drop-in with today's input contract. Streaming/shrink-on-decode could support a constrained subset. |
| [Cloudflare Images binding](https://developers.cloudflare.com/images/optimization/binding/) | Managed processing directly from a Worker byte stream, avoiding imgt's container startup and DO routing path. Different billing and input limits; returned images still need imgt caching. | Nine reference requests completed; excluded on cost grounds. The lab's Images binding and route were removed. |
| Larger CPU, placement and keeping containers warm | Architecture choices can change end-to-end latency more than wrapper language. Larger allocation does not guarantee one WebP job scales linearly. | Keep the measured 1 CPU baseline; quarter-CPU/lite profiles failed latency goals. Investigate placement and startup independently. |
| Precompute derivatives on upload / anticipated widths | Removes first-view transform latency by moving it before the request. Works best when imgt participates in an upload pipeline; arbitrary remote URLs cannot guarantee that. | Useful optional integration, not a replacement for on-demand performance. |

The shared benchmark Docker image includes Node and C++; its size must not be
presented as a lean native production image size. Compare compressed deployment
size and Cloudflare boot time only after building equivalent production images.

## Vercel baseline

The [reference script](compare-services.mjs) made three sequential first-use
requests per width from one client, alternating service order, against the
historical public Vercel demo. No concurrency/load test was run against it.
Both services received the same source URL in each pair. imgt uses q77/effort2;
the Vercel endpoint uses q75. Unique source parameters can also miss Unsplash's
cache, so these are exploratory end-to-end results, not isolated encoder tests.

| Width | imgt first request | Vercel first request | imgt verified EDGE | Vercel verified HIT | imgt / Vercel bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 640 | 1,814 ms | 951 ms | 34 ms | 34 ms | 68,866 / 60,158 |
| 1920 | 2,589 ms | 2,044 ms | 37 ms | 38 ms | 548,138 / 486,068 |
| 3840 | 3,243 ms | 3,212 ms | 47 ms | 50 ms | 1,486,240 / 1,209,718 |

[Raw service results](services-baseline.json). Immediate repeats sometimes
remain MISS while persistence completes. Only `settledRepeat` with an actual
cache-hit header is counted in the HIT columns. First-use does not mean a
verified sleeping-container cold start. Current outputs are 13–23% larger;
quality, encoding latency and download bytes need to be evaluated together.

Matching this demo's warm cache latency does not establish a general Vercel
performance claim. A controlled Vercel deployment, identical prewarmed origin
bytes, quality-matched output, multiple regions, verified cold/warm state and
p50/p95 under agreed concurrency are needed for that claim.

## Architecture changes and qualification

Cost is a constraint, not a reason to compare only container RAM. Cloudflare
[bills](https://developers.cloudflare.com/containers/platform/pricing/) active
CPU usage, but provisioned memory and disk for the time an instance is awake.
At published overage rates, 3 GiB memory plus 2 GB disk is $0.00000764 per awake
second per container, before CPU, network, Workers/DO/R2, included allowances
and the base plan. A hypothetical 0.5 CPU-second transform costs $0.00001 in CPU
alone. These are arithmetic examples, not a measured per-request bill.
Disabling an internal cache does not reduce provisioned-memory charges. Keep
the two-minute sleep setting until measured traffic justifies a different
warmth/cost tradeoff; never imply that a faster encoder removes platform boot.

On a validated cache miss, request origin headers while preparing a sleeping
container. Both operations share the existing deadline and abort signal. Cache
hits do neither. The `startup` and `origin_headers` Server-Timing spans overlap;
do not add them together. An origin later rejected by its response headers may
have already started a container; this is the deliberate cold-latency tradeoff.

Cloudflare [placement](https://developers.cloudflare.com/containers/concepts/placement/)
and the DO shard location influence misses. Changing languages cannot remove
an extra geographic round trip. Measure gateway, R2, origin, startup, upload,
queue, encode and response transfer separately before changing shard routing.
The current [DO location documentation](https://developers.cloudflare.com/durable-objects/reference/data-location/)
explicitly says a South America hint falls back to Eastern North America and
existing objects do not relocate. Container region availability alone does not
remove that DO hop for a client in Brazil.

Production qualification order: cache/overlap improvements, then the optimized
Sharp pipeline after complete HTTP/cloud validation. Retain source validation, pixel/byte limits, color/orientation/alpha,
absolute deadlines, queued cancellation and deduplication. An encoder change
requires a new derivative namespace. Do not silently replace unsupported input
formats or call an incomplete Rust prototype production-ready.


Cloudflare's [custom instance constraints](https://developers.cloudflare.com/containers/platform/limits/)
require at least 3 GiB memory per vCPU and at least one vCPU. The current 1 CPU /
3 GiB configuration already uses that memory floor. Choosing a smaller native
runtime does not unlock a 1 CPU / 512 MiB deployment on this platform.

The Worker and container share a renderer version. During an incompatible
rolling update, a successful response from an old container is discarded and a
retryable 503 returned, rather than poisoning the new cache namespace. Cache
hits remain independent of container startup. The next request can succeed once
the new container is active; a successful Workers Build alone is insufficient
proof that rollout has finished.
