# Deployment guide

## GitHub integration

The README's deploy button creates a repository in your GitHub account and
connects it to Cloudflare Workers Builds. The production deploy command is
`npm run deploy` (equivalent to `npx wrangler deploy`). The checked-in Wrangler
build command runs `npm run check`, then `npm run build:docs` to publish the
canonical Markdown guides and `/llms-full.txt` alongside the site. Cloudflare's
GitHub integration handles deployment; no GitHub Actions workflow is required.

The deploy button requires the source repository to be public. You need Workers
Paid and an activated R2 subscription in the target account. Cloudflare builds
the Docker image remotely; the browser flow requires no local Docker daemon
or manually copied API token. See [Cloudflare's deployment flow](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
and [container builds](https://developers.cloudflare.com/containers/guides/deploy/).

After the first deployment, set the `ALLOWED_HOSTS` **Text** variable in
Cloudflare **Workers & Pages → your Worker → Settings → Variables and Secrets**,
then select **Deploy**. New installations deny image requests until it is set.
Include `images.unsplash.com` for the demo; see [source host configuration](configuration.md#allowed-source-hosts).
`keep_vars: true` preserves dashboard variables on code deployments. An explicit
`vars.ALLOWED_HOSTS` in `wrangler.jsonc` overrides that variable if you opt into
repository management.

## Deployment names

Names are scoped to the Cloudflare account. A new account can use the defaults.
For a second copy in the same account, change all of these before deploying:

| Setting in `wrangler.jsonc`  | Example for a second deployment                |
| ---------------------------- | ---------------------------------------------- |
| `name`                       | `shop-images`                                  |
| `containers[0].name`         | `shop-images-transformer`                      |
| `r2_buckets[0].bucket_name`  | `shop-image-derivatives`                       |
| `ratelimits[0].namespace_id` | A numeric string unused by your other limiters |

Keep the binding names (`DERIVATIVES`, `IMGT_NATIVE_TRANSFORMER`, and
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

Two running shards allocate 6 GiB. Containers stop after two idle minutes once
foreground requests and background image refreshes finish. Shorter idle time
reduces awake time but can cause more cold starts. Images served from Workers
Cache or R2 do not start a container. An idle, awake container can still incur
memory charges; compare active CPU time, awake hours and cache reuse for your
workload.

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

See [application defaults and fixed limits](configuration.md#application-defaults)
for widths, qualities, shards, idle time, cache lifetimes and allocation.
The smaller `basic` and `lite` resource profiles did not pass the large-image
workload; see [performance decisions](performance.md).

Changing shard count changes request routing and can temporarily run old and
new work for the same derivative during rollout. R2 contents remain valid. Keep
the shard count stable during routine releases. The per-shard queue limit and
20-second deadline remain fixed safety limits.

## Updates

### Native image updates

IMGT uses the native `ctx.container` API with `scheduling_policy:
"durable_object"`. Deploy with `npm run deploy`, then verify a fresh image with
`npm run smoke -- YOUR_ENDPOINT YOUR_SOURCE_URL --fresh`. Use a public source
that permits extra query parameters; adding parameters can invalidate signed
URLs. `/health` checks the Worker, so a successful health response alone does
not establish container readiness.

Cloudflare's [application-wide rolling deployments](https://developers.cloudflare.com/containers/configuration/rollouts/)
apply to the `default` scheduling policy. With `durable_object`, a running
container keeps its image until it stops; its next start selects the named
`sharp` image from the deployed Worker. The two-minute idle alarm waits for
foreground requests and background image refreshes to finish before
stopping. Readiness checks wait for the private container health endpoint before
uploading an image. Fresh allocation can still exceed the public 20-second
deadline; deploy success is not a promise that every image request succeeds.

When changing `transforms.webpEffort`, bump `RENDERER_VERSION` in
`container/renderer.ts` in the same change. Running native containers keep their
previous environment until restart, so the new effort needs new renderer shard
IDs and the renderer handshake to prevent old encoder output from being stored
under the new cache keys. Review the version whenever output pixels or encoding
defaults change.

Keep the existing `v1` and `v2-native-container` migration history and namespace
names. The retired `ImgtImageTransformer` export returns `410` and preserves
its historical namespace without a production binding or Container entry.
Removing an entry from this file does not delete an existing Cloudflare Container
application; retire the unused application separately without deleting namespace
data. Changing an existing application's scheduling policy is unsupported. See
Cloudflare's [scheduling migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/).

Renaming an existing native Container application is not a configuration-only
change: Wrangler checks its name against the application attached to the namespace.
The [application update API](https://developers.cloudflare.com/api/resources/containers/subresources/applications/methods/edit/)
does not expose a name field. Plan a separate replacement before changing its
checked-in name; preserve the production namespace and account for a container
restart.

Your copy deploys your commits; upstream changes do not update it automatically.
Until the first tagged release, review changes on upstream `main` and record the
commit you apply. When [releases](https://github.com/relferreira/imgt/releases)
are available, use their tags and read the migration notes. Preserve your
`ALLOWED_HOSTS`, resource names, rate-limit namespace, and custom domain
configuration when applying changes.

If your repository is a GitHub fork, sync the fork or merge the desired upstream
commit into a review branch. A repository created by the deploy button may be an
independent copy: compare upstream changes and apply them in a branch in your
copy rather than assuming GitHub's Sync fork button is available. Run
`npm ci && npm run check`, review configuration changes, and merge to your
production branch. After Workers Builds succeeds, run
`npm run smoke -- YOUR_ENDPOINT YOUR_SOURCE_URL`.

Changing the encoder or persisted cache semantics may require a derivative
namespace bump. Release notes should identify these changes; older R2 objects
remain until lifecycle cleanup. Rollbacks must keep the matching container
image available. Consult [container rollout behavior](https://developers.cloudflare.com/containers/configuration/rollouts/).

## Troubleshooting

| Symptom                                      | Check                                                                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source host is not allowed                   | Add the original image's host to the dashboard `ALLOWED_HOSTS` Text variable and select Deploy; see [source host rules](configuration.md#allowed-source-hosts). |
| Health succeeds but images fail after deploy | Check Workers Builds and container readiness logs; an existing native container uses the new image on its next start.                                           |
| Smoke test has no `EDGE` hit                 | The source must permit caching. Check its cache headers and the Worker cache configuration.                                                                     |
| Source returns 403/404/410                   | The source must be publicly accessible. imgt does not forward client credentials.                                                                               |
| HTTP 429                                     | The IP rate limiter or shard admission limit was reached; honor `Retry-After`.                                                                                  |
| HTTP 504                                     | Source download, startup, queueing, or transform exceeded the deadline. Check timing and source size.                                                           |
| Container name already exists                | Use a distinct name for a new installation; do not delete an existing application's resources.                                                                  |

The static homepage demonstrates resizing a fixed Unsplash photo. It requires
`images.unsplash.com` in the allowlist. Opening the page loads the original from
Unsplash; each click on Optimize image or Run again makes one image request
against this deployment and counts toward the IP allowance. Use the smoke
command above for full image, cache, and ETag verification.
