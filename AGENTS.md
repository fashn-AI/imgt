# Working on imgt

imgt is a small, self-hosted image optimizer on Cloudflare. Keep it simple.

- Prefer straightforward code and existing modules. Add dependencies or
  abstractions only when they solve a concrete problem.
- Use Prettier's default settings: `npm run format`.
- Use Node.js 24. Run `npm run check` before committing and
  `npx wrangler deploy --dry-run` before merging. Docker is needed for the latter.
- Keep regression tests for changes to caching, validation, image output,
  cancellation, or concurrency.
- Keep experiments and raw benchmark results out of the normal checkout.
  Use research branches and summarize useful findings in `docs/performance.md`.

The Worker lives in `src/`, the Sharp service in `container/`, the static demo
in `public/`, and checks in `test/` and `scripts/`.
Read `docs/architecture.md` before changing request flow.
Preserve source-host validation, resource limits, deadlines, and deduplication.
Review the renderer version in `container/renderer.ts` when changing image
output or encoding defaults so incompatible results cannot share cache entries.

Deployment uses Cloudflare's GitHub integration. A push to the production branch
deploys automatically; CI checks the code but does not deploy. Verify a finished
deployment with `npm run smoke -- YOUR_ENDPOINT YOUR_SOURCE_URL`.
