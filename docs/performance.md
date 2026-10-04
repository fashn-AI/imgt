# Performance

imgt uses Sharp/libvips with two container shards, each allocated 1 vCPU,
3 GiB RAM and 2,000 MB disk. Derivatives persist in R2 and Workers Cache, so
cache hits do not start a container.

## Current decisions

- **Sharp/libvips:** the evaluated alternatives did not establish an overall
  advantage while retaining the required format and color support.
- **One CPU and one encoder:** local comparisons found little benefit from
  additional CPUs for thumbnails. Each container admits four inputs but encodes
  one at a time. Smaller allocations missed deadlines or exhausted memory on
  the large-image workload.
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

MISS responses expose `job`, `startup` and `origin_headers` timing, plus
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
[archived research](https://github.com/relferreira/imgt/tree/b5761868f5a8f93a7a938a31c599e6f12d29d0fc/benchmark)
contains earlier methodology, reports and engine prototypes.
