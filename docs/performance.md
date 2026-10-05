# Performance

imgt uses Sharp/libvips with two container shards, each allocated 1 vCPU,
3 GiB RAM and 2,000 MB disk. Derivatives persist in R2 and Workers Cache, so
cache hits do not start a container.

## Current decisions

- **Sharp/libvips:** the evaluated alternatives did not establish an overall
  advantage while retaining the required format and color support.
- **One CPU and one encoder per shard:** the gallery comparison below completed
  50 and 100 image bursts at the existing allocation. More CPUs improved burst
  latency, but are not required to fix admission failures. Each shard accepts
  up to 128 distinct jobs, with eight active downloads or uploads. Its container
  encodes one image at a time. Earlier smaller allocations missed deadlines or
  exhausted memory on the large-image workload.
- **Late ICC conversion:** eligible RGB inputs resize before conversion to
  sRGB. Other color and depth cases use the original conversion order. Regression
  tests cover supported formats, EXIF orientation, profiles and transparency.
- **Quality 77, WebP effort 2:** higher effort produced smaller files at the
  cost of substantially longer encoding. Changing effort requires a renderer
  version bump so running containers cannot populate incompatible cache keys.
- **Two shards, two idle minutes:** stable routing deduplicates work for each
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
