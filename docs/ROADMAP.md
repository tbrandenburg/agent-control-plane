# Implementation Roadmap — Phased Delivery Plan

Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`UI.md`](./UI.md). Those two documents
describe **what** the final system is; this one describes **in what order to build it** so that the
riskiest assumptions get falsified earliest and a usable dashboard exists after the first product
phase.

Section references (§N) throughout point at `ARCHITECTURE.md`.

---

## Guiding principle

**Vertical slices, not layers.** Every phase ends in something a human can operate in a browser. The
ordering is driven by *which assumptions are most likely to be wrong*, not by which components are
easiest to write.

Security is deliberately deferred to Phase 4 — **not** because it's unimportant, but because every
deferred security property in this design is a single flag, hook, or hash call away from being
enabled (`internal: true`, an `onRequest` hook, `sha256(token)`). Deferring them is genuinely cheap.
Deferring the bridge/SSE contract would not have been, so that lands in Phase 1.

### The one tension, resolved up front

§1 caps authored code at **<1000 LOC**; §13 deliberately chooses raw SQL, no ORM, no framework
abstraction for the *control plane*. A "state-of-the-art project setup" is *not* in conflict with this
— §1 explicitly excludes tooling, container manifests, SQL schema files, generated types, and (as
clarified below) the dashboard's own UI code from the budget. The resolution:

> **State-of-the-art tooling everywhere. Deliberately boring runtime for the control plane. Full
> modern stack for the dashboard, since it was never part of the LOC budget in the first place.**

Concretely, this splits in two, deliberately:

- **Control plane** (`control-plane/`, `sandbox/bridge.js`, proxy config): no TypeScript compile step,
  no bundler, no ORM — full static type-checking via JSDoc + `checkJs`, raw SQL, `node:sqlite`. This is
  the code the `<1000 LOC` ceiling actually governs (§1's "control-plane application logic, the sandbox
  bridge, and proxy configuration glue").
- **Dashboard** (`control-plane/dashboard/` or similar, built by Vite): **React + TypeScript, Tailwind
  v4, shadcn/ui, TanStack Query** — a full modern frontend stack, matching production's own (§13 no
  longer lists this as a deviation — see the correction below). This is *not* control-plane application
  logic under §1's own definition, so adopting a build step and framework here costs nothing against
  the ceiling; it was already excluded (§14's budget table only ever charged ~40-60 LOC for the
  *server-side* static-file routes and login/cookie-auth branch, never the SPA's own source).

**Corrected from an earlier draft of this document:** vanilla-JS-no-bundler was originally proposed for
the dashboard too, on the reasoning that "a build toolchain is unjustified weight for three routes."
That reasoning didn't hold up: the LOC-budget justification was never actually true (see above), and
"three routes" undersells what's inside them — session detail (UI.md §3) is concurrent SSE token
deltas, WS presence broadcasts, and cursor-paginated history updating across five panels
simultaneously, which is precisely the state-synchronization problem a component/render model exists
to solve. React/Vite/Tailwind is now the Phase 0 default for the dashboard, matching production
instead of deviating from it.

**Deliberately not adopted: Bun as the control-plane runtime.** Bun (runtime + package manager +
`bun:test` + bundler in one, now backed by Anthropic, and the runtime Claude Code itself ships as) is
real and rising fast — but `ARCHITECTURE.md` §3/§12/"Tech stack summary" *documents* Node.js + Fastify
as an explicit architectural choice for the control plane, not an incidental one. Swapping the runtime
is an architecture decision, not a Phase 0 tooling decision, and isn't made silently here. If a genuine
need for it shows up later (e.g. sandbox cold-start latency), revisit as a deliberate, documented
`ARCHITECTURE.md` change — not a Phase 0 default. (Vite, used for the dashboard build above, is
unrelated to this — it's a frontend build tool, not a runtime swap.)

---

## Phase 0 — Project setup

No product value. Roughly half a day. Everything after it is cheaper and more trustworthy.

**Control plane**

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | **Node 24 (Active LTS)**, pinned via `.nvmrc` + `engines` | Not 22 — past Active LTS, in Maintenance-only mode. Not 26 — "Current" as of writing (released May 2026), doesn't become LTS until ~Oct 2026; too fresh to pin a production system to. 24 is the currently correct Active LTS choice; revisit at 26's LTS promotion |
| Web framework | **Fastify v5.x** (`@fastify/static`, `@fastify/secure-session`, `@fastify/websocket`) | v6 exists only as `v6.0.0-alpha.0` — not GA, not ready to pin. Explicitly pinned here for consistency: this is the one dependency across all three docs that was never version-pinned even after everything else was |
| SQLite driver | **Built-in `node:sqlite`**, not `better-sqlite3` | `node:sqlite` reached **Release Candidate** stability at v25.7.0 / v24.14.0 (picked up `defensive`-by-default, `serialize`/`deserialize`, and window-function aggregates along the way). Closes §15's open runtime question in favor of a **zero-dependency, no-native-compile** built-in with a near-identical synchronous API to `better-sqlite3` — a direct win for the "reuse over recreation" / minimal-footprint principle, not just a version bump |
| Package manager | `pnpm`, `packageManager` field, lockfile committed, corepack-pinned | Deterministic, mature workspace support, strict `node_modules` (no phantom deps) by default. Bun's package manager is faster but not adopted here (see runtime note above) — mixing "Bun installs, Node runs" is an odd hybrid not worth the inconsistency for this project's size |
| Types | **JS + JSDoc + `checkJs`** in `tsconfig.json`, `tsc --noEmit` in CI | Full type-checking with **zero build step and zero LOC cost** for the control plane specifically — honours §13's no-bundler decision for that code without giving up type safety |
| Lint / format | `biome` (one tool, one config, shared with the dashboard) | Replaces eslint + prettier; less config sprawl, orders of magnitude faster |
| Unit / integration tests | **Vitest** + built-in `v8` coverage | Corrected from `node:test`: 2024-2025 adoption data shows Vitest as the fastest-growing, highest-retention/satisfaction JS test tool, already used professionally roughly an order of magnitude more than `node:test`. Jest-compatible API, native ESM/watch mode, no `ts-node` needed for the JSDoc+`checkJs` setup above — the better-adopted, better-DX choice without sacrificing the "no framework lock-in" goal |
| E2E tests | Playwright against a real `docker compose up` stack | §1's evidence-first stance forbids mocking Docker in E2E; Playwright remains the dominant E2E tool by a wide margin |
| Task runner | `make install / run / stop / test / lint / build / clean` wrapping pnpm scripts | Standard command surface |
| CI | GitHub Actions: typecheck → lint → unit → integration → E2E on real compose | Quality gate from commit #1 |
| **LOC gate** | `make loc` — prints the §14 budget table from real counts, **fails CI above 1000** | Turns §1's constraint from aspirational into enforced. Continuously falsifies §14 rather than checking it at the end |
| Migrations | Numbered `.sql` files + a ~8-line applier | §1 excludes raw SQL from the budget — exploit that |
| Repo layout | `docs/`, `control-plane/`, `sandbox/`, `proxy/`, `e2e/`, `.github/` — clean root | Only essential config files at root |

**Dashboard**

| Concern | Choice | Rationale |
|---|---|---|
| Build tool | **Vite** | Dominant React dev-server/bundler; fast HMR, zero-config TS/JSX |
| Framework | **React 19** | Matches production's own stack — closes the §13 deviation instead of adding a new one |
| Language | **TypeScript** (full, not JSDoc) | Unlike the control plane, a build step already exists here (Vite), so there's no cost saved by avoiding real `.tsx` |
| Styling | **Tailwind v4** | CSS-first config (`@theme` in CSS, no `tailwind.config.js`), Rust-based Oxide engine |
| Components | **shadcn/ui** (Radix primitives) | Vendored into the repo at generation time, not an opaque npm dependency — fastest current path to accessible, polished interactive components (dialogs, tabs, dropdowns) |
| Data fetching | **TanStack Query** | Matches this app's actual pattern: REST reads + WS-message-driven cache invalidation, replacing hand-rolled polling/refetch logic |
| Live stream | Native `WebSocket`, no wrapper library | Protocol is small and fully specified (§6) — a library would solve a problem this app doesn't have |
| Lint / format / tests | Shared `biome` config; Vitest + React Testing Library for component tests | One toolchain across control plane and dashboard where it's not runtime-specific |

**Exit criterion:** `make test` green on an empty skeleton (control plane **and** dashboard), CI green,
LOC gate reporting `0 / 1000`, `vite build` producing a static bundle `@fastify/static` can serve.

**Note for `ARCHITECTURE.md`:** the `node:sqlite` choice above is a correction to that document's
stated tech stack (§3/§4/"Tech stack summary" previously said `better-sqlite3`) — already applied there
alongside the React/Vite/Tailwind dashboard correction (§5/§13/§14).

---

## Phase 1 — Spawn an agent from the dashboard

The first vertical slice: one thin cut through *every* layer. No auth, no webhooks, no proxy, no
continuation, no WebSocket.

**Scope**

- SQLite schema: `sessions` only (`id`, `title`, `repo_*`, `model`, `status`, `container_name`,
  `opencode_session_id`)
- `POST /api/sessions` (**synchronous** bootstrap — skip the `setImmediate` split for now),
  `GET /api/sessions`, `GET /api/sessions/:id`
- `sandbox.run()` via `docker run`; one **pre-cloned, hardcoded** repo bind-mounted — no git logic yet
- `sandbox/bridge.js`: `POST /prompt` + SSE relay to `POST /internal/sessions/:id/events`
- `events` table + `GET /api/sessions/:id/events`, consumed via **TanStack Query polling** (1s interval)
  — no WebSocket yet
- Dashboard: React session list, create form, polling transcript view — first real exercise of the
  Vite/React/Tailwind/shadcn stack set up in Phase 0
- Networking: sandbox attached to `egress-net` with raw env-var credentials — **insecure on purpose**,
  one line to flip in Phase 4

**Exit criterion:** you click "New Session" in a browser, type a prompt, and watch tokens appear.

**Assumptions falsified here**

1. Is `opencode serve`'s SSE stream actually relayable frame-by-frame as §8 claims?
2. Is the bridge's `/prompt` + relay contract the right seam?
3. Does storing every frame verbatim (§4) produce a usable transcript, or an unmanageable firehose?

These are the three most likely-to-be-wrong assumptions in the whole design, and this phase kills all
of them for the least possible code.

---

## Phase 2 — Real-time streaming and real bootstrap

**Scope**

- WebSocket `GET /api/ws/sessions/:id` with `subscribe`, `prompt`, `ping` only — `presence`,
  `fetch_history`, and `stop` deferred to Phase 6
- `wsToken` in **plaintext, no rotation** — deliberate, tracked, closed in Phase 4
- Real bootstrap (§10): `git ls-remote` → SHA-pin → `git fetch --depth 1` → checkout, all three trees,
  sparse checkout for team config, stderr failure classification
- `OPENCODE_CONFIG_CONTENT` composition (§8) — **narrowed to `model` + `autoupdate: false` only per
  §8's declared correction; no per-gateway provider block enumerated in control-plane code.** Platform
  config repo cloning (this phase's own bootstrap work, above) is what actually supplies the provider
  catalog opencode resolves natively — the control plane must not duplicate that as application code.
  **Sequencing dependency: implement after real bootstrap (the `git ls-remote`/clone bullet above),
  not before** — two of the three open-decision options below need bootstrap success/failure to be
  detectable per session.
  **Still an open decision (§8 — corrected after an earlier precedence-direction error):** whether to
  inject a default/example gateway block at all for environments without a Platform config repo, and
  if so, by which mechanism — `OPENCODE_CONFIG` (step 3) actually *overrides* the Platform config repo
  (step 2, Global), not the reverse, so it cannot be used for zero-branching "default, real config
  wins" semantics as an earlier draft claimed. Tracked as
  [GitHub issue #1](https://github.com/tbrandenburg/agent-control-plane/issues/1) — resolve its
  Options A/B/C explicitly in code review before implementing, and note the issue's own sequencing
  note requiring Phase 2's real-bootstrap bullet to land first.
- `GET /api/models` static allowlist, `reasoningEffort` → `model.variant` passthrough
- Async spawn split: `status: pending_bootstrap` + `setImmediate` (§10)
- `POST /api/sessions/:id/stop`, `PATCH /api/sessions/:id`, healthcheck-gated readiness (§8)

**Exit criterion:** create a session against an arbitrary repository from the dashboard and watch a
live-streaming transcript.

**Assumptions falsified here:** whether §10's bootstrap failure-mode table matches reality. Stderr
pattern matching is the most speculative code in the design.

---

## Phase 3 — Lifecycle and operability

**Scope**

- Session continuation (§7): `predecessor_id`/`successor_id`, `resolveActiveSession`,
  `OPENCODE_SESSION_ID` reattach hint, `session_continued` broadcast to both sides
- Bridge idle watchdog (15 min), named volumes, hourly reaper with the active-session guard (§12)
- `GET /api/sessions/:id/sandbox/logs`, `.../sandbox/diagnostics`, `.../artifacts`
- Dashboard: Overview, Diagnostics, Logs, Artifacts panels + continuation banner (UI.md §3)

**Exit criterion:** leave a session overnight, return, send a prompt, and the conversation continues
in a fresh sandbox against the same volume.

**Assumptions falsified here:** the design's riskiest lifecycle claim — that `opencode serve`
reattaches cleanly to a session id whose conversation state lives on a re-mounted volume. This is why
continuation lands at Phase 3 rather than late.

---

## Phase 4 — Security

Everything knowingly left open above gets closed here, **as one set**. Security properties are
verifiable as a group, so doing this in one phase beats dribbling it in.

**Scope**

- `sandbox-net: internal: true`; sandbox containers detached from `egress-net`
- Caddy `sandbox-proxy` as the sole bridging container, `header_up` credential injection (§12)
- `git remote set-url origin <url-without-credential>` before any bind-mount (§2)
- Dashboard login: `openid-client` Authorization Code + PKCE + `@fastify/secure-session` (§11)
- Bearer verification via RFC 7662 token introspection on the shared `/api/*` `onRequest` hook,
  `OIDC_SERVICE_CLIENT_IDS` allowlist
- `POST /oauth2/token` passthrough
- `wsToken` hashing + the 2-token sliding rotation window (§6)
- Per-session `INTERNAL_TOKEN` minted at spawn, both directions (§11)

**Exit criteria (evidence, not assertion)**

- An E2E test asserting `curl example.com` from inside a sandbox reports `UNREACHABLE`
- An E2E test asserting unauthenticated `GET /api/sessions` returns `401`
- An E2E test asserting a stale `wsToken` closes the socket with code `4001`

---

## Phase 5 — GitHub webhook trigger

Fully additive; zero coupling to Phases 1-4.

- `POST /webhooks/github`: raw `node:crypto` HMAC verification
- `deliveries` dedup on `X-GitHub-Delivery`
- `comment.author_association` trust check (`OWNER` / `MEMBER` / `COLLABORATOR`)
- `buildPrompt` / `buildTitle`, branch selection (`refs/pull/<N>/head` vs. `HEAD`)
- `WEBHOOK_DEFAULT_MODEL`, `GITHUB_WEBHOOK_BOT_EMAIL`
- Verify the image-baked `create-issue-comment` tool round-trips a reply onto the triggering issue/PR

**Exit criterion:** comment `@bot` on a real PR, get a review comment back.

---

## Phase 6 — Polish

- WS `presence` broadcast + Participants panel (UI.md §3)
- WS `fetch_history` cursor pagination
- WS `stop` message
- Mobile/narrow-viewport tab layout (UI.md §4)
- **Decide `events` retention** (§15) — age-based prune, size cap, or keep-forever

---

## Why this ordering

- **Phase 1 is a vertical slice, not a layer.** The "spawn an agent from the dashboard" milestone
  arrives at the earliest structurally possible point, and it exercises Docker, the bridge, SSE,
  SQLite, and the UI simultaneously — i.e. it tests the integration risks, not the code-volume risks.
- **Every deferral is a one-line flip**, not a rewrite. That property is what makes deferring security
  to Phase 4 defensible rather than reckless.
- **Riskiest assumptions front-loaded:** SSE relay (P1), bootstrap classification (P2), volume
  reattach (P3).
- **The LOC gate runs from Phase 0**, so §14's budget table is continuously falsified against real
  counts instead of being checked once at the end.

## Deliberately deferred — tracked, not forgotten

| Deferred | From | Closed in | Cost to close |
|---|---|---|---|
| `internal: true` network isolation | P1 | P4 | One compose line + detach sandbox from `egress-net` |
| Caddy credential injection | P1 | P4 | New container + Caddyfile (§1: config glue, ~25 LOC) |
| OIDC dashboard login + bearer introspection | P1 | P4 | One `onRequest` hook + two routes |
| `wsToken` hashing/rotation | P2 | P4 | One hash call + two columns |
| Per-session `INTERNAL_TOKEN` | P1 | P4 | One `docker run -e` + one header check |
| WebSocket (polling used instead) | P1 | P2 | Additive; polling path is deleted |
| Real git bootstrap (hardcoded mount used instead) | P1 | P2 | Additive |
| Continuation / reaper / volumes | P1-2 | P3 | Additive schema columns |
| `presence`, `fetch_history`, WS `stop` | P2 | P6 | Additive message types |
| `events` retention policy | all | P6 | Open decision (§15) |

---

## Modernity check log

Every concrete technology/version choice named in `ARCHITECTURE.md`, `UI.md`, and this document,
checked against current reality as of this writing. Re-run this check before Phase 0 actually starts
if significant time has passed — dates matter here, not just tool names.

| Tech | Checked | Result |
|---|---|---|
| Node.js version | ✅ | 24 = Active LTS (correct choice — see Phase 0 table); 22 = Maintenance-only; 26 = Current, not LTS until ~Oct 2026 |
| `node:sqlite` | ✅ | Reached Release Candidate at v24.14.0/v25.7.0 — corrected from `better-sqlite3` |
| Package manager | ✅ | pnpm over Bun — deliberate, see "the one tension" above; corroborated by `vercel/next.js` itself still using `pnpm-lock.yaml` despite Vercel's own investment in Rust-based JS tooling |
| Unit test runner | ✅ | Vitest over `node:test` — corrected, see Phase 0 table |
| E2E test runner | ✅ | Playwright — still dominant, no change |
| Dashboard framework | ✅ | React/Vite/Tailwind/shadcn — corrected from vanilla-JS, see the tension section above |
| Fastify | ✅ | v5.x is current stable; v6 is alpha-only, not GA — pinned explicitly (previously unpinned) |
| Caddy | ✅ | `caddy:2-alpine` still correct — latest is v2.11.4, no v3 exists |
| `openid-client` | ✅ | v6.x is current; its functional API (`discovery()`, `buildAuthorizationUrl()`, `tokenIntrospection()`) is exactly what `ARCHITECTURE.md` §11 already shows — no stale v5 class-based API present |
| Docker Compose file syntax | ✅ | No top-level `version:` key in §12's snippet — already correct per current Compose Spec (that key is deprecated) |
| LiteLLM | Not checked | External gateway product name/API, not a versioned dependency choice this project controls the same way — no action needed unless a specific API incompatibility surfaces during implementation |
