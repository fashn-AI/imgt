# Deployment guide

## GitHub integration

The README's deploy button creates a repository in your GitHub account and
connects it to Cloudflare Workers Builds. The production deploy command is
`npx wrangler deploy` for the initial provisioning. After both applications and
the migrations exist, set the production deploy command to
`npm run deploy -- https://YOUR_WORKER_ENDPOINT` for gated updates. The checked-in
Wrangler build command runs `npm run check` before upload. Cloudflare's GitHub integration handles deployment; no GitHub
Actions workflow is required.

The deploy button requires the source repository to be public. You need Workers
Paid and an activated R2 subscription in the target account. Cloudflare builds
the Docker image remotely; the browser flow requires no local Docker daemon
or manually copied API token. See [Cloudflare's deployment flow](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
and [container builds](https://developers.cloudflare.com/containers/guides/deploy/).

The default sample host is `images.unsplash.com`. Replace it with your source
hosts in `wrangler.jsonc` and commit that change. Keep Git as the source of truth:
later deployments can overwrite variables edited only in the dashboard.
Do not add allowlist exceptions to application source files.

## Deployment names

Names are scoped to the Cloudflare account. A new account can use the defaults.
For a second copy in the same account, change all of these before deploying:

| Setting in `wrangler.jsonc` | Example for a second deployment |
| --- | --- |
| `name` | `shop-images` |
| `containers[0].name` | `shop-images-transformer` |
| `containers[1].name` | `shop-images-native-transformer` |
| `r2_buckets[0].bucket_name` | `shop-image-derivatives` |
| `ratelimits[0].namespace_id` | A numeric string unused by your other limiters |

Keep the binding names (`DERIVATIVES`, `IMGT_TRANSFORMER`, `IMGT_NATIVE_TRANSFORMER`, and
`IMAGE_RATE_LIMITER`) and Durable Object class names unchanged. Do not rename
an existing installation's container or bucket just to apply an upgrade.
Resource names and allowlisted hosts belong to that installation.

## Costs

Workers Paid has a $5 monthly minimum. Containers add usage charges for memory,
CPU, disk, and applicable network traffic beyond included allowances. R2 has
storage and operation charges. Workers Cache, requests, and build usage also
have their own allowances and billing rules; this is not a flat $5 hosting plan.
Use the current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/),
and [R2 pricing](https://developers.cloudflare.com/r2/pricing/) for estimates.

The default routes work to two 1-vCPU/3-GiB containers and sleeps each after
two idle minutes. Two running shards allocate 6 GiB. Native scheduling bounds
shard IDs in application code; it has no platform `max_instances` setting.
The retained legacy application has a four-instance cap to accommodate existing
instance records during upgrades. During a backend switch, both applications
can briefly have running containers until the previous backend becomes idle.
The idle timeout is 80% shorter. These are configuration changes, not guaranteed
bill reductions. More frequent cold starts are
the tradeoff; image requests served from Workers Cache or R2 do not start a
container. An idle, awake container can still incur memory charges.

At September 5, 2026 overage rates, a 3-GiB/2-GB instance costs about $0.00092
for a two-minute idle tail in memory and disk alone. Two such instances awake
continuously for 30 days would cost about $39.61 for memory/disk before included
allowances, CPU and other services. This is a cost model, not a measured bill.
Bursts amortize the idle tail; isolated transformations do not.

For context, [Cloudflare Images transformations](https://developers.cloudflare.com/images/pricing/)
cost $0.50 per 1,000 monthly unique transformations after the first 5,000:
100,000 would be $47.50 and one million $497.50 for transformation charges.
The hosted Images storage/delivery prices are separate. imgt avoids this
dependency, but self-hosting is not automatically cheaper at low volume. Compare
unique variants, cache reuse, active CPU time and awake hours for your workload.

The 120-request/minute IP limiter is approximate and local to a Cloudflare
location. It includes cache hits and is not a spending cap. Set account billing
alerts and keep `ALLOWED_HOSTS` limited to the public assets you intend to serve.

## Storage cleanup

In your derivative bucket's **Settings → Object Lifecycle Rules**, add an
expiration rule for the `derivatives/` prefix after 30 days. This is a cache:
deleted derivatives are regenerated when needed. Keep it private and use
Standard storage. The application never needs a public bucket URL or S3 keys.

Wrangler/deploy-button provisioning creates the bucket; it does not install
this lifecycle rule. Lifecycle age is measured from object creation, not last
access. Application freshness and stale deadlines are independent of cleanup.
See [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

## Capacity

Application settings live in `imgt.config.ts`. Deployment allocation lives in
`wrangler.jsonc`:

- To use four shards, change `config.containers.shards` to `4`; the checked-in
  native adapter permits at most four configured shard IDs and the retained
  `containers[0].max_instances` also permits four.
- To keep containers warm longer, adjust `config.containers.sleepAfter`.
- Keep the custom 1-vCPU/3-GiB allocation for large source images. The smaller
  `basic` and `lite` profiles did not pass our large-image workload; see the
  [performance notes](performance.md).

Our production downsize to a platform cap of two returned instance-limit errors
even after the application reported ready, with four stopped instance records
still present. Restoring the cap to four preserves the existing installation.
A fresh account may be able to use a cap of two, but that path is not yet verified.
Do not lower the cap below an existing fleet as a routine cost optimization.

Changing shard count changes request routing and can temporarily run old and
new work for the same derivative during rollout. R2 contents remain valid. Keep
the shard count stable during routine releases. The per-shard queue limit and
20-second deadline remain fixed safety limits.

## Updates

### Native Container scheduling migration

The new `imgt-native-transformer` application uses Durable Object scheduling
and the native `ctx.container` API. The `v2-native-container` migration adds a
separate SQLite Durable Object namespace. Keep the original `v1` migration,
legacy container entry and binding intact: an existing application's scheduling
policy is immutable.

For an existing installation, first deploy the configuration with
`vars.IMGT_CONTAINER_BACKEND` set to `legacy` to provision the new application.
After Workers Builds succeeds, switch the variable to `native` in Git and
deploy again. Verify `/health` returns the expected `x-imgt-container-backend`
and `x-imgt-worker-version`, then run the smoke test with a fresh source URL.
Roll back by committing `IMGT_CONTAINER_BACKEND: "legacy"`; retain both
namespaces and migration history. No derivative namespace bump is needed
because Sharp, output settings and cache semantics are unchanged.

Before switching ordinary requests, validate a controlled canary with legacy
routing retained. Set `IMGT_NATIVE_CANARY_PREFIX` to a distinct experiment ID;
only sources whose `imgt_native_eval` query begins with that ID followed by a
hyphen route to native. Existing host validation, rate limits, shard limits and
deadlines still apply. The response backend header identifies the selected
route. Remove the prefix after the experiment. A successful deployment does
not establish that the first allocation meets the image job deadline.

The repository now selects native by default. An explicit durable alarm enforces
the two-minute idle interval, in addition to the platform inactivity timeout.
The canary prefix is unset after rollout. First-use custom-image initialization
exceeded the 20-second deadline in two migration trials; later starts on the
initialized image passed. After a build, validate fresh transforms on both
configured shards and allow initialization to settle before declaring the
deployment ready. Keep these first-use failures in any performance report.
Native images do not receive a platform-managed fleet rollout: running instances
keep their image until they stop, and later starts use the new named-image digest.
The idle alarm bounds that transition; renderer changes still require a new
renderer version and derivative namespace.

### Gated updates for an existing installation

`npm run deploy -- https://YOUR_WORKER_ENDPOINT [PUBLIC_SOURCE_URL]` uploads a
candidate with ordinary traffic routed to the retained legacy application.
Wrangler's native named-image upload does not roll out the legacy application.
First, the candidate is included at 0% and its legacy route is verified using a
Worker version override. Then it receives traffic, the native shards are allowed
to reach their normal two-minute idle shutdown, and controlled canary misses
initialize the new image on both shards. Native Durable Objects cannot be tested
at 0%: their version is assigned by deployment percentages, independently of the
gateway override.

Only after both native misses return the exact current encoder bytes does the
gate promote native routing. Promotion uses `--containers-rollout none`, preserving
the image that just passed preflight. It then requires one fresh native miss per
shard on the promoted version. A failed check leaves the previous route active
or restores the verified legacy candidate; the build fails instead of reporting
the deployment ready. Each initialization phase permits at most four attempts
per shard, with 30-second client limits and ten-second retry pauses. Public image
jobs retain their existing 20-second deadline, resource limits and idle timeout.

The gate uses the existing Workers Builds authorization; it adds no credential
or public administrative endpoint. It briefly uses the existing legacy and native
applications, with normal usage charges and bounded probes. The default source
is the Unsplash sample. For another allowlist, supply an allowed, publicly cached
source that accepts extra query parameters without changing its image bytes.
The gate requires a single active production version and already-applied Durable
Object migrations. Initial provisioning and lifecycle migrations still use
`npx wrangler deploy`; verify and initialize those before normal traffic.

See [version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/)
and [Durable Object deployment routing](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/).

Wrangler 4.145.0 supports the native configuration. Refer to Cloudflare's
[scheduling migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/)
and [native API migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-container-api/).

Your copy deploys your commits; upstream releases do not update it automatically.
Use tagged releases from [imgt](https://github.com/relferreira/imgt/releases) and
read their migration notes. Preserve your `ALLOWED_HOSTS`, resource names,
rate-limit namespace, and custom domain configuration when applying changes.

If your repository is a GitHub fork, sync the fork or merge the upstream release
into a review branch. A repository created by the deploy button may be an
independent copy: compare release changes and apply them in a branch in your
copy rather than assuming GitHub's Sync fork button is available. Run
`npm ci && npm run check`, review configuration changes, and merge to your
production branch. After Workers Builds and the container rollout finish, run
`npm run smoke -- YOUR_ENDPOINT YOUR_SOURCE_URL`.

Changing the encoder or persisted cache semantics may require a derivative
namespace bump. Release notes should identify these changes; older R2 objects
remain until lifecycle cleanup. Rollbacks must keep the matching container
image available. Consult [container rollout behavior](https://developers.cloudflare.com/containers/configuration/rollouts/).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Source host is not allowed | Set `vars.ALLOWED_HOSTS` in your repo and redeploy. Wildcards do not include the parent domain. |
| Health succeeds but images fail after deploy | Wait for initial provisioning or container rollout; check Workers Builds and container logs. |
| Smoke test has no `EDGE` hit | The source must permit caching. Check its cache headers and the Worker cache configuration. |
| Source returns 403/404/410 | The source must be publicly accessible. imgt does not forward client credentials. |
| HTTP 429 | The IP rate limiter or shard admission limit was reached; honor `Retry-After`. |
| HTTP 504 | Source download, startup, queueing, or transform exceeded the deadline. Check timing and source size. |
| Container name already exists | Use a distinct name for a new installation; do not delete an existing application's resources. |

The static homepage demonstrates resizing a fixed Unsplash photo. It requires
`images.unsplash.com` in the allowlist. Opening the page loads the original from
Unsplash; each click on Optimize image or Run again makes one image request
against this deployment and counts toward the IP allowance. Use the smoke
command above for full image, cache, and ETag verification.
