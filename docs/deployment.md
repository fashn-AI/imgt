# Deployment guide

## GitHub integration

The README's deploy button creates a repository in your GitHub account and
connects it to Cloudflare Workers Builds. The production deploy command is
`npm run deploy` (equivalent to `npx wrangler deploy`). The checked-in Wrangler
build command runs `npm run check`, then `npm run build:site` to publish the
site, canonical Markdown guides and `/llms-full.txt` from `dist/public/`.
Shiki highlights the TypeScript examples at build time; only static HTML and
CSS are shipped to the browser. Cloudflare's
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

After saving dashboard variables, run another production build from your
connected GitHub repository before testing images. Dashboard variable deployments
can omit the named image metadata used by native Containers, leaving `/health`
working while image requests return `503`. A full deployment through Workers
Builds restores the image references and preserves `ALLOWED_HOSTS`. Retry the
production build or push a commit to the production branch; no application code
change is needed to restore the references.

Complete the [R2 lifecycle setup](#storage-cleanup) before using the deployment
in production. The bucket is provisioned automatically; image expiration is not.

## Deployment names

Names are scoped to the Cloudflare account. A new account can use the defaults.
For a second copy in the same account, change all of these before deploying:

| Setting in `wrangler.jsonc`  | Example for a second deployment                |
| ---------------------------- | ---------------------------------------------- |
| `name`                       | `shop-images`                                  |
| `containers[0].name`         | `shop-images-transformer`                      |
| `r2_buckets[0].bucket_name`  | `shop-images`                                 |
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

**Set up an R2 lifecycle rule before production use.** Deployment creates the
private `imgt` bucket and connects it through the `DERIVATIVES` binding, but it
does not add an image expiration rule. Without one, unused cached images remain
in R2 and storage usage grows.

1. Open **R2 → imgt → Settings → Object Lifecycle Rules → Add rule**. If you
   configured a different bucket name, select that bucket.
2. Name the rule `expire-cached-images` and set its prefix to `derivatives/`.
3. Set the action to **Delete objects** after **30 days**.
4. Enable the rule and save it.

This bucket stores only optimized images, which are regenerated when requested
after deletion. Keep it private and use Standard storage. No public bucket URL,
custom domain, CORS configuration or S3 credentials are needed.

Lifecycle age is measured from object creation, not last access. Application
freshness and stale deadlines are independent of cleanup.
See [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

### Existing installations

The previous default bucket was `imgt-derivatives`. Using the new `imgt` default
starts a new cache; deployment does not rename, copy or delete the old bucket.
No cache migration is required. Add the lifecycle rule to both buckets if you
retain the old one, so its cached images also expire. Keep your existing
`bucket_name` when upgrading if you want to continue using that cache instead.

## Capacity

See [application defaults and fixed limits](configuration.md#application-defaults)
for default quality, encoding effort, shards, idle time, cache lifetimes and
fixed resource limits.
The smaller `basic` and `lite` resource profiles did not pass the large-image
workload; see [performance decisions](performance.md).

Changing shard count changes request routing and can temporarily run old and
new work for the same derivative during rollout. R2 contents remain valid. Keep
the shard count stable during routine releases. The per-shard queue limit and
20-second deadline remain fixed safety limits.

## Updates

### Native image updates

IMGT uses the native `ctx.container` API with `scheduling_policy:
"durable_object"`. Push to your connected GitHub repository's production branch
and wait for Workers Builds to finish, then verify a fresh image with
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
commit you apply. When [releases](https://github.com/fashn-AI/imgt/releases)
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
| Images return 503 after changing dashboard variables | Run a production GitHub build to restore native Container image metadata; dashboard variable deployments can omit it. |
| Smoke test has no `EDGE` hit                 | The source must permit caching. Check its cache headers and the Worker cache configuration.                                                                     |
| Source returns 403/404/410                   | The source must be publicly accessible. imgt does not forward client credentials.                                                                               |
| HTTP 429                                     | The IP rate limiter or shard admission limit was reached; honor `Retry-After`.                                                                                  |
| HTTP 504                                     | Source download, startup, queueing, or transform exceeded the deadline. Check timing and source size.                                                           |
| Container name already exists                | Use a distinct name for a new installation; do not delete an existing application's resources.                                                                  |

The static homepage demonstrates resizing a fixed Unsplash photo, starting at
1200 pixels and quality 85. Its quality selector affects only the demo; the
API's default remains 77. It shows the original JPEG size, the optimized WebP
size and the percentage change. The original size is read with a HEAD request;
if the origin does not provide it, optimization still works.
It requires
`images.unsplash.com` in the allowlist. Opening the page loads the original from
Unsplash; each click on Optimize image or Run again makes one image request
against this deployment and counts toward the IP allowance. Use the smoke
command above for full image, cache, and ETag verification.

## Website metadata

The included landing page documents the upstream imgt project. Its canonical
URL, social previews and sitemap point to `https://imgt.fashn.ai/`, so copies of
the same project page identify the original website. This is a documentation
URL, not an image endpoint for your application. Integration examples use a
placeholder that you must replace with your own deployment URL.

If you repurpose the landing page as your own website, update the site URLs and
branding in `public/index.html`, `public/sitemap.xml`, `public/robots.txt` and
`public/_headers`. The build computes the CSP hash for the structured data;
inline scripts remain restricted. The share preview is a static 1200 × 630 PNG,
with editable artwork in `public/og.svg`. Regenerate it after artwork changes:

```sh
node --input-type=module -e 'import sharp from "sharp"; await sharp("public/og.svg").png().toFile("public/og.png")'
```

`/llms.txt` links to the locally served Markdown guides and `/llms-full.txt`.
The homepage advertises its Markdown version through HTML and HTTP alternate
links. Search and agent crawlers can read these public resources; `robots.txt`
asks crawlers to skip the image API and health endpoint. Cloudflare bot controls
can enforce additional policies independently; review those settings on your
own domain if an intended crawler receives a challenge or denial.
