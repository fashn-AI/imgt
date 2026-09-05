# Deployment guide

## GitHub integration

The README's deploy button creates a repository in your GitHub account and
connects it to Cloudflare Workers Builds. The production deploy command is
`npx wrangler deploy`; the checked-in Wrangler build command runs `npm run check`
before upload. Keep this integration as the deployment owner. The GitHub
Actions workflow runs checks and a Docker startup check; it does not deploy.

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
| `r2_buckets[0].bucket_name` | `shop-image-derivatives` |
| `ratelimits[0].namespace_id` | A numeric string unused by your other limiters |

Keep the binding names (`DERIVATIVES`, `IMGT_TRANSFORMER`, and
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
two idle minutes. Two running shards allocate 6 GiB; the platform cap remains
four instances (12 GiB) to accommodate existing instance records during upgrades.
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
  `containers[0].max_instances` already permits four. Keep routing at or below
  the platform cap.
- To keep containers warm longer, adjust `config.containers.sleepAfter`.
- Keep the custom 1-vCPU/3-GiB allocation for large source images. The smaller
  `basic` and `lite` profiles did not pass our large-image workload; see the
  [benchmark report](../benchmark/SMALLER_CONTAINERS.md).

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

The onboarding page verifies the public API and does not edit infrastructure.
It has no administrative endpoints or credentials. Its test makes three image
requests, which count toward the IP allowance.
