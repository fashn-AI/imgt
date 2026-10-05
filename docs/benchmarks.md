# Benchmarks and pricing

The [benchmark page](https://imgt.fashn.ai/benchmarks) provides live latency
charts, smaller local allocations, and an interactive monthly cost model.
Measurements and rates were checked on October 5, 2026.

## Live comparison

Same 50 PNG sources, width 640, quality 98 and WebP effort 4. One client entered
through São Paulo edge locations; Cloudflare containers were in North America.
These were sequential single runs with warm containers. Complete-response latency
ends after the response body, before output validation.

| Workload, p95 | Four 2-CPU containers | Eight 1-CPU containers | Vercel |
| --- | --- | --- | --- |
| 20 fresh images/s, 1,200 requests | 1.148 s | 1.462 s | 1.341 s |
| 50 fresh images together | 1.755 s | 2.637 s | 1.377 s |
| 200 fresh images together | 6.525 s | 5.636 s | 1.508 s |
| 200 cached images together | 230 ms | 222 ms | 193 ms |

All requests succeeded. All 1,400 comparable fresh outputs matched Vercel byte
for byte. A separate three-minute run completed 3,600 fresh transforms at 20/s,
without errors, at a 1.110 s p95. Four-shard fresh-container warmups took up to
7.376 s and eight-shard warmups up to 9.335 s. Cold provisioning can exceed the
20-second deadline. These results do not establish a global latency SLO.

## Memory and allocation

The measured renderer does not require the full provisioned allocation. A local
100-request large-input test, including a 50-megapixel RGBA image and inputs padded
to 25 MiB, peaked at 628 MiB per container. Cloudflare custom allocations require
at least 3 GiB per CPU, so a 2-CPU container reserves at least 6 GiB. See
[resource limits](https://developers.cloudflare.com/containers/platform/limits/).

Reducing shard count or CPU capacity reduces provisioned memory charges. It also
reduces uncached burst capacity. The current production allocation remains four
2-CPU containers, with two encoders per container. Smaller configurations are
experiments, not general production recommendations. A live two-container repeat
completed 300/300 fresh transforms at 5/s with a 1.222 s p95. Its 50-image burst
was 4.201 s and its 200-image burst 15.254 s. At 10/s it completed 598/600, with
two client timeouts. The initial 1/s attempt also had an upstream error and two
client timeouts; the repeated 1/s run completed 30/30 with a 5.380 s p95. Timeout
causes remain unresolved. All 1,178 successful fresh repeat outputs matched
Vercel, and cache and conditional 304 checks passed. Detailed smaller-allocation
results are recorded in [performance notes](performance.md).

## Cost model

The public calculator uses a synthetic scenario: two million fresh derivatives,
three million total requests, 120 KiB per output, eight million billed Vercel read
units, 0.14 consumed CPU seconds per fresh transform, and every container awake
for a 30-day month. It assumes Cloudflare account allowances are available.

| Allocation | Total reserved RAM | Modeled imgt monthly subtotal |
| --- | --- | --- |
| One 1-CPU container | 3 GiB | $38.02 |
| Two 1-CPU containers | 6 GiB | $70.32 |
| Four 2-CPU containers | 24 GiB | $187.69 |
| Eight 1-CPU containers | 24 GiB | $214.14 |

The equivalent modeled Vercel image meters are $223.20 at iad1 on-demand rates,
or $359.52 at gru1 rates, before plan credits and delivery charges. These are
estimates, not bills or savings guarantees. The smaller profiles provide less
uncached throughput and have not established live parity with the larger profile.

imgt subtotals include the $5 Workers plan, provisioned container memory and disk,
consumed CPU, modeled Durable Object duration/requests, R2 Standard storage and
operations, Worker requests/CPU, and North American container output transfer.
The model conservatively sends every request through the Durable Object and R2,
adds an extra R2 read per transform, and retains 30 days of unique derivatives.
Workers use an assumed 7 ms CPU per request; Durable Objects stay active for the
container's entire awake period at 128 MB each. R2 and Durable Object excess
billing units are rounded up. These assumptions can differ from actual usage.

CPU measurements were approximately 0.12 to 0.15 seconds per transform locally.
The default rounds to 0.14. Provisioned CPUs are not billed as active continuously.
Awake time cannot be below the modeled consumed CPU requirement; allocations with
insufficient monthly CPU capacity are flagged. Uniform traffic and the two-minute
idle timeout can keep all containers awake even at modest average throughput.

Vercel write units are fresh transforms multiplied by output size rounded up to
8 KiB. Read units must come from billed usage, not image request counts; recently
cached regional reads may avoid the read meter. Two million transformations over
30 days average 0.77/s, but monthly counts cannot establish peak traffic.

Excluded: Vercel subscription, credits, CDN requests and data transfer;
source-host transfer on either provider; excess logs/traces, Durable Object storage,
and container idle/startup CPU overhead. Taxes and support time are excluded.
Shared allowances, caching, retained unique objects and geography affect costs.
Use a private `imgt` bucket with an enabled `derivatives/` lifecycle rule deleting
after 30 days, as described in [deployment](deployment.md#storage-cleanup).

Price sources:

- [Cloudflare Containers](https://developers.cloudflare.com/containers/platform/pricing/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/pricing/)
- [Vercel image billing units](https://vercel.com/docs/image-optimization/limits-and-pricing)
- [Vercel iad1 rates](https://vercel.com/docs/pricing/regional-pricing/iad1)
- [Vercel gru1 rates](https://vercel.com/docs/pricing/regional-pricing/gru1)

Raw inputs, credentials, per-request logs and research scripts are excluded from
the public site and normal repository checkout.
