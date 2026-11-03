# Benchmarks and pricing

The [benchmark page](https://imgt.fashn.ai/benchmarks) contains response-time and
estimated-cost charts. These measurements were collected on October 6, 2026.

## Default configuration

Since November 2026 the default is an always-on 1-CPU primary container plus a
3-CPU overflow container that runs only during bursts. It replaced four 1-CPU
containers after replays of production bursts; see the
[November 2026 replay](performance.md#primary-and-overflow-containers-november-2026).
The live measurements below were collected on October 6, 2026 with fixed
allocations and do not yet include the new default. In those tests four 1-CPU
containers handled the 200-image bursts and sustained load, and the cheaper
two-1-CPU pair overloaded. Choose a configuration for your workload using the
measurements, pricing assumptions and [container sizing guide](configuration.md#container-sizes).

The target includes all FASHN projects: approximately 2.25M monthly transformations
and a busiest observed 15-minute interval of about 2.9/s. We test 3/s, 10/s and 20/s,
plus simultaneous galleries. Fifteen-minute averages do not reveal second-by-second
bursts.

## Live response times

Successful complete-response p95, including source fetch, Cloudflare request flow and
the full response body. Each configuration ran separately from a client in Brazil,
using 50 real FASHN PNG originals, width 640, quality 98, WebP effort 4 and unique
query keys. All accepted optimized responses were decoded and checked for the
requested dimensions and format. Gallery bars use warm containers. Results are finite
runs, not a global latency guarantee.

| Allocation | 50 together | 3/s | 10/s | 20/s | 200 together |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4 × 1 CPU | 2.402 s | 0.934 s | 0.942 s | 1.046 s | 6.836 s |
| 2 × 2 CPUs | 2.460 s | 1.063 s | 0.968 s | 1.282 s | 7.703 s |
| 2 × 1 CPU | 4.954 s | 0.990 s | 1.122 s | 19.857 s (7 failures) | 17.321 s |
| Vercel | 1.100 s | 1.273 s | 1.252 s | 1.219 s | 2.044 s |

The selected profile uses its final warm-gallery and 200-image burst repeat; the
original repeats remain in the timing details. The quick 3/s phase has 180 arrivals
and 10/s has 600. The two-2-CPU and four-1-CPU profiles also receive longer
confirmation at 20/s; counts and maximum response times are listed below. The
two-1-CPU 20/s entry instead includes the longer trial: 619 requests were dispatched
from a planned 3,600, with seven HTTP 429 admission errors. The run stopped after the
error threshold. Its earlier 600-request 20/s trial returned all images, but needed
48.283 seconds to finish 30 seconds of arrivals. That configuration cannot be called
sustainable at 20/s.

The smaller pair returned all 180 requests at 3/s and all 600 at 10/s. It is a budget
alternative, but slower galleries and burst overload make it a weaker production
choice when avoiding broken images is the priority.

The charts retain failure counts. Failed responses are excluded from successful
latency percentiles, never presented as fast images. The Vercel reference used here
returned all 1,830 responses as optimized images. An earlier reference run returned
three valid original PNG images under HTTP 200 instead of optimized WebP; these were
original-image fallbacks, not broken responses. imgt does not currently fall back to
the original after a transform error.

The restored pair's immediate rollout gallery accepted 48/50 responses on the expected
Worker version. The other two were rejected by the benchmark version guard. Cloudflare
tail identified the previous gateway version calling the new cache entrypoint and
returning HTTP 200 with no exception for both requests. Both retained images were
rechecked as valid 640px WebP on the new version. These were mixed-version rollout
samples, not observed broken images; they are excluded from the warm steady-state
charts. The original rejection records are retained in research.

## Smaller local containers

Production ARM64 Rust image, Docker CPU and memory quotas without swap, original
bodies replayed in memory, and R2 writes delayed 300 ms. The real Worker gateway,
coordinator, HTTP service and persistence flow are exercised. These measurements
exclude Cloudflare provisioning and real origin, R2 and network latency.

| Allocation | 50 together | 3/s | 10/s | 20/s | 200 together |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4 × 1 CPU | 2.092 s | 0.203 s | 0.243 s | 0.440 s | 7.475 s |
| 2 × 2 CPUs | 2.080 s | 0.217 s | 0.227 s | 0.339 s | 6.702 s |
| 2 × 1 CPU | 3.636 s | 0.202 s | 0.296 s | 7.501 s | 12.291 s |
| 4 × basic | 7.480 s | 1.071 s | 10.067 s | 43.184 s | 24.090 s |
| 8 × basic | 4.373 s | 0.911 s | 2.209 s | 10.767 s | 13.097 s |

All 7,400 fresh local outputs matched the Sharp control byte for byte. All 7,400 R2
readbacks avoided another transform, and 50 concurrent callers shared one uncached
transform in each profile. No out-of-memory exit occurred. At 20/s, four basic
containers needed 77.481 seconds to finish 30 seconds of arrivals; eight basic needed
43.140 seconds. Completing finite arrivals does not establish sustainable throughput.

A separate input-limit test uploaded eight simultaneous 25 MiB bodies, including a
50-megapixel RGBA image, and requested width 3840 / quality 98. All 24 outputs across
the three sizes matched Sharp. Maximum charged cgroup memory was 880 MiB for 2 CPU / 6
GiB, 951 MiB for 1 CPU / 3 GiB, and 1,018 MiB for basic / 1 GiB. This includes charged
file cache. Basic had little memory headroom in that fixture; this is not proof that
every allowed image fits in 1 GiB.

Cloudflare offers basic at 1/4 CPU and 1 GiB, but the current native durable_object
scheduling API explicitly does not accept basic. Switching scheduling policy requires
a new Container application. Basic is a local experiment, not a supported drop-in
production configuration. Custom resources have a 1-CPU minimum and 3 GiB minimum RAM
per CPU.

Other native-supported fractional presets were not benchmarked. Standard-1 reserves 4
GiB for half a CPU, so matching the same four-CPU budget would reserve 32 GiB rather
than 12 GiB. Lite's 256 MiB allocation is below the memory observed in the
allowed-input fixture; it is not qualified for these limits.

The final four-shard runtime passed another 600 arrivals at 20/s, both fresh galleries
and 200 cached edge readbacks. All four instances then stopped with exit code 0 after
idle time. Fifty new uncached images restarted all four with new boot IDs and
succeeded at p95 2.834 s, maximum 2.913 s. First provisioning returned 50/50 at p95
6.397 s, maximum 6.510 s. No image or version-check failure occurred in that final
verification.

## Estimated monthly cost

Both providers use the same modeled image workload: 2.25M fresh derivatives, 10M total
image requests, 120 KiB average output, 8.57M billed Vercel read units, 0.14 consumed
container CPU seconds per transform, and every container awake for a 30-day month.
Total image requests and output size are assumptions; Vercel cache units cannot be
translated directly into request counts.

| Allocation | Total RAM | Estimated monthly cost |
| --- | ---: | ---: |
| 4 × 1 CPU | 12 GiB | $121.52 |
| 2 × 2 CPUs | 12 GiB | $120.80 |
| 2 × 1 CPU | 6 GiB | $81.92 |
| 4 × basic (local only) | 4 GiB | $71.13 |
| 8 × basic (local only) | 8 GiB | $124.96 |
| Vercel image meters, iad1 | Managed | $250.93 |

The recent 101K/day snapshot projects to 3.03M fresh derivatives over 30 days. With
the same 10M total-request budget and other assumptions, four 1-CPU shards model
$130.01/month. One day is not a measured monthly bill or forecast guarantee.

imgt includes a $5 Workers plan, consumed CPU, provisioned RAM and disk, Durable
Object requests and awake duration, R2 storage/operations, Worker invocations/CPU and
North American container output transfer. Account allowances are shared and assumed
available. CPU usage is a local estimate, not a measured Cloudflare invoice. The model
conservatively sends every image request to R2 and the coordinator rather than
assuming edge cache hits.

A [30-day R2 lifecycle rule](deployment.md#storage-cleanup) is required for the
modeled retained storage. Source transfer, excess logging, Durable Object storage,
taxes and support time are excluded. Vercel uses iad1 on-demand image rates before
plan credits and delivery charges. These estimates are not invoices.

More horizontal replicas add provisioned RAM, disk and Durable Object awake duration.
Eight basic containers reserve more memory and model higher cost than four 1-CPU
containers, while performing worse locally. RAM allocation is largely Cloudflare's
sizing minimum, not the renderer's measured working set.

## Timing and reliability details

The transform deadline remains 60 seconds and the benchmark client limit is 90
seconds. Each shard has eight active source/upload jobs, bounded waiting,
deduplication and 128 distinct pending jobs. Basic and 1-CPU profiles use one native
encoder per shard; 2-CPU profiles use two. Each image uses one libvips thread. Queued
native work retains its slot until completion after cancellation. The two-minute idle
stop waits for active work. R2 and edge hits avoid compute.

### 4 × 1 CPU

- first-gallery-50: 50/50 succeeded; p95 6.338 s, maximum 6.559 s, total elapsed 6.607 s.
- steady-3: 180/180 succeeded; p95 0.934 s, maximum 1.361 s, total elapsed 60.325 s.
- steady-10: 600/600 succeeded; p95 0.942 s, maximum 2.597 s, total elapsed 60.598 s.
- stress-20: 3600/3600 succeeded; p95 1.046 s, maximum 5.783 s, total elapsed 181.134 s.
- burst-200: 200/200 succeeded; p95 6.836 s, maximum 7.848 s, total elapsed 7.885 s.
- cached-200: 200/200 succeeded; p95 0.205 s, maximum 0.222 s, total elapsed 1.329 s.
- gallery-50: 50/50 succeeded; p95 2.402 s, maximum 2.823 s, total elapsed 2.841 s.
- first-gallery-50-final: 50/50 succeeded; p95 6.397 s, maximum 6.510 s, total elapsed 6.553 s.
- stress-20-final: 600/600 succeeded; p95 1.126 s, maximum 2.959 s, total elapsed 31.509 s.
- burst-200-initial: 200/200 succeeded; p95 6.743 s, maximum 7.640 s, total elapsed 7.699 s.
- cached-200-initial: 200/200 succeeded; p95 0.191 s, maximum 0.206 s, total elapsed 1.416 s.
- gallery-50-initial: 50/50 succeeded; p95 2.597 s, maximum 2.832 s, total elapsed 2.847 s.
- idle-restart-50: 50/50 succeeded; p95 2.834 s, maximum 2.913 s, total elapsed 2.933 s.

### 2 × 2 CPUs

- gallery-50: 50/50 succeeded; p95 2.460 s, maximum 2.789 s, total elapsed 2.804 s.
- steady-3: 180/180 succeeded; p95 1.063 s, maximum 3.119 s, total elapsed 60.293 s.
- steady-10: 600/600 succeeded; p95 0.968 s, maximum 1.954 s, total elapsed 60.788 s.
- stress-20: 3600/3600 succeeded; p95 1.282 s, maximum 5.281 s, total elapsed 181.025 s.
- burst-200: 200/200 succeeded; p95 7.703 s, maximum 8.237 s, total elapsed 8.277 s.
- cached-200: 200/200 succeeded; p95 1.296 s, maximum 1.332 s, total elapsed 1.413 s.
- first-gallery-50: 50/50 succeeded; p95 2.837 s, maximum 2.968 s, total elapsed 3.011 s.
- rollout-first-gallery-50: 48/50 accepted by the version guard; p95 7.253 s, maximum 7.776 s, total elapsed 7.817 s.
- steady-10-five-minutes: 3000/3000 succeeded; p95 0.957 s, maximum 4.984 s, total elapsed 300.642 s.
- burst-200-initial: 200/200 succeeded; p95 7.854 s, maximum 8.592 s, total elapsed 8.645 s.
- cached-200-confirmation: 200/200 succeeded; p95 0.871 s, maximum 1.512 s, total elapsed 1.562 s.

### 2 × 1 CPU

- first-gallery-50: 50/50 succeeded; p95 9.135 s, maximum 9.497 s, total elapsed 9.568 s.
- steady-3: 180/180 succeeded; p95 0.990 s, maximum 1.205 s, total elapsed 60.352 s.
- steady-10: 600/600 succeeded; p95 1.122 s, maximum 4.551 s, total elapsed 60.830 s.
- stress-20: 612/619 succeeded (3600 planned; stopped after error threshold); p95 19.857 s, maximum 22.695 s, total elapsed 52.347 s.
- burst-200: 200/200 succeeded; p95 17.321 s, maximum 18.820 s, total elapsed 18.874 s.
- cached-200: 200/200 succeeded; p95 0.240 s, maximum 0.267 s, total elapsed 1.336 s.
- gallery-50: 50/50 succeeded; p95 4.954 s, maximum 5.198 s, total elapsed 5.217 s.

See [performance history](performance.md) for earlier trials and unresolved historical
failures. These October 6 results supersede older Sharp allocation comparisons for the
current Rust capacity decision. Earlier failures remain in the history; this bounded
test does not establish long-term reliability or Vercel-equivalent burst latency. Raw
scripts, per-request logs and source URLs stay outside the normal repository.

## Sources

- [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)
- [Native scheduling and supported sizes](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- [Container limits](https://developers.cloudflare.com/containers/platform/limits/)
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Worker pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers Cache invocation billing](https://developers.cloudflare.com/workers/cache/#pricing)
- [Vercel iad1 pricing](https://vercel.com/docs/pricing/regional-pricing/iad1)
- [Vercel image billing units](https://vercel.com/docs/image-optimization/limits-and-pricing)
