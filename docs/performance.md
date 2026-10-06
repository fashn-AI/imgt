# Performance

imgt uses Rust/libvips with four container shards, each allocated 1 vCPU, 3 GiB RAM
and 2,000 MB disk. Derivatives persist in R2 and Workers Cache, so cache hits do not
start a container.

## Current decisions

- **Rust/libvips runtime:** identical native library and codec versions retain
  the evaluated Sharp output, while reducing the runtime footprint. Controlled
  local repeats show similar rendering speed, lower memory use and modest CPU
  savings. The current capacity comparison below includes live Cloudflare load tests.
- **Four CPUs across four shards:** the October 6 Rust capacity comparison
  below evaluates smaller pairs and horizontal scaling with four total CPUs. Each
  shard still admits eight active jobs and at most 128 distinct jobs; ready
  inputs use one encoder slot per shard. libvips uses one thread per image.
  Canceled native work retains its slot until processing settles.
- **Late ICC conversion:** eligible RGB inputs resize before conversion to
  sRGB. Other color and depth cases use the original conversion order. Regression
  tests cover supported formats, EXIF orientation, profiles and transparency.
- **Conditional source refreshes:** unchanged direct sources with strong ETags
  renew retained derivatives without downloading the original or starting compute.
  This reduces repeated work after cache expiry; it does not speed up an image's
  first transform. Source changes and unvalidated sources still encode normally.
- **Quality 77, WebP effort 4:** standard Sharp WebP effort matched the
  evaluated Vercel outputs at the same client quality. This replaces the earlier
  effort-2 throughput tradeoff. Renderer v5 isolates the Rust output from older
  cached images and running containers. Client quality values stay unchanged.
- **Four shards, two idle minutes:** stable routing deduplicates work for each
  derivative. The idle alarm waits for foreground requests and background
  refreshes to finish, balancing awake time against cold starts.
- **Owned native buffers:** the Rust HTTP body owns the encoded allocation
  directly. Input buffers outlive every lazy image depending on their bytes;
  native work retains its permits until completion, including after cancellation.

## Rust capacity and horizontal scaling, October 6, 2026

Use four 1-CPU / 3-GiB shards, one encoder per shard and one libvips thread per image.
Total CPU and reserved RAM stay at four CPUs and 12 GiB. The smaller 1-CPU pair is a
budget option at the observed average peak, but its longer 20/s run exhausted
admission capacity and returned seven HTTP 429 responses. Four 1-CPU shards passed
3,600 fresh arrivals at 20/s and improved the 200-image burst. The longer two-2-CPU
confirmation also passed 3,600 arrivals, with p95 1.282 s versus 1.046 s for four
1-CPU shards. The horizontal allocation costs only $0.72/month more in the model, so
use it for FASHN. These are separate bounded runs, not proof of a universal latency
winner.

| Allocation | 50 together | 3/s | 10/s | 20/s | 200 together |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4 × 1 CPU | 2.402 s | 0.934 s | 0.942 s | 1.046 s | 6.836 s |
| 2 × 2 CPUs | 2.460 s | 1.063 s | 0.968 s | 1.282 s | 7.703 s |
| 2 × 1 CPU | 4.954 s | 0.990 s | 1.122 s | 19.857 s (7 failures) | 17.321 s |
| Vercel | 1.100 s | 1.273 s | 1.252 s | 1.219 s | 2.044 s |

The first post-restore gallery returned all 50 images in Cloudflare tail, but two
gateway responses still identified the previous version during rollout. The
version-pinned benchmark rejected those two samples; cache readbacks validated their
optimized WebP output. Preserve the distinction between rollout version mismatches and
image failures. The warm charts exclude that startup.

The local comparison covers five allocations, including four and eight basic
quarter-CPU containers, and retains the Worker request flow, deduplication and
persistence. All 7,400 fresh outputs matched Sharp bytes; cache readbacks and
50-caller deduplication passed for every profile. Local-only basic is unavailable
through the current native durable_object scheduling API; changing scheduling policy
requires a new Container application. Eight basic shards were slower and had higher
modeled cost than the recommended four-shard allocation.

In the separate eight-upload maximum-input fixture, basic charged memory reached 1,018
MiB without an OOM. That single fixture leaves little margin and does not establish
that every allowed image fits in 1 GiB. Measured memory is below the recommended
provisioned allocation; Cloudflare custom sizes require at least 3 GiB per CPU.

The final runtime-v16 deployment passed 50/50 first-provisioning images, another 600
arrivals at 20/s, two fresh bursts and 200 edge-cached readbacks. All four containers
then stopped cleanly and restarted with new boot IDs for 50/50 fresh images: p95 2.834
s, maximum 2.913 s. The first provisioning p95 was 6.397 s. Every accepted final image
decoded as the requested 640px WebP. No image or version-check failure occurred in the
final deployment check.

The public benchmark now has two charts: latency by workload and estimated monthly
cost. It uses 2.25M fresh derivatives, 10M assumed image requests, 120 KiB average
output, 0.14 consumed CPU seconds per transform, 30-day R2 retention and all replicas
awake for the full month. Four 1-CPU shards model about $122/month; the smaller pair
about $82. At the recent 101K/day snapshot, the four-shard estimate is $130/month with
the same other assumptions. Shared account allowances are assumed available, and the
estimate is not an invoice. Vercel remains faster for the measured simultaneous
galleries. Complete timings, counts, pricing sources and limitations are in [the
benchmark report](benchmarks.md).

Raw benchmark scripts, source lists and per-request responses remain in the external
research checkout. Aggregate measurements alone are committed.

## Packaged Rust release, October 6, 2026

The default Dockerfile now builds the qualified Rust service against the same
Sharp-bundled libvips 8.18.6 and WebP 1.6.0. Node and the Sharp addon are absent
from the runtime image. The former Sharp service and Dockerfile remain a
compatibility reference. Renderer v5 separates Rust derivatives from v4; runtime
v12 starts fresh containers. The two 2-CPU/6-GiB shards and encoding defaults are
unchanged so the language migration can be evaluated independently of capacity.

The release checks run the Worker transform/cache tests against the actual HTTP
Container, validate upload bounds, queued and active cancellation, deadlines,
admission and SIGTERM draining, and compare supported formats, all eight EXIF
orientations, ICC color, alpha and integer quality output against Sharp.
Both ARM64 and emulated AMD64 packages passed. These are correctness checks;
emulated AMD64 timing is not a production performance measurement.
`npm run test:container` reproduces the checks in Docker. Its delayed encoder
fixture is compiled only into a separate test image, never the production image.

## Encoder scheduling and live timing, October 6, 2026

Three alternating local trials compared encoder and libvips thread counts on
two shards, each limited to two CPUs and 3 GiB without swap. The memory limit
is a Docker test cap, not an available two-CPU Cloudflare custom allocation.
Every configuration processed 100 fresh derivatives at width 640/quality 98
and another 100 at width 1024/quality 77, with effort 4 unchanged. The gateway,
coordinator, HTTP container and delayed R2 double followed the earlier replay
method. All 3,000 fresh outputs succeeded and matched the control bytes. R2
readbacks and 50-caller deduplication passed in every configuration and round.
No build ran concurrently.

| Encoders / libvips threads per image | 640px burst p95 | 1024px burst p95 | CPU seconds per 100 1024px images |
| --- | ---: | ---: | ---: |
| 2 / 1, current | 3.264 s | 4.156 s | 17.16 |
| 2 / 2 | 3.345 s | 4.188 s | 17.18 |
| 2 / 4 | 3.335 s | 4.199 s | 17.35 |
| 4 / 1 | 3.358 s | 4.259 s | 17.51 |
| 1 / 2 | 5.722 s | 7.469 s | 16.82 |

Values are medians of three trials. More encoders or native threads did not
improve these bursts. Retain two encoders and one native thread per image for
the current two-CPU allocation. This does not establish optimal settings for
other image distributions or CPU sizes.

A separate live probe sent 60 fresh requests through Node fetch and another
60 through curl HTTP/2 at three requests/second, width 640 and quality 98.
All 120 requests succeeded and the 60 paired outputs matched exactly. Node
complete-response median/p95 was 743/1,176 ms; curl was 736/984 ms. The Node
median measured origin headers at 131 ms, upload at 43 ms, Sharp at 106 ms,
and the coordinator job at 359 ms, with no median queue wait. These overlapping
spans cannot be added. One first request included 855 ms of container startup.
Maximum full-response time was 1.559 s. No historical long body stall recurred
in this small probe; it does not establish that those failures are resolved.
The allocation and runtime remained unchanged.

## Avoiding unchanged-source encoding, October 6, 2026

Direct origins with strong ETags now retain a source validator in R2 metadata.
Once the derivative expires, an origin `304` renews the existing WebP bytes
without starting compute. Changed sources, weak or absent validators, redirects
and older cache entries use the regular transform path. Source cache-policy
changes still invalidate storage; deadlines and single-flight persistence
remain enforced. This refresh change retained renderer v4 because no encoding options or pixels
change. The evaluated FASHN media origin supports a strong ETag and returned
HTTP 304 to a conditional GET.

Three alternating local replays compared unconditional renewal with conditional
renewal. Each profile generated 100 distinct derivatives, expired their stored
freshness and stale deadlines, then requested those derivatives together. Width
640/quality 98 and width 1024/quality 77 were both evaluated. Two HTTP Sharp
containers each had two CPUs, two encoders, one native thread and a 3-GiB local
cap. Origin bodies were replayed in memory; R2 writes were delayed 300 ms and
remained outside the response dependency chain. No build ran concurrently.

| Expired, unchanged-source burst | Unconditional refresh | Conditional refresh |
| --- | ---: | ---: |
| 100 images, 640px/quality 98, median trial p95 | 3.311 s | 40 ms |
| 100 images, 1024px/quality 77, median trial p95 | 4.167 s | 27 ms |
| Source bytes per 100 renewals | 317.4 MB | 0 |
| Encoder calls per 100 renewals | 100 | 0 |
| Container preparation calls per 100 renewals | 100 | 0 |

All 2,400 initial and renewal responses succeeded and matched the control bytes.
All 600 conditional renewals avoided download, preparation and encoding. Every
result was read back from R2 without another encoder call; 50 callers continued
sharing one uncached job through delayed persistence. A separate real HTTP
origin/container integration test covers unchanged and changed source pixels,
client 304 responses, source removal and decoding. Regression checks also cover
redirects, inherited/updated cache policy, metadata limits, legacy entries,
private/no-store/no-cache transitions and cancellation of a stalled R2 read.

These local refresh timings exclude real origin, R2 and Cloudflare latency.
First-transform performance is unchanged. Refreshes still incur an origin
request, derivative read and R2 write. Savings depend on how often requested
derivatives expire while their originals remain unchanged; monthly savings
cannot be inferred from the total transformation count alone.

## Rust with libvips investigation, October 2026

A local Rust prototype linked directly to the exact native library bundled with
Sharp 0.35.4: libvips 8.18.6 and WebP 1.6.0. This differs from the earlier Rust
experiment, which used independent decoding and resizing libraries. Sharp
already processes images in native code; switching the wrapper language does
not replace libvips or its codecs. See [Sharp's concurrency documentation](https://sharp.pixelplumbing.com/performance/).

The control used the current renderer with build-time TypeScript stripping,
matching production. Both processes used jemalloc, one libvips thread per image,
and disabled operation caching. Native ARM64 Docker containers had two CPUs,
1 GiB memory and no swap. Each engine processed the same 50 gallery PNGs three
times at width 640, quality 77 and 98, and WebP effort 4. Engine order alternated
between runs; input order was shuffled. This is 300 transforms per engine,
including file reads and excluding output writes, HTTP, origin, R2 and network.
It measures sequential rendering, rather than the production two-encoder burst
or sustained-load workload.

| Measurement | Current Sharp control | Rust/libvips prototype |
| --- | ---: | ---: |
| Runtime filesystem, sum of regular-file sizes | 248.4 MB | 124.1 MB |
| Idle process RSS, median of three starts | 97.3 MiB | 15.4 MiB |
| Maximum sampled process RSS after a transform | 267.9 MiB | 89.3 MiB |
| Maximum cgroup memory, including filesystem cache | 400.5 MiB | 257.0 MiB |
| Quality 77, median / pooled p95 | 109.4 / 126.6 ms | 107.5 / 125.5 ms |
| Quality 98, median / pooled p95 | 127.4 / 150.2 ms | 125.3 / 150.9 ms |
| Quality 98, mean process CPU time | 115.0 ms | 113.4 ms |

The Rust image contains a stripped executable, the same bundled native codecs
and the same Debian runtime dependencies, without Node or the Sharp addon. It
is a rendering harness, not a complete HTTP service. Docker reported stored
image sizes of 86.6 MB for the production Sharp image and 40.5 MB for the native
prototype; filesystem sizes above are separately measured from container
exports and should not be confused with transfer sizes. HTTP runtime dependencies
would add to the Rust prototype's footprint.

All 300 corresponding gallery outputs matched byte for byte. A separate small
fixture screen covered JPEG, PNG, WebP and AVIF, all eight EXIF orientations,
P3, CMYK, grayscale, 16-bit pixels, alpha and no enlargement. Both engines
rendered all 34 valid cases and rejected four invalid/truncated cases. Of those
34 valid outputs, 32 matched exactly. Resized CMYK and 16-bit fixtures differed,
with decoded channel differences up to 8 and 30 respectively. Full-size versions
matched. These differences need investigation before adoption; gallery parity
does not establish compatibility for all supported inputs.

The initial native pipeline always requested an output ICC profile and was
slower, despite matching gallery bytes. Skipping unnecessary profile conversion
for unprofiled sRGB inputs brought it close to Sharp. Operation choices can
outweigh wrapper overhead. Three local Docker starts reached the protocol-ready
marker in median 186 ms for Sharp and 125 ms for Rust, including Docker launch
and attachment. These tiny samples do not establish Cloudflare cold-start gains,
and the marker does not mean an HTTP listener is ready.

**Initial screen decision:** retain Sharp pending HTTP qualification. Rust
offers a substantial footprint reduction in this screen, but only about a 2% median rendering improvement, with no quality-98
p95 improvement. This does not establish a meaningful capacity or delivery-time
advantage. At this stage the prototype used a minimal C FFI harness without
the production HTTP admission, concurrent encoder scheduling, deadlines,
cancellation or graceful draining. Available [Rust libvips bindings](https://github.com/olxgroup-oss/libvips-rust-bindings)
can wrap the native API, but selecting and qualifying a production binding is
separate from measuring the engine.

Lower RSS alone would not reduce the current Cloudflare bill: memory is
[billed by provisioned capacity](https://developers.cloudflare.com/containers/platform/pricing/),
and custom instances require [at least 3 GiB per vCPU](https://developers.cloudflare.com/containers/platform/limits/).
A two-vCPU container still needs 6 GiB. Smaller predefined instances also reduce
CPU allocation. A migration would need a native AMD64 comparison, output
qualification, the complete two-encoder HTTP workload, and measured Cloudflare
startup or CPU savings sufficient to justify owning another service runtime.

The research branch is `renan/rust-libvips-research`; prototypes and raw results
remain outside the normal checkout. No production implementation, allocation or
deployment changed for this investigation.

## Rust HTTP qualification follow-up, October 2026

The prototype now implements the private HTTP transform protocol with Axum and
Tokio, bounded uploads, independent upload and encoder admission, deadlines,
disconnection handling and graceful shutdown. Native work retains its admission
and encoder permits until it settles, even when the caller leaves. Cancellation
signals libvips through its progress/kill API. These are research implementations;
production used Sharp during these tests.

The initial color mismatches came from operation order. Matching Sharp's
shrink-on-load, resizing, ICC conversion, autorotation and alpha handling fixed
the evaluated cases. Malformed embedded profiles use the same fallback behavior.
The final ARM64 HTTP revision passed 832 paired comparisons: all 800 successful
outputs matched byte for byte, and both engines rejected the 32 invalid or
truncated cases with HTTP 400. Inputs included JPEG, PNG, WebP and AVIF, eight
EXIF orientations, P3 and CMYK profiles, 16-bit pixels, grayscale, transparency,
no enlargement and one-pixel resize edges. Quality values included 1, 77, 98
and 100. This establishes parity for the evaluated corpus, not every possible
input. An earlier HTTP revision also matched all 352 valid AMD64 comparisons
and rejected 32 invalid cases under emulation; that does not measure native
AMD64 performance.

Thirteen HTTP contract scenarios passed for each engine, including byte and
pixel limits, stalled uploads, retryable admission rejection, expired or
abandoned queued work, active cancellation, recovery after a real native timeout
and draining an admitted upload on SIGTERM. The prototype uses a separate
research renderer identifier; no production cache entries were written.

Local integration tests exercised the actual Worker gateway, coordinator,
single-flight and derivative storage modules against HTTP containers. Origins
were replayed in memory and an R2 double delayed writes by 300 ms. Every stored
derivative was read back without another transform. Fifty callers for one
uncached derivative produced one transform, including during the delayed write.
Workers Cache, real R2 latency and Cloudflare container provisioning are outside
this local workload.

Two shards ran each workload. Regular bursts used the same 50 gallery PNGs and
two adjacent widths to create 100 distinct derivatives, with three trials per
engine and allocation. There were 2,400 successful responses and 1,200 matching
Sharp/Rust output pairs. CPU allocation was enforced with no swap: two CPUs,
two encoders and 1 GiB per shard, or one CPU, one encoder and 512 MiB per shard.
The lower-memory allocations are Docker test limits, not available Cloudflare
custom instance configurations. Burst p95 values are the median of three runs.

| Measurement | Sharp HTTP | Rust HTTP |
| --- | ---: | ---: |
| Runtime filesystem, sum of regular-file sizes | 248.4 MB | 125.0 MB |
| Docker-reported stored image size | 86.6 MB | 40.9 MB |
| Idle process RSS, median of five starts | 110.6 MiB | 24.3 MiB |
| Local Docker launch to HTTP readiness, median of five starts | 326 ms | 246 ms |
| 100-image burst p95, 2 CPUs/shard, width 640, quality 98 | 3.41 s | 3.27 s |
| 100-image burst p95, 2 CPUs/shard, width 1024, quality 77 | 4.12 s | 4.11 s |
| 100-image burst p95, 1 CPU/shard, width 640, quality 98 | 6.26 s | 6.09 s |
| 100-image burst p95, 1 CPU/shard, width 1024, quality 77 | 7.86 s | 7.82 s |
| Maximum cgroup memory across regular 2-CPU bursts | 351 MiB | 310 MiB |
| Maximum cgroup memory across regular 1-CPU bursts | 302 MiB | 237 MiB |
| Initial sustained 20 images/second, 600 images, p95 | 260 ms | 260 ms |
| Initial sustained run, CPU seconds across both shards | 79.0 s | 77.2 s |
| Initial sustained run, maximum cgroup memory | 339 MiB | 264 MiB |
| Final revision sustained repeat, 600 images, median / p95 | 171 / 285 ms | 176 / 433 ms |
| Final sustained repeat, CPU seconds across both shards | 78.9 s | 78.5 s |
| Final sustained repeat, maximum cgroup memory | 328 MiB | 286 MiB |
| Maximum-input stress, 100-image burst p95 | 12.78 s | 13.56 s |
| Maximum-input stress, maximum cgroup memory | 629 MiB | 693 MiB |

The sustained workload used width 640, quality 98, two CPUs and two encoders per
shard. Both engines completed all 600 fresh images at 20 requests/second in
each of two paired screens, with matching outputs and no failed requests. Each
was a 30-second local run, not a production capacity guarantee. Burst, startup
and the first sustained screen preceded the final removal of an extra Rust
upload buffer copy. Output and contract qualification, maximum-input stress and
the sustained workload were repeated afterward. The final sustained repeat had
a higher Rust p95 despite similar medians and CPU use; these samples do not
establish equal tail latency or a Rust speed advantage. Repository checks ran
on the host during part of the Sharp repeat; performance runs were otherwise
sequential, with no concurrent Docker build.

The stress workload padded every input to the permitted 25 MiB and included a
50-megapixel RGBA source. Both engines completed all 100 requests with matching
outputs inside the deadline and without running out of memory. Removing the
Rust buffer copy reduced its observed peak from 770 MiB to 693 MiB, but that
remains higher than Sharp's 629 MiB in the paired rerun. Rust is not uniformly
better on memory or latency. Cgroup peaks include filesystem cache and other
charged memory, rather than just process RSS. Runtime filesystem sizes and
Docker-reported stored sizes are separate measurements, not registry transfer
sizes.

**Follow-up decision:** the much smaller complete HTTP runtime makes Rust a
viable migration candidate. Local output, lifecycle and integration tests now
support proceeding to a native AMD64 and isolated Cloudflare comparison. Burst
latency and sustained medians are similar, but the final Rust sustained p95 regressed in this screen. Measured CPU savings are small, and reduced
RSS does not automatically reduce provisioned-memory charges. A production
migration must retain validation, resource limits, deadlines and deduplication,
review the native FFI ownership and packaging, and use a new renderer version.
The next comparison should use GitHub deployment automation on an isolated
research deployment and measure actual cold starts, sustained load, response
failures and billed usage before replacing the production container.

The HTTP prototype and raw measurements remain outside the normal checkout in
the research workspace. No production code, allocation or deployment changed.

## Controlled Sharp and Rust repeats, October 6, 2026

The earlier 433 ms Rust versus 285 ms Sharp p95 result placed too much weight
on one sustained run. Reexamining its request timings showed native processing
medians of 136.1 and 136.2 ms, respectively. A cluster of Rust upload and queue
delays produced most of the tail difference. This does not identify the cause
of those delays or establish that Sharp renders faster.

The Rust HTTP prototype was revised to pass the encoded libvips allocation
directly to the HTTP body through an immutable owned buffer, rather than copying
it into another allocation. The owner frees native memory after its last body
reference is released. It also enables TCP_NODELAY, cleans up libvips thread
state after each job, uses one Tokio event-loop thread and limits blocking native
threads to the encoder count. Admission, native cancellation and input-buffer
lifetimes are retained. These are research changes, not new production settings.
Sharp already returns its native encoded buffer without that extra copy and
cleans up libvips thread state. See the [Sharp native pipeline](https://github.com/lovell/sharp/blob/v0.35.4/src/pipeline.cc),
[Axum socket configuration](https://docs.rs/axum/0.8.9/axum/serve/trait.ListenerExt.html)
and [Bytes ownership API](https://docs.rs/bytes/latest/bytes/struct.Bytes.html#method.from_owner).

Both engines still use identical libvips 8.18.6, WebP 1.6.0, jemalloc, effort 4,
SIMD, one libvips thread per image and disabled operation caching. The same
native ARM64 Docker host ran each engine sequentially, without concurrent builds
or repository checks. Client arrival delay, event-loop delay and cgroup CPU
throttling were recorded. Origins were replayed from memory and R2 writes used
a 300 ms delay; these are controlled doubles, not actual Cloudflare services.
Full HTTP response bodies were read and hashed.

Six rounds compared Sharp, the previous Rust HTTP revision and the optimized
Rust revision. Each engine occupied every order position twice. Two shards each
had 2 CPUs, 6 GiB memory, two encoders and no swap. Every round sent 300 fresh
640-pixel, quality-98 derivatives at 20/s, followed by a simultaneous 100-image
1024-pixel, quality-77 burst. All 7,200 responses succeeded. Every corresponding
Rust output matched Sharp, including 4,800 comparisons across the two Rust
revisions. Every derivative was retrieved from R2 without another transform,
and 50 callers for one uncached derivative produced one transform per trial.

The following latency values are the median of six trial p95 values, rather
than a pooled p95 that can be dominated by one noisy trial. CPU and peak memory
values are also medians across trials. Each memory result is the higher of the
two shard peaks, including charged filesystem cache, rather than process RSS.

| Measurement, two 2-CPU shards | Sharp | Previous Rust | Optimized Rust |
| --- | ---: | ---: | ---: |
| 20/s sustained delivery p95 | 271 ms | 261 ms | 260 ms |
| Sustained native processing median | 136.6 ms | 135.2 ms | 134.4 ms |
| CPU seconds per 300 sustained images, both shards | 39.54 s | 39.01 s | 38.08 s |
| Sustained peak memory per shard | 325 MiB | 250 MiB | 222 MiB |
| 100-image burst delivery p95 | 4.164 s | 4.082 s | 4.091 s |
| CPU seconds per burst, both shards | 17.12 s | 16.85 s | 16.83 s |
| Burst peak memory per shard | 339 MiB | 310 MiB | 269 MiB |

There were still noisy tails. Sustained trial p95 ranged from 264 to 728 ms for
Sharp, 243 to 640 ms for the previous Rust revision, and 238 to 409 ms for the
optimized revision. Pooled p95 was 348, 276 and 272 ms, respectively. No trial
or outlier was removed. The repeats do not support the earlier claim of a
consistent Rust tail penalty, but neither do they prove that a particular socket
or ownership change caused the improvement. The single-run ablation screen
cannot establish that causal relationship. The optimized revision reduced
observed sustained CPU use by about 4%; native rendering and burst times stayed
close. Rust's native evaluation accounted for almost all its native processing
time; median task dispatch was 0.033 ms and pipeline preparation was 0.370 ms.
The native evaluation includes decoding, resizing and encoding, not only WebP.

### Smaller allocation comparison

Four balanced Sharp/Rust rounds used two shards each with 1 CPU, 3 GiB memory,
one encoder and no swap. Each engine received 120 fresh derivatives at 6/s at
640 pixels and quality 98, another 120 at 1024 pixels and quality 77, and a
simultaneous 100-image burst at 1028 pixels and quality 77. All 2,720 responses
succeeded and all 1,360 Rust/Sharp output pairs matched. R2 readback and
single-flight checks passed for every trial. Values below are medians of four
trial measurements; latency remains the median trial p95.

| Measurement, two 1-CPU shards | Sharp | Optimized Rust |
| --- | ---: | ---: |
| 6/s, 640 pixels, quality 98, delivery p95 | 197 ms | 192 ms |
| CPU seconds per 120 images, both shards | 14.70 s | 14.03 s |
| Peak memory per shard in that phase | 234 MiB | 123 MiB |
| 6/s, 1024 pixels, quality 77, delivery p95 | 280 ms | 275 ms |
| CPU seconds per 120 images, both shards | 18.88 s | 18.40 s |
| Peak memory per shard in that phase | 251 MiB | 139 MiB |
| 100-image burst delivery p95 | 8.559 s | 8.306 s |
| Burst time until last complete response | 9.475 s | 9.223 s |
| Burst peak memory per shard | 255 MiB | 172 MiB |

The smaller allocation is viable for this local steady workload in either
language. Its slower burst drain follows reduced CPU allocation; lower Rust
memory did not recover two-CPU burst performance. The 6/s and 20/s phases have
different offered loads, so their latencies are not a direct allocation-speed
comparison. Fifteen-minute Vercel averages cannot establish shorter peak loads.
Cloudflare startup, response-body delivery, real origins, R2 and billing still
need measurement before changing the production allocation. Cloudflare charges
for provisioned memory; lower observed use does not by itself lower that charge.

### Optimized prototype qualification and decision

The optimized revision repeated all 832 format comparisons: all 800 successful
outputs matched exactly, and both engines rejected the same 32 invalid-input cases.
All thirteen HTTP contract scenarios passed for both engines, including active
and queued cancellation, real native deadlines, upload limits and SIGTERM drain.
A separate resource screen used the one-CPU, 3-GiB allocation with no swap.
Every source body was padded to the 25-MiB input limit, and the corpus included
one 50-megapixel RGBA source. An eight-request burst at requested width 3840 and
quality 98, followed by 40 requests at width 640 and quality 98, completed all
48 requests for each engine. All 48 output pairs, cache readbacks and delayed-write
single-flight checks passed. Peak charged memory was 862 MiB for Sharp and
834 MiB for Rust in that screen. Large native image buffers narrowed the memory
advantage substantially; regular-gallery memory is insufficient for sizing the
maximum permitted inputs. This single resource screen is not a throughput
comparison or an out-of-memory guarantee.

**Comparison decision:** Rust remains a viable smaller runtime, with similar
rendering performance and modest measured CPU savings. The controlled tests
correct the earlier emphasis on one slower Rust tail result. Rust did not provide
a large encoding-speed gain: both engines already execute the same native image
library. Either engine supported the evaluated smaller steady workload, while
large bursts required longer waiting at the reduced CPU allocation. Native AMD64
performance, actual Cloudflare provisioning and delivery, and billed usage remain
unmeasured for the Rust service. Production used Sharp during this investigation; it
did not change the deployed runtime, allocation, image quality or cache version.

The prototype and raw results remain outside the normal checkout in the
October 6 research workspace. The qualified service now lives in `container/rust/`.

## Smaller available container sizes, October 2026

A follow-up local screen used CPU and memory quotas matching available
Cloudflare sizes: two custom 2-CPU/6-GiB containers, two custom 1-CPU/3-GiB
containers, two basic containers (0.25 CPU/1 GiB each), and four basic containers.
Both Sharp and the final Rust HTTP revision were tested with two shards; the
four-basic profile used Rust. Two encoders per shard were used for the 2-CPU
control and one for the smaller sizes. Each shard still admitted eight active
jobs, with the existing bounded Worker queue and 60-second deadline unchanged.
Disk capacity did not affect the workload and was modeled only for pricing.

[Cloudflare's instance constraints](https://developers.cloudflare.com/containers/platform/limits/)
require at least 3 GiB per CPU for custom instances. Lower CPU fractions require
predefined sizes. This screen therefore tests deployable allocations, rather
than assuming a 2-CPU container can be reduced to 1 GiB because its RSS fits.
The standard-1 preset has 0.5 CPU and 4 GiB, offering less CPU and more RAM than
the evaluated custom 1-CPU/3-GiB size. Lite's 0.0625 CPU and 256 MiB were not
tested; that CPU capacity is below the measured work required for this load.

Each engine/profile completed two 100-image bursts, at width 640/quality 98 and
width 1024/quality 77; two 60-second runs of 180 fresh images at 3/second using
the same output settings; and a 30-second run of 180 fresh images at 6/second,
width 640/quality 98. There were 5,180 successful fresh responses across seven
engine/profile combinations. All successful output hashes matched the Sharp
control. R2 readbacks avoided additional transforms, and 50 callers shared one
transform in every engine/profile. No memory-limit or OOM events were recorded.
The origin replay, Worker modules and delayed R2 double were the same as the
HTTP qualification above. Runs were sequential without a concurrent build.
These are single local screens, not native AMD64 or Cloudflare measurements.

The table uses the more expensive 1024-pixel workload for the 3/second and burst
columns. Smaller 640-pixel outputs also passed. At 3/second the 1-CPU setup's p95
was 200 ms for Sharp and 206 ms for Rust at width 640, versus 202 ms and 198 ms
respectively for the baseline. At 6/second its p95 was 194 ms and 193 ms,
versus 190 ms and 192 ms for the baseline. The lower sustained rate corresponds
to roughly the busiest reported 15-minute average; it does not reveal the
instantaneous traffic spikes inside that interval.

| Allocation | Engine | Total provisioned RAM | 3 fresh images/s p95 | 100-image burst p95 | Monthly memory + disk at 720 awake hours/shard |
| --- | --- | ---: | ---: | ---: | ---: |
| Two × 2 CPU / 6 GiB | Sharp | 12 GiB | 253 ms | 4.13 s | $78.49 |
| Two × 2 CPU / 6 GiB | Rust | 12 GiB | 264 ms | 4.03 s | $78.49 |
| Two × 1 CPU / 3 GiB | Sharp | 6 GiB | 260 ms | 7.78 s | $39.61 |
| Two × 1 CPU / 3 GiB | Rust | 6 GiB | 268 ms | 7.71 s | $39.61 |
| Two × basic: 0.25 CPU / 1 GiB | Sharp | 2 GiB | 10.32 s | 38.56 s | $14.41 |
| Two × basic: 0.25 CPU / 1 GiB | Rust | 2 GiB | 8.11 s | 33.74 s | $14.41 |
| Four × basic: 0.25 CPU / 1 GiB | Rust | 4 GiB | 2.07 s | 18.72 s | $28.82 |

Two basic containers accumulated substantial queues: the 6/second run took
57 seconds to finish for Sharp and 50 seconds for Rust, despite arrivals ending
after 30 seconds. Successful completion of this finite run does not establish
sustainable throughput. Four basic containers improve throughput but retain
substantially higher per-request latency. Increasing shard count also changes
other service charges, which the memory/disk column does not include.

An additional resource check sent eight simultaneous padded 25-MiB uploads to
one shard, including a synthetic uniform 50-megapixel RGBA PNG requested at
width 3840/quality 98, alongside seven gallery images. All 48 responses across
two engines and three sizes succeeded and matched the control, with healthy
containers and no OOM events. On the 1-CPU/3-GiB allocation, peak cgroup memory
was 984 MiB for Sharp and 901 MiB for Rust. The large image took 4.11 and 4.29
seconds respectively, versus 3.69 and 3.58 seconds on the baseline. Basic took
20.30 and 23.34 seconds. This checks the evaluated synthetic input, not the
maximum CPU or memory demands of every permitted 50-megapixel image.

Costs use [Cloudflare's published rates](https://developers.cloudflare.com/containers/platform/pricing/):
$0.0000025/GiB-second for provisioned memory and $0.00000007/GB-second for
provisioned disk. Custom sizes use 2 GB disk per shard and basic uses 4 GB.
The table assumes every shard remains awake for 720 hours, before included
usage; CPU, Workers, Durable Objects, R2, logs, egress, the plan fee and taxes
are additional. These are allocation costs, not total service bills. Sleeping
reduces billed time. Lower CPU allocation does not halve active CPU charges
when the same number of CPU seconds is needed to encode the images.

**Local recommendation:** two custom 1-CPU/3-GiB containers with one encoder
per shard are the best candidate for a workload around 3 fresh images/second.
They retain comparable latency at that rate and in the 6/second screen while
halving provisioned RAM. Both engines qualify in this screen, so downsizing
can be evaluated separately from the Rust migration. Large simultaneous bursts
still take about twice as long; this is not equivalent peak capacity. Keep the
current production allocation until a native AMD64 and isolated Cloudflare
confirmation checks origin latency, cold starts, queues and actual billed usage.

Raw measurements and the allocation harness remain in the research workspace.
No production configuration or deployment changed.

## Measure your deployment

Use `npm run smoke -- YOUR_ENDPOINT YOUR_SOURCE_URL --fresh` for a fresh
transform, pixel decoding, cache and ETag verification. Add `--fresh` only when
the source accepts extra query parameters. See the [deployment guide](deployment.md).

MISS responses expose `admission`, `job`, `startup` and `origin_headers` timing, plus
container `source_body`, `queue` and `sharp` timing. `container_boot` identifies
a Linux restart. Startup and source fetching overlap; timings must not be
added together. Measure complete response time separately from these spans.

The previous comparisons used small samples, limited images and sequential
runs. They do not establish multi-region p95 latency, load capacity, cost savings
or broad parity with other image services. Host placement and encoder settings
affect results; local Docker timings are not Cloudflare delivery timings. A
fresh allocation can exceed the transform deadline, now 60 seconds.

Keep experiments and raw results on research branches or outside the normal
checkout. Record region, allocation, inputs, sample count, failures and cold
versus warm behavior; summarize useful findings here. The
[archived research](https://github.com/fashn-AI/imgt/tree/b5761868f5a8f93a7a938a31c599e6f12d29d0fc/benchmark)
contains earlier methodology, reports and engine prototypes.

## Gallery burst comparison, October 2026

The previous four-job admission limit rejected 42 of 50 simultaneous requests
and 92 of 100 in a local replay. This is an admission failure, rather than
evidence that the Sharp encoder cannot process a gallery within its deadline.

The comparison replayed 50 real public PNG images, 1.1 to 4.3 megapixels and
about 3.2 MB each on average. A 100-request burst used two nearby widths for
each image. Each workload ran three times at widths 384 and 1024, with quality
75, 76, or 77 and effort 2. Two Docker containers had enforced CPU and memory
limits. Actual Worker routing/coordinator modules sent HTTP uploads to Sharp;
an in-memory R2 double delayed writes by 300 ms. Successful outputs were
decoded and their dimensions checked, then storage hits were verified to avoid
additional transforms.

| Admission and allocation per shard | 100-image success | 384 px p95 | 1024 px p95 | Peak container memory |
| --- | --- | --- | --- | --- |
| Four jobs, 1 CPU, 3 GiB | 8/100 | Not comparable: most requests rejected | Not comparable | 301 MiB |
| 64 uploads, 1 CPU, 3 GiB | 100/100 | 4.68 s | 5.60 s | 553 MiB |
| Eight active jobs, bounded waiting, 1 CPU, 3 GiB | 100/100 | 4.16 s | 5.37 s | 299 MiB |
| Eight active jobs, bounded waiting, 2 encoders, 2 CPUs, 6 GiB | 100/100 | 2.41 s | 2.92 s | 397 MiB |

The p95 columns are the median of three burst p95 observations. Memory is the
maximum cgroup peak across the regular runs, including process and filesystem
cache. Warm containers and locally replayed sources make these capacity
comparisons; they do not measure Cloudflare delivery latency or cold starts.

A separate stress run padded valid inputs to the permitted 25 MiB, with one
50-megapixel RGBA source included. A 100-request burst with 64 uploads per
container reached the 3 GiB memory limit and returned deadline failures. Eight
active jobs completed the burst within 20 seconds at 604 MiB with swap disabled
and 631 MiB in the initial run. This artificial workload checks admission memory pressure; it is
not representative of the normal gallery.

The v1 change retains one CPU and one encoder per shard, replaces
immediate burst rejection with a bounded wait before origin download, and
keeps completed-result deduplication during R2 writes. Doubling CPU capacity
helps burst latency, but these measurements do not establish that it is needed
for sustained traffic. Cloudflare bills memory by provisioned awake capacity
and CPU by active usage, so unused larger instances have a real memory cost.
See [container pricing](https://developers.cloudflare.com/containers/platform/pricing/).

Raw inputs, harnesses, per-request observations, and allocation experiments
remain outside the normal checkout. Cloudflare provisioning, origin latency,
R2, edge cache, geography, and production traffic peaks require live measurement.

### Live verification

After the GitHub deployment, a warm-container check sent 50 then 100 concurrent
requests using the same 50 public PNG sources and previously unused widths
391, 393, and 394 at quality 79. All 150 responses were cache misses and
returned valid WebP images with the requested widths, with no admission errors.

| Concurrent requests | Successful misses | Complete-response p95 | Repeated-request p95 |
| --- | --- | --- | --- |
| 50 | 50/50 | 2.836 s | 274 ms |
| 100 | 100/100 | 4.776 s | 109 ms |

Every repeated request returned an edge cache hit. The deployed smoke test
also verified image decoding, cache reuse, and conditional `304` responses.
These are individual burst observations, not a production latency SLO or a
sustained load test. The warmup requests reported zero container startup time,
so this run does not establish cold-start capacity.

## Earlier effort-2 capacity planning

A gallery burst checks admission behavior. It does not establish capacity for
several applications sharing a deployment. Count new derivatives separately
from cached delivery requests, and benchmark the actual client width and quality
settings before sizing compute. Monthly and daily totals do not reveal
sub-minute peaks.

A follow-up local comparison used the same 50 PNG sources at width 640 and
quality 98. Every request had a distinct derivative key, so no edge hits, R2
hits, or deduplication reduced encoder work. Two and four shards each used one
CPU, 3 GiB RAM, eight active jobs, and a 128-job admission bound. Each rate ran
for 60 seconds using open-loop arrivals. Storage was again an in-memory R2
double with asynchronous writes delayed by 300 ms; outputs were decoded.

| Workload | Two shards | Four shards |
| --- | --- | --- |
| 10 new derivatives/s, p95 | 166 ms | 167 ms |
| 20 new derivatives/s, p95 | 1,131 ms | 351 ms |
| CPU utilization per shard at 20/s | 87–96% | 46–51% |
| 100 simultaneous new derivatives, p95 | 4.486 s | 3.073 s |
| 200 simultaneous new derivatives, p95 | 9.134 s | 5.522 s |

Every request succeeded: 1,860 sustained requests and 300 burst requests per
allocation. Each scenario ran once, so these are individual observations,
not a statistical capacity guarantee. Four shards had useful headroom at 20
new derivatives/s. Two were close to CPU saturation at that rate, even though
they returned no errors. Queue capacity cannot compensate for a sustained
arrival rate higher than encoder throughput.

A live two-shard probe at quality 98 returned 50/50 and 100/100 valid cache
misses. The first burst included up to 5.092 seconds of startup and had an
8.649-second p95. The warm 100-request burst used nearby widths 641 and 642
and had a 5.864-second p95. Local replay latency therefore must not be treated
as Cloudflare delivery latency. Larger inputs, other formats, distant origins,
and other width/quality mixes still need representative verification.

For a rollout that targets 20 new derivatives/s with compute margin, four
existing shards are a simple capacity choice: set `containers.shards` to 4.
There is no need to add a scheduler service, a per-application pool, or automatic
scaling based on these observations. A smaller pilot can retain two shards.
That trial selected four shards. The comparison above used local replay;
verify live delivery latency and failures on your deployment.

Use production admission waits, encoder utilization, cache misses, failures,
and sub-minute traffic peaks to validate the target. Apply the same 20-second
deadline and memory bounds while increasing capacity. Keep source validation
and deduplication across applications. Treat cached delivery throughput as a
separate Worker/cache measurement because it does not start Sharp.

### Live four-shard verification

After the automatic GitHub deployment, the same 50 public PNG sources were
requested at quality 98 using fresh widths. The deployment health check
reported Cloudflare's GRU location. Four warmup requests confirmed four
distinct container boots. All succeeded; the slowest complete response took
12.524 seconds, including startup.

| Workload | Successful responses | Complete-response p95 |
| --- | --- | --- |
| 200 simultaneous new derivatives, widths 643–646 | 200/200 | 6.409 s |
| Repeat the 200-image burst | 200/200 edge hits | 362 ms |
| 20 new derivatives/s for 60 seconds, widths 650–673 | 1,200/1,200 | 1.038 s |

Every fresh request was a cache miss, and every successful output was decoded
and checked for the requested width. Repeated outputs preserved their bytes and
ETags, and a conditional request returned `304`. The deployed smoke test also
passed. The sustained test used open-loop arrivals and all four shards.

This is one live observation with this PNG sample and nearby widths, not a
production latency guarantee. It does not establish sustained cold-start
capacity, multi-region performance, or behavior for every application input.
Keep measuring representative production traffic during application rollout.

[Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)
bills memory by provisioned awake capacity and CPU by active usage. Doubling
shards doubles awake memory capacity; it does not automatically double CPU
charges for the same total transform work. Storage, Worker and Durable Object
usage, logs, and transfer are separate from the container memory estimate.

## Vercel quality comparison

A comparison of the viewer's local imgt integration and its Vercel staging
deployment found both requested the same original sources at width 384 and
quality 75, with WebP output. Downloaded files had identical dimensions.
The browser reported different density-adjusted natural widths because the
integrations use different `sizes` and `srcset` descriptors; those values
were not the files' pixel widths.

Six matched PNG sources, 1.1 to 4.3 megapixels, were encoded locally with the
current renderer. Effort 2 reproduced all six deployed imgt files byte for
byte. Effort 4 reproduced all six Vercel files byte for byte at the same width
and quality. This isolates encoder effort as the difference for these samples.
None of the sampled sources had an embedded ICC profile or transparency.

Mean file size was 9,417 bytes for imgt and 8,998 bytes for Vercel. Compared
with losslessly stored resized originals, mean RGB PSNR was 38.515 dB and
38.739 dB respectively. This is a small fidelity difference, not a general
perceptual quality score. Fabric crops showed compression loss in both
outputs. Increasing quality to 85 improved detail but raised imgt's mean
size to 14,132 bytes, so it is not required just to match these Vercel outputs.

A local sequential comparison used one libvips thread, disabled Sharp caching,
and three rounds per source. At width 640 and quality 75, effort 2 averaged
58 ms CPU per transform versus 74 ms for effort 4. At quality 98, the averages
were 68 ms and 89 ms. These are local full-transform measurements, not deployed
CPU or latency estimates.

The default now uses effort 4 with client quality unchanged. Renderer v4
isolates R2, edge cache, and container shards from the previous encoder.
The earlier capacity measurements above used effort 2; they must not be
treated as measurements of effort 4. Results cover six sources and one
width for byte parity, not all formats, profiles, or delivery sizes.

## Effort-4 capacity comparison

The earlier four-shard live capacity result used effort 2. After switching to
effort 4, a 200-image fresh quality-98 burst succeeded with an 11.401-second
p95. A sustained 20 fresh images/s run then returned admission and deadline
failures and was stopped. A separate 10/s run completed all 600 requests with
a 1.114-second p95. One container encoded this sample roughly twice as slowly
as the others. Local capacity must therefore be verified on Cloudflare.

An equal-resource local comparison used eight 1-CPU, 3-GiB shards with one
encoder each, versus four 2-CPU, 6-GiB shards with two encoders each. Both
allocate eight CPUs and 24 GiB in total. Each completed 1,800 fresh 640-pixel,
quality-98 images at 10/s and 20/s, followed by 100- and 200-image bursts.
Outputs were decoded and dimensions checked. Each scenario ran once.

| Allocation | 20/s p95 | 100-image burst p95 | 200-image burst p95 | Peak memory per shard |
| --- | --- | --- | --- | --- |
| Eight 1-CPU shards | 575 ms | 3.454 s | 6.654 s | 287 MiB |
| Four 2-CPU shards, two encoders each | 435 ms | 3.096 s | 6.782 s | 322 MiB |

The sustained run slightly favored vertical scaling; burst results were close.
These warm Docker observations exclude Cloudflare provisioning, origin
downloads and real R2 writes. No scheduler service or automatic scaling is
needed for this comparison.

### Live scaling and backend comparison

A live comparison requested the same 50 PNG sources at width 640, quality 98
and WebP format from imgt and the viewer's Vercel backend. Extra source query
parameters created distinct derivative keys without changing source bytes.
Both requests entered through the providers' GRU edge locations; Cloudflare
placed containers in North America. The 60-second sustained workload used
open-loop arrivals. All fresh responses were cache misses and decoded to valid
640-pixel WebP images. These are sequential individual runs from one client.

Every request succeeded. All 1,400 comparable fresh imgt outputs matched Vercel
byte for byte, covering the 50 sources at the main application's loader
settings. Conditional cache validation returned `304`. Sustained and cached
delivery latency were close, while Vercel handled large all-miss bursts faster.
This does not establish a multi-region latency SLO or every-input parity.

The first eight-shard allocation had one startup failure and subsequent
connection failures. Container-state restoration previously held the Durable
Object initialization gate while a platform connection waited approximately
30 seconds, exceeding the public deadline. Restoration now runs in the
background and logs failures; uploads still require bounded readiness checks.
The repeated run used fresh runtime identities: all eight boots succeeded,
with the slowest warmup response taking 9.335 seconds. The failed observations
are retained outside the checkout. This change does not guarantee platform
provisioning within the deadline.

Four 2-CPU shards use the same total eight CPUs and 24 GiB as eight smaller
shards, with fewer Durable Objects and two encoder slots each. A separate
large-input check on two such containers completed a 100-image burst including
one 50-megapixel RGBA source and other inputs padded to 25 MiB. Peak memory was
628 MiB per container with swap disabled and no memory kills. Runtime versioning restarts the containers while retaining compatible
renderer-v4 derivatives.

The live vertical comparison completed the same workload with four distinct
container boots, verified through the container API as 2 vCPUs and 6 GiB each.
All four fresh warmups succeeded; the slowest response took 7.376 seconds.

| Workload, complete-response p95 | Eight 1-CPU shards | Four 2-CPU shards | Vercel |
| --- | --- | --- | --- |
| 20 fresh images/s, 1,200 requests | 1.462 s | 1.148 s | 1.341 s |
| 50 fresh images together | 2.637 s | 1.755 s | 1.377 s |
| 200 fresh images together | 5.636 s | 6.525 s | 1.508 s |
| Repeat the 200-image burst | 222 ms | 230 ms | 193 ms |

All vertical requests succeeded, including 1,400 fresh outputs that matched
Vercel byte for byte. The repeated burst preserved every output hash and ETag,
and conditional validation returned `304`. Four larger shards are retained:
sustained traffic and the 50-image gallery burst favored that allocation,
while eight smaller shards handled the 200-image burst somewhat faster. Both
use eight total CPUs and 24 GiB; four larger shards require fewer Durable
Objects. Placement variability and the single-run method limit the comparison.

A longer confirmation run sent 3,600 additional fresh images over three
minutes at 20/s. All succeeded and matched the corresponding Vercel outputs.
Its complete-response p95 was 1.110 seconds, with the same four container boots
throughout. The deployment smoke test also passed on a separate public origin.

The result supports the tested 20-new-images/s target for this input mix. It
does not reproduce Vercel's latency for large simultaneous cache misses. Do
not increase queue limits to disguise that difference. Cached delivery is
measured separately and remains close in these observations.

At the published container memory rate, 24 GiB provisioned continuously for
a 30-day month is approximately $155 in memory charges alone, before shared
included usage. Actual awake time can reduce this estimate. CPU, disk, Worker,
Durable Object, R2, logs and network usage are separate charges. See
[Cloudflare container pricing](https://developers.cloudflare.com/containers/platform/pricing/).


## Smaller effort-4 allocations

The [benchmark page](https://imgt.fashn.ai/benchmarks) separates deployed
latency from local capacity experiments and modeled monthly charges. Its
[Markdown summary](benchmarks.md) is included in the agent documentation.

A new local replay used the same 50 PNG inputs at width 640, quality 98 and
effort 4. Docker enforced CPU and memory limits with swap disabled. Actual
routing and coordinator modules uploaded to Sharp over HTTP, sources were
replayed locally, and an R2 double delayed writes by 300 ms. Timings include
output validation. Each rate ran once for 30 seconds; later bursts were separate.

| Allocation per shard | Shards | 1/s success; p95 | 5/s success; p95 | 10/s success; p95 | 20/s success; p95 | 50-image burst success; p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 CPU, 3 GiB, one encoder | 1 | 30/30; 243 ms | 150/150; 212 ms | 300/300; 7.712 s | 356/600; 16.012 s | 50/50; 6.222 s |
| 1 CPU, 3 GiB, one encoder | 2 | 30/30; 246 ms | 150/150; 216 ms | 300/300; 385 ms | 600/600; 9.612 s | 50/50; 3.443 s |
| 0.25 CPU, 1 GiB, one encoder | 4 | 30/30; 1.075 s | 150/150; 2.179 s | 298/300; 15.191 s | 309/600; 19.545 s | 50/50; 7.500 s |

P95 values include only successful requests. They do not establish capacity
when any request fails. One CPU rejected 244 requests at 20/s. Two CPUs
completed that arrival window but needed another ten seconds to drain their
growing queue; this is overload rather than sustained 20/s capacity. At 10/s,
one CPU needed another eight seconds to drain, while two CPUs kept up.
The fractional allocation returned deadline, admission and service failures at
higher rates. A 200-image burst completed 128/200 on one CPU, 200/200 on two
CPUs (12.648 s p95), and 149/200 on four quarter-CPU shards.

Peak regular container memory was 334 MiB, 272 MiB and 259 MiB respectively.
CPU usage at 5/s was about 0.12 to 0.14 consumed seconds per fresh transform.
These observations exclude Cloudflare placement and provisioning, remote source
fetching and actual R2 latency. They do not establish deployed performance.

Cloudflare custom containers require at least 3 GiB per CPU. The published
`basic` tier provides 0.25 CPU and 1 GiB, but the native start API documentation
and current Workers types omit that named tier. Its local resource experiment
does not establish compatibility with this project's native deployment API.
See [instance limits](https://developers.cloudflare.com/containers/platform/limits/)
and the [native API](https://developers.cloudflare.com/containers/api/durable-object-container/).

At continuously awake capacity, custom allocations reserve 3 GiB for one CPU,
6 GiB for two total CPUs and 24 GiB for eight total CPUs. Provisioned memory,
Durable Object duration and disk make spare capacity costly even when encoding
CPU usage is low. The public cost calculator includes these components and
explicit account-allowance assumptions; memory-only estimates are not total bills.
Monthly transformation counts cannot determine the uncached burst capacity
required to match Vercel delivery. Start with measured peaks and a latency target.

### Two smaller containers on Cloudflare

A temporary GitHub deployment allocated two 1-CPU, 3-GiB containers with one
encoder each. The container API confirmed both allocations running in North
America. Runtime identities changed without invalidating renderer-v4 derivatives.
The same client, sources, width and quality were used for this later trial.

The first 1/s run returned 27/30: one upstream HTTP 500 and two client timeouts at
30 seconds. Direct source checks subsequently succeeded. The failed run was
retained, and a fresh-key repeat continued through sustained rates and bursts.

| Repeat workload | Success | Complete-response p95 of successful requests |
| --- | --- | --- |
| 1/s, 30 fresh requests | 30/30 | 5.380 s |
| 5/s, 300 fresh requests | 300/300 | 1.222 s |
| 10/s, 600 fresh requests | 598/600 | 1.510 s |
| 50 fresh images together | 50/50 | 4.201 s |
| 200 fresh images together | 200/200 | 15.254 s |
| 200 cached images together | 200/200 | 467 ms |

The two failures at 10/s were client timeouts. Their causes remain unresolved;
this does not establish reliable 10/s capacity. Long successful low-rate requests
also had substantial time outside the instrumented job: one client response took
18.421 s while the job reported 385 ms with no admission or encoder queue. Do not
attribute every delivery outlier to encoder CPU, or remove those observations
from end-to-end results. Cloudflare tail recorded two canceled outcomes and no
exceptions during the repeat, with the same two container boots throughout.

All 1,178 successful fresh repeat outputs matched the existing corresponding
Vercel outputs byte for byte. All 200 repeats were edge hits, and conditional
validation returned `304`. The two-container option substantially reduces
reserved memory but was slower for fresh gallery bursts and had client timeouts.
It is an option to evaluate for modest traffic, not a verified replacement for the
20/s profile. Production returns to four 2-CPU containers with fresh runtime
identities after the trial. Cache keys and WebP output remain compatible.


### Two 2-CPU containers, traffic sizing trial

A further temporary GitHub deployment retained two independent encoders per
container but reduced routing to two shards. The container API confirmed two
2-vCPU, 6-GiB, 2,000-MB instances in North America. Sources, client location,
width 640, quality 98 and effort 4 stayed the same as the earlier comparison.
All requests used fresh derivative keys unless labeled as a repeat.

| Workload | Success | Complete-response p95 of successful requests |
| --- | --- | --- |
| First provisioning, 50 images together | 0/50; HTTP 500 | No successful responses |
| Warm 1/s, 30 fresh requests | 30/30 | 1.263 s |
| Warm 5/s, 300 fresh requests | 300/300 | 1.047 s |
| Warm 10/s, 600 fresh requests | 600/600 | 1.084 s |
| Warm 50 images together | 50/50 | 2.996 s |
| Warm 200 images together | 200/200 | 9.812 s |
| Repeat the 200-image burst | 200/200 edge hits | 280 ms |
| 50 images after a 150-second idle period, first cycle | 50/50 | 3.515 s |
| 50 images after a second 150-second idle period | 50/50 | 3.769 s |
| Warm 10/s for five minutes, 3,000 fresh requests | 2,998/3,000 | 1.094 s |

The first provisioning failure remains unresolved. Live tail connected after
that burst, and the existing Wrangler OAuth permissions could not retrieve
historical Observability events. Two sample retries later returned one retained
R2 image and one new successful transform. This does not establish where the
initial failures occurred. Retain the 50 failures rather than treating the warm
repeat as the only observation.

Both idle cycles reported new boot identities for both shards; the API confirmed
both containers stopped before the first restart. Successful maxima were 3.922 s
and 19.157 s. The warm 10/s minute had a 17.486 s maximum, the warm 200-image
burst a 28.644 s maximum, and the five-minute run a 28.885 s maximum. These
client measurements include delivery outside the instrumented transform job.
The five-minute run's two failures were client timeouts at 30 seconds.

Successful-request p95s by minute were 1.152, 1.134, 1.061, 0.993 and 1.090 s.
Admission p95 was zero and encoder queue p95 was 45.9 ms; the same two boots
remained throughout. These results do not establish a CPU saturation cause for
the timeouts, or prove that increasing CPU fixes delivery failures.

All 4,282 successful fresh responses across the warm trial, the idle restarts,
and the five-minute confirmation matched the prior corresponding Vercel bytes.
Cache repeats and conditional 304 validation passed. The two-container profile
halves provisioned memory to 12 GiB and reduces the public synthetic cost model
to $109.20/month, compared with $187.69 for four containers. These are modeled
subtotals with the calculator's assumptions, not measured bills.

The trial failed its zero-failure acceptance check. Production returns to four
2-CPU containers with fresh runtime identities, preserving renderer-v4 cached
derivatives. Four containers passed the earlier 20/s three-minute comparison;
that remains a finite observation, not a guarantee of future delivery reliability.
The smaller profile is retained in the benchmark page as an experiment, rather
than a verified production recommendation. Raw request data stays outside the
normal checkout.


### Two-container reliability repeat

A second two-2-CPU-container deployment retained renderer v4, quality 98, width
640, two encoders per container, the 20-second transform deadline and the same
50 public PNG sources. The client waited up to 60 seconds and recorded response
header time separately from complete-body time. Logs were attached before the
GitHub deployment. Cloudflare confirmed two 2-vCPU, 6-GiB instances in ENAM.

| Workload | Success | Complete-response p95 | Maximum successful response |
| --- | --- | --- | --- |
| First provisioning, 50 fresh images | 50/50 | 8.862 s | 9.201 s |
| 3/s for five minutes | 900/900 | 1.105 s | 1.453 s |
| 10/s for five minutes | 2,999/3,000 | 1.099 s | 3.766 s |
| 50 fresh images together | 50/50 | 2.988 s | 3.173 s |
| 200 fresh images together | 200/200 | 9.208 s | 10.292 s |
| Repeat 200 images | 200/200 edge hits | 223 ms | 408 ms |
| 50 fresh images after 150 seconds idle | 50/50 | 4.131 s | 4.298 s |

No client or transformation timeouts occurred; every successful response arrived
within the earlier 30-second client limit. The one failure at 10/s was a source
HTTP 500, surfaced as HTTP 502 after 440 ms. Its transform failed after 182 ms,
not at the deadline. Repeating that same public request later generated an image
successfully in 799 ms. All 4,252 successful fresh responses, including that
retry and idle restart, matched the existing Vercel bytes. New boot identities
confirmed both containers restarted for the final burst.

This establishes an upstream failure for this specific request, not a cause for
the earlier client timeouts or first provisioning failures. Longer client waiting
did not recover an over-30-second response in this repeat. Those earlier failures
remain part of the evidence. More containers cannot prevent an origin HTTP 500.

The Worker now retries a source GET once on a network failure or HTTP 500, 502,
503 or 504, after 100 ms, before uploading an image. The retry budget is shared
across validated redirects and bounded by the original job deadline. It does not
retry rate limits, permanent source errors, responses carrying Retry-After,
container uploads, or the entire image request. Regression checks cover response
body cleanup, retry exhaustion, cancellation, redirects and source privacy.


The source-retry deployment's follow-up was interrupted by rollout resets. Its
10/s phase stopped after 414 of 3,000 planned requests: 408 succeeded, six
returned HTTP 500. The subsequent 50-image burst completed 50/50, but the
200-image burst returned 199 HTTP 500 responses and one image. The live tail
recorded `Durable Object reset because its code was updated` in the image-cache
entrypoint. Repeating that burst returned 200/200: 193 R2 images, one edge hit
and six fresh transforms. Many derivatives had completed even though delivery
failed. The load test was stopped; this is not a five-minute success result.

This identifies a reset cause for these specific HTTP 500 responses. It does not
identify the cause of the first earlier provisioning burst or two client
timeouts. The Worker now retries only Cloudflare exceptions marked retryable,
unless also marked overloaded, once after 100 ms with a newly acquired Durable
Object stub. The job rechecks R2 before doing new work. Native transform upload
streams and HTTP error responses are not replayed. Each job attempt retains
its transform deadline; reset recovery can wait beyond a single attempt's
20-second processing limit.


An immediate post-deployment burst after adding one reset retry completed 38/50:
34 fresh transforms and four retained R2 images. Eleven responses were HTTP 503
container-readiness failures and one remained HTTP 500. Successful p95 was
17.007 s and maximum 17.827 s. The strict runner stopped instead of continuing
into a sustained test. Seven reset-retry events were logged. This recovered
some work but did not establish reliable rollout delivery.

The first startup-recovery change included container start and inactivity configuration,
instead of failing all waiters at the first setup error. A healthy running
container still skips mandatory inactivity restoration, so failed background
reconnection cannot block cached delivery or warm uploads. Overload errors are
not retried. The transform and shared startup limits increase from 20 to 60
seconds, matching a preference for bounded waiting over prematurely broken
images. Admission remains 128 distinct jobs and eight active jobs per shard,
with two native encoders. Cloudflare retryable reset recovery allows up to two
retries with 100/200 ms backoff and a fresh stub; each attempt has its own bounded
transform deadline. Other HTTP failures and streamed uploads are not replayed.
Runtime v10 starts containers with the new deadline, retaining renderer-v4
output and cache keys. The smoke client waits up to 90 seconds.


The first runtime-v10 rollout burst returned no responses accepted by the
runner's exact-version guard: 39 HTTP 504 responses, four HTTP 503 responses
(three invalid-shard responses and one readiness failure), and seven responses
rejected for an unexpected Worker version. Those seven are version-check
failures, not established client timeouts. The phase lasted 76.941 seconds.
An instance inspection initially found no v10 instances, then two running ones.
Readiness logs showed one 60-second wait with `polls: 0` and `running: true`,
blocked on inactivity configuration before health checking. A later fresh smoke
request succeeded in 1.298 s, repeated at 50 ms from edge cache, with 304 passing.

Cold readiness now polls health independently of inactivity settings. Once
healthy, the existing restoration method applies those settings in the
background. The durable idle alarm still enforces the two-minute compute
shutdown. A regression check stalls the native inactivity call indefinitely
and verifies that cold readiness and a real transport upload still complete.
This keeps startup control-plane I/O out of the image-delivery dependency chain.
Mixed Worker versions and earlier invalid-shard responses remain rollout
observations; a larger allocation does not resolve them.

The next post-deployment 50-image burst returned 49 HTTP 504 responses and one
HTTP 503. Both shards stalled on their first health GET until the 60-second
readiness limit (`polls: 1`). No successful transforms were observed in that
phase, and the strict runner stopped. A later single fresh request succeeded
in 4.270 s, with startup measured at 828 ms. The live Worker already had
`durable_object_io_tasks_prevent_eviction` enabled; these failures do not
establish eviction or CPU exhaustion. Health GETs now use separate two-second
probe deadlines, allowing another connection within the shared startup limit.
A regression check covers a hung first probe, cancellation, shared startup and
a single subsequent image upload.

With bounded probes, the next immediate rollout burst completed 33/50, at
44.515 s p95 and 44.908 s maximum. Sixteen requests returned HTTP 504 and one
failed the exact-Worker-version guard. All 33 decoded outputs matched Vercel.
One shard became healthy after 40.204 s and 28 health probes; the other exhausted
60 seconds after 29 probes. A separate warm-up completed 1/2 and stopped before
sending sustained load. This is not an accepted two-container capacity result.

Cloudflare reported a [Durable Objects and Containers incident in Eastern North America](https://www.cloudflarestatus.com/incidents/z28czd65h29l)
from October 5, 17:14 to 22:35 UTC. Earlier trials overlapped it, while these
latest failures happened after the reported resolution. The affected geography
matches the containers, but the incident does not prove the cause of each failure.
Runtime v11 gives the next trial fresh shard identities while retaining the same
allocation, renderer and cached derivatives; it avoids reusing the objects that
continued failing health across rollout attempts.

### Clean two-container confirmation

Runtime v11 started two fresh Durable Object shards, each 2 vCPUs, 6 GiB RAM
and two encoders. The live Worker retained the pending-I/O compatibility flag,
renderer v4 and effort 4. The client allowed 90 seconds; job attempts allowed
60 seconds. Cloudflare placed both containers in ENAM. Exact Worker-version
checks, full-body reads, WebP decoding and Vercel byte comparisons passed.

| Workload | Success | Complete-response p95 | Maximum |
| --- | --- | --- | --- |
| Immediate provisioning burst | 50/50 | 12.394 s | 21.484 s |
| 10/s, five-minute arrival window | 3,000/3,000 | 1.571 s | 67.690 s |
| 50 fresh images together | 50/50 | 2.733 s | 2.913 s |
| 200 fresh images together | 200/200 | 10.330 s | 26.125 s |
| 200 cached images together | 200/200 | 296 ms | 533 ms |
| Recheck 20 responses slower than 20 s | 20/20 edge hits | 64 ms | 70 ms |

All 3,302 fresh outputs matched Vercel. The five-minute arrival window took
321.558 seconds to deliver its last image, including draining outstanding
requests. Admission p95 was zero and native queue p95 was 46.5 ms. Minute-by-minute
p95 values were 1.979, 1.551, 1.211, 1.261 and 2.112 seconds. Both boot IDs
remained stable during the warm run.

Eighteen sustained responses took over 20 seconds; twelve exceeded 30 seconds,
and two exceeded 60 seconds. The slowest had headers after 740 ms and an
instrumented 190 ms job, with zero admission or encoder queueing. Most of its
67.690 seconds elapsed while the client waited for the response body. The
other over-60-second response reported a 356 ms job. These delivery outliers
remain unexplained and do not establish a CPU limit. The longer client window
allowed these images to arrive; a 30-second client limit would have rejected
some successful full responses. A zero-error finite trial is not a latency or
availability guarantee, and it does not explain the previous rollout failures.

After 150 seconds with no image requests, the container API confirmed both
instances stopped. A fresh 50-image gallery restarted both and completed
50/50 at 4.237 s p95 and 12.668 s maximum, with new boot IDs. All 50 outputs
matched Vercel, bringing the clean confirmation to 3,352 byte-matched fresh
images. The two-container allocation is retained as a smaller starting point
for traffic within the tested workload. Its 20/s capacity is unverified, and
long response-body waits and historical startup failures remain unresolved.
More encoders can shorten large fresh bursts, but the measurements do not
establish that more memory fixes those delivery outliers.
