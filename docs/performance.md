# Performance

imgt uses Sharp/libvips with four container shards, each allocated 2 vCPUs,
6 GiB RAM and 2,000 MB disk. Derivatives persist in R2 and Workers Cache, so
cache hits do not start a container.

## Current decisions

- **Sharp/libvips:** the evaluated alternatives did not establish an overall
  advantage while retaining the required format and color support.
- **Two CPUs and two encoders per shard:** the effort-4 allocation comparison
  below measures horizontal and vertical scaling with eight total CPUs. Each
  shard still admits eight active jobs and at most 128 distinct jobs; ready
  inputs use two encoder slots. Sharp uses one libvips thread per image.
  Canceled native work retains its slot until processing settles.
- **Late ICC conversion:** eligible RGB inputs resize before conversion to
  sRGB. Other color and depth cases use the original conversion order. Regression
  tests cover supported formats, EXIF orientation, profiles and transparency.
- **Quality 77, WebP effort 4:** standard Sharp WebP effort matched the
  evaluated Vercel outputs at the same client quality. This replaces the earlier
  effort-2 throughput tradeoff. Renderer v4 isolates the new output from older
  cached images and running containers. Client quality values stay unchanged.
- **Four shards, two idle minutes:** stable routing deduplicates work for each
  derivative. The idle alarm waits for foreground requests and background
  refreshes to finish, balancing awake time against cold starts.
- **Build-time type stripping:** the container loads JavaScript to reduce
  runtime module initialization. Local startup measurements do not establish
  a Cloudflare cold-start improvement.

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
fresh allocation can also exceed the public 20-second deadline.

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
The default is now four shards. The comparison above used local replay;
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
