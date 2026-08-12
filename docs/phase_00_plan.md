# Phase 0 — Project Setup

Establish the repository skeleton, toolchain, quality gates, and LOC budget enforcement for the control plane and dashboard.

> **Steering documents:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) (§1 LOC scope boundary, §3 component
> inventory, §4 data model, §14 LOC budget), [`UI.md`](./UI.md) (dashboard routes/stack),
> [`ROADMAP.md`](./ROADMAP.md) (Phase 0 tables, "the one tension, resolved up front", modernity check log).
> Where this plan and those documents disagree, the steering documents win — this plan only sequences them.

## Goal

Produce an empty-but-real monorepo skeleton where `make install`, `make lint`, `make test`, `make build`,
and `make loc` all pass on a CI runner, `vite build` emits a static bundle `@fastify/static` can serve,
and the `<1000 LOC` ceiling from [`ARCHITECTURE.md` §1](./ARCHITECTURE.md) is **enforced by CI from
commit #1** rather than asserted at the end.

**Note on the literal exit number:** [`ROADMAP.md`](./ROADMAP.md)'s Phase 0 exit criterion states the LOC
gate should report "**`0 / 1000`**" literally. This plan's own Step 2 adds a minimal `server.js`,
`config.js`, and `db.js` (health route, config defaults, migration open) — a handful of real authored
lines by design, not zero. This is a deliberate, acknowledged divergence from ROADMAP's literal wording,
not a silent one: "empty skeleton" is read here as "no product/session logic," and the actual expected
number is small-but-nonzero (roughly the "Bridge"/"Public API" rows' floor, effectively 0 at this phase
since those rows have no content yet — in practice single digits to tens of lines). Track this explicitly
rather than papering over it; if a literal `0` is required, `server.js`'s health route would need to move
into Phase 1, which this plan does not recommend.

Why it matters: [`ROADMAP.md`](./ROADMAP.md) makes the LOC gate the mechanism that continuously falsifies
§14's budget table. Every later phase is cheaper and more trustworthy if the gate, the type-checker, and
a real `docker compose` E2E harness exist before any product code does.

## Scope

**Included**
- Repo layout: `docs/`, `control-plane/`, `control-plane/dashboard/`, `sandbox/`, `proxy/`, `e2e/`, `.github/` — clean root.
- Control-plane runtime skeleton: Node 24, Fastify v5.x, `node:sqlite`, JS + JSDoc + `checkJs`, no bundler.
- Dashboard skeleton: Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui + TanStack Query.
- Shared tooling: `pnpm` workspace, `biome`, Vitest (+ v8 coverage), Playwright.
- `make` task surface, GitHub Actions CI pipeline, migration applier + numbered `.sql` files.
- `make loc` budget gate that prints the §14 table from real counts and fails above 1000.
- `docker-compose.yml` + Dockerfiles sufficient to boot an empty control plane for E2E.

**Excluded (later phases)**
- Any session/API/bridge/webhook/auth product logic — Phases 1-5.
- `internal: true` network isolation, Caddy proxy, OIDC — Phase 4. (Note: [`ROADMAP.md`](./ROADMAP.md)'s
  "Deliberately deferred" table tracks these as P1→P4 deferrals since Phase 0 has no product code to defer
  from at all — Phase 0 simply never builds them in the first place, which is a stricter, not weaker, exclusion.)
- Actual `sessions`/`events`/`deliveries` schema content — Phase 1 introduces the first migration with real tables.

**Constraints**
- Zero authored control-plane application logic beyond a health route — the LOC gate must report a small
  number (see the Goal section's note on why this isn't literally `0` despite ROADMAP's wording).
- No TypeScript compile step for the control plane ([`ROADMAP.md`](./ROADMAP.md) Phase 0 "Types" row).
- No Bun; no ORM; no `better-sqlite3` ([`ROADMAP.md`](./ROADMAP.md) modernity check log).

## Design

**Two deliberately different toolchains, one repo.** [`ROADMAP.md`](./ROADMAP.md)'s "one tension"
section is the governing decision: the control plane is boring-by-design (no build step, JSDoc types,
raw SQL) because it is what the `<1000 LOC` ceiling governs; the dashboard is a full modern stack
because [`ARCHITECTURE.md` §1/§14](./ARCHITECTURE.md) explicitly exclude UI source from the budget.

**LOC gate contract.** `make loc` is the executable form of [`ARCHITECTURE.md` §14](./ARCHITECTURE.md):

- **Counted:** `control-plane/src/**/*.js`, `sandbox/*.js`, `proxy/Caddyfile`.
- **Not counted:** `control-plane/dashboard/**`, `**/*.test.*`, `e2e/**`, `migrations/*.sql`,
  `*.config.*`, Dockerfiles, `docker-compose.yml`, `*.json`, `*.md`, generated types, blank lines,
  comment-only lines.
- Output is a table mirroring §14's component rows, plus `TOTAL n / 1000`; exit code 1 when `n > 1000`.

**Type-checking without a build step.** One root `tsconfig.json` with `allowJs`, `checkJs`,
`noEmit`, `strict`. The dashboard has its own `tsconfig.json` extending it with `jsx: react-jsx`.
`tsc --noEmit` is a CI gate for both.

**Migrations.** Numbered `migrations/NNN_name.sql`, applied by an ~8-line idempotent applier that
tracks applied filenames in a `_migrations` table. SQL files are budget-exempt per §1, so schema
complexity is intentionally pushed into `.sql` rather than into JS.

**Compose topology (Phase 0 shape).** `control-plane` only, on a single default bridge network with
`./data:/data` and the docker socket mounted. `sandbox-net`/`egress-net`/`sandbox-proxy` are declared
in [`ARCHITECTURE.md` §12](./ARCHITECTURE.md) but land in Phases 1/4 — Phase 0 must not pre-build them.

**Test pyramid.** Vitest for unit/integration; Playwright for E2E against a real `docker compose up`
stack — never mocked, per [`ARCHITECTURE.md` §1](./ARCHITECTURE.md)'s evidence-first stance.

## Changes

**Created**
- Root: `package.json` (pnpm workspace root), `pnpm-workspace.yaml`, `.nvmrc`, `tsconfig.json`,
  `biome.json`, `Makefile`, `docker-compose.yml`, `.gitignore`, `.dockerignore`.
- `control-plane/`: `package.json`, `src/server.js` (Fastify bootstrap + `GET /health`), `src/db.js`
  (`node:sqlite` open + migration applier), `migrations/001_init.sql`, `Dockerfile`, `vitest.config.js`.
- `control-plane/dashboard/`: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`,
  `src/main.tsx`, `src/App.tsx`, `src/index.css` (Tailwind v4 `@theme`), `components.json` (shadcn),
  `vitest.config.ts`, one smoke component test.
- `e2e/`: `package.json`, `playwright.config.ts`, `tests/smoke.spec.ts`.
- `scripts/loc.mjs` — the LOC budget reporter/gate.
- `.github/workflows/ci.yml`.
- `sandbox/`, `proxy/` — placeholder directories with `.gitkeep` only (populated in Phases 1/4).

**Modified**
- `AGENTS.md` — add a pointer to `docs/phase_00_plan.md` / `docs/phase_01_plan.md` under steering documents.

**Removed**
- Nothing.

## E2E Tests

### Happy Path

`docker compose up -d` boots the control plane; Playwright navigates to `http://localhost:3000/`,
sees the dashboard shell render (app title, empty state), and `GET /health` returns `200 {"status":"ok"}`.
This proves the full chain: Docker → Node → Fastify → `@fastify/static` → the `vite build` bundle.

### Important Variants

- Dashboard served on a deep route (`/sessions/new`) returns the same SPA `index.html` (SPA fallback works
  before any real route exists) — the serving contract from [`ARCHITECTURE.md` §5](./ARCHITECTURE.md).
- `make build` from a clean checkout produces `control-plane/public/index.html` plus hashed JS/CSS assets.
- Fresh volume: first boot creates `data/control-plane.db` and applies `001_init.sql`; second boot is a no-op.

### Error Paths

- Control plane started with an unwritable `./data` mount exits non-zero with a readable message, not a stack trace.
- `make loc` with a deliberately oversized fixture file (temporary, in-test) exits 1 and prints the offending total.
- Playwright against a stopped stack fails fast with a connection error rather than hanging to timeout.

### Help / Command Discovery

- `make` (no target) prints a help listing of every target with a one-line description.
- `make loc` prints the §14-shaped budget table even when passing, so the number is always visible.
- `README.md` is not in Phase 0 scope; discovery lives in `make help` + this plan.

### Regression Coverage

None — this is the first phase. The E2E smoke test *becomes* the regression baseline every later phase must keep green.

## Verification

1. `make install` succeeds from a clean checkout on Node 24 with corepack-pinned pnpm.
2. `pnpm exec tsc --noEmit` clean for both control plane (JSDoc/`checkJs`) and dashboard.
3. `make lint` clean (biome, both packages).
4. `make test` green: control-plane unit/integration + dashboard component tests.
5. `make build` emits `control-plane/public/`.
6. `make loc` prints the budget table and reports a total under 1000 (expected: small, not literally `0`
   — see the Goal section's note reconciling this against ROADMAP's literal "`0 / 1000`" wording), exit 0.
7. `docker compose up -d && make e2e` green; `docker compose down -v` cleans up.
8. CI workflow green end-to-end on a pushed branch: typecheck → lint → unit → integration → E2E → loc.

---

## Implementation Steps

### Step 1: Repository skeleton and package management

#### Changes

##### Create
- `.nvmrc` (`24`), root `package.json` with `engines.node`, `packageManager` (corepack-pinned pnpm), and `private: true`.
- `pnpm-workspace.yaml` listing `control-plane`, `control-plane/dashboard`, `e2e`.
- `.gitignore`, `.dockerignore`.
- `control-plane/package.json`, `control-plane/dashboard/package.json`, `e2e/package.json`.
- `sandbox/.gitkeep`, `proxy/.gitkeep`.

##### Modify
- `AGENTS.md` — link the phase plans alongside the existing steering documents.

##### Remove
- Nothing.

#### Implementation

##### Workspace layout
Mirror [`ROADMAP.md`](./ROADMAP.md) Phase 0's "Repo layout" row exactly: `docs/`, `control-plane/`,
`sandbox/`, `proxy/`, `e2e/`, `.github/`. The dashboard is nested at `control-plane/dashboard/` because
its build output is consumed by the control plane's own `@fastify/static` root
([`ARCHITECTURE.md` §5](./ARCHITECTURE.md)).

##### Dependency policy
Control plane runtime deps only: `fastify` (pinned `^5`), `@fastify/static`. `@fastify/websocket`,
`@fastify/secure-session`, and `openid-client` are **not** installed yet — they arrive with the phases
that use them (P2 and P4 respectively), keeping the dependency graph honest per phase.

**Reconciling with [`ROADMAP.md`](./ROADMAP.md)'s Phase 0 table:** that table's "Web framework" row lists
`Fastify v5.x (@fastify/static, @fastify/secure-session, @fastify/websocket)` together, which reads as if
all three plugins are chosen in Phase 0. This plan interprets that row as naming the overall framework
ecosystem decision (which plugins this project will use, eventually), not a mandate to install unused
auth/WebSocket plugins against Phase 0's own "zero authored logic beyond a health route" constraint —
installing them now would add dead dependency weight with nothing to exercise them. This is a deliberate,
stated reading of an ambiguous steering-doc row, not a silent deviation; flag the row for disambiguation
in `ROADMAP.md` itself if this interpretation is contested.

##### Error Handling
`make install` must fail loudly if the active Node major is not 24 — enforce via `engines` plus
`engine-strict=true` in `.npmrc`, not a hand-written check.

##### Output / UX
`pnpm install` at root installs all three workspaces in one command; `make install` is a thin wrapper.

#### Patterns & Constraints

##### Mirror
[`ROADMAP.md`](./ROADMAP.md) Phase 0 control-plane and dashboard tables, row for row.

##### Decisions
- pnpm, not Bun or npm — [`ROADMAP.md`](./ROADMAP.md) "the one tension" section.
- Lockfile committed; corepack pins the pnpm version.

##### Gotchas
- pnpm's strict `node_modules` means any phantom dependency surfaces immediately — good, but expect
  explicit installs for anything a transitive dep previously provided.
- Nesting the dashboard inside `control-plane/` requires it to be an explicit workspace entry, otherwise
  pnpm will not link it.

##### Out of Scope
Publishing config, changesets, release automation, Renovate/Dependabot.

#### Tests

##### E2E
None yet.

##### Integration
None yet.

##### Unit
None yet.

#### Validation

##### Commands
```
corepack enable && pnpm install && pnpm -r ls --depth 0
```

##### Expected Results
All three workspaces resolve; no phantom-dependency warnings; lockfile is deterministic on a second run.

---

### Step 2: Control-plane runtime skeleton with type-checking

#### Changes

##### Create
- `control-plane/src/server.js` — Fastify instance, `GET /health`, `listen` on `PORT` (default 3000).
- `control-plane/src/config.js` — env reading with defaults; the future home of §5's `MODEL_ALLOWLIST`.
- `tsconfig.json` (root) — `allowJs`, `checkJs`, `strict`, `noEmit`, `module: nodenext`.
- `biome.json` — shared lint/format config.
- `control-plane/vitest.config.js` + `control-plane/src/server.test.js`.

##### Modify
- `control-plane/package.json` — `type: module`, `scripts.dev/start/test/typecheck`.

##### Remove
- Nothing.

#### Implementation

##### Fastify bootstrap
A single exported `buildServer()` factory returning a configured (but not listening) Fastify instance,
plus a `start()` guard invoked only when the module is the entrypoint. This factory is the seam every
later phase registers routes/plugins onto, and the seam integration tests use via `fastify.inject()`
without opening a port.

##### Type-checking via JSDoc
Public functions carry `@param`/`@returns` JSDoc. `checkJs` makes `tsc --noEmit` a real gate with zero
build step and zero LOC cost — [`ROADMAP.md`](./ROADMAP.md) Phase 0 "Types" row.

##### Error Handling
`start()` catches listen failures, logs a single-line reason, and `process.exit(1)`. No silent failures
(root `AGENTS.md` quality standards). Fastify's own logger is enabled — no custom logging layer.

##### Output / UX
`GET /health` → `200 {"status":"ok"}`. Deliberately unauthenticated; the `/api/*`-scoped `onRequest`
auth hook from [`ARCHITECTURE.md` §11](./ARCHITECTURE.md) will not cover it by construction.

#### Patterns & Constraints

##### Mirror
[`ARCHITECTURE.md` §5](./ARCHITECTURE.md)'s `fastify.register(@fastify/static)` snippet — Step 4 wires it;
this step only establishes the factory it registers onto.

##### Decisions
- ESM (`type: module`) throughout; no CommonJS despite §5's illustrative `require()` snippets.
- `buildServer()` never listens — testability first.

##### Gotchas
`checkJs` with `module: nodenext` is strict about import specifiers: `node:`-prefixed builtins and
explicit `.js` extensions on relative imports are mandatory.

##### Out of Scope
Any `/api/*` route, auth hook, WebSocket, or CORS config.

#### Tests

##### E2E
None yet.

##### Integration
`buildServer().inject({ method: 'GET', url: '/health' })` returns 200 with the expected body.

##### Unit
`config.js` default/override resolution for `PORT` and `DATA_DIR`.

#### Validation

##### Commands
```
pnpm --filter control-plane test && pnpm exec tsc --noEmit && pnpm exec biome check .
```

##### Expected Results
Green tests, zero type errors, zero lint findings.

---

### Step 3: SQLite via `node:sqlite` plus the migration applier

#### Changes

##### Create
- `control-plane/src/db.js` — open `data/control-plane.db`, enable WAL, run migrations, export the handle.
- `control-plane/migrations/001_init.sql` — `_migrations` bookkeeping table only.
- `control-plane/src/db.test.js`.

##### Modify
- `control-plane/src/server.js` — open the DB during `buildServer()` and close it on Fastify `onClose`.

##### Remove
- Nothing.

#### Implementation

##### Database open
Use the built-in `node:sqlite` `DatabaseSync` — **not** `better-sqlite3`. This is the correction
[`ROADMAP.md`](./ROADMAP.md) Phase 0 records against [`ARCHITECTURE.md` §3/§4/"Tech stack summary"](./ARCHITECTURE.md),
which still name `better-sqlite3`; the API is near-identical and synchronous, so no call-site shape changes.
Set `journal_mode = WAL` immediately after open, per §4.

##### Migration applier
Read `migrations/*.sql` sorted by filename, compare against rows in `_migrations`, execute unapplied
files inside a transaction, then record the filename. Target ~8 lines. Schema complexity belongs in the
`.sql` files, which [`ARCHITECTURE.md` §1](./ARCHITECTURE.md) excludes from the LOC budget — exploit that
deliberately rather than expressing schema in JS.

##### Error Handling
A failing migration rolls back its transaction, logs the filename and SQLite error, and exits non-zero.
Never continue booting on a partially-applied schema.

##### Output / UX
One log line per applied migration; silence when nothing is pending.

#### Patterns & Constraints

##### Mirror
[`ARCHITECTURE.md` §4](./ARCHITECTURE.md) — raw SQL, no ORM, WAL mode, single-writer assumption.

##### Decisions
- `node:sqlite` (Release Candidate stability) closes [`ARCHITECTURE.md` §15](./ARCHITECTURE.md)'s open
  runtime question in favour of a zero-dependency, no-native-compile builtin.
- Migrations are forward-only; no `down` migrations (single host, single process).

##### Gotchas
- `node:sqlite` is still flagged as RC — a Node minor bump can shift its API surface. Pin Node via `.nvmrc`
  *and* `engines`, and re-check on any major upgrade.
- WAL creates `-wal`/`-shm` sidecar files; `.gitignore` and `.dockerignore` must cover them.

##### Out of Scope
The `sessions`, `events`, and `deliveries` tables — those land in Phase 1 as `002_sessions.sql` etc.

#### Tests

##### E2E
None yet.

##### Integration
Boot against a temp directory twice: first run applies `001_init.sql`, second run applies nothing and
leaves `_migrations` unchanged.

##### Unit
Applier ordering (`002` after `010`? no — lexicographic ordering with zero-padded prefixes) and the
rollback path on a deliberately malformed SQL fixture.

#### Validation

##### Commands
```
rm -rf /tmp/cp-test && DATA_DIR=/tmp/cp-test pnpm --filter control-plane test
```

##### Expected Results
`control-plane.db` created, `_migrations` contains exactly one row, idempotent on re-run.

---

### Step 4: Dashboard skeleton and static-file serving

#### Changes

##### Create
- `control-plane/dashboard/`: `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`,
  `src/App.tsx`, `src/index.css`, `components.json`, `src/lib/utils.ts` (shadcn helper),
  `src/App.test.tsx`.

##### Modify
- `control-plane/src/server.js` — register `@fastify/static` with root `public/`, plus SPA fallbacks for
  `/`, `/sessions/new`, `/sessions/:id`.
- Root `Makefile` (Step 5) wires `vite build --outDir ../public`.

##### Remove
- Nothing.

#### Implementation

##### Dashboard shell
React 19 + TypeScript + Vite. Tailwind v4 configured CSS-first via `@theme` in `src/index.css` — no
`tailwind.config.js`. `QueryClientProvider` (TanStack Query) wraps the app at the root even though no
query exists yet, so Phase 1 adds queries without touching bootstrap. Render only an app shell
(header, empty content area) consistent with [`UI.md` §1](./UI.md)'s chrome — no session list yet.

##### shadcn/ui vendoring
Initialise `components.json` and vendor exactly one primitive (e.g. `button`) to prove the generation
path works. [`ARCHITECTURE.md` §5](./ARCHITECTURE.md) requires components to be vendored into the repo,
not consumed as an opaque npm package.

##### Static serving
Exactly the three routes from [`ARCHITECTURE.md` §5](./ARCHITECTURE.md) / [`UI.md` "Routes"](./UI.md) —
`/`, `/sessions/new`, `/sessions/:id` — each `sendFile('index.html')`. Do not add a wildcard catch-all;
the route list is explicit by design and extra screens are out of scope.

##### Error Handling
If `control-plane/public/index.html` is missing (dashboard not yet built), `@fastify/static` registration
must not crash the server — log a warning and continue serving `/health`, so `make test` works without a
prior `make build`.

##### Output / UX
Dev loop: `vite dev` with a proxy to `http://localhost:3000` for `/api` and `/health`. Prod: single
Fastify process serving both bundle and API — no second service ([`ARCHITECTURE.md` §5](./ARCHITECTURE.md)).

#### Patterns & Constraints

##### Mirror
[`UI.md` "Implementation note"](./UI.md) — React components per panel, `fetch`/WS-driven, independent units.

##### Decisions
- Vite output goes to `control-plane/public/`, which is gitignored and produced by `make build`.
- Full `.tsx` TypeScript here (not JSDoc) — a build step already exists, so there is nothing to save.

##### Gotchas
- Tailwind v4 uses the `@tailwindcss/vite` plugin and CSS-first config; v3-era `tailwind.config.js` and
  `postcss.config.js` instructions do not apply.
- The Vite `outDir` sits outside the dashboard root, so `emptyOutDir` must be set explicitly or Vite refuses.

##### Out of Scope
Session list, create form, transcript, any panel from [`UI.md` §3](./UI.md) — all Phase 1 or later.
Login/auth UI — Phase 4.

#### Tests

##### E2E
Deferred to Step 6.

##### Integration
`inject({ url: '/sessions/new' })` returns the SPA `index.html`, not a 404, after `make build`.

##### Unit
React Testing Library smoke test: `App` renders the header text.

#### Validation

##### Commands
```
pnpm --filter dashboard build && pnpm --filter dashboard test && ls control-plane/public/index.html
```

##### Expected Results
Hashed JS/CSS assets plus `index.html` in `control-plane/public/`; component test green.

---

### Step 5: Make targets, LOC gate, and container manifests

#### Changes

##### Create
- `Makefile` — `help install run stop test lint build clean loc e2e typecheck`.
- `scripts/loc.mjs` — budget reporter/gate.
- `control-plane/Dockerfile`, `docker-compose.yml`.

##### Modify
- Root `package.json` — scripts the Makefile delegates to.

##### Remove
- Nothing.

#### Implementation

##### Make surface
Implement the standard command surface from the root `AGENTS.md` and [`ROADMAP.md`](./ROADMAP.md)
Phase 0 "Task runner" row: `install run stop test lint build clean`, plus `loc`, `e2e`, `typecheck`.
Default target is `help`, auto-generated from `##` comments on each target.

##### LOC gate
`scripts/loc.mjs` globs the counted paths, strips blank and comment-only lines, groups counts into the
§14 component rows, prints the table with a `TOTAL n / 1000` footer, and exits 1 above the ceiling.
Exclusions are exactly [`ARCHITECTURE.md` §1](./ARCHITECTURE.md)'s scope boundary — dashboard source,
tests, e2e, SQL, manifests, config, generated types. Encode the include/exclude lists as data at the top
of the script so later phases adjust one array rather than the logic.

##### Container manifests
`control-plane/Dockerfile`: Node 24 slim base, pnpm via corepack, production install, non-root user,
`HEALTHCHECK` hitting `/health`. `docker-compose.yml`: one `control-plane` service, `./data:/data`,
`/var/run/docker.sock:/var/run/docker.sock`, port 3000, **no `version:` key** (deprecated per
[`ROADMAP.md`](./ROADMAP.md)'s modernity check log). No `sandbox-net`/`egress-net`/`sandbox-proxy` yet.

**Deliberate exception, called out explicitly:** mounting the Docker socket here is a security-sensitive
resource grant introduced a full phase before any code exercises it — Phase 0 has zero session/sandbox
logic ("Excluded" section above). This is accepted anyway, as a stated trade-off rather than an oversight,
because the compose service definition is otherwise churn-prone to change later and the socket itself is
inert without `sandbox.run()` (Phase 1) actually calling `docker run`. If this is judged too early, the
alternative is to add the mount only in Phase 1's `docker-compose.yml` change instead.


##### Error Handling
`make loc` failure prints the per-row breakdown *and* the top offending files by count, so the failure is
actionable rather than a bare number.

##### Output / UX
`make loc` output shape:
```
Component                                   LOC
Public API                                    0
...
TOTAL                                    0 / 1000  ✅
```
Use `✅`/`❌` only in this generated CLI table — never in source or comments (root `AGENTS.md`).

#### Patterns & Constraints

##### Mirror
[`ARCHITECTURE.md` §14](./ARCHITECTURE.md)'s exact component row names, so the gate's output is directly
comparable to the documented budget.

##### Decisions
- The gate counts *authored* lines only; the exclusion list is normative and lives in one place.
- Docker socket is mounted from Phase 0 because Phase 1's `sandbox.run()` needs it and changing the compose
  contract later is churn.

##### Gotchas
- Counting `proxy/Caddyfile` must not fail when the file does not exist yet (Phase 4) — treat missing
  counted paths as zero, not as an error.
- Mounting the Docker socket into a non-root container requires matching the host docker group, or the
  Phase 1 spawn path fails with a permission error that looks unrelated.

##### Out of Scope
Multi-stage image optimisation, image publishing, compose profiles for sandboxes.

#### Tests

##### E2E
Deferred to Step 6.

##### Integration
`docker compose up -d` then `curl -fsS localhost:3000/health` returns 200.

##### Unit
`loc.mjs` counting logic against fixtures: blank lines, comment-only lines, and excluded paths all
contribute zero; a file over the ceiling triggers exit code 1.

#### Validation

##### Commands
```
make help && make build && make loc && docker compose up -d && curl -fsS localhost:3000/health && docker compose down -v
```

##### Expected Results
Help lists every target; `make loc` prints the table and exits 0 near zero; health check returns
`{"status":"ok"}`.

---

### Step 6: E2E harness and CI pipeline

#### Changes

##### Create
- `e2e/playwright.config.ts`, `e2e/tests/smoke.spec.ts`.
- `.github/workflows/ci.yml`.

##### Modify
- `Makefile` — `make e2e` brings the compose stack up, runs Playwright, tears it down deterministically.

##### Remove
- Nothing.

#### Implementation

##### Playwright harness
`webServer` is **not** used to fake a server — the config points `baseURL` at the real compose stack.
[`ARCHITECTURE.md` §1](./ARCHITECTURE.md)'s evidence-first stance and the root `AGENTS.md` both forbid
mocking Docker in E2E. `make e2e` runs `docker compose up -d --build`, waits for the health endpoint,
runs the specs, then `docker compose down -v` in a trap so a failed run still cleans up.

##### Smoke spec
Navigate to `/`, assert the dashboard shell renders; assert `GET /health` returns 200; assert
`/sessions/new` serves the SPA rather than 404. This is the regression baseline every later phase inherits.

##### CI pipeline
Ordered jobs per [`ROADMAP.md`](./ROADMAP.md) Phase 0 "CI" row: typecheck → lint → unit → integration →
E2E on a real compose stack → `make loc`. Fail fast; upload the Playwright report on failure.

##### Error Handling
The health-wait loop has a bounded timeout (e.g. 60s) and, on expiry, dumps `docker compose logs` before
failing — otherwise CI E2E failures are undiagnosable.

##### Output / UX
CI surfaces the `make loc` table in the job summary so budget drift is visible on every PR, not only on failure.

#### Patterns & Constraints

##### Mirror
[`ROADMAP.md`](./ROADMAP.md) Phase 0 exit criterion: `make test` green on an empty skeleton, CI green,
LOC gate reporting `0 / 1000`, `vite build` producing a servable bundle.

##### Decisions
- The LOC gate runs in CI from commit #1, making §14 continuously falsified rather than end-checked.
- E2E always runs against `docker compose`, never against `vite dev` or a bare `node` process.

##### Gotchas
- GitHub Actions runners have Docker available but image builds are cold — cache the pnpm store and the
  Docker layer cache or E2E job time balloons.
- Playwright browsers must be installed with `--with-deps` in CI.

##### Out of Scope
Release/publish workflows, matrix builds across Node versions (one pinned Active LTS only), coverage
thresholds (introduce when there is code worth thresholding).

#### Tests

##### E2E
`smoke.spec.ts` — the three assertions above.

##### Integration
Covered by the compose-up health check inside `make e2e`.

##### Unit
None specific to this step.

#### Validation

##### Commands
```
make e2e && make lint && make test && make loc
```

##### Expected Results
Playwright smoke suite green against the real stack; CI green end-to-end on a pushed branch; `make loc`
reports a total far below 1000. This satisfies [`ROADMAP.md`](./ROADMAP.md)'s Phase 0 exit criterion and
unblocks [`docs/phase_01_plan.md`](./phase_01_plan.md).
