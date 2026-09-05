# Engine investigation

Measured September 5, 2026 UTC. Goal: minimize complete image delivery time on
Cloudflare while keeping imgt independently deployable. Cloudflare Images is
excluded as a production dependency by the project's cost requirement. An engine's language,
Docker image size, resize-only benchmark, or matching quality number is not
enough to decide this.

## Current evidence

The reproducible [common-input harness](engines/README.md) runs each engine in
its own native-architecture container with 1 CPU, 3 GiB RAM and no swap. The
AMD64 run used an AMD EPYC 7763 GitHub runner, five samples per case. Results
include decode, orientation, resize and WebP encode, excluding HTTP, origin,
Cloudflare startup, and output-file writes. These are medians, not tail latency.

| Engine | 22 MP portrait → 640 | → 1920 | → 3840 | Peak cgroup memory |
| --- | ---: | ---: | ---: | ---: |
| Sharp, operation cache 64 MiB | 388 ms | 972 ms | 1,370 ms | 983 MiB |
| Sharp, operation cache disabled | 262 ms | 966 ms | 1,363 ms | 354 MiB |
| Direct libvips thumbnail, C++ | 249 ms | 523 ms | 1,098 ms | 256 MiB |
| Rust image + fast_image_resize + libwebp | 282 ms | 475 ms | 942 ms | 322 MiB |

[Raw x86 results](engines-amd64.json), [quality results](engines-quality-amd64.json),
[CI execution](https://github.com/relferreira/imgt/actions/runs/33935703781).
All Sharp/native libvips runs use the same libvips 8.18.6 / WebP 1.6.0 bundle.
The Rust codec stack differs. Five samples and a fixed profile order can retain
host drift; qualify finalists with interleaved Cloudflare measurements.

Disabling Sharp's operation cache preserved every tested output hash and reduced
peak memory by 64%. R2 and edge caching already retain completed derivatives;
libvips' operation cache is a separate intermediate-image cache. This is the
first production change. It does not require a derivative namespace change.

Direct libvips reduced the 1920px portrait time by 46% versus uncached Sharp.
These initial timings preceded an explicit output-profile fix discovered by
the later P3/CMYK tests; they must be remeasured with that fix before adoption.
All tested 1920px/full-size photo outputs were byte-identical. Some thumbnails
differed, so this is a pipeline change, not evidence of JavaScript overhead.
The [libvips thumbnail pipeline](https://github.com/libvips/libvips/wiki/HOWTO----Image-shrinking)
combines optimized loading, shrinking, color conversion and orientation.

Rust was fastest on large x86 JPEGs, but was slower than Sharp for 640px on ARM
(516 vs 232 ms). It currently lacks AVIF and ICC conversion. Its WebP-input
SSIM was approximately 0.005 below the existing renderer reference. It is an
experimental candidate, not a production-compatible replacement. Color-profile,
CMYK, malformed-input and cancellation qualification remain necessary for any
new native adapter, including the C++ prototype.

The C++ prototype now explicitly converts to sRGB using perceptual intent.
P3/CMYK outputs match Sharp without resizing, but resizing before conversion
still differs from Sharp's conversion-before-resize path (decoded-output SSIM
0.979 and 0.962 in the tested thumbnails). All eight orientation cases, grayscale,
transparency, WebP and AVIF matched in that local HTTP check. See
[color qualification](native-compatibility-local.json). Do not describe these
results as complete color equivalence.

Quality checks use full-resolution SSIM, output dimensions/hashes, EXIF rotation
and transparent images composited on white and black. The reference is the
existing Sharp lossless resize; that favors its resampling behavior and does
not establish perceptual equivalence across a representative image corpus.

## The options

These cover the relevant engine families and Cloudflare execution choices.
Only candidates explicitly marked measured have been benchmarked here.

| Option | Assessment for imgt | Status / decision |
| --- | --- | --- |
| [Sharp](https://sharp.pixelplumbing.com/performance/) + libvips | Mature format/color support; existing tested HTTP admission and cancellation. Tune cache, load/resize pipeline and encoder settings before replacing it. | Measured; retain as correctness baseline and ship cache improvement. |
| Direct libvips in C/C++ | Same codecs without adopting another image server. Its thumbnail pipeline gives a substantial measured improvement. A small adapter can preserve imgt's gateway, R2 and queue. | Measured prototype; strongest low-dependency replacement candidate. |
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

Production qualification order: cache/overlap improvements, then a native
libvips adapter if its complete HTTP/cloud performance
still wins. Retain source validation, pixel/byte limits, color/orientation/alpha,
absolute deadlines, queued cancellation and deduplication. An encoder change
requires a new derivative namespace. Do not silently replace unsupported input
formats or call an incomplete Rust prototype production-ready.
