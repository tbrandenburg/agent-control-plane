# Agent Guidelines

## Important steering documents

- [Architecture](docs/ARCHITECTURE.md)
- [UI](docs/UI.md)
- [Roadmap](docs/ROADMAP.md)

## Implementation plans

- [Phase 0 — Project Setup](docs/phase_00_plan.md)
- [Phase 1 — Spawn an Agent From the Dashboard](docs/phase_01_plan.md)

## Key Pitfalls

- Dashboard `jsdom` must stay `^29` — `jsdom@30` requires Node `^22.22.2 || ^24.15.0 || >=26.0.0`,
  which is newer than this repo's pinned `24.x` (`pnpm install` fails with `ERR_PNPM_UNSUPPORTED_ENGINE`).
- TypeScript 7 removed `compilerOptions.baseUrl` — use `paths` alone (e.g. `"@/*": ["./src/*"]`)
  without `baseUrl` in any `tsconfig.json`, or `tsc --noEmit` fails with `TS5102`.
- Root `control-plane/vitest.config.js` must set `test.include: ['src/**/*.test.js']` — without it,
  Vitest run from `control-plane/` also picks up `dashboard/src/**/*.test.tsx` (wrong environment,
  missing jsdom globals) since both live under the same workspace root.
- Biome's CSS parser rejects Tailwind v4 `@theme`/`@apply` directives by default — set
  `css.parser.tailwindDirectives: true` in `biome.json` or `biome check` fails to parse `index.css`.
- `docker compose up` auto-creates a host bind-mount directory (e.g. `./data`) as root if it doesn't
  already exist, so a non-root container user (`USER node`) fails with `unable to open database file`
  (SQLite `ERR_SQLITE_ERROR`/errcode 14) — the host directory must pre-exist with permissive ownership,
  or the container must `chown` the mounted path at startup.
- Root `.dockerignore` silently drops any path it lists from the Docker build context even if that
  path exists on the host right before `docker build` runs (e.g. `control-plane/public` built by
  `make build`) — never exclude a directory in `.dockerignore` that a Dockerfile `COPY` step expects
  to contain host-built output; add a `RUN test -f <expected-file>` guard in the Dockerfile to fail
  loudly instead of silently shipping an image missing that output.
- `docker-compose.yml`'s host port must be overridable (e.g. `"${HOST_PORT:-3000}:3000"`), not
  hardcoded — dev machines often already have something bound to the default port, and a
  hardcoded mapping makes `docker compose up` fail with `address already in use` with no
  indication it's a host conflict rather than an app bug. `make e2e` reads `HOST_PORT` and passes
  the matching `E2E_BASE_URL` to Playwright so CI (no conflict) and local dev (possible conflict)
  both work unmodified.

