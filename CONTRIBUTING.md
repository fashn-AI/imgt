# Contributing

Use Node.js 24. Docker is needed for container builds and local Worker testing.

```bash
npm ci
npm run check
npm run dev
```

Run `npm run format` before committing TypeScript or JavaScript changes. The
repository uses a pinned Prettier version with two-space indentation, double
quotes, semicolons, and a 100-column target. Editors can use the root
`.prettierrc.json` configuration. `npm run format:check` verifies formatting
without changing files and is included in `npm run check`, CI, and deployment
checks. Generated output and recorded benchmark data are excluded.

Open a pull request describing the problem, resulting behavior, and validation.
Keep changes focused. Preserve the small public API and avoid adding frameworks
or services unless they solve a demonstrated need. Add regression tests when
changing cache policy, validation, coordination, cancellation, or concurrency.

`src/index.ts` adapts Cloudflare bindings; service modules should remain testable
without a running Worker. The gateway checks source access before entering the
shared cache. The coordinator validates jobs and every source redirect. Keep
the deployment's allowlist consistent across those boundaries.

Run `npm run check` and `npx wrangler deploy --dry-run` before merging. CI runs
the tests and builds/starts the Linux container using native Node TypeScript.
Deployments are owned by Cloudflare's Git integration, not the CI workflow.

For performance changes, use `benchmark/containers.mjs` and report architecture,
resource limits, inputs, sample count, failures, and cold versus warm behavior.
Do not present local Docker results as Cloudflare measurements. Keep source
images out of Git; retain their URLs and measured output in the report.

Never commit `.env`, `.dev.vars`, credentials, or account tokens. Dependency
updates must include both the root and container lockfiles when applicable.

## Releases

After CI and a deployment smoke test pass, create a version tag and release notes
covering behavior, migration steps, and measured limitations. Test the deploy
button against a fresh installation before calling a release independently
deployable. Do not assume a green Worker build proves container readiness.

Changes to this project are distributed under the [MIT license](LICENSE).
