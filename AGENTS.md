# Agent Guidelines

## Important steering documents

- [Architecture](docs/ARCHITECTURE.md)
- [UI](docs/UI.md)
- [Roadmap](docs/ROADMAP.md)

## Implementation plans

- [Phase 0 — Project Setup](docs/phase_00_plan.md)
- [Phase 1 — Spawn an Agent From the Dashboard](docs/phase_01_plan.md)

## Make targets

Run `make help` for the full list. Most common:

- `make install` — install all workspace deps
- `make run` — bring up the persistent, real docker compose stack (fresh dev bring-up); `make stop`
  to tear it down
- `make run-dev` — start the control-plane server locally via pnpm (no Docker), foreground/Ctrl+C
- `make test` / `make lint` / `make typecheck` — unit+integration tests / biome / tsc
- `make e2e` — build sandbox image, bring up the real docker compose stack, run Playwright, tear down
- `make dev-stack` / `make dev-stack-down` — isolated, ad-hoc verification stack (unique port +
  compose project + `SANDBOX_NETWORK`) safe to run alongside another already-running stack; only
  `smoke.spec.ts` is safe against it (`session-lifecycle.spec.ts` reads the default stack's DB directly)
- `make deploy` — rebuild+redeploy control-plane with the current commit's `GIT_SHA` baked in (onto
  an already-running stack, prod-like; `make run` is for a fresh full-stack bring-up)
- `make release BUMP=patch|minor|major` — bump version, tag, push, cut a GitHub release

## Validation Conventions

- **Model-resolution / config-composition changes require a real E2E gate in the same step.**
  Any implementation step whose `Changes` touch model-resolution or config-composition logic
  (non-exhaustive examples: `OPENCODE_CONFIG_CONTENT` composition, bootstrap/clone wiring,
  provider defaults, `OPENCODE_*` env vars passed into the sandbox container) **must**
  include a real, executed end-to-end prompt check in its own `Validation` → `Commands` — at
  minimum, a single real prompt against a real, already-passing session scenario (e.g.
  `opencode/big-pickle`, per step `00602`) proving a model still resolves. This check is required
  in that same step, not deferred solely to the phase's final E2E step. Background: step `00200`
  changed model-resolution logic with only `pnpm --filter control-plane test` (unit-level)
  validation; the regression this introduced went undetected for four subsequent `closed` steps
  until step `00600`'s real E2E run caught it (see `docs/phase_02_findings.md` and
  [§8](docs/ARCHITECTURE.md) for the corrected precedence-chain analysis this rule protects).

## Release Conventions

- **Use `make release BUMP=patch|minor|major` (default `patch`) to cut a release** whenever a
  merged change is meant to be deployed/tracked as a versioned artifact — e.g. after merging a PR
  that should go live, or when a maintainer asks to "cut a release"/"bump the version"/"tag a
  release". It bumps `package.json`'s `version` in the root **and every workspace package** to the
  identical new value via pnpm's own `pnpm version` (no hand-edited/out-of-sync version fields),
  requires a clean tree on `main` in sync with `origin/main`, runs `make lint typecheck test`
  first, then commits, tags (`vX.Y.Z`), pushes, and creates a GitHub release via `gh release
  create --generate-notes`. Do not hand-edit version fields or `git tag` manually — always go
  through this target so every workspace package and the git tag stay in sync.
- Not every merge needs a release — routine internal refactors, docs-only changes, or WIP commits
  on a feature branch don't warrant one. Use judgment; when in doubt, ask before bumping a version.
- After a release, `make deploy` (or CI's own deploy step) bakes the released commit's SHA into
  `GET /version` — the git tag gives that SHA a human-readable version name to cross-reference.

## Key Pitfalls

- A step file's presence in `docs/plan/steps/in-review/` (or even `closed/`) is not proof any of its
  code exists — step 00400 (WebSocket subset) was found in `in-review/` with zero corresponding
  implementation: no `ws.js`/`ws.test.js`, no `@fastify/websocket` dependency, no shared prompt
  function, no `broadcastToSession` call, and no matching commit in `git log`. Always independently
  verify the specific files a step claims to create/modify exist on disk (`ls`, `git log -- <path>`)
  before trusting its status or running its validation commands.
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
- The repo-root `workspace/` directory is **load-bearing, not scratch space** — it's
  `docker-compose.yml`'s default `WORKSPACE_HOST_PATH`, the "pre-cloned, hardcoded repo" Phase 1
  bind-mounts read-only into every sandbox container at `/workspace/repo` (`sandbox.js`). It's
  untracked (not in git) and looks like debris on a bare `ls`/`git status`, but deleting it while
  the stack is running reproduces this repo's own already-documented pitfall live: Docker
  auto-recreates it as an **empty, root-owned** directory the moment a new sandbox spawns, breaking
  every session's checked-out repo until fixed. Recoverable without host `sudo` via
  `docker run --rm -v "$(pwd)/workspace:/fix" alpine chown -R "$(id -u):$(id -g)" /fix` (root-in-
  container maps to host root by default). Treat any untracked root-level directory referenced by
  `docker-compose.yml`'s env defaults as production state, not cleanup candidate — check
  `grep -rn <dirname> docker-compose.yml` before deleting anything that "looks like" a stray folder.
- `docker compose up`'s host port binding silently defaults when the shell invoking it doesn't have
  the same `HOST_PORT` the original stack was started with (e.g. a fresh agent/CI shell vs. the
  interactive shell that ran the initial `docker compose up`) — this reproduced live as a real
  outage: rebuilding images and restarting via `docker compose up -d --build` in a shell without
  `HOST_PORT=3001` exported tried to bind the default `3000`, which collided with an unrelated
  process already on that port, and left `control-plane` down until manually restarted with the
  correct `HOST_PORT`. Before restarting any already-running compose stack, inspect the live
  container's actual port mapping first (`docker ps --format '{{.Ports}}'`) and pass it through
  explicitly, rather than trusting the compose file's own fallback default.
- 2026-08-13: `docker-compose.yml`'s default project name is derived from the directory name, so
  running `make e2e` (or any bare `docker compose ...`) from a shell that already has a same-named
  stack running on this host targets/tears down *that* stack, not an isolated one — its own
  `trap 'docker compose down -v' EXIT` would have destroyed a live instance. Verified live: a
  production-like `agent-control-plane` stack was already running on port 3001 when parallel
  subagent fixes needed E2E verification. Fix: for any ad hoc E2E verification against an
  already-populated host, always pass an explicit `-p <isolated-project-name>` plus a compose
  override file redirecting the fixed-name network (`egress-net`), the `./data` bind mount, and
  `HOST_PORT` to unused values — check `docker ps --format '{{.Ports}}'` for a free port first.
  Also note: `e2e/tests/session-lifecycle.spec.ts` hardcodes `../data/control-plane.db` (no env
  override), so it reads the *default* project's database even when the HTTP requests target an
  isolated stack's port — it cannot be run in isolation without also symlinking/overriding that
  path; prefer running only `smoke.spec.ts` (no direct DB access) for isolated verification runs.
- 2026-08-13: `pnpm run lint` runs `biome check --write .` locally, silently auto-fixing
  formatting drift so the command reports clean even when new code doesn't match Biome's actual
  formatting rules — CI's `checks` job runs the read-only `biome check .` (no `--write`) and fails
  on exactly that drift. Reproduced live: a subagent-written multi-line `for`/`test(...)` block in
  `e2e/tests/smoke.spec.ts` passed local `pnpm run lint` (which reformatted it in place without
  ever showing a diff) but failed CI's lint job on the pushed, unformatted version. Before pushing,
   run the CI-equivalent read-only `pnpm exec biome check .` (not `--write`) as a final gate, or
   always `git diff` after `pnpm run lint` to confirm nothing needed fixing.
- A step's code and tests can cite a findings doc (e.g. `docs/phase_02_findings.md`'s "Option C
  decision") by name in doc comments/test descriptions as their rationale source without that file
  ever actually being created — grep for the exact filename across the repo before trusting a step
  that references one; a plan step's own Validation section may require the doc to exist even
  though the implementation code "looks done" and its own tests pass.
- A gap step in `closed/` that documents "root-cause and fix `X`" (e.g. 00202's bootstrap
  cone-mode sparse-checkout fix) is not proof the fix landed either — reproduced live: re-running
  `pnpm --filter control-plane test` still fails `bootstrap.test.js`'s "sparse mode restricts the
  checkout to .opencode" assertion identically to how 00202 itself described it, with `bootstrap.js`
  unchanged. `git cone-mode` always includes top-level files in the repo root regardless of the
  declared cone path, which is likely the actual root cause of the test's false assumption — but
  since `bootstrap.js`/`bootstrap.test.js` are a different step's files, out-of-scope steps must not
  silently inherit and "fix" a failure that isn't theirs; treat it as a pre-existing, orthogonal
  failure (verify via `git stash` that it reproduces identically without your own changes) and
  leave it for whichever step actually owns those files.
- Registering `@fastify/websocket` with a bare `app.register(fastifyWebsocket)` (no `await`) and
  then declaring a `{ websocket: true }` route in the same synchronous tick leaves
  `request.params` (and every other route-scoped decoration) `undefined` inside the WS handler,
  even after `await app.listen(...)`/`await app.ready()` — reproduced live with a minimal
  standalone repro script. The plugin's `onRoute` hook (which wraps the route's handler to
  branch on `request.raw[kWs]`) isn't attached yet when the route is added, so the raw,
  unwrapped handler runs instead. Fix: wrap the plugin registration and the WS route
  declaration in an encapsulated child plugin (`app.register(async (instance) => { await
  instance.register(fastifyWebsocket); instance.get(path, { websocket: true }, handler); })`)
  so the `await` completes before the route is declared, without having to make the outer
  `buildServer()` itself async.
- A step that fixes one file's Biome formatting drift (e.g. step 00402 fixing `ws.test.js`) does
  not guarantee `pnpm exec biome check .` passes repo-wide afterward — reproduced live: the same
  root-level command still failed on `control-plane/dashboard/src/components/StatusBadge.test.tsx`
  (last touched by an unrelated Phase 1 commit). Always re-run the *root-level* `pnpm exec biome
  check .` (not just the targeted file) after any formatting-drift fix step, and if it surfaces
  drift in a file outside that step's own scope, raise it as its own separate gap step rather than
  silently fixing or ignoring it.
- `jsdom@29` (this repo's pinned dashboard test dependency) ships a real, network-attempting
  `WebSocket` global — unlike `fetch`, which every dashboard test already stubs, an un-stubbed WS
  hook test will try to open a real socket instead of throwing "not implemented". Any test that
  renders a component using `useSessionSocket`/raw `WebSocket` must `vi.stubGlobal('WebSocket',
  <FakeWebSocketClass>)` (a minimal `addEventListener`/`send`/`close`-only class collecting emitted
  events) before rendering, mirroring the existing `vi.stubGlobal('fetch', ...)` pattern — otherwise
  the test hangs or flakes on a real connection attempt instead of failing fast.
- `GET /api/sessions/:id` (this phase's backend) never re-exposes `wsToken` — only `POST
  /api/sessions`'s one-time response does (§6's no-rotation-yet shortcut is implemented literally:
  no `ws_token_hash`/rotation columns exist). The dashboard must capture and persist the plaintext
  token itself (e.g. `sessionStorage`, keyed by session id) at creation time for the WS hook to use
  on `/sessions/:id` — there is no server-side way to recover it later, and a page opened directly
  by URL (no stored token) is expected to render the "session token invalid, reload" state, not a
  silent hang.
- 2026-08-13: `control-plane/src/bootstrap.js`'s `bootstrapWorkspace()` (Phase 2 Step 1, closed) is
  fully implemented and unit-tested (including real-network fixtures) but is never actually called
  from `routes/sessions.js`'s `spawnSandbox()` (Step 3, closed) or anywhere else — `sandbox.js`'s
  `run()` still bind-mounts the single, global, Phase-1-era `WORKSPACE_HOST_PATH` for every session,
  so `POST /api/sessions`'s `repoOwner`/`repoName`/`teamConfigRepo` are validated but never actually
  used to clone anything — a real, still-open gap (tracked as a recommended follow-up gap step, e.g.
  `00601`, matching this repo's own `00201`/`00202`/`00301`/`00401` pattern) independent of whether
  `make e2e` itself is green. **Do not confuse this with a model-provider/E2E-blocking issue** — see
  the next bullet for how that part is actually resolved.
- The Phase 1 e2e fixture model (a hypothetical gateway-routed model requiring a provider block only
  a real Platform config repo supplies, which — per the bullet above — nothing in this stack ever
  clones) produces `session.error` / `"ProviderModelNotFoundError: ... Model not found: ..."`. The
  fix is not to build that wiring for E2E purposes: `opencode/big-pickle` (and opencode's other
  bundled `*-free` models) is a real, free, zero-credential model `opencode` resolves natively — no
  `auth.json` entry, no Platform-config-repo provider block, no gateway base URL/API key
  required — confirmed live by running the sandbox image standalone with
  only `OPENCODE_CONFIG_CONTENT='{"model":"opencode/big-pickle","autoupdate":false}'` and driving a
  full real turn through `opencode serve`'s own API. Use `opencode/big-pickle` (or any other
  zero-config bundled model — it is one convenient E2E-fixture option, not a pinned requirement) for
  any E2E/dev scenario that needs a real, working model with zero config/credential setup. This is
  purely an E2E-fixture choice — it says nothing about production model selection (unchanged,
  already supports arbitrary `providerID/modelID`) or about a target repo's own
  `opencode.json`/`opencode.jsonc` support, which is a separate, already-Phase-2 feature
  (`ARCHITECTURE.md` §8, native precedence) gated on real bootstrap wiring, not on any test model.
- A WS/SSE E2E test that sends a prompt immediately after opening/subscribing a WebSocket can race a
  fast, real model (e.g. `opencode/big-pickle`) that completes and broadcasts before the socket has
  actually finished subscribing server-side — `subscribe` (over WS) and the prompt (a separate HTTP
  connection) have no cross-connection ordering guarantee, and this phase's WS subset has no
  `fetch_history` replay (deferred to Phase 6 by design), so a missed frame is gone for good, not
  just delayed. Fix: only send the prompt from a callback fired after `subscribe` is actually sent,
  plus a small settle delay (e.g. 500ms) — trivial for a human using the dashboard, but necessary for
  an automated test racing a fast model.
- `control-plane/src/routes/internal.js`'s `broadcastToSession(id, {type: 'event', ...req.body})`
  does not actually produce a `{type: 'event', ...}` wrapper on the wire: since `req.body` (opencode's
  own native event) already carries its own `type` field, the object spread **overwrites** the
  wrapper's literal `'event'` with that inner type. Any WS consumer/test that checks for the literal
  string `'event'` will silently never match — check for the real event's own `type` value directly
  (e.g. `message.part.updated`) instead, using `properties !== undefined` (or similar) as the
  discriminator against `ping`/`prompt-result` frames if needed. Not a functional bug in the shipped
  dashboard hook (`useSessionSocket.ts` only ever filters out `pong`), but a real quirk worth knowing
  before writing any new WS consumer/test.
- When running an isolated `docker compose` stack for verification (`-p <name>`, per the host-port
  isolation pattern already documented above), also override the service's `SANDBOX_NETWORK` env var
  to the isolated project's own network name — `docker-compose.yml`'s `egress-net` is a fixed,
  non-project-prefixed name (`networks.egress-net.name: egress-net`), so an isolated stack's
  `sandbox.js`-spawned containers otherwise silently join the *other*, already-running default
  project's `egress-net` (that name already exists docker-wide) instead of the isolated one — the
  spawned sandbox container itself comes up healthy, but the isolated control-plane can never reach
  it (cross-network DNS failure manifests as a generic `SANDBOX_UNAVAILABLE`/503, easily
  misdiagnosed as a spawn failure rather than a network-isolation mistake).
- Step 00601 (closed) wired `bootstrapWorkspace()` into `spawnSandbox()` and its own unit tests
  correctly cover the new call, but its Action 7 checklist ("re-run `make build/e2e/lint/test/loc`
  and confirm green") was not actually all green at closure time: `pnpm exec biome check .`
  (the read-only gate CI's `checks` job runs, not `pnpm run lint`'s auto-fixing local wrapper)
  failed on the exact file the step modified (`sessions.js`), and `make loc` was over budget
  (1005/1000) with `sessions.js` now the single largest file. A step's own "confirm green" claim
  for a checklist of shell commands must be backed by literally re-running each command and
  reading its exit code/output — never inferred from the diff "looking clean" or from having run
  `pnpm run lint` (which silently reformats instead of failing).
- Step 00601's `bootstrapWorkspace()` wiring (closed) also silently broke `control-plane/Dockerfile`:
  it never installed `git` (only `docker.io`), so every real bootstrap attempt inside the
  `control-plane` container failed instantly with `spawn git ENOENT` — invisible in 00601's own unit
  tests (which mock `spawn`) and never caught because its own `make e2e` checklist item wasn't
  actually re-run (see the bullet above). Once `git` is installed, the *next* failure is
  `fatal: server certificate verification failed. CAfile: none CRLfile: none` — `node:24-slim` (via
  `docker.io`'s dependency chain) does not pull in `ca-certificates`, so `git`'s HTTPS clones can
  never verify GitHub's cert either; both packages (`git ca-certificates`) are required together.
  Separately (still open, out of scope for step 00602): `e2e/tests/session-lifecycle.spec.ts` hardcodes
  a placeholder `repoOwner: 'acme', repoName: 'widgets'` that was never a real, clonable GitHub repo —
  harmless before 00601 (bootstrap was never actually called, so the fake repo was never dereferenced),
  but now that bootstrap is wired for real, every happy-path session request in that spec fails at the
  git-clone step (`could not read Username for 'https://github.com'` — GitHub's real API returning 401
  for a private/nonexistent repo, not a 404) before ever reaching model resolution. Fixing this
  requires either pointing the spec at a real, public, always-clonable fixture repo or providing a
  real credential — out of scope for a stub-model-retirement step; needs its own follow-up gap step.
  Follow-up gap step created: `docs/plan/steps/planned/00606-...md`, tracking the current, live
  reproduction (2 of the 6 tests that ran in an isolated `make e2e` failed with
  `pending_bootstrap-failed` for exactly this reason) — this confirms step `00602`'s own Action 5
  ("confirm `make e2e` still passes") was not actually true at review time, even though the root
  cause is step `00601`'s, not `00602`'s own changes.
- 2026-08-13: `control-plane/src/config.js`'s `PLATFORM_CONFIG_REPO` default
  (`https://github.com/tbrandenburg/agent-control-plane.git`) is a **private** repo — every real
  `bootstrapWorkspace()` call (any session, any target repo, any environment without host git
  credentials) fails at the platform-repo-clone step with `fatal: could not read Username for
  'https://github.com'`, reproduced live with a standalone `docker run --rm --network egress-net
  agent-control-plane:local git clone ...` against the exact same URL. It only ever appeared to work
  on a dev machine that already has `gh auth login`-managed git credentials in its global credential
  store — that store is never available inside the container (no such mount in
  `docker-compose.yml`), so this is not a fluke: no `PLATFORM_CONFIG_REPO` override exists anywhere
  in the repo's `.yml`/`.env` files. Before trusting any "make e2e passes"/"bootstrap works" claim
  that depends on the *default* platform-config repo, verify the default URL is actually a public,
  credential-less-clonable repo — a private/inaccessible default silently makes every dev-machine
  run "work" (host credentials leak through the shell used to invoke `make e2e`, if run outside an
  isolated container) while failing deterministically in any real CI/isolated-container run. Tracked
   in `docs/plan/steps/planned/00607-...md`.
- 2026-08-13: `scripts/loc.mjs`'s LOC gate counts authored lines repo-wide, regardless of which file
  they live in — extracting a function into a new, better-organized module (e.g. splitting
  `sessions.js`'s bootstrap/spawn orchestration into `spawn-session.js`) does not by itself reduce the
  `TOTAL` in `make loc`, since the same authored lines are just relocated (plus a small per-file
  import/header overhead). When a real, non-removable functionality addition (e.g. step `00601`'s
  `bootstrapWorkspace()` wiring) pushes the total over the ceiling, modularize first for organization,
  but expect to also need `scripts/loc.mjs`'s `CEILING` constant raised (with a rationale comment) if
  the growth is genuinely justified — don't assume a refactor alone will bring a ~1000-line total back
  under budget. `scripts/loc.mjs`'s two `COMPONENTS` rows named `Bootstrap` and `Prompt/stop delivery`
  already existed with empty `globs: []` (matching `docs/ARCHITECTURE.md` §14's table) before any file
  was assigned to them — check for an already-reserved-but-empty row matching new code's purpose
  before inventing a new row.
- 2026-08-13: `control-plane/src/config.js`'s `PLATFORM_CONFIG_REPO` default was
  `tbrandenburg/agent-control-plane`, a **private** GitHub repo — since `bootstrapWorkspace()` clones
  it unconditionally for every session and no `.yml`/`.env` file anywhere overrode it, every real,
  credential-less bootstrap (any CI/isolated-container run) failed at the platform-repo-clone step
  regardless of target repo (fixed in step `00700` by switching the default to
  `octocat/Hello-World`, a real public, always-clonable repo — content is irrelevant per this doc's
  own Option C decision, only unconditional clonability matters). Once that was fixed, a second,
  previously-masked bug surfaced in `e2e/tests/arbitrary-repo-bootstrap.spec.ts` (every session had
  failed bootstrap before ever reaching this assertion): it hardcoded `/workspace/repo/README.md`
  for both target-repo fixtures, but `octocat/Hello-World` actually ships a plain `README` (no
  extension) — only `octocat/Spoon-Knife` ships `README.md`. A green step closure that never
  actually got a session past `pending_bootstrap` can hide arbitrarily many downstream assertion
  bugs; fixing an upstream blocker can immediately surface them.
- 2026-08-13: This repo (`tbrandenburg/agent-control-plane`) was made **public**, reopening it as
  `control-plane/src/config.js`'s `PLATFORM_CONFIG_REPO` default (previously swapped out for
  `octocat/Hello-World` in step `00700` for exactly this reason — see the bullet above). Repo-root
  `opencode.jsonc` is this repo's **own dev-time opencode config** (loaded when a human/agent runs
  `opencode` inside this checkout) **and**, now that `PLATFORM_CONFIG_REPO` points at this repo, it
  doubles as the platform-config layer every spawned sandbox actually receives: `bootstrap.js`
  clones this whole repo, and `sandbox.js` bind-mounts the resulting `platformConfigDir` verbatim
  at `/root/.config/opencode` (`GLOBAL_CONFIG_CONTAINER_PATH`) inside the container — so whatever
  is at repo-root `opencode.jsonc` right now (`model: opencode/big-pickle`, `autoupdate: false`,
  a couple of MCP servers, non-credentialed provider option blocks) is literally opencode's Global
  config inside every sandbox. **Because of that bind-mount, repo-root `opencode.jsonc` must never
  contain credentials, tokens, or machine-specific paths/permissions** — unlike a personal
  `~/.config/opencode/opencode.jsonc`, this file is public and gets shipped into every session's
  sandbox verbatim. Verified with a real, credential-less `git clone` of this repo plus a real
  (unmocked) `bootstrapWorkspace()` call reading the cloned `opencode.jsonc` back off disk before
  committing this change (root `AGENTS.md`'s evidence-first rule) — re-run that same check after
  editing repo-root `opencode.jsonc` to confirm the pushed content is what a sandbox will actually
  receive, since `bootstrapWorkspace()` clones `origin/main`, not the working tree.
- 2026-08-13: `opencode serve` (the actual command `sandbox/Dockerfile`'s `CMD` runs) has **no**
  `--auto`/`--dangerously-skip-permissions` flag — verified via `opencode serve --help`; those flags
  only exist on the interactive `opencode [project]`/`opencode run` commands. So opencode's default
  `ask` permission (e.g. for the bash tool) previously left every unattended sandbox session
  permanently stuck on a `permission.asked` event with zero approval-relay mechanism anywhere in
  this codebase (GitHub issue #7). Fixed with `"permission": "allow"` in repo-root `opencode.jsonc`
  (bind-mounted as every sandbox's Global config per the bullet above) — a config-level fix, not a
  CLI flag, and deliberately blanket rather than scoped to just `bash`, since the target repo is
  bind-mounted read-only (`sandbox.js:127`'s `:ro`) regardless of tool permission, and a narrower
  allow-list risks another tool defaulting to `ask` and silently hanging the same way. Verified with
  a real, unmocked isolated stack: the exact bash-tool prompt that previously hung indefinitely now
  completes with zero `permission.asked` events and a correct, verbatim reply.


## Lessons Learned

- 2026-08-26: Fixing issue #34 (`engines.node` pinned to `24.x` blocking Node 26) — no nvm/fnm/
  asdf/volta or pre-pulled Node 26 runtime existed in this sandbox, but a real `node:26-slim`
  Docker container was available and gave a genuine Node 26 validation instead of trusting
  `jsdom@^29`'s already-documented Node 26 compatibility alone: `docker run node:26-slim` +
  `npm install -g pnpm@10.33.2` + `pnpm install/lint/typecheck/test/build` all passed with the
  widened `engines.node`. The only 3 test failures seen (`bootstrap.test.js`'s real-GitHub-clone
  cases, `fatal: could not read Username for 'https://github.com'`) reproduced byte-for-byte
  identically on a matching `node:24-slim` container with the same missing DNS/network access, so
  they were confirmed to be a network-isolation artifact of that ad hoc container, not a Node 26
  regression. Lesson: before assuming a target runtime is "unavailable to test," check whether
  Docker can pull it — a disposable container often beats a version-manager install for one-off
  cross-Node validation, and always cross-check any container-specific failure against the same
  container recipe on the *current* known-good Node version before blaming the new one.
- 2026-08-13: A subagent's own "server-side logic is already correct, confirmed by reading the
  code" claim for issue #8 (Stop button 400) was not actually verified end-to-end — real E2E
  testing after integration showed `POST /api/sessions/:id/stop`'s bridge-success path (per
  `docs/ARCHITECTURE.md` §9's own documented design) never actually stops/removes the container,
  contradicting `sessions.js`'s own doc comment. Always run the literal user-facing action
  end-to-end (not just "does the request reach the handler without error") before accepting a
  subagent's server-side-correctness claim; filed as a separate follow-up issue (#10) rather than
  scope-creeping into the original fix.
- 2026-08-13: `vi.fn(() => Promise.resolve(...))`'s inferred `mock.calls[0]` type is `never[]`,
  so casting it directly `as [string, RequestInit]` fails `tsc --noEmit` with TS2352 ("may be a
  mistake") even though the runtime value is correct — cast through `as unknown as [...]` instead.
  `pnpm test` (vitest) does not run `tsc`, so this type error only surfaces via a separate
  `pnpm typecheck`/`tsc --noEmit` run; always run both after adding test files with typed mock
  assertions, not just the test runner.
- 2026-08-13: A subagent's own assumed opencode SSE event shapes (`message.part.delta` carrying
  `properties.part.{text,messageID}`, role living at `properties.part.role`) were never verified
  against a real event stream before being coded into `Transcript.tsx`'s issue-#16 rewrite — the
  subagent even flagged this exact risk in its own handoff, but it went unverified through review.
  Real, live-captured events showed `message.part.delta` actually carries
  `properties.{messageID,partID,delta}` (no `properties.part` at all) and role only ever appears
  on separate `message.updated` frames' `properties.info.{id,role}`. This produced a shipped
  regression (assistant replies never rendered anywhere, not even in the raw-events fallback) that
  only surfaced during the coordinator's own real E2E pass, not in unit tests (whose fixtures
  encoded the same wrong assumption). Rule: for any WS/SSE frame-parsing change, capture at least
  one real, live event stream (`GET /api/sessions/:id/events` against a real session) and diff it
  against the code's assumed shape *before* trusting unit-test fixtures — self-authored fixtures
  can't catch a wrong-shape assumption because the same wrong assumption wrote both.
- 2026-08-13: After editing dashboard source and rebuilding a Docker image for E2E verification,
  re-running `docker compose build` alone is not sufficient if the Dockerfile `COPY`s a prebuilt
  bundle (`control-plane/public`, populated by `make build`/`vite build`) rather than building it
  in-container — a stale bundle from an earlier `make build` gets silently baked into the "new"
  image, making a real code fix appear unfixed under E2E testing. Always re-run `make build`
  immediately before any `docker compose build` used for verifying a dashboard-side fix.
- 2026-08-13: When splitting a batch of issues (#18-#24) across 5 parallel subagent worktrees,
  reading each target route handler's *actual current code* before writing the file-ownership
  plan — not just the issue text — avoided an assumed conflict: `GET /api/sessions` already fully
  supported `status`/`limit`/`offset` query params by the time #23 ("no filtering/pagination") was
  filed, so #23 could be scoped frontend-only, eliminating any file overlap with #19's sibling fix
  in the same route file's PATCH handler. A 5-minute `grep`/read of the handler up front let all 5
  issues run as a true parallel octopus-merge with zero manual conflict resolution.
- 2026-08-13: An octopus-merge of 5 independently-linted subagent branches can still reintroduce
  fresh Biome formatting drift in a file the merge auto-resolved (each branch's own pre-merge
  `biome check --write` only ever saw its own diff, not the merged result) — always re-run the
  repo-root, read-only `pnpm exec biome check .` once immediately after any multi-branch merge,
  before trusting the individual branches' own "lint passed" claims.
- 2026-08-13: `make loc`'s repo-wide LOC ceiling can be pushed over budget by the *combined* sum of
  several independently-small parallel fixes (5 subagents landing ~10-25 lines each) even though no
  single fix looks like bloat in isolation — always re-run `make loc`/`node scripts/loc.mjs` once
  after integrating parallel work, not only after each subagent's own individual diff.
- 2026-08-13: A subagent's own passing unit tests for a new bulk-operation endpoint (issue #29's
  `DELETE /api/sessions`, which stops every session's container in a `for`/`await` loop) do not
  catch a real, severe perf bug: each `docker stop` against an already-gone container takes ~5s to
  fail, so a real integration run against ~20-100 stale rows made the endpoint hang 100+ seconds —
  invisible in unit tests (which mock `sandbox.stop`) and never caught because the subagent's own
  validation was unit-level only. Only surfaced via a real, unmocked E2E call against an isolated
  `make dev-stack`. Fix: `Promise.allSettled(rows.map(...))` instead of a sequential loop. Rule:
  any new endpoint that loops over N rows calling an external process (docker/git/network) per row
  must be exercised with a realistic N in a real E2E pass — a unit test with mocked externals
  cannot catch a purely time-based regression, no matter how many unit tests pass.
