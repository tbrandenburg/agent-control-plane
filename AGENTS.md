# Agent Guidelines

## Important steering documents

- [Architecture](docs/ARCHITECTURE.md)
- [UI](docs/UI.md)
- [Roadmap](docs/ROADMAP.md)

## Implementation plans

- [Phase 0 — Project Setup](docs/phase_00_plan.md)
- [Phase 1 — Spawn an Agent From the Dashboard](docs/phase_01_plan.md)

## Key Pitfalls

- A step file's presence in `docs/plan/steps/closed/` is not proof its prerequisites were met — a
  gap step (00501) explicitly conditioned moving 00500 to `closed/` on its own action items being
  verified complete first, yet 00500 was found in `closed/` while none of those actions were ever
  done. Step reviewers must independently verify file existence/content, never infer completion
  from directory placement alone.
- A dashboard implementation step's own validation commands (`pnpm --filter dashboard test/build`,
  `make loc`) can all report green even when the entire feature was never built — a leftover Phase 0
  placeholder still compiles, its one placeholder test still passes, and `make loc` deliberately
  excludes dashboard client source from the budget. Step review must independently verify the
  specific files the step claims to create actually exist (e.g. `find control-plane/dashboard/src`)
  before trusting any "tests passed" claim.
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
- `control-plane/src/db.test.js` hardcodes the exact `_migrations` row list (e.g.
  `[{ filename: '001_init.sql' }]`) — adding any new migration file breaks those assertions;
  assert on `expect.arrayContaining([...])` (creation test) or on the row list being stable
  across two `openDb()` calls (idempotency test) instead of an exact, migration-count-coupled array.
- `docker-compose.yml`'s host port must be overridable (e.g. `"${HOST_PORT:-3000}:3000"`), not
  hardcoded — dev machines often already have something bound to the default port, and a
  hardcoded mapping makes `docker compose up` fail with `address already in use` with no
  indication it's a host conflict rather than an app bug. `make e2e` reads `HOST_PORT` and passes
  the matching `E2E_BASE_URL` to Playwright so CI (no conflict) and local dev (possible conflict)
  both work unmodified.
- Vitest test doubles that emit fake child-process events via `queueMicrotask`/`setTimeout` must be
  created lazily inside `mockImplementationOnce(() => makeFakeChild())`, never eagerly via
  `mockReturnValueOnce(makeFakeChild())` — the latter schedules the emit at mock-setup time, so by
  the time the production code's second `spawn()` call actually attaches listeners (e.g. after an
  intervening `await sleep(...)` in a polling loop), the event already fired with no listener and
  the test hangs until timeout.
- A bare `await fetch(url)` retry-polling loop against a port that isn't listening yet at real
  container cold-start (e.g. `sandbox/bridge.js`'s `waitForOpencode` racing `opencode serve`'s own
  startup under `sh -c "opencode serve & exec node bridge.js"`) can hang forever instead of
  rejecting fast and being retried — reproduced live: `docker logs` showed only the first log line
  for minutes although `docker exec`-ing a fresh `node -e "fetch(...)"` in the same container
  resolved instantly. Manually exec'ing the bridge after opencode was already up never reproduced
  it, only real parallel cold-start did. Fix: wrap every polling `fetch` call in a per-attempt
  `AbortController` timeout (e.g. 2s) so a single hung attempt can never block the retry loop past
  its own overall deadline.
- `sandbox/package.json`'s `opencode-ai` dependency looks "unused" if you only `grep` for it in
  `sandbox/*.js` — it is never `import`ed. It's actually essential: `npm install` puts its `opencode`
  CLI binary on `PATH` (`node_modules/.bin/opencode`), which `sandbox/Dockerfile`'s `CMD` invokes
  directly (`opencode serve ...`). Verify a Docker-image dependency's real usage with `docker build`
  + `docker run --entrypoint sh ... -c "which <bin>"` before concluding it's dead code from a
  source-grep alone.
- A dashboard component under test that polls via TanStack Query's `refetchInterval` (e.g.
  `Transcript.tsx`'s 1s poll) must be tested with **real** timers and `@testing-library/react`'s
  `waitFor` (increase its own `timeout`, not the global one) — combining `vi.useFakeTimers()` with
  `vi.advanceTimersByTimeAsync`/`vi.waitFor` on top of React Query's internal `setTimeout`-based
  scheduler reliably hangs the test past Vitest's 5s default timeout instead of ever resolving.
- `control-plane/src/sandbox.test.js`'s "real Docker integration" test reaches the host from a
  `bridge`-network container via `docker network inspect bridge`'s gateway IP (`172.17.0.1`) with a
  bare `http.createServer` fixture — this is not universally routable (observed: connections time
  out with `UND_ERR_CONNECT_TIMEOUT` rather than being refused, in an environment with restrictive
  Docker/host networking), which starves `sandbox/bridge.js`'s startup callback and makes
  `waitForHealth` time out deterministically, not flakily. Verify container→host fixture reachability
  independently (e.g. `docker run --rm --network bridge ... node -e "fetch('http://<gateway>:<port>')"`)
  before trusting a real-Docker integration test's pass/fail as signal about the code under test.

