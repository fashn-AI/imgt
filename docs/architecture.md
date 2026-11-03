# Architecture

imgt runs Rust/libvips in a Cloudflare Container and caches generated WebP images in
Workers Cache and a private R2 bucket. Originals are streamed to the container
and never stored. The static demo uses plain HTML, CSS, and JavaScript.
`npm run build:site` copies assets and documentation to `dist/public/` and
highlights TypeScript examples with Shiki. Syntax colors are external CSS;
the browser loads no highlighting library.

```text
GET /image?url=…&w=640&q=77
  → gateway: validate source and parameters, rate limit
  → image entrypoint: canonical, tiered Workers Cache
  → primary Durable Object: R2 lookup
      → fresh: return derivative
      → stale: return derivative, refresh in background
      → missing: fetch source → libvips → return and persist derivative
```

The gateway is uncached so equivalent public URLs share one canonical image
cache key. It applies client ETag conditions after the shared fetch; a `304`
never replaces the full image in Workers Cache. Static assets bypass the Worker.
`/health` reports availability and configured hosts without starting compute.

## Cache policy

Only derivatives are stored, under `derivatives/v5/<hash>.webp`. The key includes
source URL, width, quality, output format, and encoder effort. ETags hash the
output bytes. Absolute freshness and stale deadlines are stored in R2 metadata.

| State | Response | Container work |
| --- | --- | --- |
| Workers Cache hit | `EDGE` | None |
| Fresh R2 derivative | `R2` | None |
| R2 within its stale window | `STALE`, cached for up to 60 seconds | Background revalidation or transform |
| Expired R2 derivative, source unchanged | `R2` | None |
| Missing or expired derivative, source changed | `MISS` | Caller waits for a transform |

Source `s-maxage` or `max-age` controls freshness, with a configurable four-hour
minimum and upstream `Age` subtracted. Durations are bounded to 2,147,483,647
seconds so millisecond deadlines remain safe. The stale window defaults to
24 hours; stale response lifetimes cannot extend beyond its deadline.

Direct source responses with a strong ETag retain that validator and cache
policy alongside the derivative. On expiry, imgt sends `If-None-Match` to the
origin. A `304` renews freshness and persists the existing WebP bytes without
starting a container, downloading the original or encoding again. The client
ETag stays unchanged. Updated `304` cache directives take precedence; absent
directives retain the previous origin policy. Source validators and policy
metadata are each limited to 512 UTF-8 bytes. Weak ETags, redirects and existing
objects without a source validator use the unconditional transform path.
New images still fetch the origin and start compute concurrently. A changed
conditional source starts compute after its origin response arrives.

`private` and `no-store` sources return `403`. `no-cache` images are transformed
with `Cache-Control: no-store` and are not retained. Those policy transitions,
and source `403`, `404`, or `410`, delete existing derivatives even if encoding
fails. Temporary failures preserve old data only within its stale window.
Already delivered or edge-cached stale images can remain visible for the rest
of their short lifetime. R2 lifecycle cleanup is independent of these deadlines.

Requests for one derivative share a single-flight job. Its entry remains until
R2 persistence or invalidation settles, preventing duplicate work during cleanup.
The coordinator rechecks R2 within that job to cover races with earlier writes.

## Validation and resource limits

The gateway validates access before consulting the shared cache. The image
entrypoint creates the derivative job, and the Durable Object validates its
source, parameters, and key before calling the coordinator directly. Every
origin redirect is checked against the same `ALLOWED_HOSTS` allowlist.

Sources must use HTTPS without credentials or a custom port. Inputs are JPEG,
PNG, WebP, or AVIF, limited to 100 MiB by default and 50 megapixels. Width accepts any integer
from 1 to 3840 pixels; quality accepts any integer from 1 to 100 and defaults to 77. Each width and quality combination has a separate cache entry. Output
preserves orientation and aspect ratio, never enlarges a small source, and uses
WebP. `transforms.maxSourceBytes` in `imgt.config.ts` configures the original-file
byte limit. Declared oversized sources are rejected before upload; the Rust
service also enforces the limit on actual bytes, including chunked uploads.
Oversized inputs return `413` without being cached.

One primary Durable Object coordinates every cache miss and accepts up to 512
distinct jobs. At most 96 jobs read R2, download sources or wait for a
container at once; the others wait without downloading originals.
A dispatcher sends each upload to the always-on primary container first, with
three uploads per vCPU. When `wakeAtQueuedJobs` uploads are waiting, it starts
the larger overflow container, held by a second Durable Object, and uses both
until the overflow has been idle for its own short timeout. The primary keeps
serving while the overflow starts; a failed start is retried after five seconds.
Within a container, uploads run independently and ready inputs enter a queue with
one active native encoder per vCPU. A stalled upload does not block ready
images. Buffered inputs share a 1 GiB budget per vCPU (at least the source
limit); an upload that would exceed it fails immediately with retryable `503`
instead of waiting, so partial uploads cannot block each other. Completed results keep their
single-flight entry during R2 writes but release active capacity immediately.
Requests beyond the bounded admission limit return retryable `429`.
The 60-second deadline covers admission waiting, origin fetch, startup, upload, queueing, and
encoding. Canceled queued jobs are removed; active native processing retains
its slot until it settles so canceled work cannot overlap new work.

## Slow requests and errors

The 60-second transformation deadline starts when a distinct cache-miss job
enters the coordinator, before admission waiting. It covers that wait, source
fetch, container readiness, upload and encoding. It is not a total HTTP response
time limit: the edge cache, initial R2 lookup and network delivery can add time
outside the transform clock. Benchmarks measure the complete response separately.

An expired transform returns `504`; a full admission queue returns `429` with
`Retry-After: 1`. Container readiness failures return `503`, and the IP rate
limiter returns `429` with `Retry-After: 60`. Error responses use `no-store`.
Temporary source GET network failures and HTTP `500`, `502`, `503` or `504`
responses get one retry after 100 ms, before any container upload. That single
retry budget is shared across redirects and uses the original job deadline.
Responses with `Retry-After`, permanent errors and source rate limits are not
retried.

Cloudflare exceptions explicitly marked `retryable` get up to two image-job retries
after 100 ms and 200 ms with a fresh Durable Object stub. Exceptions marked `overloaded`
and HTTP error responses are not retried. The retried job rechecks R2 before
starting new work; each attempt retains its 60-second transform deadline.
Recovery from a reset can therefore wait longer than one transform deadline.
Container upload requests themselves are never replayed. There is no
original-image fallback.
A normal HTML image element, including the element rendered by Next.js Image,
does not implement imgt's `Retry-After` handling; an error can leave a broken image.

Within the stale window, an existing derivative is served while refreshing in
the background. A temporary refresh failure preserves that derivative until
its stale deadline. Missing derivatives and images beyond that window still
need a successful transform. Duplicate callers share the same job; retries do
not replay an in-progress container upload automatically.

## Container lifecycle and updates

`ImgtNativeImageTransformer` uses `ctx.container` with `durable_object`
scheduling. Only the configured primary and overflow IDs may start compute. Concurrent callers
share startup and private health polling. Reconnect restoration runs in the
background so an unavailable container connection cannot block cached delivery.
Uploads still require a healthy container. Startup and health checks share
bounded readiness polling. Each health GET has a two-second limit and can be
retried within the shared deadline; streamed transform uploads are not replayed.
Transient start failures wait within that deadline
instead of failing immediately. Overload errors fail without a readiness retry.
Inactivity settings are restored in the background after a cold start is healthy;
a stalled control-plane setting cannot delay uploads. The durable idle alarm
enforces compute shutdown independently. Canceling one caller does not cancel
another's startup. Transform uploads are never replayed automatically.

Each container's `idleTimeoutMs` (two minutes for the primary, 30 seconds for
the overflow) is restored on reconnect. A durable alarm also stops compute
after foreground requests and background refreshes finish, deferring while work
is active and blocking events during shutdown. Exit monitoring clears readiness
for the next request.

The `durable_object_io_tasks_prevent_eviction` compatibility flag enables
Cloudflare's [background I/O lifecycle behavior](https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/).
Pending I/O, `waitUntil()` work, and monitoring can prevent eviction for up to
15 minutes per operation while duration charges continue. The alarm enforces
our shorter container idle timeout independently of object eviction.

Renderer versions isolate R2 keys, edge keys, and container IDs. A separate
runtime version rotates container IDs when container settings change. The source
byte limit, each role's vCPU and the location hint are also part of container
IDs, so changing them automatically replaces containers that retain the previous
size, startup environment or region, keeping compatible derivatives in R2. The Worker checks
the container's renderer header before persisting bytes during rollout. Review
`RENDERER_VERSION` whenever pixels or encoding defaults change, including WebP
effort: running containers retain their previous environment until restart.
The retired `ImgtImageTransformer` export and migration history preserve the
existing installation's old namespace.

## Code and checks

- `src/index.ts`: Cloudflare bindings, entrypoints, and container wiring.
- `src/gateway.ts`, `service.ts`: public routing, shared cache, R2 state decisions.
- `src/coordinator.ts`, `jobs.ts`: typed resize jobs, admission, deduplication.
- `src/source.ts`, `options.ts`, `settings.ts`: source and configuration validation.
- `src/cache.ts`, `store.ts`, `http.ts`: cache policy, storage, response helpers.
- `src/native-container.ts`, `native-idle.ts`: startup and compute lifecycle.
- `container/`: Rust HTTP uploads, bounded native jobs and libvips; the former Sharp
  service is retained as a comparison reference.

Worker logs cover transform failures, persistence, and container starts/stops.
MISS timing reports admission waiting, job, origin headers, startup, upload, queue, and native encoding
work; spans overlap. Container boot labels identify real restarts. Its private
health endpoint reports active, queued, uploading, and in-flight jobs.

`npm run check` exercises the request flow with controlled origins and storage,
plus real HTTP uploads and the Sharp compatibility reference.
`npm run test:container` builds and tests the Rust HTTP service in Docker. `npx wrangler deploy --dry-run`
checks the bundle and Docker image. Cloudflare's tiered cache and provisioning
require a live [deployment smoke test](deployment.md#updates).
See [performance decisions](performance.md) for the current defaults.
