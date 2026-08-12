# Phase 1 — Spawn an Agent From the Dashboard

The first vertical slice: one thin cut through every layer, ending in a browser where a prompt produces streaming agent output.

> **Steering documents:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) (§2 system context, §4 data model, §5 API,
> §8 bridge/SSE contract, §9 synchronous delivery, §14 LOC budget), [`UI.md`](./UI.md) (§1 session list,
> §2 create session, §3 session detail), [`ROADMAP.md`](./ROADMAP.md) (Phase 1 scope, exit criterion,
> falsified assumptions, deferral table). Prerequisite: [`docs/phase_00_plan.md`](./phase_00_plan.md).

## Goal

A human opens the dashboard, clicks "New Session", submits a title/model, watches a sandbox container
spawn, types a prompt, and sees `opencode`'s tokens appear in a transcript.

Why it matters: [`ROADMAP.md`](./ROADMAP.md) identifies three assumptions as the most likely to be wrong
in the entire design, and this phase kills all three for the least possible code:

1. Is `opencode serve`'s SSE stream actually relayable frame-by-frame as [§8](./ARCHITECTURE.md) claims?
2. Is the bridge's `/prompt` + relay contract the right seam?
3. Does storing every frame verbatim ([§4](./ARCHITECTURE.md)) produce a usable transcript, or an
   unmanageable firehose?

## Scope

**Included**
- `sessions` table subset: `id`, `title`, `repo_owner`, `repo_name`, `model`, `reasoning_effort`,
  `status`, `container_name`, `opencode_session_id`, `created_at`, `updated_at`. `reasoning_effort` is
  included (unlike other continuation/auth columns) because [§8](./ARCHITECTURE.md) requires it stored
  and re-sent as the per-prompt default — omitting it would make that mechanism unimplementable.
- `events` table + `GET /api/sessions/:id/events` (cursor pagination, `timestamp,id` cursor per [§4](./ARCHITECTURE.md)).
- `POST /api/sessions` (**synchronous** bootstrap — the `setImmediate` split is deferred to Phase 2),
  `GET /api/sessions`, `GET /api/sessions/:id`.
- `POST /api/sessions/:id/prompt` — synchronous proxy to the bridge ([§9](./ARCHITECTURE.md)).
- `GET /api/models` — static allowlist from `config.js` ([§5](./ARCHITECTURE.md)).
- `sandbox.run()` / `sandbox.inspect()` via `docker run` / `docker inspect` (`child_process.spawn`).
- `sandbox/bridge.js`: `POST /prompt`, SSE relay to `POST /internal/sessions/:id/events`,
  `POST /internal/sessions/:id/oc-session`.
- `sandbox/Dockerfile` with `opencode` + the bridge, one **pre-cloned, hardcoded** repo bind-mounted.
- Dashboard: session list ([`UI.md` §1](./UI.md)), create form ([`UI.md` §2](./UI.md)) — **title, repo,
  model, and reasoning effort only**, transcript view ([`UI.md` §3](./UI.md) Conversation tab) via
  TanStack Query polling at 1s.

**Excluded — deliberately, tracked in [`ROADMAP.md`](./ROADMAP.md)'s deferral table**
- WebSocket ([§6](./ARCHITECTURE.md)) — polling stands in; closed in Phase 2.
- Real git bootstrap, SHA-pinning, failure classification ([§10](./ARCHITECTURE.md)) — Phase 2.
- **`teamConfigRepo`** — dropped from the Phase 1 create form and `POST /api/sessions` body entirely.
  It has no destination this phase: there is no real git bootstrap ([§10](./ARCHITECTURE.md) lands in
  Phase 2) and only one hardcoded pre-cloned repo is bind-mounted, so collecting a team-config-repo
  override now would be a dead field with nothing to override. Re-added in Phase 2 alongside real
  bootstrap, not before.
- `setImmediate` async spawn split, `pending_bootstrap` semantics — Phase 2.
- Auth of every kind: OIDC, bearer introspection, `wsToken`, per-session `INTERNAL_TOKEN` — Phase 4.
- `internal: true` isolation and the Caddy `sandbox-proxy` — Phase 4. **Sandboxes run on `egress-net`
  with raw env-var credentials in this phase — insecure on purpose, one compose line to flip.**
- Continuation, reaper, named volumes, idle watchdog — Phase 3.
- Diagnostics, logs, artifacts panels; Participants panel — Phase 3 / Phase 6.
- Webhooks — Phase 5.

**Constraints**
- Every counted line lands against [§14](./ARCHITECTURE.md)'s budget; `make loc` stays green.
- No queue, no `prompts` table, no `/internal/queue`, no `/internal/ack`, no poll loop
  ([§9](./ARCHITECTURE.md) — the single most valuable simplification in the design).
- The dashboard must not render any panel the backend does not yet back ([`UI.md`](./UI.md) design goals).

## Design

**Request flow (this phase).**
```
Browser ── POST /api/sessions ──▶ control-plane
                                   │ insert row (status: active)
                                   │ docker run sandbox (blocking)
                                   │ wait for /global/health
                                   ◀── 201 { id }
Browser ── POST /api/sessions/:id/prompt ──▶ control-plane ──▶ bridge POST /prompt
                                                                   │ POST /session/:oc/prompt_async
Browser ◀── GET /events?cursor= (1s poll) ── control-plane ◀── POST /internal/sessions/:id/events ◀── SSE relay
```

**Bridge contract** — verbatim from [§8](./ARCHITECTURE.md), no reinterpretation:
- `opencode serve` on `127.0.0.1:4096` inside the sandbox.
- All events flow through the **single global** `GET /event` SSE stream, filtered client-side on
  `properties.sessionID`. `GET /session/{id}/event` does not exist.
- Plain SSE, `data:` frames only, no `event:` field.
- Prompt body: `{ model: { providerID, modelID, variant? }, parts: [{ type: 'text', text }] }` where
  `splitModel` splits on the **first** `/`.
- Every frame is relayed verbatim and stored verbatim in `events` ([§4](./ARCHITECTURE.md)) — including
  `message.part.delta` token frames, which are what makes live "typing" UX possible.
- The bridge reports the freshly created conversation id once via
  `POST /internal/sessions/:id/oc-session`, making `sessions.opencode_session_id` authoritative in the
  control plane's own DB rather than derived from the sandbox ([§4](./ARCHITECTURE.md)/[§8](./ARCHITECTURE.md)).

**Model handling.** `GET /api/models` returns the hand-curated static allowlist. Validation on
`POST /api/sessions` and `/prompt` is **syntax only** (`provider/model`, first-`/`-is-separator,
`400 INVALID_MODEL_REFERENCE`) — explicitly **not** allowlist membership
([§5](./ARCHITECTURE.md): "no membership-check code should be added here").

**Readiness.** The control plane waits for the sandbox's Docker healthcheck (`GET /global/health`) to
pass before its first `/prompt` call, retrying with backoff on connection-refused
([§8](./ARCHITECTURE.md) — the one trade-off the synchronous model introduces over a poll loop).

**Status semantics.** `sessions.status` only ever holds `active` | `archived` | `pending_bootstrap`
([§4](./ARCHITECTURE.md)). `running`/`stopped`/`failed` are **derived** in the dashboard from the live
`docker inspect` phase returned alongside the row ([`UI.md` §1](./UI.md)) — the backend never stores them.

**Networking (temporary).** Sandbox containers join `egress-net` and receive the LiteLLM base URL and
API key directly as env vars. This violates the secret-custody boundary of [§2](./ARCHITECTURE.md) by
design and is closed in Phase 4. [`ROADMAP.md`](./ROADMAP.md)'s deferral table actually tracks this as
**three separate** P1→P4 items (`internal: true` isolation, Caddy credential injection, per-session
`INTERNAL_TOKEN`), not one — so this must be marked with an explicit `PHASE-4` comment **at each of the
distinct code sites it touches** (the `--network` flag, the `-e LITELLM_*`/`OPENCODE_CONFIG_CONTENT`
env injection, and the missing `INTERNAL_TOKEN` check on `/internal/*`), not a single marker.

## Changes

**Created**
- `control-plane/migrations/002_sessions_events.sql` — `sessions` (subset), `events`.
- `control-plane/src/routes/sessions.js` — sessions CRUD subset + events read + prompt proxy.
- `control-plane/src/routes/internal.js` — `/internal/sessions/:id/events`, `/internal/sessions/:id/oc-session`.
- `control-plane/src/sandbox.js` — `run()`, `inspect()`, `waitForHealth()`.
- `control-plane/src/model.js` — `splitModel`/syntax validation.
- `sandbox/bridge.js`, `sandbox/Dockerfile`, `sandbox/package.json`.
- Dashboard: `src/api/client.ts`, `src/routes/SessionList.tsx`, `src/routes/NewSession.tsx`,
  `src/routes/SessionDetail.tsx`, `src/components/Transcript.tsx`, `src/components/PromptComposer.tsx`.
- `e2e/tests/session-lifecycle.spec.ts`.

**Modified**
- `control-plane/src/config.js` — add `MODEL_ALLOWLIST`, `SANDBOX_IMAGE`, `CONTROL_PLANE_INTERNAL_URL`, `WORKSPACE_HOST_PATH`.
- `control-plane/src/server.js` — register the new route modules.
- `docker-compose.yml` — build the sandbox image; keep sandboxes on `egress-net` (Phase 4 flips this).
- `control-plane/dashboard/src/App.tsx` — real routing across the three declared routes.
- `scripts/loc.mjs` — new counted paths already covered by the include globs; verify row mapping.

**Removed**
- Nothing. Phase 0's `/health` and smoke E2E stay as the regression baseline.

## E2E Tests

### Happy Path

Against a real `docker compose` stack: open `/`, click "New Session", fill title + repo + model, submit;
land on `/sessions/:id`; observe status become active and a container name appear; type a prompt; assert
transcript text grows and at least one `message.part.delta` event is persisted; assert
`opencode_session_id` is populated on `GET /api/sessions/:id`. This is [`ROADMAP.md`](./ROADMAP.md)'s
Phase 1 exit criterion executed verbatim.

### Important Variants

- Second prompt in the same session reuses the same `opencode_session_id` (no new conversation created).
- Two concurrent sessions produce two containers and two disjoint event streams — proves the
  `properties.sessionID` filter in the bridge relay actually isolates traffic.
- Session list reflects live `docker inspect` phase (`running` after spawn, `stopped` after the container
  exits) while `sessions.status` remains `active` — proves the derived-badge design of [`UI.md` §1](./UI.md).
- Cursor pagination: request events with a cursor from a prior page and receive only newer frames, no duplicates.

### Error Paths

- `POST /api/sessions` with `model: "claude-sonnet"` (no `/`) → `400 INVALID_MODEL_REFERENCE`.
- `POST /api/sessions` with `model: "litellm/not-in-allowlist"` → **`201`, accepted** — the allowlist is
  UI-only and must not gate ([§5](./ARCHITECTURE.md)).
- `POST /api/sessions/:id/prompt` for an unknown session id → `404`, no container touched.
- Prompt sent while the sandbox is still unhealthy → the readiness wait retries and then either succeeds
  or returns a clear `503`; never an unhandled `ECONNREFUSED`.
- `docker run` failure (bad image) → the API returns a readable error, not a raw spawn stack trace. The
  session row itself is left `active` with no live container (Phase 1's schema has no failure/diagnostics
  columns — those arrive in Phase 3) — this is a materially weaker guarantee than "the row reflects the
  failure," and is stated honestly here rather than implying stored failure state that doesn't exist yet.
- Sandbox killed mid-stream → the relay stops without crashing the control plane; already-persisted events
  remain readable.

### Help / Command Discovery

- `make loc` still prints the [§14](./ARCHITECTURE.md) budget table and stays under 1000 with the new code.
- `GET /api/models` returns the static allowlist and the create form's dropdown is populated from it
  ([`UI.md` §2](./UI.md)).
- `make help` lists any new target (e.g. `make sandbox-image`).

### Regression Coverage

- Phase 0 smoke spec stays green: `/health` returns 200, `/` and `/sessions/new` serve the SPA.
- Migration idempotency holds — booting twice applies `002` exactly once.
- `pnpm exec tsc --noEmit`, `make lint` clean across both packages.

## Verification

1. `make build && make e2e` green, including `session-lifecycle.spec.ts`.
2. A prompt round-trip produces `message.part.delta` rows in `events` — verified by direct SQL query, not
   only by UI assertion (evidence-first).
3. `sessions.opencode_session_id` is non-null after the first prompt and unchanged after the second.
4. `make loc` under 1000 with the per-row breakdown compared against [§14](./ARCHITECTURE.md)'s estimates.
5. The three [`ROADMAP.md`](./ROADMAP.md) Phase 1 assumptions are explicitly answered in writing — including
   assumption 3 (transcript vs. firehose), which may force an [§15](./ARCHITECTURE.md) `events` retention
   decision earlier than Phase 6. Record the answer; do not silently proceed.
6. Grep confirms a `PHASE-4` marker at each distinct insecure-networking code site (network mode flag,
   credential env injection, missing `INTERNAL_TOKEN` check) — three markers expected, not one; see the
   Design section's "Networking (temporary)" note.

---

## Implementation Steps

### Step 1: Schema and sessions read API

#### Changes

##### Create
- `control-plane/migrations/002_sessions_events.sql`.
- `control-plane/src/routes/sessions.js` (read paths only in this step).
- `control-plane/src/routes/sessions.test.js`.

##### Modify
- `control-plane/src/server.js` — register the sessions routes.

##### Remove
- Nothing.

#### Implementation

##### Schema
`sessions`: `id TEXT PRIMARY KEY`, `title`, `repo_owner`, `repo_name`, `model`, `reasoning_effort`,
`status TEXT NOT NULL`, `container_name`, `opencode_session_id`, `created_at`, `updated_at`. Continuation
columns (`predecessor_id`, `successor_id`, `continuation_reason`, `current_attempt`, `workspace_expires_at`)
are omitted — they arrive in Phase 3 as an additive migration. `ws_token_hash`/`ws_token_prev_hash`/
`ws_token_prev_expires_at` are also omitted here — the plaintext `wsToken` mechanism itself is introduced
in **Phase 2** (WebSocket `subscribe`), and its hashing/rotation columns are added in **Phase 4**
([`ROADMAP.md`](./ROADMAP.md) Phase 2/4 sections; Step 4 of this plan is consistent with this). All of
these match [`ROADMAP.md`](./ROADMAP.md)'s "additive schema columns" deferral note.

`events`: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `session_id` (indexed), `timestamp`, `payload TEXT`
(the verbatim SSE frame). Index on `(session_id, timestamp, id)` to serve the `timestamp,id` cursor.

##### Read routes
`GET /api/sessions` with `limit`/`offset`/`status`; `GET /api/sessions/:id` returning the row plus the
live `docker inspect` phase (added in Step 2 — return a null phase until then).

##### Error Handling
Unknown session id → `404` with a structured `{ error }` body. Invalid `limit`/`offset` → `400`, clamped
never silently.

##### Output / UX
JSON field names are camelCase on the wire (`repoOwner`, `opencodeSessionId`) while columns stay
snake_case — [§4](./ARCHITECTURE.md) names the field `opencodeSessionId`, corrected from an earlier
`oc_session_id` draft. Do not reintroduce the old name.

#### Patterns & Constraints

##### Mirror
[§4](./ARCHITECTURE.md)'s table definitions and [§5](./ARCHITECTURE.md)'s endpoint table.

##### Decisions
- Raw SQL with prepared statements; no ORM, no query builder ([§13](./ARCHITECTURE.md)).
- `events` stores the raw frame text, not a parsed/normalised shape — verbatim is the contract.

##### Gotchas
- `node:sqlite` returns `null` (not `undefined`) for NULL columns; the row→JSON mapper must handle it.
- The cursor is `timestamp,id`, not `id` alone — two frames can share a timestamp.

##### Out of Scope
`PATCH /api/sessions/:id`, `/stop`, diagnostics, logs, artifacts — Phases 2 and 3.

#### Tests

##### E2E
None yet.

##### Integration
`inject()` against a seeded DB: list pagination, filter by status, 404 on unknown id, cursor pagination
returning no duplicates across page boundaries.

##### Unit
Cursor encode/decode round-trip, including the same-timestamp tie-break.

#### Validation

##### Commands
```
pnpm --filter control-plane test && pnpm exec tsc --noEmit && make loc
```

##### Expected Results
Green; `002` applies once; LOC total consistent with [§14](./ARCHITECTURE.md)'s "Public API" and "SQLite" rows.

---

### Step 2: Sandbox lifecycle via the Docker CLI

#### Changes

##### Create
- `control-plane/src/sandbox.js` — `run()`, `inspect()`, `waitForHealth()`.
- `control-plane/src/sandbox.test.js`.
- `sandbox/Dockerfile`, `sandbox/package.json`.

##### Modify
- `docker-compose.yml` — build the sandbox image; expose `SANDBOX_IMAGE` to the control plane.
- `Makefile` — `make sandbox-image`.

##### Remove
- Nothing.

#### Implementation

##### `sandbox.run(session)`
`child_process.spawn('docker', ['run', '-d', ...])` per [§13](./ARCHITECTURE.md) (plain `docker run`, the
direct analog of one K8s Job per session). Arguments: `--name <container_name>`, `--network egress-net`
(**PHASE-4: becomes `sandbox-net` with `internal: true`**), `-v <host repo path>:/workspace/repo:ro`
(hardcoded pre-cloned repo this phase), `-e SESSION_ID`, `-e CONTROL_PLANE_URL`,
`-e OPENCODE_CONFIG_CONTENT`, `-e LITELLM_*` (**PHASE-4: injected by the Caddy proxy instead**).

`OPENCODE_CONFIG_CONTENT` is the minimal non-negotiable layer from [§8](./ARCHITECTURE.md): `model`,
`autoupdate: false`, and the `provider.litellm` block. In this phase `baseURL` points straight at
LiteLLM; Phase 4 repoints it at `http://sandbox-proxy:8080/litellm`.

##### `sandbox.inspect(name)`
`docker inspect` → `{ exists, state }`. Shape it exactly as [§7](./ARCHITECTURE.md)'s
`resolveActiveSession` will consume it in Phase 3, so continuation needs no refactor. A missing container
is `{ exists: false }`, not an error.

##### `sandbox.waitForHealth(name)`
Poll `docker inspect`'s health status (or the bridge's `GET /global/health`) with backoff until healthy or
a bounded timeout — [§8](./ARCHITECTURE.md)'s healthcheck-gated readiness.

##### Sandbox image
Base with `opencode` installed, `tools/` for the image-baked built-ins (populated in Phase 5), the bridge
copied in, `HEALTHCHECK` on the bridge's health route, and an entrypoint starting `opencode serve` on
`127.0.0.1:4096` plus the bridge.

##### Error Handling
Never use `exec` with string interpolation — `spawn` with an argv array, so repo/session values can never
be shell-injected. Non-zero `docker` exit → an `Error` carrying trimmed stderr; the route surfaces a
readable message, never a raw stack.

##### Output / UX
Container naming is deterministic and greppable: `sandbox-<sessionId>` (Phase 3 adds the attempt suffix
when continuation introduces multiple attempts per session).

#### Patterns & Constraints

##### Mirror
[§12](./ARCHITECTURE.md)'s compose topology and [§13](./ARCHITECTURE.md)'s `docker run` row.

##### Decisions
- Docker **CLI via spawn**, not dockerode — [§1](./ARCHITECTURE.md) excludes the Docker CLI from the budget
  while an SDK wrapper would add authored glue.
- No named volumes yet; the workspace is a read-only bind mount of a pre-cloned repo (Phase 3 adds volumes).

##### Gotchas
- `--network egress-net` requires the compose-created network name (project-prefixed) — resolve it from
  env rather than hardcoding the bare name.
- The control plane runs in a container; the bind-mount source path must be a **host** path, not a
  path inside the control-plane container. Thread it through `WORKSPACE_HOST_PATH`.
- Docker healthcheck status only appears in `docker inspect` when the image declares `HEALTHCHECK`.

##### Out of Scope
`docker stop`, `docker logs`, volume creation, the reaper, per-session `INTERNAL_TOKEN`.

#### Tests

##### E2E
Covered in Step 6.

##### Integration
Against real Docker: run a container from the sandbox image, assert `inspect` reports `running`, assert
`waitForHealth` resolves, then remove it.

##### Unit
Argv construction for `run()` (exact flag list, env pass-through, no shell string anywhere) and
`inspect()` output parsing for the missing/running/exited cases.

#### Validation

##### Commands
```
make sandbox-image && pnpm --filter control-plane test
```

##### Expected Results
Image builds; integration test spawns and reaps a real container; no `exec`/string-interpolated command
anywhere in `sandbox.js`.

---

### Step 3: The sandbox bridge and SSE relay

#### Changes

##### Create
- `sandbox/bridge.js`.
- `control-plane/src/routes/internal.js`.
- `sandbox/bridge.test.js`.

##### Modify
- `control-plane/src/server.js` — register internal routes.
- `sandbox/Dockerfile` — start the bridge alongside `opencode serve`.

##### Remove
- Nothing.

#### Implementation

##### Bridge HTTP server
A **small inbound HTTP server, not a poller** ([§8](./ARCHITECTURE.md)/[§9](./ARCHITECTURE.md)). Routes:
- `POST /prompt` → `POST /session/:oc/prompt_async` with
  `{ model: { ...splitModel(model), variant: reasoningEffort }, parts: [{ type: 'text', text: content }] }`.
  When `reasoningEffort` is unset, **omit `variant` entirely** — not `undefined` — so opencode's own
  per-provider defaults apply. Invent no fallback value.
- `GET /global/health` → readiness for the Docker healthcheck.

##### `getOrCreateOcSession()`
[§8](./ARCHITECTURE.md)'s core logic, scoped to what Phase 1 actually needs: `POST /session {}` to create
a fresh conversation, then report the new id once via `POST /internal/sessions/:id/oc-session`. **The
`OPENCODE_SESSION_ID` env-hint reattach branch is deliberately not implemented this phase** — no
continuation exists yet ([§7](./ARCHITECTURE.md) is Phase 3 scope), so there is no caller that would ever
set that env var, and implementing an unreachable branch ahead of need is exactly the kind of anticipatory
code this repo's YAGNI principle rules out. Add the hint-check branch in Phase 3 alongside
`spawnContinuation`, where it becomes exercised and testable, not before.

##### SSE relay
Consume the **single global** `GET /event` stream. Parse plain `data:` frames only — there is no `event:`
field. Filter on `properties.sessionID` matching the bridge's own conversation id, then `POST` each frame
verbatim to `/internal/sessions/:id/events`. Treat `server.connected`/`heartbeat` as keepalive no-ops.
Reconnect with backoff if the stream ends.

##### Internal ingest routes
`POST /internal/sessions/:id/events` inserts one `events` row per frame.
`POST /internal/sessions/:id/oc-session` sets `sessions.opencode_session_id` **once**; a second call with a
different id is a `409`, not a silent overwrite — the control plane is the source of truth
([§4](./ARCHITECTURE.md)).

##### Error Handling
A failed ingest `POST` is retried with bounded backoff and then dropped with a log line — [§4](./ARCHITECTURE.md)
explicitly frames `events` as a best-effort mirror ("there might still be some parts missing"), not a
guaranteed-complete transcript. Do not build recovery machinery that the design does not claim.
No auth on `/internal/*` this phase; add a `PHASE-4` comment where the `INTERNAL_TOKEN` check will go.

##### Output / UX
The bridge logs one line per lifecycle transition (`starting bridge`, `connected to opencode`,
`session ready`, `received prompt`). This is justified purely on Phase 1's own terms — `docker logs` needs
readable output to debug the vertical slice regardless of any dashboard panel — not by anticipating
Phase 3's Logs panel. That the format happens to match [`UI.md` §3](./UI.md)'s Logs panel sample is a
convenient byproduct, not a design goal of this step.

#### Patterns & Constraints

##### Mirror
[§8](./ARCHITECTURE.md)'s bridge code sketch — it is a verified contract ("verified live against a real
two-turn run"), not a suggestion. Follow it literally.

##### Decisions
- No harness-abstraction layer — talk to `opencode serve` directly ([§8](./ARCHITECTURE.md), declared YAGNI).
- Node with zero runtime dependencies in the bridge if practical (`node:http` + `fetch`), keeping the
  [§14](./ARCHITECTURE.md) bridge row near its ~50-70 LOC estimate.

##### Gotchas
- `GET /session/{id}/event` **does not exist** — using it is the single most likely implementation mistake here.
- SSE frames can split across chunk boundaries; buffer until a blank-line delimiter.
- `splitModel` splits on the **first** `/` — model ids legitimately contain further slashes.
- The bridge must not hold any external secret ([§3](./ARCHITECTURE.md)); in Phase 1 the LiteLLM key
  transits via opencode's config env, which is exactly the Phase 4 debt being tracked.

##### Out of Scope
`POST /stop`/abort, the 15-minute idle watchdog (Phase 3), `INTERNAL_TOKEN` auth (Phase 4).

#### Tests

##### E2E
Covered in Step 6.

##### Integration
Run the bridge against a stub SSE server emitting a recorded real frame sequence (including
`message.part.delta`); assert every frame is forwarded verbatim and that frames for a different
`properties.sessionID` are filtered out.

##### Unit
SSE chunk-boundary buffering; `splitModel` on `litellm/eu.anthropic.claude-sonnet-4-6`; `variant` omitted
vs. present in the `prompt_async` body.

#### Validation

##### Commands
```
pnpm --filter sandbox test && pnpm --filter control-plane test
```

##### Expected Results
Frames arrive verbatim in `events`; `opencode_session_id` set exactly once; a duplicate oc-session report
returns 409.

---

### Step 4: Session creation and synchronous prompt delivery

#### Changes

##### Create
- `control-plane/src/model.js` — `splitModel` + syntax validation.
- `control-plane/src/routes/models.js` — `GET /api/models`.

##### Modify
- `control-plane/src/routes/sessions.js` — add `POST /api/sessions` and `POST /api/sessions/:id/prompt`.
- `control-plane/src/config.js` — add `MODEL_ALLOWLIST`.

##### Remove
- Nothing.

#### Implementation

##### `POST /api/sessions`
Validate body (`title`, `repoOwner`, `repoName`, `model`, optional `reasoningEffort`). **No
`teamConfigRepo` field this phase** — dropped per Scope above, since there is no real bootstrap/team-config
clone path to override yet. Insert the row (with `reasoning_effort` stored, per [§8](./ARCHITECTURE.md))
with `status: 'active'`, then **synchronously** `sandbox.run()` + `waitForHealth()` and return `201 { id }`.
[`ROADMAP.md`](./ROADMAP.md) explicitly instructs skipping the `setImmediate` split this phase; `wsToken`
is not returned because no WebSocket exists yet (Phase 2 adds it, Phase 4 hashes it).

##### `POST /api/sessions/:id/prompt`
Look up the session, resolve the container address on `egress-net`, and make a **synchronous proxy call**
to the bridge's `POST /prompt`. Return the bridge's ack. No queue, no ack table, no poll loop
([§9](./ARCHITECTURE.md)). `resolveActiveSession` ([§7](./ARCHITECTURE.md)) is **not** called here — that
is Phase 3; a dead sandbox is a plain error this phase.

##### `GET /api/models` and validation
Return `{ models: MODEL_ALLOWLIST }` from `config.js` — static, hand-curated, no LiteLLM query, no cache
([§5](./ARCHITECTURE.md)). Validation is **syntax only**: non-empty `provider` and `model` around the
first `/`, else `400 INVALID_MODEL_REFERENCE`. **Do not check allowlist membership** — [§5](./ARCHITECTURE.md)
states this explicitly as a confirmed production behaviour and warns against adding a stricter gate.

##### Error Handling
Spawn failure → `500` with the classified docker stderr message and a session row left in a queryable
state. Bridge unreachable after readiness backoff → `503`. Unknown session → `404`.

##### Output / UX
Wire shapes exactly as [§5](./ARCHITECTURE.md): `201 { id }` on create (plus `wsToken` from Phase 2),
`{ messageId, position }` ack on prompt.

#### Patterns & Constraints

##### Mirror
[§5](./ARCHITECTURE.md)'s endpoint table and [§9](./ARCHITECTURE.md)'s synchronous-proxy rationale.

##### Decisions
- Synchronous create is a deliberate, tracked Phase 1 simplification, not the final design.
- `reasoningEffort` is stored and passed through as `model.variant` with **zero translation logic**
  ([§8](./ARCHITECTURE.md) — it is opencode's own variant vocabulary, not a control-plane invention).

##### Gotchas
- Creating a session blocks the HTTP request for the full container spawn — acceptable here, but the
  dashboard needs a pending state or it looks hung.
- An invalid `variant` for a given provider/model is rejected or ignored by opencode itself; the control
  plane deliberately does not pre-validate it ([§8](./ARCHITECTURE.md)).

##### Out of Scope
`POST /stop`, `PATCH /api/sessions/:id`, webhook-driven creation, auth.

#### Tests

##### E2E
Covered in Step 6.

##### Integration
Create → prompt → events flow with a stubbed sandbox module; the 404/503 paths; `GET /api/models` shape.

##### Unit
Model syntax validation table: `litellm/x` valid, `x` invalid, `/x` invalid, `x/` invalid,
`litellm/a/b` valid with `modelID = "a/b"`, and a non-allowlisted but well-formed id **accepted**.

#### Validation

##### Commands
```
pnpm --filter control-plane test && make loc
```

##### Expected Results
All validation cases pass — most importantly the non-allowlisted-but-valid model returning 201, proving no
membership gate was added.

---

### Step 5: Dashboard — list, create, and polling transcript

#### Changes

##### Create
- `src/api/client.ts` — typed `fetch` wrappers + TanStack Query hooks.
- `src/routes/SessionList.tsx`, `src/routes/NewSession.tsx`, `src/routes/SessionDetail.tsx`.
- `src/components/Transcript.tsx`, `src/components/PromptComposer.tsx`, `src/components/StatusBadge.tsx`.
- Component tests for `StatusBadge` and `Transcript`.

##### Modify
- `src/App.tsx` — routing across exactly `/`, `/sessions/new`, `/sessions/:id`.

##### Remove
- The Phase 0 placeholder shell content.

#### Implementation

##### Session list — [`UI.md` §1](./UI.md)
Table of title / repository / model / status. `StatusBadge` **derives** its value: `sessions.status`
(`active`/`archived`/`pending_bootstrap`) combined with the live `docker inspect` phase to render
`active`/`running`/`stopped`/`failed`/`archived`. The backend never stores the derived values — encode this
in one small pure function with its own unit test.

##### Create form — [`UI.md` §2](./UI.md)
Fields map 1:1 to the Phase 1 `POST /api/sessions` body: title, repoOwner + repoName, model (dropdown from
`GET /api/models`), reasoning effort (Low/Medium/High/Max) — every rendered field is stored and used
([§8](./ARCHITECTURE.md)'s `reasoning_effort` default). **No "Team config" field this phase** — it is
omitted, not just visually hidden, since [`UI.md` §2](./UI.md)'s full wireframe includes it but this
phase has no bootstrap path to override (Scope, above); re-add it in Phase 2 alongside real git bootstrap.
**`additionalRepos`/`readOrgRepos` must not appear** — permanent declared deviation
([§13](./ARCHITECTURE.md), restated in [`UI.md` §2](./UI.md)).

##### Session detail — [`UI.md` §3](./UI.md)
Conversation transcript + prompt composer + a minimal Overview panel (status, model, sandbox,
OpenCode session). Events are read via `GET /api/sessions/:id/events` on a **1s TanStack Query poll**
([`ROADMAP.md`](./ROADMAP.md) Phase 1) using the cursor to append rather than refetch. Render
`message.part.delta` frames as incremental text so the "watch tokens appear" exit criterion is literally true.

**Do not render** Participants, Artifacts, Diagnostics, or Logs panels — [`UI.md`](./UI.md)'s design goal
is that no functionality is implied that the backend does not provide. Those arrive in Phases 3 and 6.

##### Error Handling
Create-session failures surface the server's message inline on the form. A polling failure shows a
non-blocking "reconnecting" indicator rather than clearing the transcript.

##### Output / UX
Header shows a connection indicator; during a synchronous create the submit button shows a pending state,
since the request blocks on container spawn (Step 4 gotcha).

#### Patterns & Constraints

##### Mirror
[`UI.md`](./UI.md) wireframes for layout and [`UI.md` "Implementation note"](./UI.md) for component decomposition:
small, independent, `fetch`-driven units.

##### Decisions
- Polling now, WebSocket in Phase 2 — the polling path is **deleted**, not layered over
  ([`ROADMAP.md`](./ROADMAP.md) deferral table).
- Dashboard source stays outside the [§14](./ARCHITECTURE.md) LOC budget; verify `make loc` still excludes it.

##### Gotchas
- Appending by cursor requires stable ordering; reuse the server's `timestamp,id` cursor rather than
  client-side sorting.
- A 1s poll against a token-delta firehose can be heavy — this is exactly [`ROADMAP.md`](./ROADMAP.md)
  assumption 3; record the observed volume rather than tuning it away silently.

##### Out of Scope
Search/filter controls beyond what [`UI.md` §1](./UI.md) shows, the mobile tab layout ([`UI.md` §4](./UI.md),
Phase 6), login UI (Phase 4).

#### Tests

##### E2E
Covered in Step 6.

##### Integration
React Testing Library against a mocked API layer: create form submits the right body; transcript appends
across two polled pages without duplicates.

##### Unit
The status-derivation function across every `(sessionStatus, dockerPhase)` combination.

#### Validation

##### Commands
```
pnpm --filter dashboard test && pnpm --filter dashboard build && make loc
```

##### Expected Results
Component tests green; bundle builds into `control-plane/public/`; LOC total unchanged by dashboard source.

---

### Step 6: End-to-end vertical slice and assumption falsification

#### Changes

##### Create
- `e2e/tests/session-lifecycle.spec.ts`.
- `docs/phase_01_findings.md` — the written answers to [`ROADMAP.md`](./ROADMAP.md)'s three assumptions.

##### Modify
- `.github/workflows/ci.yml` — ensure the sandbox image is built before the E2E job.
- `docker-compose.yml` — final Phase 1 topology.

##### Remove
- Nothing.

#### Implementation

##### E2E spec
Full browser flow against a real `docker compose` stack, no mocks of any kind ([§1](./ARCHITECTURE.md),
root `AGENTS.md`): create → spawn → prompt → streaming transcript → assert `opencode_session_id`
persisted. Then the variants and error paths listed above.

##### Assumption findings
`docs/phase_01_findings.md` answers, with evidence:
1. Is the SSE stream relayable frame-by-frame? — attach an observed frame-type histogram.
2. Is `/prompt` + relay the right seam? — note any place the contract leaked.
3. Transcript or firehose? — report events-per-turn and bytes-per-turn; if it is a firehose, escalate
   [§15](./ARCHITECTURE.md)'s `events` retention decision from Phase 6 to now, and say so explicitly.

##### Error Handling
The E2E teardown removes every spawned sandbox container even on failure, or CI leaks containers across runs.

##### Output / UX
The findings document is the phase's evidence artifact — [§1](./ARCHITECTURE.md)'s evidence-first stance
means the phase is not complete on a green test alone, but on recorded answers to the questions it existed to ask.

#### Patterns & Constraints

##### Mirror
[`ROADMAP.md`](./ROADMAP.md)'s Phase 1 exit criterion and "assumptions falsified here" list.

##### Decisions
- The E2E stack is the real thing; nothing about Docker, opencode, or the bridge is stubbed at this level.
- Findings are committed, not left in a session transcript.

##### Gotchas
- Model calls cost money and are non-deterministic — use a trivially short prompt and assert on **frame
  arrival and event persistence**, not on model output text.
- Container startup dominates E2E runtime; set generous but bounded Playwright timeouts and prebuild images.

##### Out of Scope
Any Phase 2+ capability, and any "small" security fix — Phase 4 closes them **as one verifiable set**
([`ROADMAP.md`](./ROADMAP.md)).

#### Tests

##### E2E
`session-lifecycle.spec.ts` — happy path, variants, and error paths from the sections above.

##### Integration
The full control-plane suite runs against the real DB and a stubbed sandbox in CI's integration job.

##### Unit
No new unit coverage; this step consumes prior steps'.

#### Validation

##### Commands
```
make build && make sandbox-image && make e2e && make lint && make test && make loc
```

##### Expected Results
Green E2E against the real stack; `events` contains `message.part.delta` rows verified by direct SQL;
`make loc` under 1000; `docs/phase_01_findings.md` answers all three assumptions with evidence.
[`ROADMAP.md`](./ROADMAP.md)'s Phase 1 exit criterion — "you click New Session in a browser, type a
prompt, and watch tokens appear" — demonstrably met, unblocking Phase 2.
