# Architecture & Specification — Thin Docker-Based Agent Control Plane

This document describes the **current, final design** — not the history of how it was derived. It
supersedes `docs/archive/INITIAL.md`, whose 17 rounds of review/retraction are preserved there for
provenance only. Where this document and the archive disagree, this document is correct.

For the target *behavior* this system reimplements, see [`docs/archive/ai-coding-agent-doc.md`](./archive/ai-coding-agent-doc.md) — that remains
the source-of-truth spec for external contract (API shapes, WebSocket protocol, webhook semantics),
moved into `docs/archive/` alongside `INITIAL.md` since it documents the original K8s-based system, not
this one, but it is still load-bearing: every deviation in §13 is measured against it.
This document describes how a Docker-only, single-tenant, <1000-authored-LOC system satisfies that
contract.

> **Dashboard UI:** for the screen-by-screen wireframes, panel-to-endpoint mapping, and design goals of
> the dashboard SPA referenced throughout §5 and §11, see **[`docs/UI.md`](./UI.md)** — read it
> alongside this document, not as an afterthought; several §13/§14 corrections (diagnostics, presence)
> were driven directly by it.

---

## 1. Purpose & scope

**Goal:** reimplement the capabilities in [`docs/archive/ai-coding-agent-doc.md`](./archive/ai-coding-agent-doc.md) (a control plane for running
non-interactive, background `opencode` coding-agent sessions in isolated sandboxes) as the simplest
possible Docker-only system — no Kubernetes, no Helm, no service mesh, no PostgreSQL.

**Binding constraints:**
- Single Docker host. Exactly one control-plane process ever running. No multi-tenant HA, no org-wide
  production SLA.
- **< 1000 lines of authored code total.** Scope boundary (formalized, not incidental): counts toward
  the budget are control-plane application logic, the sandbox bridge, and proxy configuration glue
  (the Caddyfile) — i.e. code this project's own authors write. Does **not** count: Fastify itself,
  the SQLite driver, the Docker CLI/SDK, the Caddy base image, `opencode` itself, container manifests
  (Dockerfiles, `docker-compose.yml`), raw SQL schema files, generated types. Current estimate:
  **~655-790 LOC** (see §14 for the live budget table).
- Every deviation from `ai-coding-agent-doc.md` must be a deliberate, stated simplification ("we don't
  have that requirement"), not an accidental gap — see §13 for the full deviations table.

---

## 2. System context

```
Client (curl / any HTTP+WS client — no dashboard)
   │  HTTP (OAuth2 Bearer JWT) / WebSocket (wsToken)
   ▼
control-plane (Node.js, Fastify)  ── SQLite (data/control-plane.db)
   │  docker run (child_process.spawn)          │  synchronous HTTP call (§9) over sandbox-net
   ▼                                             ▼
sandbox container ── bridge.js (Node, small HTTP server + SSE relay) ── opencode serve (127.0.0.1:4096)
   │  network: sandbox-net (internal: true — NO route to internet)
   ▼
sandbox-proxy container (Caddy) ── bridges sandbox-net + egress-net, injects Authorization headers
   ▼
Real GitHub / LiteLLM endpoints (egress-net → host internet)
```

**Secret-custody boundary:** the sandbox container is structurally incapable of reaching the internet
(`internal: true` Docker network has no NAT/default route — live-verified: `curl` from inside such a
network to `example.com` reports `UNREACHABLE`). It therefore never needs to hold a GitHub token or
LLM API key. Only two places ever hold secrets: the `sandbox-proxy` container's env (GitHub/LiteLLM
credentials, injected into outbound requests via Caddy `header_up`), and the control plane's own env
(the GitHub token used for cloning, `OIDC_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`).
Cloned repo/config directories also have any embedded credential stripped (`git remote set-url origin
<url-without-credential>`) before being bind-mounted into a sandbox, preserving the same property for
the filesystem path, not just the network path.

---

## 3. Component inventory

| Component | Responsibility | Explicitly NOT responsible for |
|---|---|---|
| `control-plane/` (Fastify + SQLite) | Session CRUD, auth (OAuth2 + WS tokens + dashboard cookie), bootstrap orchestration, sandbox lifecycle, WebSocket relay/broadcast, webhook ingestion, reaping, serving the dashboard SPA's static assets | Understanding OpenCode's conversation model beyond relaying events; merging opencode config (opencode does that natively) |
| `sandbox/bridge.js` | Runs alongside `opencode serve` inside each sandbox; exposes `POST /prompt` / `POST /stop`; relays `opencode serve`'s SSE stream to the control plane; owns the 15-minute idle watchdog; persists/restores `opencode`'s own session id across restarts | Queueing or acknowledging commands (no queue exists); holding any external secret |
| `proxy/` (Caddy — **declared deviation from a custom TLS-terminating MITM forward proxy**, see §12/§13) | The **only** container attached to both `sandbox-net` and `egress-net`; injects `Authorization` headers for GitHub/LiteLLM; routes by path prefix | Any application logic — pure declarative reverse-proxy config; CONNECT-tunnel MITM semantics (not reimplemented, see §13) |
| `opencode serve` (vendored, not authored) | Durable conversation state (own local SQLite at `~/.local/share/opencode/opencode.db`), model invocation, tool execution, SSE event bus | Control-plane bookkeeping (session rows, tokens, continuation metadata) — entirely separate persistence layer |

---

## 4. Data model (SQLite, `better-sqlite3`, WAL mode)

**Why SQLite, not PostgreSQL:** `opencode serve`'s conversation persistence (inside each sandbox,
scoped to that sandbox's own `~/.local/share/opencode`) and the control plane's own bookkeeping DB are
two fully independent persistence layers, connected only by the bridge's HTTP/SSE relay — nothing about
`opencode serve` being non-ephemeral requires any particular control-plane database engine. Given the
single-host, single-process constraint, SQLite provides everything needed (concurrent reads alongside
single-writer inserts) with zero added container, connection pooling, or migration tooling.

### `sessions`

| Column | Notes |
|---|---|
| `id` | primary key |
| `title`, `repo_owner`, `repo_name`, `model`, `reasoning_effort`, `team_config_repo` | from `POST /api/sessions` body |
| *(no `additional_repos`/`read_org_repos` columns)* | **Declared deviation** — multi-repo/org-wide read grants are not modeled; see §13 |
| `status` | `active` \| `archived` \| `pending_bootstrap` (§10 async-spawn split) |
| `ws_token_hash`, `ws_token_prev_hash`, `ws_token_prev_expires_at` | rotation state, see §6 — **stored hashed (e.g. SHA-256), never plaintext** (corrected: earlier draft stored raw tokens); `subscribe` hashes the client-supplied token and compares against the stored hash |
| `predecessor_id`, `successor_id`, `continuation_reason`, `current_attempt` (default 1), `workspace_expires_at` | continuation lineage, see §7 |
| `container_name` | for `docker inspect`/`logs`/`stop` |
| `opencode_session_id` | the underlying `opencode serve` conversation id — **control plane is its source of truth** (confirmed: real system stores session id + messages in Postgres so the webui doesn't depend on a live sandbox), set once by the bridge on first creation, passed to successor sandboxes on continuation (§8). Naming corrected from an earlier `oc_session_id` draft — production's actual column/field is `opencode_session_id`/`opencodeSessionId` |

**No `prompts` table.** Prompt/stop delivery is a synchronous proxy call, not a queue — see §9.

### `events` (minimal — decoupled from delivery)

Append-only, backing `GET /api/sessions/:id/events` cursor pagination (`timestamp,id` cursor format)
and WS `fetch_history`/reconnect replay. Carries no queue/ack/delivery-state responsibility — it exists
purely for read-side replay.

**Every relayed SSE frame is stored verbatim, not just final snapshots (confirmed):** the real system
persists everything it receives over the bridge relay, including per-token `message.part.delta` frames
— matching this table's original design, not a departure from it. One caveat carried over rather than
assumed away: the confirmation notes "there might still be some parts missing" — i.e. this is a
best-effort mirror of whatever the bridge successfully relays, not a guaranteed-complete transcript
(a dropped SSE frame during a bridge restart, for instance, is not retroactively recoverable from
`opencode serve`'s own local DB by this design). No retention/pruning is specified anywhere in either
doc — this table grows unboundedly per session and is **not** touched by the 7-day reaper (§12), which
only expires sandboxes/volumes. Flagged here as an open question rather than silently assumed either
way — see §15.

### `deliveries`

`delivery_id PRIMARY KEY, received_at` — webhook dedup on `X-GitHub-Delivery`, checked before any
session-spawn logic runs; a repeat delivery returns `200 { status: "duplicate" }`.

---

## 5. API specification

All routes live under `/api/*` except the GitHub webhook (unprefixed), matching
`ai-coding-agent-doc.md`. Auth: `Authorization: Bearer <HS256 JWT>` from `POST /oauth2/token` (§11).

| Endpoint | Behavior |
|---|---|
| `POST /api/sessions` | Insert session row (`status: pending_bootstrap`), return `{id, wsToken}` immediately (`201`); `bootstrapWorkspace` + `docker run` happen via `setImmediate` **after** the response is sent (§10) |
| `GET /api/sessions` | List; `limit`/`offset`/`status` query params |
| `GET /api/sessions/:id` | Session + live container status (`docker inspect`) + `continuation` object (§7). **Rotates the ws token unconditionally on every call, storing only its hash** (§6) |
| `PATCH /api/sessions/:id` | `{status}` update |
| `POST /api/sessions/:id/stop` | Synchronous proxy call straight to the bridge's `POST /stop`, which calls OpenCode's native `abort`; falls back to `docker stop` only if the bridge doesn't respond within a timeout |
| `POST /api/sessions/:id/prompt` | Synchronous proxy call straight to the bridge's `POST /prompt`; ack `{messageId, position}` returned once the bridge accepts the call. Runs `resolveActiveSession` first (§7) |
| `GET /api/sessions/:id/events` | Cursor-paginated read from the `events` table |
| `GET /api/sessions/:id/sandbox/logs` | `docker logs --tail N <container>`. `container` query values: `sandbox` \| `sandbox-proxy` — no `iptables-init` (network isolation is now structural via `internal: true`, not a sidecar container, see §12) |
| `GET /api/sessions/:id/sandbox/diagnostics` | `docker inspect` + structured fields (`phase`, `failureReason`, `failureMessage`, `lastSpawn`, `lastFailure`, `failureCount`) — **confirmed real dashboard screenshot** shows this as a dedicated, actively-used panel, not redundant with raw `sandbox/logs` text; no longer a cut candidate (see §14) |
| `GET /api/models` | Static, hand-curated allowlist from `config.js` — confirmed to match production, see below |
| `GET /api/sessions/:id/artifacts` | Thin 1:1 proxy to OpenCode's real `GET /session/{ocSessionId}/diff` (confirmed via live OpenAPI spec: `operationId: "session.diff"`, `SnapshotFileDiff[]` response) — no custom diffing, no git shelling |
| `GET /api/ws/sessions/:id` | WebSocket upgrade — see §6 |
| `POST /webhooks/github` | HMAC-verified `issue_comment` handler — see §10 |
| `POST /oauth2/token` | Proxied 1:1 to the real external OIDC provider's token endpoint (Caddy passthrough) — no application code, see §11 |
| `GET /`, `GET /sessions/new`, `GET /sessions/:id` | Dashboard SPA — see "Dashboard" below |

**Internal-only surface:** the control plane calls the bridge directly over `sandbox-net`
(`POST /prompt`, `POST /stop`), authenticated by a per-session `INTERNAL_TOKEN` minted at spawn time
(distinct from the OAuth2 access tokens above, never exposed outside `sandbox-net`). The bridge also
pushes OpenCode events to `POST /internal/sessions/:id/events` (this was always a push and needed no
queue/ack semantics) and, once, the freshly created OpenCode conversation id to
`POST /internal/sessions/:id/oc-session` (§8) — the latter is what makes `opencode_session_id` in the
`sessions` table (§4) authoritative rather than PVC-derived.

**Coverage:** all 13 service endpoints from `ai-coding-agent-doc.md` are routed, plus the dashboard
routes (see below) — full endpoint parity with the source doc.

### `GET /api/models`

**Confirmed: static list, by design — not a live LiteLLM query.** The real system ("codefleet") uses a
hand-curated static list because it currently doesn't expose *every* model LiteLLM knows about — a
deliberate allowlist/curation concern (which models are approved/supported for this platform), not a
staleness problem a live query would fix. Reverting the earlier "live-query LiteLLM" idea from this
design — it solved a problem that doesn't exist (keeping the list fresh) at the cost of one that does
exist here (only exposing an intentionally-curated subset):

```js
// config.js — ids are already provider-qualified (`providerID/modelID`, §8's `splitModel`), and
// nothing requires them to share one providerID. Entries can span any number of providers/gateways
// registered in the Platform config repo's opencode.json (see §8's declared correction) — the
// allowlist's job is curation, not enumerating which gateways exist.
const MODEL_ALLOWLIST = [
  { id: 'litellm/eu.anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  // { id: 'openai-direct/gpt-5', name: 'GPT-5 (direct)' },  — a second, differently-gatewayed
  // example entry; not implemented, illustrating that the shape already supports it today.
  // ... hand-maintained, one entry per approved model
]

fastify.get('/api/models', async () => ({ models: MODEL_ALLOWLIST }))
```

- **No live gateway query, no cache, no model-listing dependency on any specific gateway's env vars**
  — simpler than the hybrid design previously drafted here, and it's what production actually does.
- Updating the list is a config change + redeploy, same cost as any other static allowlist (§13) —
  acceptable since model approval is inherently a curated, infrequent decision, not something that
  should auto-follow whatever any one gateway happens to expose.
- This list is independent of whichever provider(s) the Platform config repo or the control plane's
  own default-fallback layer (§8) actually wire up at runtime — it's UI curation metadata only, never
  a source of provider connection details.

**The allowlist is UI-only, not a validation gate (confirmed):** `POST /api/sessions`,
`POST /api/sessions/:id/prompt`, and the WS `prompt` message validate `model` against **syntax only**
(`provider/model` shape, first-`/`-is-separator rule, `400 INVALID_MODEL_REFERENCE` on mismatch) — they
do **not** check membership in `MODEL_ALLOWLIST`. A well-formed `litellm/<anything>` string is accepted
even if it's not in the dropdown list; the allowlist exists purely to populate `GET /api/models` for
UI/discovery. This matches confirmed production behavior exactly — **no membership-check code should be
added here**, since that would be a stricter validation than what's actually deployed.

### Dashboard

> 📐 **See [`docs/UI.md`](./UI.md) for the full screen-by-screen wireframes** (session list, create
> session, session detail + all its side panels) and exactly which endpoint/section backs each one.
> Do not design or implement dashboard screens from this section alone — `UI.md` is the authoritative
> UI spec; this section only covers how it's served and authenticated.

The dashboard is **not a separate service** — it's `@fastify/static` serving one built SPA's static
output (`control-plane/public/`, the `vite build` artifact) off the same Fastify process already
handling `/api/*`:

```js
fastify.register(require('@fastify/static'), { root: path.join(__dirname, 'public') })
fastify.get('/', (req, reply) => reply.sendFile('index.html'))
fastify.get('/sessions/new', (req, reply) => reply.sendFile('index.html'))
fastify.get('/sessions/:id', (req, reply) => reply.sendFile('index.html'))
```

**Corrected — no longer a deviation from production:** the dashboard is a **React + TypeScript SPA**
built with Vite, styled with Tailwind v4, using shadcn/ui (Radix) primitives for accessible interactive
components (dialogs, tabs, dropdowns) and TanStack Query for REST data-fetching/cache invalidation. It
calls the existing `/api/*` endpoints and opens the existing `GET /api/ws/sessions/:id` WebSocket, same
contract as before — only the implementation substrate changed, not the API surface. This matches
production's own stack instead of deviating from it (see §13's corrected deviations table).
Not a black-box dependency chain: shadcn/ui components are vendored into the repo at generation time,
not pulled in as an opaque npm package. The `vite build` output (static JS/CSS bundles) doesn't count
against the LOC budget (§1) — only hand-authored control-plane server code does (see §14).

**Dashboard auth:** browser login is `openid-client`'s Authorization Code + PKCE flow against the same
external OIDC provider service clients use, with `@fastify/secure-session` for the browser cookie —
see §11 (corrected from an earlier `@fastify/oauth2` draft). No bespoke login form or password storage;
`GET /login` → IdP login → `GET /oauth2/callback` → encrypted session cookie (no server-side session
table). The `onRequest` hook on `/api/*` accepts **either** this cookie **or** a service bearer token,
both validated via **token introspection** (§11) — one shared verification path, not two auth systems.

---

## 6. WebSocket protocol

Connect to `GET /api/ws/sessions/:id`. All **six** message types from the source doc are implemented:

| Type | Behavior |
|---|---|
| `subscribe` | Authenticate with `wsToken`; required first message. Accepts either the current `ws_token` or a still-valid `ws_token_prev` (see rotation below) |
| `prompt` | `{content, model?, reasoningEffort?}` → proxied synchronously to the bridge, same as the REST route |
| `ping` | Keepalive |
| `presence` | `{state: "viewing"\|"away"}` — stored on the socket's subscriber-registry record **and broadcast to the session's other subscribers** (dashboard screenshot confirms a live "Participants" panel — not a no-op; corrected from an earlier assumption that it was dead code absent a dashboard) |
| `fetch_history` | `{cursor}` → replies with a batch of `{type:"event",...}` messages + `{type:"history_complete"}`, reusing the exact same cursor query as `GET /api/sessions/:id/events` (third cut candidate: shrink to one fixed-size batch if needed) |
| `stop` | Synchronous proxy call, same as the REST route |

**`ws_token` rotation (2-token sliding window, stored hashed — confirmed correction):** `GET
/api/sessions/:id` generates a new random `wsToken`, returns the **plaintext** value to the caller once
(same as the doc's contract), but stores only `sha256(wsToken)` in `ws_token_hash` — the database never
holds a usable token. Rotation happens unconditionally on every call (matching the doc's literal
contract — no "only rotate if idle" heuristic). The current hash moves into `ws_token_prev_hash` with a
30-second expiry before the new one is issued. `subscribe` hashes the client-supplied token and compares
against either `ws_token_hash` or a still-valid `ws_token_prev_hash`; anything else closes the socket
with code `4001`. This closes a real race: a concurrently-open WS client can be about to `subscribe`
with a token that a fresh `GET` call just invalidated.

**Subscriber broadcast:** a module-level `Map<sessionId, Set<WebSocket>>` in the server, populated on
`subscribe`, cleaned up on socket `close`. `session_continued` messages are broadcast to **both** the
new session's subscribers and the old (predecessor) session's already-open sockets — the predecessor's
sockets remain registered under the predecessor's session id, so `broadcastToSession(predecessorId,
msg)` reaches them directly without resubscribing. No Redis/pub-sub needed — single-process is enough.

---

## 7. Session continuation

**Schema** (on `sessions`, see §4): `predecessor_id`, `successor_id`, `continuation_reason`,
`current_attempt` (default 1), `workspace_expires_at` (sliding 7-day window, updated on every accepted
prompt).

**Reason enum:** `workspace_expired | workspace_missing | workspace_corrupt` — 3 of the source doc's 4
values. `workspace_origin_mismatch` is **not reachable** in this design (there's no org-wide
repo-access model to mismatch against) and is omitted as a declared, permanent deviation, not a gap.

**Trigger logic** — both `POST /api/sessions/:id/prompt` and the WS `prompt` message call this before
enqueuing:

```js
async function resolveActiveSession(session) {
  const status = await sandbox.inspect(session.containerName)
  if (status.exists && ['running', 'starting'].includes(status.state)) return session
  if (Date.now() > session.workspace_expires_at) return spawnContinuation(session, 'workspace_expired')
  if (!status.exists) return spawnContinuation(session, 'workspace_missing') // idle-exit case, the common path
  return spawnContinuation(session, 'workspace_corrupt') // container exists but failed/errored
}

function spawnContinuation(oldSession, reason) {
  const successor = db.insertSession({
    ...oldSession, id: newId(), predecessor_id: oldSession.id, current_attempt: oldSession.current_attempt + 1,
  })
  db.updateSession(oldSession.id, { successor_id: successor.id, continuation_reason: reason })
  sandbox.run(successor) // docker run against the SAME named volume as oldSession, plus
                          // -e OPENCODE_SESSION_ID=<oldSession.opencode_session_id> (§8) — reattach hint
                          // comes from the control plane's own row, not read back off the volume
  broadcastToSession(oldSession.id, { type: 'session_continued', sessionId: successor.id, predecessorSessionId: oldSession.id, reason })
  broadcastToSession(successor.id, { type: 'session_continued', sessionId: successor.id, predecessorSessionId: oldSession.id, reason })
  return successor
}
```

Continuation **always** creates a new control-plane session row (matching the doc's
predecessor/successor model) while restoring the same underlying `opencode` conversation id inside it
(see §8's bridge logic) — this is the design that makes both requirements (a real predecessor id to
broadcast to, and actual conversation continuity) simultaneously true.

Volume/watchdog note: sandboxes exit on their own — the bridge's idle watchdog shuts a sandbox down
~15 minutes after the agent goes idle with nothing queued (§8), which is the normal, expected
`workspace_missing` trigger path, not a failure.

---

## 8. `opencode` configuration & the sandbox bridge

### Config layering

**Corrected against opencode's own documented precedence chain (Context7 `/anomalyco/opencode`,
`config.mdx`), which is 8 steps, not the 3+1 shape earlier drafts of this section implied** (lowest →
highest, later overrides earlier):

1. **Remote config** (`.well-known/opencode`) — organizational defaults
2. **Global config** (`~/.config/opencode/opencode.json`) — user preferences
3. **Custom config** (`OPENCODE_CONFIG` env var — a **file path**, not inline JSON)
4. **Project config** (`opencode.json` in the target repo)
5. **`.opencode` directories** (agents, commands, plugins) — includes `OPENCODE_CONFIG_DIR` (team layer)
6. **Inline config** (`OPENCODE_CONFIG_CONTENT` env var — JSON content, not a path) — runtime overrides
7. **Managed config files** (macOS admin-controlled) — not applicable to this Linux/Docker deployment
8. **macOS managed preferences** (MDM) — not applicable here either

This project's three-layer framing (Platform → Team → Repo) maps onto steps 2/5/4 respectively —
`PLATFORM_CONFIG_REPO` is sparse-cloned into `~/.config/opencode/` (step 2's actual path), the team
layer uses `OPENCODE_CONFIG_DIR` (step 5), and the target repo's own `opencode.json` is step 4,
discovered natively by opencode after cloning. **No custom *merge-algorithm* logic is required** —
opencode resolves layer precedence natively.

**Precision correction:** this is *not* "purely opencode's native resolution end-to-end" — the
bootstrap/supervisor layer (below) explicitly **composes** which directory trees exist at which paths
(via cloning/mounting) and **overwrites the model selection at runtime** via `OPENCODE_CONFIG_CONTENT`
(step 6). What's true is narrower than "no custom logic": there's no custom *deep-merge algorithm*
(opencode's own precedence rules do that part), but there *is* real, authored orchestration logic
deciding what gets fed into that resolution chain in the first place.

`OPENCODE_CONFIG_CONTENT` (step 6, set by the control plane at spawn time) is the fact that must
survive every override **from steps 1-5** — narrower in two ways than earlier drafts of this document
implied: (a) it is not the chain's *highest* layer in general (steps 7-8 could still override it on a
managed macOS deployment, though those don't apply here), and (b) what it actually needs to carry is
narrower than a full provider block.

**Declared correction (superseding the single-`provider.litellm`-block framing previously here):**
per `docs/archive/ai-coding-agent-doc.md`'s own "OpenCode config layering" chapter, the full provider
catalog — arbitrary numbers of gateways/providers, each with its own `npm` package and `baseURL` — is
**Platform config repo territory** (step 2 above), not control-plane-injected config. `model` is
already `providerID/modelID` (`splitModel`, §8 below) precisely so that any number of providers can be
registered in that layer and selected per-session/per-prompt — the control plane was never meant to
enumerate them. Confirming evidence already in this doc: the reference example's `apiKey` value is the
literal dummy string `"unused-injected-by-proxy"` — the real secret is injected by Caddy's
`header_up Authorization` at the network boundary (§12), never carried in the JSON config at all. So
even the one provider block previously shown here was never actually about credentials — at most it
was routing information that itself belongs in the Platform layer.

What `OPENCODE_CONFIG_CONTENT` (step 6) **actually** must own — narrowly, and only this:

```jsonc
{
  "model": "litellm/eu.anthropic.claude-sonnet-4-6",
  "autoupdate": false
}
```

- `model` — the session's chosen model, which must not be silently overridable by Platform/team/repo
  config (steps 2/4/5) — that's the whole point of using step 6 for this, not a lower step.
- `autoupdate: false` — pinned agent behavior, unrelated to providers entirely.

**Open design question, precedence-checked but not settled here (corrects an inversion error from an
earlier draft of this section — see `docs/phase_01_findings.md`'s post-close note for the full trail):**
an earlier version of this section proposed writing a default/example gateway block via `OPENCODE_CONFIG`
(step 3) so any real Platform config repo (step 2, Global) would "naturally" override it with no
conditional logic. **That direction is backwards.** opencode's own docs state sources are loaded
1→8 and "later sources override earlier ones" (step 8 is explicitly "highest priority") — so **step 3
(`OPENCODE_CONFIG`) is loaded after, and therefore overrides, step 2 (Global)**, not the reverse. A
control-plane default written via `OPENCODE_CONFIG` would permanently shadow the Platform config
repo's own provider definitions, the opposite of "default, real config wins" semantics.

The only step *below* Global (step 2) is Remote config (step 1, fetched by opencode itself from
`.well-known/opencode` over HTTP) — not a file/env var the control plane can locally inject at spawn
time in the same way, so there is no clean precedence-only slot for "default that a Platform config
repo can silently override." The realistic options are therefore still an explicit choice, not a
zero-branching precedence trick:
- **Option A:** write the control plane's default gateway block directly into the Global config path
  itself (`~/.config/opencode/opencode.json` inside the sandbox) *before* the Platform config repo is
  cloned into that same path, so the clone step's own file overwrite (not opencode's precedence
  resolution) is what determines the outcome — fragile, depends on bootstrap ordering, not opencode's
  arbitration.
- **Option B:** keep the default injection explicitly conditional in control-plane code — only write
  it when the session's Platform config repo failed to resolve/clone — accepting the branching logic
  this was trying to avoid.
- **Option C:** don't inject any default at all (matches the earlier "Option A" from before this
  correction) — every environment, including this project's own dev/e2e stack, must have a real
  Platform config repo (or an equivalent stand-in) before a session can invoke any model.

This is deliberately left open for whoever implements Phase 2 to resolve, with the corrected
precedence facts above — not decided silently, and not assumed to be zero-branching. Tracked in
[GitHub issue #1](https://github.com/tbrandenburg/agent-control-plane/issues/1) (blocked on Phase 2's
real-bootstrap work landing first, per that issue's own sequencing note).

The control plane owns the model-selection overwrite only (not provider-routing enforcement, which
belongs to the Platform layer + Caddy's credential injection, §12) — it does not own the broader
OpenCode config schema (agents, tools, skills, model catalog), which remain platform/team/repo-owned
files, unchanged in directory convention from the source doc
(`agents/`, `commands/`, `skills/<name>/SKILL.md`, `tools/<name>.js`, `plugins/`).

**Built-in tools:** `create-pull-request` and `create-issue-comment` are baked into the sandbox
image's `tools/` directory at image-build time (not runtime code, not control-plane logic) — always
available in every sandbox regardless of platform/team config, same as the source doc. The webhook
flow's "agent replies on the triggering issue/PR" behavior (§10) depends on `create-issue-comment`;
carried over unchanged, not reimplemented.

**What *is* new control-plane code (confirmed real, not just declared):** cloning, sparse-checking-out,
SHA-pinning, and mounting the three source trees (target repo, platform config, team config) onto the
right paths before spawn — this is real bootstrap/composition logic, just not config-*merging* logic.
See §10's bootstrap failure-mode table for the concrete implementation.

**Model selection has two independent paths, not one:** `OPENCODE_CONFIG_CONTENT.model` sets the
session-level default; a per-prompt `model?` field (on `POST /api/sessions/:id/prompt` and the WS
`prompt` message) is passed straight through as a per-message argument to `prompt_async`, overriding
the default for that one call without touching config-layer precedence at all — these are two
unrelated mechanisms, not competing ones.

**`reasoningEffort` maps directly onto opencode's own "model variant" mechanism (confirmed against
source, not invented):** `prompt_async`'s request body accepts `model.variant`, a string key
(`low`/`medium`/`high`/`max`/etc.) looked up in that model's pre-computed `variants` map and deep-merged
into provider options at request time (`packages/opencode/src/session/llm/request.ts`). Anthropic ships
built-in `high`/`max` variants; OpenAI ships `none`/`minimal`/`low`/`medium`/`high`/`xhigh`. This means:
- The source doc's four `reasoningEffort` values (`low`/`medium`/`high`/`max`) are **not a control-plane
  invention to translate** — they're opencode's own variant vocabulary, so we pass `reasoningEffort`
  straight through as `model.variant` on every `prompt_async` call, first or subsequent, with **zero
  translation logic**.
- Not mandatory (confirmed) — when omitted, `variant` is just `{}` and provider defaults apply
  (`packages/llm/src/protocols/openai-chat.ts`: an undefined effort omits the field from the provider
  request entirely, not a hardcoded default).
- No session-level "sticky" reasoning effort needs storing separately — since it's a per-call
  `prompt_async` argument (not a config-layer concern), the control plane just re-sends whatever the
  session's stored `reasoning_effort` default is (§4) on each `/prompt` call unless a per-prompt override
  is given, exactly mirroring how `model?` already works one line above. No new mechanism, same pattern.
- One real risk not to paper over: a `variant` name that doesn't exist for the resolved provider/model
  (e.g. requesting `xhigh` against a model that only defines `high`/`max`) is a **provider-model-specific
  mismatch opencode itself will reject or ignore** — the control plane doesn't validate this ahead of
  time; it surfaces whatever `prompt_async` returns.

### Sandbox bridge (`sandbox/bridge.js`)

Runs alongside `opencode serve` (`127.0.0.1:4096`) inside each sandbox — **confirmed**: the real
supervisor also runs `opencode serve`, not a bare CLI invocation, so the HTTP/SSE contract below is
correct, not just plausible. It is a **small inbound HTTP server**, not a poller — the control plane
calls it directly over `sandbox-net`:

```js
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN
const OC = 'http://127.0.0.1:4096'
const OPENCODE_SESSION_ID_HINT = process.env.OPENCODE_SESSION_ID   // set by control plane on continuation spawn

function splitModel(m) { const i = m.indexOf('/'); return { providerID: m.slice(0, i), modelID: m.slice(i + 1) } }

async function getOrCreateOcSession() {
  // Control plane, not the PVC, is the source of truth for the opencode session id (see below) —
  // it's passed in at spawn time on continuation, not recovered from a file on the volume.
  if (OPENCODE_SESSION_ID_HINT && (await fetch(`${OC}/session/${OPENCODE_SESSION_ID_HINT}`)).ok) return OPENCODE_SESSION_ID_HINT
  const { id } = await postJSON(`${OC}/session`, {})
  await postJSON(internalUrl(`/internal/sessions/${SESSION_ID}/oc-session`), { ocSessionId: id })
  return id
}

// app.post('/prompt', ...) -> POST /session/:id/prompt_async
//   { model: { ...splitModel(model), variant: reasoningEffort }, parts: [{type:'text', text: content}] }
//   variant omitted entirely (not just `undefined`) when reasoningEffort is unset — opencode's own
//   per-provider default behavior, no control-plane fallback value invented
// app.post('/stop', ...)   -> POST /session/:id/abort {}
// streamSSE(`${OC}/event`, evt => postJSON(internalEventsUrl, evt)) — relays every frame verbatim,
//   mirroring messages into the control plane's own DB (see below), not just replaying live
// setInterval: idle watchdog — process.exit(0) after 15 min with nothing queued
```

**Session id and messages are mirrored into the control plane's own database, not sourced from the
sandbox at read time (confirmed):** the real system stores the OpenCode session id and message history
in its own Postgres so the webui can show them independent of sandbox/PVC availability. This design
mirrors that with two small changes from the earlier draft:
- `sessions.opencode_session_id` (new column, §4) — set once via the bridge's
  `POST /internal/sessions/:id/oc-session` call right after `getOrCreateOcSession` creates a fresh
  OpenCode conversation. No more file-on-PVC as the source of truth for the id itself.
- On continuation (`spawnContinuation`, §7), the control plane already has `opencode_session_id` in its own
  row — it passes it to the successor sandbox via `docker run -e OPENCODE_SESSION_ID=<value>`, so the new
  bridge reattaches without depending on reading anything back off the (possibly-stale) volume for the
  id itself. `opencode serve`'s own local SQLite (§3, on the same named volume) still holds the actual
  conversation content — the id is just the key, and that key now lives in two places (control-plane DB
  + opencode's own DB), never only on a file the control plane has no independent record of.
- The `events` table (§4) already mirrors message/event history for read-side replay — this matches the
  real system's stated reason (Postgres holding session id + messages "so the webui has them") without
  requiring a design change there.

**Deliberately not built — single-harness only:** the real system apparently has "a thin layer on top
of opencode... for future use if multiple harnesses." This design talks to `opencode serve` directly,
with no harness-abstraction layer — YAGNI, since only one harness (`opencode`) exists today and a
generic harness interface for a hypothetical second one would be pure speculative complexity. If a
second harness is ever needed, the bridge's `/prompt`/`/stop`/event-relay contract is already the
natural seam to abstract at that point, not before.

**SSE relay contract (verified live against a real two-turn run):** plain SSE, `data:` frames only, no
`event:` field. `GET /session/{id}/event` does not exist — **all** events flow through the single
global `GET /event` stream, filtered client-side on `properties.sessionID`. Key event types:
`server.connected`/`heartbeat` (keepalive, no-op relay), `session.updated`/`status`/`idle`/`diff`,
`message.updated`, `message.part.updated` (final snapshot), `message.part.delta` (token-by-token — the
event to relay for live "typing" UX). The bridge relays every frame verbatim and acts only on
`session.idle` (resets its own idle-watchdog timer).

**Healthcheck-gated readiness:** the control plane waits for the sandbox's Docker healthcheck
(`GET /global/health` on the bridge/opencode) to pass before making its first synchronous `/prompt` or
`/stop` call, retrying with backoff on connection-refused — this is the one trade-off the
synchronous model introduces versus a poll loop (which was naturally resilient to spawn-order races),
and it's cheap to close.

---

## 9. Prompt/stop delivery (synchronous proxy, no queue)

`POST /api/sessions/:id/prompt` and `POST /api/sessions/:id/stop` are **synchronous proxy calls**
straight into the bridge's own small HTTP server, reachable because the control plane sits on
`sandbox-net` (§2). There is **no `prompts` table, no `/internal/queue`, no `/internal/ack`, no 2-second
poll loop** — this was the single most valuable simplification found during design: once the control
plane can reach the bridge directly, having the bridge poll for work is unnecessary machinery.

`stop` specifically: the control plane calls the bridge's `POST /stop` directly; the bridge calls
OpenCode's native `abort`; the control plane falls back to `docker stop` only on a timeout waiting for
the bridge's response.

The OpenCode **event relay** direction (bridge → control plane) is unaffected by this — it was always
a push, never had a poll/ack problem.

---

## 10. GitHub webhook trigger

**Trust check:** read `payload.comment.author_association` (**not** `payload.issue.author_association`
— independent fields on independent payload objects). Proceed only if it is exactly `OWNER`, `MEMBER`,
or `COLLABORATOR`; anything else → `200 { status: "ignored" }`.

**Dedup:** check `X-GitHub-Delivery` against the `deliveries` table before any session-spawn logic;
duplicate → `200 { status: "duplicate" }`.

**Prompt construction:**

```js
function buildPrompt(payload) {
  const isPR = !!payload.issue.pull_request
  const mention = `@${process.env.GITHUB_APP_BOT_USERNAME}`
  const bodyWithoutMention = payload.comment.body.replace(new RegExp(mention, 'i'), '').trim()
  const isMentionOnly = bodyWithoutMention.length === 0

  if (isPR && isMentionOnly) {
    return `Please review this GitHub pull request and post your review comments.\n` +
      `You can reach GitHub Enterprise Server without authentication header. It will be added automatically by the authentication proxy.\n` +
      `You can find the full repository code in the /workspace/repo directory.\n` +
      `Use pull request review skill(s) if available\n` +
      `PR title: ${payload.issue.title}\nPR description: ${payload.issue.body}\n` +
      `PR url: ${payload.issue.pull_request.html_url}\nPR dif url: ${payload.issue.pull_request.diff_url}`
  }
  return `Issue #${payload.issue.number} (${payload.issue.title}): ${bodyWithoutMention}`
}

function buildTitle(payload) {
  return `#${payload.issue.number}: ${payload.issue.title}`
}
```

**Session title for webhook-triggered sessions (confirmed via real dashboard screenshot, not
previously specified in either doc):** `#<issue/PR number>: <issue/PR title>` — e.g.
`#242: Bdu3 23594 movd transfer module to bes4`. Neither source doc's quickstart (which only requires
`title` on `POST /api/sessions`) nor its webhook chapter says what title a webhook-spawned session gets;
this convention was reverse-engineered from production's actual dashboard rendering and is now the
one used when inserting the session row in `webhook.js`, same function that builds the prompt.

**Webhook env vars:** `WEBHOOK_DEFAULT_MODEL` — model used for the spawned session when the webhook
payload carries none (`process.env.WEBHOOK_DEFAULT_MODEL || DEFAULT_MODEL`, one line in the session-row
insert). `GITHUB_WEBHOOK_BOT_EMAIL` — git author identity (`git config user.email`) applied during
bootstrap only for webhook-triggered sessions, defaulting to `agent-bot@ai-coding-inspect.dev`. Both
match the source doc 1:1; neither needs new machinery, just two small values threaded through the
existing bootstrap/session-insert code paths.

**Branch selection:** PR comment → `refs/pull/<N>/head`; issue comment → default branch (`HEAD`).

**10-second ACK vs. bootstrap:** GitHub requires a 2xx within 10 seconds or the delivery is marked
failed. `webhook.js` inserts a session row (`status: 'pending_bootstrap'`) and returns `200`/`202`
immediately (an INSERT is sub-millisecond), then calls `bootstrapWorkspace` + `sandbox.run` via
`setImmediate(...)` so the actual clone/spawn happens after the HTTP response is sent. **The same async
split applies to `POST /api/sessions`** for consistency — the source doc's quickstart doesn't require
session creation to block on the full clone either.

**Bootstrap failure-mode classification (stderr pattern matching, not exit codes — git's exit code is
always 128 regardless of failure type):**

| Pattern | Classification | Behavior |
|---|---|---|
| `/repository .* not found/i` | not_found (also covers unauthenticated access to a real private repo — GitHub deliberately makes these indistinguishable) | Team layer: silent skip. Platform/target repo: hard fail |
| `/authentication failed\|invalid username or token/i` | auth | Hard failure |
| `/could not resolve host\|failed to connect\|couldn't connect to server\|timed out/i` | network | Hard failure |
| anything else | unknown | Hard failure (fail-closed default) |

Sequence: resolve every ref (target/platform/team) to a SHA via `git ls-remote` up front, then
`git fetch --depth 1 origin <sha>` + `git checkout <sha>` — never a branch-name checkout, closing the
concurrent-push race. Team config's sparse checkout uses `git sparse-checkout init --cone` +
`git sparse-checkout set .opencode`. Before any cloned directory is bind-mounted, `git remote set-url
origin <url-without-credential>` strips the embedded token.

---

## 11. Auth

**Correction from the original hand-rolled design, refined again with dev feedback:** the control
plane is confirmed to be an OAuth2/OIDC **client**, never an issuer — that part of the earlier
correction holds. Two library choices were wrong, though: production uses **`openid-client`**
(Authorization Code + PKCE) for the dashboard, **`@fastify/secure-session`** for the browser cookie, and
**token introspection** (RFC 7662), not local JWKS verification, for validating bearer tokens. All
three are corrected below — and each one is a genuine simplification over what was drafted previously,
not just a relabeling.

### `POST /oauth2/token` — proxied, not implemented

Unchanged from the prior draft — still a transparent passthrough to the real IdP's token endpoint, no
application-level token issuance:

```js
fastify.post('/oauth2/token', async (req, reply) => {
  const upstream = await fetch(process.env.OIDC_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(req.body),
  })
  reply.code(upstream.status)
  return upstream.json()
})
```

### Dashboard login — `openid-client` (Authorization Code + PKCE) + `@fastify/secure-session`

```js
const client = require('openid-client')
const config = await client.discovery(new URL(process.env.OIDC_ISSUER), process.env.OIDC_CLIENT_ID,
  { client_secret: process.env.OIDC_CLIENT_SECRET })

fastify.register(require('@fastify/secure-session'), {
  cookieName: 'session',
  key: Buffer.from(process.env.SESSION_SECRET, 'hex'),   // one key, no server-side session table
  cookie: { httpOnly: true, secure: true, sameSite: 'lax' },
})

fastify.get('/login', async (req, reply) => {
  const code_verifier = client.randomPKCECodeVerifier()
  const code_challenge = await client.calculatePKCECodeChallenge(code_verifier)
  req.session.set('pkce_verifier', code_verifier)
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: `${process.env.CONTROL_PLANE_HOST}/oauth2/callback`,
    scope: 'openid profile email', code_challenge, code_challenge_method: 'S256',
  })
  return reply.redirect(url.href)
})

fastify.get('/oauth2/callback', async (req, reply) => {
  const tokens = await client.authorizationCodeGrant(config, new URL(req.url, process.env.CONTROL_PLANE_HOST), {
    pkceCodeVerifier: req.session.get('pkce_verifier'),
  })
  req.session.set('access_token', tokens.access_token)   // encrypted in the cookie itself, no DB row
  return reply.redirect('/')
})
```

**Genuine simplification, not just a swap:** `@fastify/secure-session` stores the (encrypted,
libsodium-sealed) session data directly in the cookie — there's **no server-side session table or Map**
to maintain at all, which is strictly less code than the earlier `createBrowserSession`/
`lookupBrowserSession` design that needed its own backing store. `openid-client` owns discovery, PKCE
generation, state handling, and the token exchange — all plugin/library calls, not authored logic.

### Verifying bearer tokens on `/api/*` — introspection, not JWKS

**Confirmed:** production validates tokens via **token introspection** (RFC 7662 — asking the IdP
"is this token still valid," not verifying a signature locally), not `jose`/JWKS. This means access
tokens may be opaque, not JWTs — introspection works either way, so this is actually the more general,
provider-agnostic choice, not a corner case:

```js
fastify.addHook('onRequest', async (req, reply) => {
  if (!req.routeOptions.url.startsWith('/api/')) return
  const bearer = req.headers.authorization?.replace(/^Bearer /, '')
  const token = bearer ?? req.session.get('access_token')
  if (!token) return reply.code(401).send({ error: 'unauthorized' })
  const result = await client.tokenIntrospection(config, token)
  if (!result.active) return reply.code(401).send({ error: 'unauthorized' })
  if (bearer && !process.env.OIDC_SERVICE_CLIENT_IDS.split(',').includes(result.client_id))
    return reply.code(401).send({ error: 'unauthorized' })
  req.client = result
})
```

- **No JWKS fetching/caching, no local signature verification** — one `client.tokenIntrospection()` call
  per request, using the same `openid-client` `Configuration` object as the dashboard flow. Simpler
  dependency footprint than the JWKS approach (no `jose` import needed at all for this path).
- **Trade-off, stated plainly:** introspection is a network round-trip to the IdP on every `/api/*`
  request, whereas local JWKS verification is not. Acceptable for a single-Docker-host, low-QPS control
  plane; would need a short-TTL cache if this ever became a bottleneck (not built — YAGNI until proven
  necessary).
- **`OIDC_SERVICE_CLIENT_IDS`** (source doc env var) still checked against the introspection response's
  `client_id` field — same allowlist semantics, now via the RFC 7662 response shape instead of a JWT
  claim.

**Internal per-session token** (`INTERNAL_TOKEN`, §5/§9): unchanged, unrelated to OAuth2 — minted
per-session at spawn time, passed via `docker run -e`, never logged, used both directions
(control-plane→bridge calls, bridge's event-ingest calls into the control plane), never exposed outside
`sandbox-net`. This one *is* still a control-plane-minted secret, because it has no external IdP to
delegate to — it's a purely internal, single-process-lifetime credential.


---

## 12. Network & security model

**Correction: production's `sandbox-proxy` is a custom TLS-terminating HTTP forward proxy** — it
handles `CONNECT` tunneling and MITMs allowed HTTPS traffic to inject route-specific headers, not a
declarative reverse proxy like Caddy/nginx. **Deliberately not reimplemented here** — building a
correct forward-proxy CONNECT/MITM implementation (cert generation, per-request TLS termination,
selective allowlisted-host interception) is real, non-trivial security-sensitive code, squarely against
the "stay simple" and `<1000 LOC` constraints (§1). Caddy's path-prefix reverse-proxy pattern below
achieves the same *outcome* (sandbox never sees a credential, control plane injects `Authorization`
headers server-side) with a fraction of the complexity and zero authored proxy code — declared in §13
as an intentional architecture-shape deviation, not an oversight.

```yaml
networks:
  sandbox-net:
    internal: true   # structurally no route to the internet
  egress-net:          # normal bridge, has NAT to the host

services:
  control-plane:
    networks: [egress-net, sandbox-net]   # both: own use + reaching bridge.js directly
    volumes: [./data:/data, /var/run/docker.sock:/var/run/docker.sock]
    environment:
      OIDC_ISSUER: ${OIDC_ISSUER}                       # e.g. https://identity.example.com
      OIDC_TOKEN_ENDPOINT: ${OIDC_TOKEN_ENDPOINT}        # from IdP discovery; proxied 1:1, §11
      OIDC_CLIENT_ID: ${OIDC_CLIENT_ID}                  # dashboard's own OIDC client (Auth Code flow)
      OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET}
      OIDC_SERVICE_CLIENT_IDS: ${OIDC_SERVICE_CLIENT_IDS} # allowlist checked against token azp/client_id
      GITHUB_WEBHOOK_SECRET: ${GITHUB_WEBHOOK_SECRET}
      GITHUB_TOKEN: ${GITHUB_TOKEN}   # host-side only, used by bootstrap; never passed into a sandbox

  sandbox-proxy:
    image: caddy:2-alpine
    networks: [sandbox-net, egress-net]   # the ONLY container bridging both
    environment:
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      GITHUB_URL: ${GITHUB_URL}   # api.github.com, a GHDR tenant host, or a GHES host — same
                                   # env var pattern as production's own GITHUB_URL config toggle
      # One `handle_path`/credential-injection block per configured model gateway — LiteLLM is the
      # example/default below, not the only supported shape (§8's declared correction). Additional
      # gateways registered in the Platform config repo's opencode.json would each need their own
      # route + credential env var here, since Caddy is the sole egress bridge (§3) regardless of
      # which layer defines the provider's existence.
      MODEL_GATEWAY_API_KEY: ${MODEL_GATEWAY_API_KEY:-${LITELLM_API_KEY}}

  # sandbox containers: spawned dynamically, always sandbox-net ONLY, never the docker socket,
  # each with a per-session INTERNAL_TOKEN minted at spawn time.
```

```caddyfile
:8080 {
  handle_path /github/* {
    reverse_proxy https://{env.GITHUB_URL} {
      header_up Authorization "Bearer {env.GITHUB_TOKEN}"
      header_up Host {env.GITHUB_URL}
    }
  }
  # One block per configured model gateway. LiteLLM shown here as the default/example — see §8's
  # declared correction: the Platform config repo's opencode.json may register additional gateways,
  # each needing its own `handle_path` + credential env var, since sandboxes can never reach the
  # internet directly (§3/§12) regardless of which config layer names the provider.
  handle_path /model-gateway/* {
    reverse_proxy https://litellm.internal.example.com {
      header_up Authorization "Bearer {env.MODEL_GATEWAY_API_KEY}"
    }
  }
}
```

**GitHub host is env-configurable, matching production's own `GITHUB_URL` toggle (confirmed):**
production's code already supports both `github.com` and GHES via a single `GITHUB_URL` env var — so
GHES-vs-github.com is a **deployment constraint, not a code constraint**, for both systems. This design
mirrors that with the same single env var name (rather than a bespoke `GITHUB_API_HOST`). This
deployment's actual target is `github.com` or a GHDR (GitHub Data Residency) tenant, so `api.github.com`
-shaped REST calls work with no `/api/v3` path rewriting — but nothing here prevents pointing
`GITHUB_URL` at a real GHES host later if a deployment ever needs it; the Caddy config doesn't assume
either shape.

`{env.VAR_NAME}` is the correct runtime placeholder syntax (substituted per-request) — **not**
`{$VAR_NAME}`, a different parse-time macro unsuitable for `header_up`.

**Named volumes** (Docker, per session): auto-created on first `docker run -v <name>:/path`; not
removed by `docker rm` (only anonymous volumes are); the reaper is the only place they're deleted
(§below), targeted via an explicit `session→volume` mapping tracked in SQLite rather than a blanket
`docker volume prune`.

**Reaper:** hourly `setInterval`, expires sessions whose workspace has exceeded its retention window —
**must skip any session whose current attempt status is `pending`/`starting`/`running`** regardless of
last-active age, to avoid removing an actively-running session's volume/container.

---

## 13. Deviations from `ai-coding-agent-doc.md` (all declared, none accidental)

| Original (K8s, production, multi-tenant) | This design (Docker, single-tenant, thin) | Why it's OK |
|---|---|---|
| K8s Job per session, Helm chart | Plain `docker run` per session, `child_process.spawn` | No cluster needed — one Docker host is the whole control plane |
| `iptables-init` init container + custom TLS-terminating MITM forward proxy (CONNECT-tunnel interception) | Docker `internal: true` network + one **Caddy** path-prefix reverse proxy | Structural network isolation needs zero custom iptables code or extra capabilities; a forward-proxy MITM implementation is real security-sensitive code a `<1000 LOC` budget can't absorb — Caddy achieves the same secret-custody outcome declaratively |
| PostgreSQL + Drizzle ORM | SQLite (`better-sqlite3`, WAL, raw SQL) | No multi-instance/HA requirement; an ORM is unnecessary weight at this schema size and LOC budget |
| Full OIDC (JWKS, client registry, refresh tokens) | **No deviation** — control plane is an OIDC *client* (`openid-client` for dashboard Authorization Code + PKCE, `@fastify/secure-session` for the browser cookie, token introspection (RFC 7662) for bearer verification) against a real external IdP, never its own issuer | Confirmed to match production's actual implementation (libraries corrected after dev feedback — not `@fastify/oauth2`/JWKS as first drafted); also strictly less authored code than a hand-rolled token endpoint or a server-side session store |
| Python supervisor in sandbox | Node.js bridge (~60-80 LOC) | Shares language/types with control plane |
| PVC, K8s reattach semantics | Named Docker volume + hourly reaper | Direct, smaller analog; **confirmed** production also retains the PVC via its own expiry/reaper management, not Job ownership/Job TTL — same shape, not just an assumption |
| GitHub webhook signature lib | Raw `node:crypto` HMAC compare | No library needed for HMAC-SHA256 |
| Open-ended `GET /models` provider catalog | Static, hand-curated allowlist (`config.js`), **UI-only — not a server-side validation gate** | **Confirmed** — production uses a static list too (not every LiteLLM-known model is exposed/approved) and validates `model` fields on syntax alone, never catalog membership; matched exactly, not narrowed further |
| Container log aggregation to OpenSearch (dashboard's "Open full logs in OpenSearch" link) | **Not built** — `docker logs --tail N` only | No log-aggregation stack in a single-Docker-host design; acceptable loss of a deep-link convenience feature, not a functional gap (raw logs are still fully retrievable via `sandbox/logs`) |
| `continuationReason: workspace_origin_mismatch` | **Not reachable, omitted from enum** | No org-wide repo-access model to mismatch against |
| `additionalRepos` / `readOrgRepos` session-creation fields | **Not built — permanent deviation** | Multi-repo/org-wide read grants are real complexity (extra clone/mount/token-scoping logic) with no need on a single-tenant host where the operator already controls repo access directly |

**Kept as-is (genuinely necessary, not overengineering):** the three-layer `opencode` config system
(native opencode behavior); all six WebSocket message types; session continuation
(predecessor/successor tracking); the GitHub `issue_comment` webhook trigger; the dashboard SPA (now
built as a static-file route on the same Fastify process — see §5 — same 3 routes, same REST/WS API
underneath, and, as of the correction above, the same React/Vite/Tailwind stack production itself uses
— no longer a deviation).

---

## Tech stack summary

A companion to the deviations table above — every component of this Docker-based design, its
technology, and its task, cross-referenced against `ai-coding-agent-doc.md`'s own confirmed stack
(see that doc's "Tech stack" section).

| Component | Technology | Task |
|---|---|---|
| Control plane runtime | Fastify (Node.js) | REST API (`/api/*`), WebSocket upgrade/relay, session/auth orchestration, dashboard static-file serving — one process, no separate services |
| Control plane database | SQLite (`better-sqlite3`, WAL mode, raw SQL — no ORM) | Direct analog of Postgres+Drizzle (§13); sessions, continuation lineage, `opencode_session_id`, `ws_token_hash`/`ws_token_prev_hash`, `events`, `deliveries` |
| Service-client auth | External OIDC provider, `client_credentials` grant, token introspection (`openid-client`'s `tokenIntrospection`, RFC 7662) | Control plane is an OIDC *client*, never an issuer; `POST /oauth2/token` is a thin Fastify passthrough; `OIDC_SERVICE_CLIENT_IDS` allowlists trusted clients (§11) |
| Dashboard auth | `openid-client` (Authorization Code + PKCE) + `@fastify/secure-session` | Browser login against the same external IdP; session state encrypted directly in the cookie, no server-side session table (§11) |
| Orchestration | Plain Docker (`docker run` via `child_process.spawn`) | One container per sandbox attempt/session — direct, smaller analog of one K8s Job per session (§13) |
| Sandbox isolation | Docker `internal: true` network (`sandbox-net`) | Structural (no NAT/default route) replacement for `iptables-init` — zero custom capabilities or iptables code (§12, §13) |
| Credential injection | Caddy (`sandbox-proxy` container, path-prefix reverse proxy) | Declared deviation from production's custom TLS-terminating MITM forward proxy — same secret-custody outcome, far less code (§12, §13) |
| Sandbox bridge | Node.js (`sandbox/bridge.js`, small inbound HTTP server) | Direct analog of the Python supervisor, but push not poll — control plane calls it synchronously over `sandbox-net`; owns idle watchdog, SSE relay, `opencode_session_id` reporting (§8) |
| Coding agent runtime | `opencode serve` (HTTP + SSE, confirmed match to production) | Model invocation, tool execution, durable local conversation state (§8) |
| Model gateway(s) | **Declared deviation (superseding earlier LiteLLM-only framing):** 0..N operator/team-configured gateways via the Platform config repo's opencode.json, resolved by opencode's native config layering — not enumerated in control-plane code. LiteLLM remains the default/example, and the control plane's own non-negotiable layer may still inject one fallback gateway for environments with no Platform config repo yet (open design question, §8) | `providerID/modelID` (`splitModel`, §8) already supports arbitrary provider ids; the control plane only ever overwrites `model`, never a provider catalog, in its non-negotiable `OPENCODE_CONFIG_CONTENT` layer |
| Model listing | Static, hand-curated allowlist (`config.js`) — confirmed to match production exactly | `GET /api/models` is UI-only; session/prompt endpoints validate `provider/model` syntax only, never catalog membership (§5, §13) |
| Config layering | `opencode`'s native config-precedence resolution, plus authored bootstrap composition logic | No custom merge-*algorithm*; real authored code clones/sparse-checks-out/SHA-pins and mounts platform/team/repo trees, and the non-negotiable `OPENCODE_CONFIG_CONTENT` layer overwrites model selection at runtime (§8) |
| Persistent workspace | Named Docker volume (per session) + hourly reaper (`setInterval`) | Direct analog of PVC + reaper-driven retention (§7, §12, §13); `opencode_session_id` lives in the control-plane DB, not solely on the volume |
| GitHub integration | GitHub webhook (`issue_comment`), built-in `create-pull-request`/`create-issue-comment` tools (image-baked) | Identical trust/prompt-construction logic to source doc; SHA-pinned clones instead of branch checkouts (§10) |
| GitHub host | Configurable via `GITHUB_URL` env var (same name as production) | `github.com`/GHDR by default for this deployment; GHES supported at the code level too — deployment constraint, not a code constraint (§12) |
| Agent/harness abstraction | Deliberately not built (declared YAGNI deviation) | Direct `opencode serve` integration only — no harness-abstraction seam, since only one harness exists today (§8, §13) |
| Dashboard | React + TypeScript SPA (Vite build, Tailwind v4, shadcn/ui, TanStack Query) | Matches production's own stack (§13 — no longer a declared deviation); built output served by `@fastify/static`, same 3 routes, same REST/WS API underneath (§5) |
| Network/security model | Two Docker networks (`sandbox-net` internal, `egress-net` NAT'd) + Caddy as sole bridge | Structural secret-custody boundary — sandbox containers can never reach the internet directly (§12) |
| Log access | `docker logs --tail N` only (no aggregation backend) | Declared deviation from production's OpenSearch-backed log aggregation — raw logs still fully retrievable, just no deep-link/search UI (§13) |

**Framing:** every component is either a direct, smaller-footprint analog of its production counterpart
(Docker vs. K8s, SQLite vs. Postgres+Drizzle, named volume vs. PVC, Caddy vs. custom MITM proxy,
vanilla JS vs. React/Vite/Tailwind), or literally the same technology/library carried over unchanged
(`opencode serve`, LiteLLM, `openid-client` + introspection auth, the GitHub webhook/trust logic, the
config-layering system).

---

## 14. LOC budget (live tracking number, not a settled fact)

| Component | Estimate |
|---|---|
| Public API (sessions CRUD, models, artifacts-proxy, logs, structured diagnostics) | ~95-110 |
| WS relay + wsToken rotation + subscriber registry + presence broadcast | ~105-120 |
| Sandbox lifecycle (`docker run`/inspect/logs/stop, per-session token mint) | ~60 |
| Bootstrap (3-repo clone/SHA-pin/failure-classification) | ~90-100 |
| Prompt/stop delivery (sync proxy) | ~15-20 |
| SQLite (sessions w/ continuation cols, minimal events, deliveries) | ~70-80 |
| Webhook (HMAC, dedup, trust check, prompt builder, async split) | ~70-80 |
| Reaper w/ active-session guard | ~30-35 |
| Auth (`openid-client` config + `/oauth2/token` proxy + introspection bearer verify + internal token) | ~40-55 |
| Bridge (small HTTP server + healthcheck-gated readiness) | ~50-70 |
| Proxy config glue (Caddyfile) | ~25 |
| Dashboard (static-file routes + login/cookie-auth branch on the server side) | ~40-60 |
| **Total** | **~690-850**, comfortably under the 1000 LOC ceiling |

**The dashboard's own React/TypeScript source (components, hooks, Tailwind classes) is not part of
this table** — it's UI code, not control-plane application logic (§1's scope boundary), same as it
would have been under the previously-planned vanilla-JS SPA. Only the ~40-60 LOC of *server-side*
routes/auth glue above counts.

**Cut priority if the ceiling is threatened during implementation** (least damaging to core UX first):
1. Narrow `fetch_history` to a single fixed-size batch instead of full pagination
2. Simplify `sandbox/diagnostics` to fewer fields (e.g. drop `lastSpawn`/`failureCount`, keep
   `phase`/`failureReason`/`failureMessage`) rather than dropping the endpoint outright — a real
   dashboard screenshot confirms this panel is actively used, not redundant with `sandbox/logs`
3. Narrow `presence` back to accept-and-store-only (no broadcast) if the dashboard's participant list
   turns out not to be worth the LOC — but treat this as a UX regression to confirm with product, not a
   free simplification, now that we've seen it rendered

**Do not cut:** the continuation schema/trigger or the webhook async split — both are correctness
fixes for already-in-scope behavior, not optional features. Diagnostics and presence moved off the
"drop entirely" list per the screenshot evidence above; both are confirmed real UI, not speculative.

---

## 15. Open items

- **Node runtime version pin:** no strong signal either way. Default to `better-sqlite3` + any current
  LTS unless there's a specific reason to adopt Node ≥22.13's built-in `node:sqlite` (Release Candidate
  stability as of writing) to minimize dependencies.
- **`events` table retention (§4):** confirmed to store the full SSE frame history, but no retention or
  pruning policy is specified anywhere — grows unboundedly per session, independent of the 7-day
  sandbox/volume reaper. Needs a decision (age-based prune? size cap? keep forever, SQLite can handle
  it at this scale?) before this becomes a real disk-growth question, not before.
- Everything else previously open has been resolved (see §13 for the final deviation list, which is
  the only place remaining ambiguity would surface as a scope question rather than an implementation
  detail).

---

## Endpoint & message-type coverage checklist

All 13 `ai-coding-agent-doc.md` service endpoints and all 6 WebSocket message types are accounted for
above (§5, §6) with an explicit status (built as-is / built with a stated scope reduction / declared
permanent deviation), plus the 3 dashboard routes (§5) and the two built-in tools (§8). No endpoint,
message type, request field, built-in tool, or env var from the source doc is silently unaddressed —
see §13 for the complete, closed deviations list.
