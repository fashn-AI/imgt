# Contributing

Use Node.js 24. Docker is needed for container builds and local Worker testing.

```bash
npm ci
cp .env.example .env
npm run check
npm run dev
```

Run `npm run format` before committing code or static asset changes. Use
the pinned Prettier version with its default settings. `npm run check` includes
formatting validation, typechecking, and tests.

Edit `.env` for local source hosts; the example permits `images.unsplash.com`.
Production source hosts are managed in Cloudflare's dashboard and preserved by
`keep_vars: true`; see [configuration](docs/configuration.md#allowed-source-hosts).

Open a pull request describing the problem, resulting behavior, and validation.
Keep changes focused. Preserve the small public API and avoid adding frameworks
or services unless they solve a demonstrated need. Add regression tests when
changing cache policy, validation, coordination, cancellation, or concurrency.

`src/index.ts` adapts Cloudflare bindings; service modules should remain testable
without a running Worker. The gateway checks source access before entering the
shared cache. The Durable Object validates incoming jobs before passing typed
jobs to the coordinator; every source redirect is checked against the same
allowlist. Keep the deployment's allowlist consistent across those boundaries.

Run `npm run check` and `npx wrangler deploy --dry-run` before merging.
GitHub Actions runs `npm run check` on every pull request.

The image service in `container/rust` is Rust linked against the libvips that
ships with Sharp. For changes there, or to `container/Dockerfile`, format with
`cargo fmt --manifest-path container/rust/Cargo.toml` and run
`npm run test:container`, which builds the Docker image and runs the
container tests against it.

Keep performance experiments, raw results and source images on research
branches or outside the normal checkout. Report region, resource limits,
inputs, sample count, failures and cold versus warm behavior. Bring back only
qualified changes and concise findings in [performance notes](docs/performance.md).

Never commit `.env`, credentials, or account tokens. Dependency
updates must include both the root and container lockfiles when applicable.

## Releases

Changes are identified by their commit on `main` until a version is tagged.
After local checks and a deployment smoke test pass, create a version tag and
release notes covering behavior, migration steps, and measured limitations.
Test the deploy button against a fresh installation before calling a release
independently deployable. Do not assume a green Worker build proves container
readiness.

Review `RENDERER_VERSION` in `container/renderer.ts` when changing image output
or encoding defaults. Changing `transforms.webpEffort` requires a version bump
so a running container with the old effort cannot populate the new cache keys.

Changes to this project are distributed under the [MIT license](LICENSE).
