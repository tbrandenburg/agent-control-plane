# Phase 2 — Real-Time Streaming and Real Bootstrap

Replace Phase 1's two biggest deliberate shortcuts — polling instead of WebSocket, and a hardcoded
pre-cloned repo instead of real git bootstrap — with the real thing, plus the async spawn split, stop,
and the model-selection/reasoning-effort mechanisms that depend on real config composition.

> **Steering documents:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) (§6 WebSocket protocol, §8 config
> layering/bridge, §9 synchronous delivery, §10 bootstrap failure-mode classification, §14 LOC budget),
> [`UI.md`](./UI.md) (§2 create session's Team config field, §3 Stop/Archive buttons),
> [`ROADMAP.md`](./ROADMAP.md) (Phase 2 scope, exit criterion, falsified assumption, deferral table).
> Prerequisite: [`docs/phase_01_plan.md`](./phase_01_plan.md) and
> [`docs/phase_01_findings.md`](./phase_01_findings.md).

## Goal

A human creates a session against an **arbitrary** repository (not the Phase 1 hardcoded one) from the
dashboard and watches a **live-streaming** transcript over WebSocket, with session creation returning
immediately while the real clone/spawn happens in the background.

Why it matters: [`ROADMAP.md`](./ROADMAP.md) identifies this phase's riskiest assumption as whether
[§10](./ARCHITECTURE.md)'s bootstrap failure-mode table (stderr pattern matching, since `git`'s exit
code is always 128 regardless of failure type) actually matches reality — "the most speculative code in
the design." Everything else in this phase (WebSocket subset, async split, stop, model/reasoning-effort
passthrough) is comparatively low-risk, well-specified plumbing; bootstrap classification is the one
piece that must be falsified with real failing clones, not just happy-path ones.

## Scope

**Included**
- `GET /api/ws/sessions/:id` WebSocket upgrade with **`subscribe`, `prompt`, `ping` only**
  ([§6](./ARCHITECTURE.md)) — `presence`, `fetch_history`, `stop`-over-WS deferred to Phase 6.
- `wsToken` issued in **plaintext, no rotation, no hashing** — a deliberate, tracked shortcut, closed in
  Phase 4 ([§6](./ARCHITECTURE.md)'s rotation/hashing scheme is out of scope here).
- Real bootstrap ([§10](./ARCHITECTURE.md)): resolve every ref (target repo, platform config, team
  config) to a SHA via `git ls-remote`, `git fetch --depth 1 origin <sha>` + `git checkout <sha>` (never
  a branch checkout), sparse checkout (`--cone`, `set .opencode`) for the team config layer, stderr
  pattern-matched failure classification (`not_found` / `auth` / `network` / `unknown`), credential
  stripping (`git remote set-url origin <url-without-credential>`) before any bind-mount.
- `OPENCODE_CONFIG_CONTENT` composition ([§8](./ARCHITECTURE.md)) — **narrowed to `model` +
  `autoupdate: false` only**, per §8's declared correction; no per-gateway provider block enumerated in
  control-plane code. The Platform config repo clone (this phase's own bootstrap work) is what actually
  supplies the provider catalog opencode resolves natively.
- `GET /api/models` static allowlist wired into the create form's dropdown (already built server-side in
  Phase 1 — this phase adds the `teamConfigRepo` field back to the form/body now that bootstrap exists).
- `reasoningEffort` → `model.variant` passthrough, already implemented server-side in Phase 1 — this
  phase exposes it end-to-end against real (not hardcoded) repos.
- Async spawn split: `status: 'pending_bootstrap'` + `setImmediate(...)` for both `POST /api/sessions`
  and (structurally, for Phase 5) the webhook path — bootstrap/spawn happens after the HTTP response is
  sent.
- `POST /api/sessions/:id/stop` — synchronous proxy to the bridge's `POST /stop` (→ OpenCode's native
  `abort`), falling back to `docker stop` only on a bridge-response timeout.
- `PATCH /api/sessions/:id` — `{status}` update (`active` ↔ `archived`).
- Healthcheck-gated readiness ([§8](./ARCHITECTURE.md)) already exists from Phase 1; this phase adds
  retry/backoff specifically around the now-asynchronous spawn path, since the HTTP response no longer
  blocks on it.
- Dashboard: WebSocket-driven transcript replacing the Phase 1 poll (deletion, not layering); Stop and
  Archive buttons in the session-detail header ([`UI.md` §3](./UI.md)); Team config field back in the
  create form ([`UI.md` §2](./UI.md)); a pending/bootstrapping state on the session list and detail
  views for `status: pending_bootstrap`.

**Excluded — deliberately, tracked in [`ROADMAP.md`](./ROADMAP.md)'s deferral table**
- WS `presence`, `fetch_history`, WS `stop` message — Phase 6.
- `wsToken` hashing + 2-token sliding rotation window — Phase 4.
- `internal: true` isolation, Caddy `sandbox-proxy`, per-session `INTERNAL_TOKEN` — Phase 4. Sandboxes
  stay on `egress-net` with raw env-var credentials this phase too.
- OIDC dashboard login, bearer token introspection — Phase 4.
- Session continuation, reaper, named volumes, idle watchdog — Phase 3.
- Diagnostics, logs, artifacts panels — Phase 3.
- Webhook trigger itself (`POST /webhooks/github`) — Phase 5. This phase's async-split plumbing is
  built generically enough for Phase 5 to reuse, but no webhook route is added yet.
- The open "default gateway block for environments without a Platform config repo" decision
  ([GitHub issue #1](https://github.com/tbrandenburg/agent-control-plane/issues/1),
  [§8](./ARCHITECTURE.md)) — must be resolved **in code review before implementing** the
  `OPENCODE_CONFIG_CONTENT` step of this phase, not silently defaulted; see Design below.

**Constraints**
- Every counted line lands against [§14](./ARCHITECTURE.md)'s budget; `make loc` stays green.
- **Sequencing dependency, non-negotiable:** implement real bootstrap (`git ls-remote`/clone/checkout)
  *before* `OPENCODE_CONFIG_CONTENT` composition. Two of the open decision's three options
  (Option A/B in [§8](./ARCHITECTURE.md)) need bootstrap success/failure to be detectable per session;
  building config composition first would make that undetectable and force rework.
- The dashboard must not render any panel/field the backend does not yet back
  ([`UI.md`](./UI.md) design goals) — e.g. still no Participants/Diagnostics/Artifacts/Logs.
- No queue, no `prompts` table — the WebSocket `prompt` message is still a synchronous proxy call
  ([§9](./ARCHITECTURE.md)), exactly like the REST route.

## Design

**Request flow (this phase).**
```
Browser ── POST /api/sessions ──▶ control-plane
                                   │ insert row (status: pending_bootstrap), return 202 { id, wsToken }
                                   │ setImmediate: bootstrapWorkspace() → sandbox.run() → waitForHealth()
                                   │   on success: status → active
                                   │   on failure: classify stderr, status stays pending_bootstrap-failed
                                   ◀── (async, after response already sent)

Browser ── WS subscribe {wsToken} ──▶ control-plane (registers socket in subscriber Map)
Browser ── WS prompt {content} ──▶ control-plane ──▶ bridge POST /prompt ──▶ prompt_async
control-plane ◀── POST /internal/sessions/:id/events ◀── SSE relay ── bridge
control-plane ── WS {type:"event", ...} ──▶ Browser (broadcast to session's subscriber Set)
Browser ── POST /api/sessions/:id/stop ──▶ control-plane ──▶ bridge POST /stop ──▶ abort
```

**WebSocket protocol subset** ([§6](./ARCHITECTURE.md), literal subset):
- `subscribe`: required first message, `{wsToken}`; compares against the session's plaintext
  `ws_token` column (no hashing/rotation this phase — Phase 4 adds both). Wrong/missing token closes
  the socket with code `4001`.
- `prompt`: `{content, model?, reasoningEffort?}` → the exact same synchronous bridge proxy call as the
  REST route, so both entry points share one implementation function, not two.
- `ping`: keepalive, no-op reply.
- A module-level `Map<sessionId, Set<WebSocket>>` subscriber registry, populated on `subscribe`,
  cleaned up on socket `close` — the same design [§6](./ARCHITECTURE.md) specifies for the full
  broadcast mechanism, built now at the subset this phase needs (no `session_continued` broadcast yet,
  since continuation doesn't exist until Phase 3).

**Real bootstrap** ([§10](./ARCHITECTURE.md), literal implementation):
- Resolve target repo, platform config repo, and team config repo (if given) to SHAs via
  `git ls-remote` **up front**, before any fetch — closes the concurrent-push race the doc calls out.
- `git fetch --depth 1 origin <sha>` + `git checkout <sha>` for each — **never** a branch-name checkout.
- Team config: `git sparse-checkout init --cone` + `git sparse-checkout set .opencode`.
- Before any cloned directory is bind-mounted: `git remote set-url origin <url-without-credential>`.
- Failure classification is **stderr pattern matching**, not exit codes (`git`'s own exit code is always
  128 regardless of failure type) — the four-row table from [§10](./ARCHITECTURE.md) verbatim:
  `not_found` (repo missing or unauthenticated-private, deliberately indistinguishable per GitHub's own
  behavior), `auth`, `network`, `unknown` (fail-closed default for anything else).
- Team-layer `not_found` is a **silent skip** (team config is optional); target/platform-layer
  `not_found` is a **hard failure** — this asymmetry is deliberate, not a bug, and must be tested as
  such.

**`OPENCODE_CONFIG_CONTENT` composition** ([§8](./ARCHITECTURE.md)):
```jsonc
{ "model": "<session.model>", "autoupdate": false }
```
Nothing else. The full provider/gateway catalog is Platform-config-repo territory (step 2 of opencode's
own 8-step precedence chain), supplied by this phase's own bootstrap clone, not enumerated here.

**Open decision — must be resolved in code review, not silently defaulted:** whether/how to inject a
default gateway block for environments with no real Platform config repo yet. [§8](./ARCHITECTURE.md)
lays out three options (A: pre-seed the Global config path before the Platform clone overwrites it,
fragile/bootstrap-order-dependent; B: explicit conditional injection only on Platform-clone failure,
accepting branching logic; C: no default at all — every environment, including this project's own
dev/e2e stack, must have a real Platform config repo or equivalent stand-in). Tracked in
[GitHub issue #1](https://github.com/tbrandenburg/agent-control-plane/issues/1). Record the chosen
option and rationale in this phase's findings document (see Verification) — do not implement silently
without that record.

**Async spawn split** ([§10](./ARCHITECTURE.md)): `POST /api/sessions` inserts the row
(`status: 'pending_bootstrap'`) and returns `202 { id, wsToken }` immediately — an INSERT is
sub-millisecond, well inside GitHub's (and any client's) expectations — then `setImmediate(...)` runs
`bootstrapWorkspace()` → `sandbox.run()` → `waitForHealth()` after the HTTP response is already sent.
This is the same split [§10](./ARCHITECTURE.md) requires for the webhook's 10-second ACK, applied here
first so Phase 5 reuses it rather than inventing its own.

**Stop.** `POST /api/sessions/:id/stop` calls the bridge's `POST /stop` directly (→ OpenCode's native
`abort`); only on a bounded timeout waiting for that response does the control plane fall back to
`docker stop` ([§9](./ARCHITECTURE.md)/[§5](./ARCHITECTURE.md)).

**Model/reasoning-effort.** No new mechanism beyond what Phase 1 already built server-side
([§8](./ARCHITECTURE.md)): `model?`/`reasoningEffort?` per-prompt overrides pass straight through to
`prompt_async` as `model.variant`, with zero translation logic. This phase's job is exposing it against
real repos and via the WS `prompt` message identically to the REST route, not inventing new logic.

**Dashboard Stop/Archive buttons** ([`UI.md` §3](./UI.md)) — explicitly called out in
[`ROADMAP.md`](./ROADMAP.md) as a gap that "slipped past Phase 1 review undetected," found via
adversarial Playwright audit, not caught by Phase 1's own validation gates. Wire them here, explicitly,
as first-class scope — not an implicit consequence of the backend endpoints existing.

**Dashboard Events tab** is **not** in this phase's scope — [`ROADMAP.md`](./ROADMAP.md) assigns it to
Phase 3, since it depends on no new backend beyond what Phase 1 already exposes and is purely a
dashboard-side addition better sequenced alongside Phase 3's other panels.

## Changes

**Created**
- `control-plane/migrations/003_ws_bootstrap.sql` — `ws_token` column (plaintext this phase),
  `pending_bootstrap` failure fields kept minimal (no structured diagnostics yet — Phase 3).
- `control-plane/src/routes/ws.js` — WebSocket upgrade handler, subscriber registry,
  `subscribe`/`prompt`/`ping`.
- `control-plane/src/bootstrap.js` — `resolveSha()`, `cloneAndCheckout()`, `sparseCheckoutTeamConfig()`,
  `classifyGitFailure()`, `stripCredential()`.
- `control-plane/src/bootstrap.test.js`.
- `control-plane/src/routes/ws.test.js`.
- Dashboard: `src/hooks/useSessionSocket.ts`, updates to `src/components/Transcript.tsx` (WS-driven,
  polling code deleted), `src/routes/NewSession.tsx` (Team config field restored).
- `e2e/tests/bootstrap-failures.spec.ts` — real failing clones (bad SHA, private repo without a token,
  unreachable host) exercised against real `git`, not stubbed.

**Modified**
- `control-plane/src/routes/sessions.js` — `POST /api/sessions` async split, `POST .../stop`,
  `PATCH /api/sessions/:id`.
- `control-plane/src/sandbox.js` — `OPENCODE_CONFIG_CONTENT` composition point, `stop()` (bridge proxy +
  `docker stop` fallback).
- `sandbox/bridge.js` — `POST /stop` → `abort`.
- `control-plane/src/server.js` — register the WS route.
- `control-plane/dashboard/src/App.tsx`, `SessionDetail.tsx` — Stop/Archive buttons, pending-bootstrap
  status rendering.
- `docker-compose.yml` — no topology change this phase (still `egress-net`, still no Caddy).
- `docs/phase_02_findings.md` — new findings document (see Verification), mirroring
  `docs/phase_01_findings.md`'s format.

**Removed**
- The Phase 1 TanStack Query 1s poll for events — **deleted**, not layered under the WebSocket
  ([`ROADMAP.md`](./ROADMAP.md) deferral table: "Additive; polling path is deleted").
- The Phase 1 hardcoded pre-cloned repo bind-mount path — replaced by real bootstrap output.

## E2E Tests

### Happy Path

Against a real `docker compose` stack with a real (test-fixture) target repo, platform config repo, and
team config repo: submit the create form with an arbitrary repository and a team config override; get
redirected to `/sessions/:id` immediately while status shows `pending_bootstrap`; watch it transition to
`active` once bootstrap/spawn completes; open the WS connection automatically; type a prompt; assert
tokens stream in over the socket (no polling network calls observed); assert the transcript matches
what Phase 1's polling path would have shown, proving the delivery mechanism changed but not the
content contract. This is [`ROADMAP.md`](./ROADMAP.md)'s Phase 2 exit criterion executed verbatim.

### Important Variants

- Session created **without** a team config repo — bootstrap succeeds, team layer is simply absent
  (not an error), `.opencode` sparse checkout step is skipped entirely.
- `PATCH /api/sessions/:id {status: "archived"}` then `GET /api/sessions/:id` reflects the change.
- `POST /api/sessions/:id/stop` while the bridge is healthy — asserts `abort` was called (via the
  bridge's own log/mock hook in the integration test) and the endpoint returns before any `docker stop`
  fallback fires.
- `POST /api/sessions/:id/stop` with the bridge deliberately unresponsive — asserts the timeout fires and
  `docker stop` is invoked as fallback.
- A well-formed but non-allowlisted `model` on `POST /api/sessions` still returns `202`/creates the
  session — the allowlist remains UI-only ([§5](./ARCHITECTURE.md)), unchanged from Phase 1.
- Two concurrent WS clients subscribed to the same session both receive the same broadcast events —
  proves the subscriber `Set`, not just a single-socket special case.

### Error Paths

- `subscribe` with a wrong/missing `wsToken` → socket closes with code `4001`, no prompt processed.
- Target repo doesn't exist / clone is unauthenticated → classified `not_found`, session bootstrap hard
  fails, status reflects the failure (no structured diagnostics fields yet — Phase 3 — but the row is
  queryable and not silently stuck `pending_bootstrap` forever).
- Platform config repo host unreachable → classified `network`, hard failure.
- Bad credential against a real repo → classified `auth`, hard failure.
- Team config repo missing/unauthenticated → classified `not_found`, **silent skip**, target repo
  bootstrap and spawn still succeed — this asymmetry vs. the target/platform hard-failure cases above is
  the specific behavior under test, not a side effect.
- An unrecognized git stderr string → classified `unknown`, hard failure (fail-closed default) — assert
  with a synthetic stderr fixture, since real git failures rarely produce this path.
- `POST /api/sessions/:id/prompt` (REST) or WS `prompt` while `status: 'pending_bootstrap'` → a clear
  error, not a hang or an `ECONNREFUSED` against a container that doesn't exist yet.

### Help / Command Discovery

- `make loc` still prints the [§14](./ARCHITECTURE.md) budget table and stays under 1000 with the new
  bootstrap/WS code.
- The create form's Team config field is present and optional, matching [`UI.md` §2](./UI.md)'s
  wireframe exactly (re-added, not newly invented).
- `make help` lists any new target added for E2E bootstrap fixtures (e.g. `make e2e-fixtures`).

### Regression Coverage

- Every Phase 1 E2E scenario (`session-lifecycle.spec.ts`) still passes with the WebSocket transcript
  path substituted for polling and the async spawn split in place — this is the biggest regression
  surface in the phase, since two of Phase 1's core mechanisms changed underneath the same test.
- Phase 0 smoke spec stays green.
- Migration idempotency holds — booting three times (`001`, `002`, `003`) applies each exactly once.
- `pnpm exec tsc --noEmit`, `make lint` clean across both packages.

## Verification

1. `make build && make e2e` green, including `bootstrap-failures.spec.ts` and the updated
   `session-lifecycle.spec.ts`.
2. A real failing clone for each of the four classification rows (`not_found`, `auth`, `network`,
   `unknown`) is exercised against real `git`, not mocked — evidence-first per root `AGENTS.md`; record
   the actual observed stderr strings in `docs/phase_02_findings.md`, since [§10](./ARCHITECTURE.md)'s
   patterns are regexes against real-world text that may not match verbatim in this environment's `git`
   version.
3. The [GitHub issue #1](https://github.com/tbrandenburg/agent-control-plane/issues/1) open decision
   (Option A/B/C) is resolved explicitly in `docs/phase_02_findings.md` with rationale, **before**
   `OPENCODE_CONFIG_CONTENT` composition code is merged — not assumed silently.
4. `make loc` under 1000 with the per-row breakdown compared against [§14](./ARCHITECTURE.md)'s
   estimates (Bootstrap ~90-100, WS relay subset well under its ~105-120 full estimate since
   `presence`/`fetch_history` aren't built yet, Prompt/stop delivery ~15-20).
5. `docs/phase_02_findings.md` records whether [§10](./ARCHITECTURE.md)'s stderr classification table
   matched real `git` failures observed in this environment, and any regex corrections needed — this
   phase's own falsified assumption, mirroring `docs/phase_01_findings.md`'s format.
6. An E2E assertion that no `GET /api/sessions/:id/events` polling request fires after WS `subscribe`
   succeeds — proves the polling path was actually deleted, not left running alongside the socket.

---

## Implementation Steps

### Step 1: Real git bootstrap and failure classification

#### Changes

##### Create
- `control-plane/src/bootstrap.js`.
- `control-plane/src/bootstrap.test.js`.
- `e2e/fixtures/` additions: a deliberately-private/nonexistent repo reference, an unreachable-host
  reference, for the real-failure E2E variants.

##### Modify
- `control-plane/src/config.js` — add `PLATFORM_CONFIG_REPO` default, `WORKSPACE_HOST_PATH` (already
  present from Phase 1; confirm it's still correct for the new clone-based flow, not just the old
  hardcoded mount).

##### Remove
- The Phase 1 hardcoded pre-cloned repo path constant.

#### Implementation

##### `resolveSha(repoUrl, ref)`
`git ls-remote <repoUrl> <ref>` for each of target/platform/team repos, **up front**, before any fetch —
closes the concurrent-push race [§10](./ARCHITECTURE.md) calls out explicitly.

##### `cloneAndCheckout(repoUrl, sha, destPath, { sparse })`
`git fetch --depth 1 origin <sha>` + `git checkout <sha>` — **never** a branch-name checkout. When
`sparse` is set (team config layer): `git sparse-checkout init --cone` + `git sparse-checkout set
.opencode` before checkout.

##### `stripCredential(destPath)`
`git remote set-url origin <url-without-credential>` — run on every cloned directory **before** it is
bind-mounted into a sandbox, preserving the filesystem-path half of the secret-custody boundary
([§2](./ARCHITECTURE.md)), not just the network-path half Phase 4 closes.

##### `classifyGitFailure(stderr)`
Pattern match, in order, against the four-row table:
`/repository .* not found/i` → `not_found`; `/authentication failed|invalid username or token/i` →
`auth`; `/could not resolve host|failed to connect|couldn't connect to server|timed out/i` → `network`;
else → `unknown`. Never dispatch on exit code — `git`'s own exit code is always 128 regardless.

##### `bootstrapWorkspace(session)`
Orchestrates all three trees (target repo — hard fail on any classification; platform config repo — hard
fail on any classification; team config repo, if given — **silent skip on `not_found`**, hard fail on
`auth`/`network`/`unknown`). Returns the composed directory-tree layout `sandbox.run()` needs to mount.

##### Error Handling
Every classification failure carries the original (credential-stripped) stderr for logging, but the
classification tag — not the raw string — drives control-plane behavior (hard fail vs. silent skip).
Never let an unclassified failure default to "success."

##### Output / UX
Bootstrap failures are logged with the classification tag and repo role (target/platform/team) so a
human reading `docker logs`/control-plane logs can immediately tell which of the three trees failed and
why — this is the only observability this phase has until Phase 3's structured diagnostics land.

#### Patterns & Constraints

##### Mirror
[§10](./ARCHITECTURE.md)'s bootstrap failure-mode table and sequence description verbatim.

##### Decisions
- `child_process.spawn('git', [...])` with an argv array — never string-interpolated shell commands,
  same rule as Phase 1's `sandbox.js` ([§13](./ARCHITECTURE.md)).
- Team-layer `not_found` is a silent skip; target/platform-layer `not_found` is a hard failure. This
  asymmetry is load-bearing and must have its own explicit test, not be inferred from the happy path.

##### Gotchas
- `git`'s exit code is **always 128** on failure regardless of cause — classification must be
  stderr-text-based, and the regex patterns are only as good as this environment's actual `git`
  version's message strings; verify against real output, not assumed strings (Verification #2).
- `git ls-remote` failures use different stderr phrasing than `git fetch` failures for the same
  underlying cause in some `git` versions — test both call sites, not just one.
- Sparse checkout (`--cone` mode) requires `git` ≥ 2.25; confirm the sandbox/CI image's `git` version.

##### Out of Scope
`OPENCODE_CONFIG_CONTENT` composition (Step 2 — sequenced strictly after this step, per the Design
section's non-negotiable dependency), structured diagnostics fields (Phase 3).

#### Tests

##### E2E
Covered in Step 5 (`bootstrap-failures.spec.ts`).

##### Integration
Against real `git` (no mocking, per root `AGENTS.md`): a real local bare repo fixture for the happy
path; a genuinely nonexistent repo path for `not_found`; a repo requiring a credential with none
supplied for `auth`; an unreachable host (e.g. a non-routable IP) for `network`; a synthetic stderr
string for `unknown` (since a real `unknown`-classified git failure is hard to construct on demand).

##### Unit
`classifyGitFailure()` against each of the four patterns plus edge cases (mixed-case matches, multi-line
stderr); `stripCredential()`'s URL rewriting for both HTTPS-with-token and SSH remote forms.

#### Validation

##### Commands
```
pnpm --filter control-plane test && make loc
```

##### Expected Results
All four classification rows pass against real `git` output captured in this environment; credential
stripping verified via `git remote -v` on the resulting clone.

---

### Step 2: `OPENCODE_CONFIG_CONTENT` composition and the open gateway-default decision

#### Changes

##### Modify
- `control-plane/src/sandbox.js` — compose `OPENCODE_CONFIG_CONTENT` from `bootstrapWorkspace()`'s
  result, replacing the Phase 1 hardcoded content.
- `docs/phase_02_findings.md` — record the resolved Option A/B/C decision (see Design).

##### Remove
- Nothing.

#### Implementation

##### Composition
`{ "model": "<session.model>", "autoupdate": false }` — nothing else. No provider/gateway block is
enumerated in control-plane code; the Platform config repo cloned in Step 1 is what supplies the
provider catalog opencode resolves natively via its own 8-step precedence chain.

##### The open decision
Before writing this code, resolve
[GitHub issue #1](https://github.com/tbrandenburg/agent-control-plane/issues/1)'s Option A/B/C explicitly
in code review, using Step 1's bootstrap success/failure signal (now available, per the Design section's
sequencing note). Record the choice and rationale in `docs/phase_02_findings.md` before merging.

##### Error Handling
If the chosen option is B (conditional default injection only on Platform-clone failure), the injection
branch must be driven by Step 1's classification result, not a separate ad hoc "does the file exist"
check — reuse the same signal, don't invent a second one.

##### Output / UX
Whichever option is chosen, the sandbox's `docker run` env composition is a single, auditable function —
not scattered across multiple call sites — so a later Phase 4 change (repointing `baseURL` through
Caddy, per [§12](./ARCHITECTURE.md)) touches one place.

#### Patterns & Constraints

##### Mirror
[§8](./ARCHITECTURE.md)'s corrected precedence-chain analysis and its explicit statement that Option A
(pre-seeding Global config) is "fragile, depends on bootstrap ordering, not opencode's arbitration."

##### Decisions
- Whatever option is chosen must be a **documented, reviewed decision**, not a default silently picked
  by whoever writes the code first — this is called out twice in the steering docs precisely because an
  earlier draft got the precedence direction backwards.

##### Gotchas
- Do **not** attempt to write a default via `OPENCODE_CONFIG` (step 3 of opencode's precedence chain)
  expecting it to be safely overridden by the Platform config repo (step 2, Global) — [§8](./ARCHITECTURE.md)
  demonstrates step 3 loads *after* and therefore *overrides* step 2, the opposite of the desired
  "default, real config wins" semantics. This is the exact inversion error the steering docs already
  corrected once; do not reintroduce it.

##### Out of Scope
Enumerating specific gateways/providers in control-plane code — that remains Platform-config-repo
territory regardless of which option is chosen.

#### Tests

##### E2E
Covered in Step 5.

##### Integration
Assert the composed `OPENCODE_CONFIG_CONTENT` for a session contains exactly `model` and `autoupdate`,
nothing else, across both the with-Platform-repo and (if Option B/A chosen) without-Platform-repo cases.

##### Unit
Composition function's output shape for each session `model` value.

#### Validation

##### Commands
```
pnpm --filter control-plane test
```

##### Expected Results
`OPENCODE_CONFIG_CONTENT` matches the narrowed two-field shape in every case; the chosen option is
documented in `docs/phase_02_findings.md` with a link back to
[GitHub issue #1](https://github.com/tbrandenburg/agent-control-plane/issues/1).

---

### Step 3: Async spawn split, stop, and archive

#### Changes

##### Create
- `control-plane/migrations/003_ws_bootstrap.sql` — `ws_token` column; no new diagnostics columns yet.

##### Modify
- `control-plane/src/routes/sessions.js` — `POST /api/sessions` (async split), `POST .../stop`,
  `PATCH /api/sessions/:id`.
- `control-plane/src/sandbox.js` — `stop()` (bridge proxy + `docker stop` fallback).
- `sandbox/bridge.js` — `POST /stop` → `abort`.

##### Remove
- Nothing.

#### Implementation

##### `POST /api/sessions` async split
Insert the row with `status: 'pending_bootstrap'`, return `202 { id, wsToken }` immediately (the INSERT
is sub-millisecond). `setImmediate(() => bootstrapWorkspace(session).then(sandbox.run).then(sandbox.waitForHealth))`
runs after the response is sent; on success, update `status: 'active'`; on failure, leave the row in a
queryable failed state (no structured diagnostics fields until Phase 3 — state this limitation plainly,
don't imply more than exists).

##### `POST /api/sessions/:id/stop`
Direct proxy to the bridge's `POST /stop`. Only on a bounded timeout waiting for that response does the
control plane fall back to `docker stop`.

##### `PATCH /api/sessions/:id`
`{status}` update — `active` ↔ `archived` only this phase (no continuation-driven status values yet).

##### Error Handling
`stop` against a session with no live container → a clear error, no attempted `docker stop` against a
name that doesn't exist. `PATCH` with an invalid `status` value → `400`.

##### Output / UX
`wsToken` is returned **plaintext** in the `202` body this phase — `subscribe` compares it directly
against the plaintext `ws_token` column ([§6](./ARCHITECTURE.md) rotation/hashing is explicitly Phase 4).

#### Patterns & Constraints

##### Mirror
[§9](./ARCHITECTURE.md)'s stop semantics and [§10](./ARCHITECTURE.md)'s async-split rationale (the same
split the webhook needs in Phase 5 — build it generically here, not webhook-specific).

##### Decisions
- The async split function is written so Phase 5's webhook handler can call the same
  `bootstrapWorkspace` → `sandbox.run` → `waitForHealth` `setImmediate` chain without duplicating it.

##### Gotchas
- A client that doesn't wait for the WS `subscribe`/status transition will see `pending_bootstrap`
  immediately after create — the dashboard must render this state, not treat it as an error (Step 5).

##### Out of Scope
Structured diagnostics fields (`phase`/`failureReason`/etc.) — Phase 3.

#### Tests

##### E2E
Covered in Step 5.

##### Integration
`POST /api/sessions` returns `202` before bootstrap completes (assert response latency is decoupled from
a slow/stubbed bootstrap); `stop` proxy vs. `docker stop` fallback on bridge timeout; `PATCH` status
transitions.

##### Unit
None beyond what's covered by integration here — this step is mostly orchestration.

#### Validation

##### Commands
```
pnpm --filter control-plane test && make loc
```

##### Expected Results
`202` returned well before a deliberately slowed bootstrap stub completes; stop/patch paths green.

---

### Step 4: WebSocket subset (`subscribe`/`prompt`/`ping`)

#### Changes

##### Create
- `control-plane/src/routes/ws.js`.
- `control-plane/src/routes/ws.test.js`.

##### Modify
- `control-plane/src/server.js` — register `@fastify/websocket` and the WS route.

##### Remove
- Nothing.

#### Implementation

##### `subscribe`
Required first message, `{wsToken}`. Compare against the session's plaintext `ws_token` column. Mismatch
or missing → close with code `4001`. On success, add the socket to the module-level
`Map<sessionId, Set<WebSocket>>` registry.

##### `prompt`
`{content, model?, reasoningEffort?}` → the **same** synchronous bridge-proxy function the REST route
(`POST /api/sessions/:id/prompt`) uses — refactor Phase 1's REST handler into a shared function called
from both entry points, not duplicated logic.

##### `ping`
Keepalive no-op reply.

##### Event broadcast
The bridge's SSE-relay ingest (`POST /internal/sessions/:id/events`, from Phase 1) now also calls
`broadcastToSession(sessionId, {type: 'event', ...})` for every subscriber socket, in addition to the
existing DB insert — this is the one addition to Phase 1's ingest route this phase requires.

##### Error Handling
A socket that never sends `subscribe` first (sends `prompt`/`ping` instead) is closed immediately, same
as an invalid token — `subscribe` is a hard precondition, not one of several valid first messages.

##### Output / UX
Socket close codes are meaningful: `4001` for auth failure, standard codes otherwise — a dashboard
"reconnecting" indicator (Step 5) can distinguish "wrong token, don't retry" from "network blip, do
retry."

#### Patterns & Constraints

##### Mirror
[§6](./ARCHITECTURE.md)'s WebSocket protocol table and subscriber-registry design — build only the
`subscribe`/`prompt`/`ping` rows this phase, exactly as the roadmap scopes it, not the full six.

##### Decisions
- Single shared prompt-handling function between REST and WS, per [§9](./ARCHITECTURE.md)'s "one
  synchronous proxy, two entry points" framing.
- No Redis/pub-sub — single in-process `Map`/`Set`, matching [§6](./ARCHITECTURE.md)'s stated
  single-process sufficiency.

##### Gotchas
- The subscriber registry must be cleaned up on socket `close` or a long-running control plane leaks
  dead socket references indefinitely.
- `wsToken` is plaintext this phase — do not log it anywhere (root `AGENTS.md`: never log sensitive
  data), even though it isn't hashed yet.

##### Out of Scope
`presence`, `fetch_history`, WS `stop`, `session_continued` broadcast (no predecessor/successor exists
yet) — all Phase 3/4/6.

#### Tests

##### E2E
Covered in Step 5.

##### Integration
`ws.inject()`-style test: correct token subscribes and receives a broadcast event; wrong token gets
`4001`; two sockets subscribed to the same session both receive the same broadcast; a socket sending
`prompt` before `subscribe` is rejected.

##### Unit
None beyond the integration coverage above — this is inherently a wiring test.

#### Validation

##### Commands
```
pnpm --filter control-plane test
```

##### Expected Results
All WS integration cases green; no dead-socket references remain in the registry after test teardown
(assert the `Map`/`Set` is empty post-close).

---

### Step 5: Dashboard — WebSocket transcript, Stop/Archive, Team config field

#### Changes

##### Create
- `control-plane/dashboard/src/hooks/useSessionSocket.ts`.
- Component tests for the new hook and the pending-bootstrap status rendering.

##### Modify
- `control-plane/dashboard/src/components/Transcript.tsx` — WS-driven, polling deleted.
- `control-plane/dashboard/src/routes/SessionDetail.tsx` — Stop/Archive buttons, connection indicator.
- `control-plane/dashboard/src/routes/NewSession.tsx` — Team config field restored.
- `control-plane/dashboard/src/components/StatusBadge.tsx` — render `pending_bootstrap` distinctly.

##### Remove
- The Phase 1 TanStack Query polling hook for events.

#### Implementation

##### WebSocket transcript
`useSessionSocket(sessionId, wsToken)` opens the socket, sends `subscribe` first, then handles incoming
`{type:"event",...}` messages by appending to the same rendering path Phase 1's polling used — the
**content** contract (render `message.part.delta` incrementally) is unchanged, only the transport is.

##### Stop/Archive buttons
Wired directly to `POST /api/sessions/:id/stop` and `PATCH /api/sessions/:id {status:"archived"}`
respectively, in the session-detail header per [`UI.md` §3](./UI.md) — this is explicitly called out in
[`ROADMAP.md`](./ROADMAP.md) as a previously-missed gap; treat it as first-class, not incidental.

##### Team config field
Restored to the create form exactly as [`UI.md` §2](./UI.md)'s wireframe shows — optional, overrides the
default team config repo, now meaningful because Step 1's real bootstrap actually clones it.

##### Pending-bootstrap status
`StatusBadge` renders a distinct visual state for `status: 'pending_bootstrap'` (e.g. a spinner/"Setting
up...") both in the session list and detail header — the create flow's 202-then-async-settle behavior
must be visible, not silently identical to `active`.

##### Error Handling
A WS close with code `4001` shows a clear "session token invalid, reload" message, not a silent
disconnect. A bootstrap failure (session stuck in a failed state) shows an inline error rather than an
infinite pending spinner.

##### Output / UX
Connection indicator in the header reflects actual WS state (connected/reconnecting/closed), replacing
Phase 1's polling-derived approximation.

#### Patterns & Constraints

##### Mirror
[`UI.md` §3](./UI.md)'s header layout (Stop/Archive buttons) and §2's Team config field placement.

##### Decisions
- The polling hook is deleted outright, not left as a fallback — [`ROADMAP.md`](./ROADMAP.md)'s deferral
  table is explicit that this is a deletion, not a layering.

##### Gotchas
- A reconnect after a dropped WS must not duplicate already-rendered transcript entries — dedupe by the
  same `timestamp,id` identity Phase 1's cursor used, even though this phase's WS path doesn't re-fetch
  via that cursor endpoint directly (no `fetch_history` yet — Phase 6).

##### Out of Scope
Participants panel, `fetch_history`-driven reconnect replay (both Phase 6); Diagnostics/Artifacts/Logs
panels (Phase 3).

#### Tests

##### E2E
Covered in Step 6.

##### Integration
React Testing Library: `useSessionSocket` connects, sends `subscribe`, renders incoming events; Stop
button calls the stop endpoint; Archive button calls `PATCH`; Team config field submits in the create
body when filled, omitted when empty.

##### Unit
`StatusBadge`'s `pending_bootstrap` rendering case added to Phase 1's existing table-driven test.

#### Validation

##### Commands
```
pnpm --filter dashboard test && pnpm --filter dashboard build && make loc
```

##### Expected Results
Component tests green; bundle builds; dashboard LOC still excluded from the [§14](./ARCHITECTURE.md)
budget.

---

### Step 6: End-to-end verification and bootstrap-classification falsification

#### Changes

##### Create
- `e2e/tests/bootstrap-failures.spec.ts`.
- `docs/phase_02_findings.md`.

##### Modify
- `e2e/tests/session-lifecycle.spec.ts` — update for WS transport and async spawn split.
- `.github/workflows/ci.yml` — ensure any new E2E fixture repos/hosts are available in CI.

##### Remove
- Nothing.

#### Implementation

##### E2E specs
`session-lifecycle.spec.ts` updated to assert over WebSocket instead of polling, and to accommodate the
`202`-then-settle create flow. `bootstrap-failures.spec.ts` drives real failing clones for all four
classification rows against real `git` — no mocking of Docker or git, per root `AGENTS.md`.

##### Findings document
`docs/phase_02_findings.md`, mirroring `docs/phase_01_findings.md`'s evidence-first format: record
whether the stderr classification patterns matched this environment's real `git` output verbatim, any
regex adjustments needed, and the resolved Option A/B/C gateway-default decision with rationale.

##### Error Handling
E2E teardown removes every spawned sandbox container and any cloned fixture directories even on
failure, or CI leaks state across runs.

##### Output / UX
The findings document is this phase's evidence artifact, same evidentiary standard as Phase 1 — a green
test run alone does not close the phase.

#### Patterns & Constraints

##### Mirror
[`ROADMAP.md`](./ROADMAP.md)'s Phase 2 exit criterion and stated riskiest assumption
(bootstrap-classification accuracy).

##### Decisions
- Real git failures, not mocked stderr, for at least three of the four classification rows (the fourth,
  `unknown`, may need a synthetic fixture — state this explicitly rather than pretending it was also
  reproduced naturally).

##### Gotchas
- Network-failure E2E cases (`network` classification) need a genuinely unreachable host reference that
  won't flake against real CI network conditions — pick a non-routable address deliberately, document
  why it's expected to time out rather than resolve.

##### Out of Scope
Any Phase 3+ capability; any "small" security fix (Phase 4 closes them as one set, per
[`ROADMAP.md`](./ROADMAP.md)).

#### Tests

##### E2E
`session-lifecycle.spec.ts` (updated) and `bootstrap-failures.spec.ts` (new).

##### Integration
Full control-plane suite runs against the real DB and a stubbed sandbox in CI's integration job, as in
Phase 1.

##### Unit
No new unit coverage; this step consumes prior steps'.

#### Validation

##### Commands
```
make build && make sandbox-image && make e2e && make lint && make test && make loc
```

##### Expected Results
Green E2E against the real stack including real failing clones; `docs/phase_02_findings.md` records the
classification-accuracy findings and the resolved gateway-default decision;
[`ROADMAP.md`](./ROADMAP.md)'s Phase 2 exit criterion — "create a session against an arbitrary repository
from the dashboard and watch a live-streaming transcript" — demonstrably met, unblocking Phase 3.
