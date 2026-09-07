# Contributing

Use Node.js 24. Docker is needed for container builds and local Worker testing.

```bash
npm ci
npm run check
npm run dev
```

Run `npm run format` before committing TypeScript or JavaScript changes. Use
the pinned Prettier version with its default settings. `npm run check` includes
formatting validation, typechecking, and tests.

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

For performance changes, run `npm run benchmark -- YOUR_ENDPOINT`; see
[performance notes](docs/performance.md). Report region, resource limits,
inputs, sample count, failures, and startup versus warm behavior. Keep raw
results and source images out of Git. Put exploratory engines and deployment
labs on research branches; bring back only qualified changes and concise findings.

Never commit `.env`, `.dev.vars`, credentials, or account tokens. Dependency
updates must include both the root and container lockfiles when applicable.

## Releases

After CI and a deployment smoke test pass, create a version tag and release notes
covering behavior, migration steps, and measured limitations. Test the deploy
button against a fresh installation before calling a release independently
deployable. Do not assume a green Worker build proves container readiness.

Changes to this project are distributed under the [MIT license](LICENSE).
