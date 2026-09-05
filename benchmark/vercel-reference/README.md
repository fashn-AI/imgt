# Owned Vercel reference

This optional benchmark-only Next.js project uses Vercel's default image loader.
It is not a dependency of the Cloudflare deployment. Import the imgt repository
into a separate personal Vercel project, select this directory as the root,
and select the Next.js framework. Node 24 and dependency versions are pinned.
The landing page does not automatically request transformed images.

Only the fixed public Unsplash fixture, widths 640/1920/3840 and quality 75 are
allowed. Output is WebP. No credentials or production source data are used.
The generated image route is `/_next/image`. Optimization is disabled by default.
For a benchmark, set `IMGT_BENCHMARK_ENABLED=1` in the reference project's build
environment and redeploy. Remove it and redeploy when finished. This setting is
specific to this optional Next.js reference, not to imgt's Cloudflare Worker.

After deployment, run from the repository root:

```sh
IMGT_ENDPOINT=https://YOUR-IMGT.workers.dev \
VERCEL_ENDPOINT=https://YOUR-REFERENCE.vercel.app \
SOURCE_PREWARM=1 SAMPLES=3 \
SERVICE_OUTPUT=benchmark/services-owned.json \
node benchmark/compare-services.mjs
```

The script and manual GitHub workflow require both explicit targets, check MISS/HIT headers and output
integrity, and marks incomplete runs as failed. If cache persistence has not
settled, rerun with the same SERVICE_OUTPUT and `--settle`. Inspect quality and
bytes alongside latency: imgt q77/effort2 and Vercel q75 are different settings.
This bounded sequential sample is not a multi-region p95 or concurrency test.
Keep request volume within the account's included usage; no paid upgrade is
required for this reference. Disable/pause the reference after the investigation.

Summarize a completed report with:

```sh
node benchmark/summarize-services.mjs benchmark/services-owned.json
```
