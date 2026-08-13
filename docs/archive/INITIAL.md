# INITIAL.md — Thin Docker-Based Agent Control Plane

**Goal:** Reimplement the capabilities described in `docs/ai-coding-agent-doc.md` (a control plane for
running non-interactive, background `opencode` coding-agent sessions in isolated sandboxes) as the
**simplest possible Docker-only system** — no Kubernetes, no Helm, no service mesh. Target: **< 1000
lines of code total** (control plane + sandbox bridge + proxy config + schema). Robustness through
simplicity — every deviation from the original doc below is a deliberate simplification, justified
by "we don't have that requirement" (no multi-tenant HA, no org-wide production SLA), not laziness.

This plan is the product of dedicated research sub-agent investigations into: (1) `opencode` CLI/server
capabilities (verified empirically against a **live locally-running `opencode serve` v1.18.16 instance**,
including its real OpenAPI spec at `GET /doc`), (2) Docker-native network isolation + credential injection
(verified against current Docker Compose + Caddy v2 docs), (3) a minimal Fastify v5 + SQLite control-plane
stack (verified against current `@fastify/websocket` v11.x / Node docs), (4) GitHub `issue_comment` webhook
trigger semantics and Docker named-volume continuation semantics (verified against current GitHub webhook
docs and Docker CLI/volume docs). Findings are folded in below; raw research is archived in
`docs/docker-thin-cp-research.md`. A second round of empirical/web verification (Aug 2026) tightened several
details that were "best-effort from docs" in the first pass — see the "Verified" callouts throughout.
A third round (Aug 2026) closed every remaining open question from §10: live-captured exact SSE event
shapes from a real two-turn `opencode serve` run, empirically confirmed `opencode` config-layer
precedence via `opencode debug config`, re-verified GitHub webhook payload/timeout/signature semantics
against current `docs.github.com` pages, and live-tested Docker network isolation end-to-end (a
container on an `internal: true` network confirmed unable to reach the internet). A fourth round
(Aug 2026) empirically confirmed why `opencode serve` (not `opencode run`) is mandatory — it exposes
the only HTTP/SSE surface with a durable, killable-and-resumable conversation store (`opencode`'s own
local SQLite file, proven to survive a hard-killed and restarted `serve` process) — and confirmed this
requirement is fully decoupled from the control plane's own database choice, closing the question of
whether PostgreSQL (as in the original doc) is needed here: it is not. No open questions
remain that block starting implementation — see the "round 3"/"round 4" callouts and the closed items in §10.

---

## 1. What we are keeping vs. simplifying from the original doc

| Original (K8s, production, multi-tenant) | This plan (Docker, single-tenant, thin) | Why it's OK to simplify |
|---|---|---|
| K8s Job per session, Helm chart | Plain `docker run` container per session, `child_process.spawn` | No cluster available/needed; one Docker host is the whole "control plane" |
| `iptables-init` + `sandbox-proxy` sidecar, `NET_ADMIN` capability | Docker `internal: true` network + a single Caddy proxy container bridging internal↔external | Structural network isolation (no route out) needs **zero** custom iptables code or extra capabilities |
| PostgreSQL | SQLite (`better-sqlite3`), WAL mode | No multi-instance/HA requirement — this is a single-process thin layer |
| OIDC `client_credentials` (JWKS, client registry, refresh tokens) | Reinstated per §17: a hand-rolled `POST /oauth2/token` (`jose`, HS256, static `OAUTH2_CLIENTS` env allowlist) — **not** a full IdP | **Correction (§17): the earlier row here was wrong to drop this** — the source doc's curl example is a plain client_credentials exchange, not full OIDC (no JWKS/login/consent implied); research showed it costs only ~55-65 LOC on top of the static-bearer-token approach, using the same env-based client registry and the same `timingSafeEqual`-on-digests pattern already used for webhook HMAC — so there was no real simplification to be had by dropping it |
| Python supervisor in sandbox | Node.js bridge script (~60-80 LOC) | Shares language/types with control plane, avoids a second toolchain |
| PVC, 7-day retention, K8s reattach semantics | Named Docker volume per session + hourly reaper `setInterval` | Direct, much smaller analog — volumes persist independently of containers exactly like a PVC |
| GitHub webhook (Fastify + signature lib) | Raw `node:crypto` HMAC compare (~15 LOC) | No library needed for HMAC-SHA256 compare |
| Open-ended `GET /models` provider catalog | Static allowlist of pre-approved `provider/model` strings in `config.js`, env-configurable | No multi-provider catalog requirement — this deployment only ever talks to one model gateway endpoint with a small, operator-curated model list (added §15.7, previously an undeclared narrowing) |

**Kept as-is** (these are genuinely necessary, not overengineering):
- The three-layer `opencode` config system (platform/team/repo + non-negotiable `OPENCODE_CONFIG_CONTENT`)
  — this is **native opencode behavior**, not something we build; we only need to set env vars correctly.
- WebSocket streaming protocol for live agent output (`subscribe`/`prompt`/`ping`/`presence`/
  `fetch_history`/`stop` messages, all six — corrected in §15.2, the first four were the only ones
  originally listed here) — this is the core UX and maps directly onto `opencode serve`'s own
  `GET /event` SSE stream.
- Session continuation concept (predecessor/successor session ids, schema and trigger made concrete in
  §15.3) — cheap to keep, and required for the "sandbox exits after 15 min idle, next prompt reattaches"
  UX described in the doc.
- GitHub `issue_comment` webhook trigger — core integration point, kept, just implemented minimally,
  with an async bootstrap split (§15.4) to satisfy GitHub's 10-second ACK requirement.

---

## 2. Architecture

```
Client (curl / dashboard-less API user)
   │  HTTP (Bearer token) / WebSocket
   ▼
control-plane (Node.js, Fastify)  ── SQLite (data/control-plane.db)
   │  docker run (child_process.spawn)
   ▼
sandbox container ── bridge.js (Node) ── opencode serve (localhost:4096, SSE /event)
   │  network: sandbox-net (internal: true — NO route to internet)
   ▼
sandbox-proxy container (Caddy) ── bridges sandbox-net + egress-net
   │  injects Authorization headers, routes /github/* and /gateway/* by hostname
   ▼
Real GitHub / model gateway endpoints (egress-net → host internet)
```

Key insight from research: the sandbox container is **structurally incapable** of reaching the
internet (Docker `internal: true` network has no NAT/default route), so it never needs to hold a
GitHub token or LLM API key — those live only in the proxy container's env, injected via Caddy's
`header_up`. This replaces the original doc's `iptables-init` + `sandbox-proxy` + `NET_ADMIN`
capability with a **~20-line Caddyfile and a two-network Compose topology**. No custom CA, no MITM,
no privileged containers.

### Why `opencode serve` (not `opencode run` per prompt)

`opencode` (confirmed via `opencode --help` **and a live running instance** locally, v1.18.16) supports
both a one-shot `opencode run --format json "<prompt>"` and a long-lived `opencode serve` HTTP server.

**✅ Verified live** (started `opencode serve --port 4097`, fetched its real OpenAPI spec from `GET /doc`,
and exercised the API with `curl`) — the actual endpoint set includes both a legacy top-level surface and
a `/api/*`-prefixed mirror; the ones we need:
- `POST /session` → `200 { id: "ses_<26-char-id>", slug, projectID, directory, title, time: {...}, ... }`
  — confirmed by creating a real session (`ses_00e4201a3ffeBlnHo1uTLDocEP`). **No `parentID`/`title` body
  is required** — an empty `{}` body works; `title` can optionally be passed to influence the placeholder
  title before the agent renames it.
- `POST /session/{sessionID}/prompt_async` → `204` (fire-and-forget). **Correction to earlier draft:**
  the `model` field in the request body is **not** a flat `"provider/model"` string — the real schema is
  a nested object: `{ model: { providerID: string, modelID: string }, agent?, parts: [...], noReply?,
  tools?, system?, variant?, messageID? }`. The bridge must split `opencode/big-pickle`
  on the first `/` into `{ providerID: "gateway", modelID: "eu.anthropic.claude-sonnet-4-6" }` before
  calling this endpoint (same first-`/`-only split rule the source doc already specifies for its own API).
- `GET /event` (and session-scoped `GET /session/{sessionID}/event`) — SSE stream of all bus events.
- Full path list has ~150 routes (session forking, revert/commit, permissions, LSP, PTY, MCP management,
  etc.) — irrelevant to this thin implementation; we only need the 3 above plus `GET /session/{id}` for
  status polling.

Because sessions must persist across sandbox restarts (7-day-style continuation) and stream live
tool-call deltas to the dashboard/API client, `opencode serve` + SSE consumption is architecturally
the right (and simpler) choice over shelling out to `opencode run` per prompt and re-parsing stdout —
the bridge just relays SSE events into the control plane's WebSocket broadcast 1:1.

### ✅ Verified live (round 4, Aug 2026): `opencode serve` is non-negotiable, and why SQLite for the control plane is still correct

A fourth research pass directly tested the claim that "`opencode` must run in `serve` mode (not `run`) for
session continuity to work, because the sessions are durably persisted" — and separately investigated
whether that requirement has any real coupling to the control-plane's own database engine (SQLite vs.
the original doc's PostgreSQL).

**`opencode serve` session durability — empirically proven, not assumed:**

```
$ opencode db path
/home/tom/.local/share/opencode/opencode.db        # SQLite (WAL mode), Drizzle-migrated

$ curl -X POST localhost:4098/session -d '{}'                       # create session
{"id":"ses_00e21b3a6ffeZzETmHUjNxrB6D", ...}
$ curl -X POST localhost:4098/session/$SID/message -d '{...}'        # send prompt, get "PONG" reply
$ kill -9 <opencode-serve-pid>                                       # hard-kill the process
$ opencode serve --port 4098 &                                       # fresh process, same data dir
$ curl localhost:4098/session/$SID
{"id":"ses_00e21b3a6ffeZzETmHUjNxrB6D","title":"One-word response: PONG", ...}   # 200, intact
$ curl localhost:4098/session/$SID/message
[ {user: "..."}, {assistant: "PONG"} ]                                # full history intact
```

This confirms **why the plan mandates `opencode serve` over `opencode run`**: `serve` is the only mode
that exposes the long-lived HTTP/SSE surface (`POST /session`, `POST /session/{id}/prompt_async`,
`GET /event`) the bridge needs to (a) push new prompts into an *existing* conversation and (b) stream
live token/tool-call deltas — `opencode run` is a one-shot CLI invocation with neither. Critically,
`opencode`'s own conversation state (sessions, messages, parts, tokens/cost) is **already durably
persisted to a local SQLite file** (`~/.local/share/opencode/opencode.db`) independent of the `serve`
process's lifetime — a killed-and-restarted `serve` process transparently re-opens the same file and
every session/message survives, confirmed both via the HTTP API and by querying the SQLite tables
directly (`opencode db "select ... from session/message"`).

**Why this does *not* imply the control plane itself needs PostgreSQL:** `opencode serve`'s persistence
(inside each sandbox, scoped to that sandbox's own `~/.local/share/opencode`) and the control plane's
bookkeeping DB (session rows, `wsToken`, event cursor, container/volume mapping) are **two entirely
independent persistence layers**, connected only by the bridge process relaying HTTP/SSE — the bridge
never touches the control plane's SQL rows directly, and `opencode serve` never touches the control
plane's DB at all. Nothing about "non-ephemeral `opencode serve`" requires any particular database
engine on the control-plane side. The original doc pairs `opencode serve` with PostgreSQL only because
its production control plane already needs Postgres for unrelated reasons (multi-instance HA, K8s-scale
concurrency) — not because `serve`'s continuity model demands it. Given this plan's explicit constraints
(single Docker host, exactly one control-plane process ever running, <1000 LOC budget), SQLite
(`better-sqlite3`, WAL mode) already provides everything the architecture needs: concurrent reads (e.g.
dashboard polling) alongside single-writer inserts (webhook/API), with zero added container, connection
pooling, or migration tooling. **Decision: keep SQLite for the control plane — confirmed, not just
assumed — and rely on `opencode serve`'s own already-durable SQLite store for conversation continuity
inside each sandbox.** This closes the last open item in §10 of the previous draft.

### ✅ Verified live (round 3, Aug 2026): exact SSE event shapes on `GET /event`

A third research pass ran `opencode serve --port 4097` locally, created a real session, sent two
real prompts (one plain-text, one triggering a `bash` tool call) with an already-authenticated
`github-copilot/claude-sonnet-5` model, and captured the raw SSE stream end-to-end. This resolves
the "remaining unknown" flagged in §10 of earlier drafts.

- **Frame format:** plain SSE, **`data:` only** — no `event:` field; the JSON payload's own `id`
  field carries the event id. One `data: {...}\n\n` frame per event. Periodic `server.heartbeat`
  events keep the connection alive (bridge should treat these as pure keepalive, no-op on relay).
- **`GET /session/{id}/event` does NOT exist** as a distinct endpoint — it falls through to the SPA
  catch-all and returns `index.html`. **All events flow through the single global `GET /event`
  stream**; a session-scoped bridge must filter client-side on `properties.sessionID`. Simplifies
  the bridge (one stream to consume, not N) but means the bridge process must discard events for
  any `sessionID` other than the one it owns (relevant if ever running multiple `opencode serve`
  instances behind one bridge — not needed for this one-sandbox-per-session design, just noted).
- **Observed event `type` values** (non-exhaustive — `/doc`'s OpenAPI spec enumerates ~120 `Event`
  variants total; only these fired during a two-turn test):
  - `server.connected`, `server.heartbeat` — connection lifecycle.
  - `session.updated` — session metadata (title, model, cost, tokens) changed.
  - `session.status` — `{"status":{"type":"busy"}}` while the agent is working.
  - `session.idle` — turn finished, agent is idle again (the bridge's natural "prompt done" signal).
  - `session.diff` — git diff summary for the turn (empty array if no files changed).
  - `message.updated` — a message (user or assistant) was created; carries role/model/time.
  - `message.part.updated` — full snapshot of a message part; `part.type` observed: `text`,
    `reasoning`, `step-start`, `step-finish`, `tool` (tool parts carry `state.status` progressing
    `pending → running → completed`/`error`, plus `tool`, `callID`, `input`, `output`, `metadata`).
  - `message.part.delta` — incremental token-by-token streaming for `text`/`reasoning` parts:
    `{"properties":{"sessionID","messageID","partID","field":"text","delta":"..."}}` — **this is
    the event to relay for live "typing" UX**; `message.part.updated` gives the final snapshot.
  - Full turn ordering (no tools): `message.updated`(user) → `message.part.updated`(text) →
    `session.status`(busy) → `session.diff` → `message.updated`(assistant) →
    `message.part.updated`(step-start) → `message.part.delta`(text)×N → `message.part.updated`
    (step-finish) → `session.updated` → `session.idle`.
  - With a tool call, between step-start/step-finish: `message.part.updated`(reasoning) →
    `message.part.delta`(reasoning) → `message.part.updated`(tool, pending→running→completed) →
    `message.part.updated`(step-finish, `reason:"tool-calls"`) → next step-start/deltas for the
    final reply.
- **Bridge relay implication:** the bridge does not need to understand every event shape — it can
  relay every `data:` frame verbatim to the control plane's WS broadcast (matching the doc's own
  "sandbox just streams events" model) and let the dashboard/API client interpret `type`. The only
  event the bridge itself must act on is `session.idle` (reset its own 15-min idle-watchdog timer).

---

## 3. Repository layout

```
control-plane/
  server.js              # Fastify app: routes, auth hook, WS handler          (~150 LOC)
  db.js                  # better-sqlite3 wrapper: sessions + events tables    (~60 LOC)
  sandbox.js             # docker run/inspect/logs/rm via child_process        (~60 LOC)
  reaper.js              # hourly setInterval: expire stale sessions/volumes   (~30 LOC)
  webhook.js             # GitHub HMAC verify + issue_comment → session       (~70 LOC)
  auth.js                # bearer token check (timingSafeEqual)                (~15 LOC)
  config.js              # env var loading, opencode config-layer builder     (~40 LOC)
  package.json
sandbox/
  bridge.js              # polls control plane, drives opencode serve via SSE (~80 LOC)
  Dockerfile             # installs opencode CLI + bridge.js, entrypoint
proxy/
  Caddyfile              # header injection + hostname routing                (~25 LOC)
docker-compose.yml                                                            (~40 LOC)
.env.example
docs/
  ai-coding-agent-doc.md          # source spec (already present)
  docker-thin-cp-research.md      # raw research findings (already present)
  INITIAL.md                      # this file
```

Estimated total: **~570-650 LOC** (see budget table §7), leaving comfortable headroom under 1000.

---

## 4. Control plane API surface (subset of original doc, same shapes)

Kept identical wire-shapes where possible so any existing client code from the doc's examples
still works conceptually:

| Endpoint | Behavior |
|---|---|
| `POST /api/sessions` | Create session row in SQLite, bootstrap the workspace (§9 step 0), `docker run` the sandbox container, return `{id, wsToken}` |
| `GET /api/sessions` | List, `limit`/`offset`/`status` query params |
| `GET /api/sessions/:id` | Session + live container status (`docker inspect`) + `continuation` object. **Rotates `ws_token`** on every call per a 2-token grace window (§14.2) — never returns a stale token as fatal on its own. |
| `PATCH /api/sessions/:id` | `{status}` update |
| `POST /api/sessions/:id/stop` | **Synchronous proxy call** (§16.1) straight to the bridge's `POST /stop`, which calls OpenCode's native `abort`; falls back to `docker stop <container>` only if the bridge doesn't respond within a timeout. No queue/ack involved. |
| `POST /api/sessions/:id/prompt` | **Synchronous proxy call** (§16.1) straight to the bridge's `POST /prompt` over `sandbox-net`, which relays to `opencode serve`'s `prompt_async`; ack `{messageId, position}` returned once the bridge accepts the call. No `prompts` table — nothing is queued. |
| `GET /api/sessions/:id/events` | Cursor-paginated event read from SQLite's minimal `events` table (§16.1 — decoupled from prompt delivery, kept only for replay/history compatibility) |
| `GET /api/sessions/:id/sandbox/logs` | Shell `docker logs --tail N <container>` |
| `GET /api/sessions/:id/sandbox/diagnostics` | Pod/container-level diagnostics (`docker inspect` + recent exit/OOM info) — **first candidate to cut under budget pressure** (§16.2), redundant with `sandbox/logs`. |
| `GET /api/models` | Static provider-qualified model allowlist from `config.js` — added per §12 endpoint-coverage audit. |
| `GET /api/sessions/:id/artifacts` | Thin 1:1 proxy to OpenCode's `GET /session/{ocSessionId}/diff` (confirmed real, §14.1) — no custom diffing. |
| `GET /api/ws/sessions/:id` | WebSocket upgrade; `subscribe`/`prompt`/`ping`/`stop` messages, same protocol as doc. Maintains an in-memory `Map<sessionId, Set<socket>>` subscriber registry (§14.3) so `session_continued` reaches a predecessor session's already-open sockets without resubscribing. |
| `POST /webhooks/github` | HMAC-verified `issue_comment` handler — same trust/prompt-construction rules as doc §"Triggering a session from a GitHub comment". Deduplicates on `X-GitHub-Delivery` against a `deliveries` table before spawning a session (§13 retraction fix — this was previously asserted as already handled but wasn't). |
| `POST /oauth2/token` | **Reinstated, §17.** `grant_type=client_credentials` form body → validates `client_id`/`client_secret` against the `OAUTH2_CLIENTS` env allowlist (`crypto.timingSafeEqual` over SHA-256 digests, same fixed-length-comparison pattern as the webhook HMAC check) → signs and returns `{access_token, token_type: "Bearer", expires_in: 3600}` as an HS256 JWT via `jose`. Matches the source doc's quickstart exactly. |

**Internal routes — inverted per §16.1: the control plane now calls the bridge, not the reverse.**
The bridge runs its own tiny HTTP server (`GET /global/health` proxy-through, `POST /prompt`,
`POST /stop`) reachable by the control plane directly over `sandbox-net`, authenticated by a
per-session internal token (distinct from OAuth2 access tokens, minted at spawn time, passed via
`docker run -e`, never logged). There is no `/internal/sessions/:id/queue` or `.../ack` route on the
control plane anymore — those, and the `prompts` table backing them, are removed entirely (§16.1). The
only thing still flowing *from* the sandbox to the control plane is the OpenCode event relay, which was
always a push (bridge → `POST /internal/sessions/:id/events` on the control plane) and needed no
queue/ack semantics in the first place.

Auth: every public `/api/*` route requires `Authorization: Bearer <token>` where `<token>` is an
HS256 JWT minted by `POST /oauth2/token` (§17, superseding the earlier static `API_BEARER_TOKENS`
plan) — verified with `jose.jwtVerify(token, JWT_SIGNING_SECRET, { algorithms: ['HS256'] })`, no other
lookup needed since the signature+`exp` check alone is sufficient (§17.3). WebSocket auth reuses the
existing per-session `wsToken` `subscribe` message pattern from the doc, with the 2-token grace-window
correction in §14.2. The control plane's calls *into* the bridge, and the bridge's event-ingest calls
*into* the control plane, both use the same per-session internal token — a separate mechanism from the
OAuth2 access tokens described above, never exposed outside `sandbox-net`.

---

## 5. `opencode` configuration in the sandbox (native mechanism, not custom)

Confirmed real, documented `opencode` env vars (opencode.ai/docs/config, `opencode --help`):
`OPENCODE_CONFIG` (path), `OPENCODE_CONFIG_DIR` (directory), `OPENCODE_CONFIG_CONTENT` (inline JSON,
highest precedence below only machine-managed config). Precedence order matches exactly what the
source doc describes for platform → team → repo → non-negotiable content layer, so **no custom
config-*merging* logic is required** (opencode resolves layer precedence natively) — we just set these
env vars when `docker run`-ing the sandbox. **Narrowed per §13's correction:** cloning, sparse-checking
out, SHA-pinning, and mounting the three source trees (target repo, platform config, team config) onto
the right paths *is* new control-plane code — see `bootstrap.js` in §14.4 — it's just not
config-*merging* code, since opencode itself still does that part natively once the directories exist
on disk.

```jsonc
// OPENCODE_CONFIG_CONTENT (set by control-plane at spawn time, non-negotiable layer)
{
  "model": "opencode/big-pickle",
  "autoupdate": false,
  "provider": {
    "gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://sandbox-proxy:8080/gateway",
        "apiKey": "unused-injected-by-proxy"
      }
    }
  }
}
```

The `apiKey` field can be a dummy value since the **proxy container** injects the real
`Authorization` header — the sandbox process never holds the secret, matching the doc's core
security property ("the sandbox itself never holds a secret") without any MITM/iptables machinery.

Platform/team/repo config layers (optional, sparse-cloned into `OPENCODE_CONFIG_DIR` by the bridge
or control plane before container start) are unchanged from the doc — same directory conventions
(`agents/`, `commands/`, `skills/<name>/SKILL.md`, `tools/<name>.js`, `plugins/`), confirmed real via
`opencode.ai/docs/config`.

**Two model-related capabilities not separately implemented, because they already flow through the
precedence chain above with no new code:**
- **`small_model`** — a second config key (used for cheaper/faster auxiliary calls) that follows the
  identical six-layer precedence as `model` (confirmed via `opencode.ai/docs/providers`). Any
  platform/team/repo layer may set it; the control plane's own `OPENCODE_CONFIG_CONTENT` (§5's JSONC
  example above) simply doesn't set it, leaving whatever a lower layer provides intact — no
  special-casing needed, same as any other key this plan's non-negotiable layer chooses not to touch.
- **Per-agent model override** (`opencode agent`, `agents/<name>.md` files) — a custom agent definition
  in any of the platform/team/repo layers can pin its own model independent of the session default;
  this is native opencode behavior riding on the same directory conventions already listed above, not
  a separate mechanism this plan needs to build or route.

Also **not applicable to this plan's architecture**: the `-m`/`--model` CLI flag on `opencode run`/the
TUI. This plan exclusively drives `opencode serve` (§2, "why `opencode serve` (not `opencode run`)")
and never shells out to a one-shot CLI invocation, so no CLI flag is ever passed or relevant — the
session/per-prompt `model` field (§15.5) is the only runtime (non-config-file) model-selection path
this plan actually uses.

### ✅ Verified live (round 3, Aug 2026): env-var config precedence, empirically confirmed

A dedicated research pass used `opencode debug config` (v1.18.16) — **the ideal introspection
tool**: it dumps the fully-merged, resolved config as JSON with no need for valid provider auth or
a `serve`/API round-trip — to test every combination of `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`,
`OPENCODE_CONFIG_CONTENT`, and a project-local `opencode.json` set simultaneously.

**Confirmed precedence, lowest → highest** (cross-checked against `opencode.ai/docs/config`):

1. Remote config (`.well-known/opencode`)
2. Global config (`~/.config/opencode/opencode.json`)
3. `OPENCODE_CONFIG` (custom file path)
4. Project config (`opencode.json` in project root) / `.opencode/` directories
5. **`OPENCODE_CONFIG_DIR`**
6. **`OPENCODE_CONFIG_CONTENT`** (inline JSON) ← what the control plane sets at spawn time
7. Managed/MDM config (`/etc/opencode/`, macOS `.mobileconfig`) — outside control-plane's reach

- **Confirmed for our design:** in every combination tested, `OPENCODE_CONFIG_CONTENT` always won
  for conflicting scalar keys (e.g. `model`) — it merges deep-merge-style on top of every other
  layer, never the other way around. The "non-negotiable top layer" property this plan relies on
  is real, not aspirational.
- **Correction to earlier draft / undocumented behavior found:** the docs describe
  `OPENCODE_CONFIG_DIR` as only a place to load `agents/commands/plugins` assets from — they do
  **not** claim it overrides project `opencode.json` scalar values. Empirically, in v1.18.16, it
  **does** override the project config's `model` key too. Treat `OPENCODE_CONFIG_DIR` as a full
  config layer (not merely an asset-discovery directory) sitting *above* project config and
  *below* `OPENCODE_CONFIG_CONTENT` — this doesn't change our design (we only ever put
  platform/team asset directories there, never rely on it *not* overriding repo config), but it's
  worth documenting so a future repo-config author isn't surprised.
- **Refuted claim from earlier draft:** "pointing `OPENCODE_CONFIG_DIR` at an existing-but-empty
  directory breaks the model/provider catalog" — tested directly, `opencode models` output was
  byte-identical with and without an empty `OPENCODE_CONFIG_DIR` set. No special-casing needed in
  `config.js` for the "team config repo has no `.opencode/` subtree" case beyond simply not setting
  the env var when there's nothing to mount (simpler than the original doc's own failure-mode
  table implies).

---

## 6. Sandbox bridge (`sandbox/bridge.js`) — pseudocode shape

**Updated per §16.1** (supersedes the §14 poll/ack version below the fold): the bridge is now a small
HTTP server, not a poller. The control plane calls it directly over `sandbox-net`, since it's on that
network too (§8) — this removes the `/internal/queue`/`/internal/ack` round-trip and the `prompts`
table entirely. `ocSessionId` persistence (closing §12 gap 3) and native `abort` handling (closing §12
gap 5) are unchanged in spirit, just reached via inbound HTTP instead of an outbound poll loop:

```js
// runs inside the sandbox container, alongside `opencode serve` (localhost:4096)
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN  // per-session, minted at spawn time
const CP = process.env.CONTROL_PLANE_URL            // control-plane is reachable on sandbox-net (§8)
const OC = 'http://127.0.0.1:4096'
const sessionId = process.env.SESSION_ID
const OC_SESSION_FILE = '/workspace/.control-plane/opencode-session-id'  // lives on the named volume

function splitModel(m) {
  const i = m.indexOf('/')
  return { providerID: m.slice(0, i), modelID: m.slice(i + 1) }
}

async function getOrCreateOcSession() {
  const saved = await readFileIfExists(OC_SESSION_FILE)
  if (saved) {
    const res = await fetch(`${OC}/session/${saved}`)
    if (res.ok) return saved   // reattach the SAME OpenCode conversation, closing §12 gap 3
  }
  const { id } = await postJSON(`${OC}/session`, {}) // confirmed: empty body is valid
  await writeFile(OC_SESSION_FILE, id)
  return id
}

let ocSessionId, idleSince = Date.now()
const idleTimer = () => { idleSince = Date.now() }

// Tiny HTTP server — the control plane calls IN, replacing the old poll loop entirely.
function startServer() {
  const app = createMinimalHttpServer() // e.g. node:http, no framework needed for 2 routes
  app.use(requireBearer(INTERNAL_TOKEN))

  app.post('/prompt', async (req, res) => {
    const { model, content } = req.body
    await postJSON(`${OC}/session/${ocSessionId}/prompt_async`, {
      model: splitModel(model), parts: [{ type: 'text', text: content }],
    })
    idleTimer()
    res.status(202).json({ accepted: true })
  })

  app.post('/stop', async (req, res) => {
    await postJSON(`${OC}/session/${ocSessionId}/abort`, {}) // native op, §14 gap 5 fix
    idleTimer()
    res.status(200).json({ stopped: true })
  })

  app.listen(PORT) // control plane's healthcheck (GET /global/health, §11) gates the first call
}

async function main() {
  ocSessionId = await getOrCreateOcSession()
  streamSSE(`${OC}/event`, (evt) =>
    postJSON(`${CP}/internal/sessions/${sessionId}/events`, evt, { headers: internalAuthHeaders() }))
  startServer()

  setInterval(() => {
    if (Date.now() - idleSince > 15 * 60 * 1000) process.exit(0) // 15-min idle watchdog, unchanged
  }, 30_000)
}
```

The event relay above is unchanged from every prior round — it was always a push (bridge → control
plane), never had a poll/ack problem, so §16.1's fix only needed to touch the prompt/stop *delivery*
direction, not event *ingestion*.

### 6.0 Original poll/ack version (superseded by §16.1 above — kept for reference only)

**This subsection is retracted design, retained only so the reasoning trail isn't lost.** Prior rounds
(§12-§15) had the bridge poll `/internal/sessions/:id/queue` and post to `/internal/sessions/:id/ack`,
backed by a `prompts` table. That table, both routes, and the poll loop below no longer exist in the
design — see §16.1 for why (a genuine architectural simplification found via colleague review, not
merely a rewording):

```js
// SUPERSEDED — do not implement this version. Shown only for historical trace.
async function main_OLD() {
  const ocSessionId = await getOrCreateOcSession()
  streamSSE(`${OC}/event`, (evt) => postJSON(`${CP}/internal/sessions/${sessionId}/events`, evt, { headers: internalAuthHeaders() }))
  let idleSince = Date.now()
  while (true) {
    const { commands } = await getJSON(`${CP}/internal/sessions/${sessionId}/queue`, { headers: internalAuthHeaders() })
    for (const c of commands) {
      if (c.type === 'stop') await postJSON(`${OC}/session/${ocSessionId}/abort`, {})
      else await postJSON(`${OC}/session/${ocSessionId}/prompt_async`, { model: splitModel(c.model), parts: [{ type: 'text', text: c.content }] })
      await postJSON(`${CP}/internal/sessions/${sessionId}/ack`, { commandId: c.id }, { headers: internalAuthHeaders() })
      idleSince = Date.now()
    }
    if (Date.now() - idleSince > 15 * 60 * 1000) process.exit(0)
    await sleep(2000)
  }
}
```

---

## 6a. Verified implementation details (from web-research sub-agents, Aug 2026)

These corrections/confirmations supersede anything conflicting elsewhere in this doc or in
`docker-thin-cp-research.md` — they come from a second research pass that cross-checked current
official docs (Fastify, Docker, Caddy, GitHub, Node.js) plus the live `opencode serve` test above.

**Fastify v5 / `@fastify/websocket`:**
- Use `@fastify/websocket` **v11.x** (requires Fastify v5). Handler signature is
  `fastify.get('/ws/:id', { websocket: true }, (socket, request) => { socket.on('message', ...) })` —
  `socket` **is the raw `ws` instance directly**, not a `{ socket }`/`connection.socket` wrapper (that
  wrapper style was removed in v10.0.0, released before v11). Do not copy older Fastify-websocket
  examples that show `(connection, req) => connection.socket.on(...)`.
- For the GitHub webhook route, preserve the raw body for HMAC verification with:
  `fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  req.rawBody = body; try { done(null, JSON.parse(body)) } catch (e) { done(e) } })` — this is the
  documented Fastify pattern (`ContentTypeParser.md`), no extra library needed.
- Bearer auth: prefer the official **`@fastify/bearer-auth`** plugin over a hand-rolled `onRequest`
  hook — a naive `crypto.timingSafeEqual` hook has a subtle length-check timing leak (must guard
  unequal-length buffers *before* calling `timingSafeEqual`, which itself throws on length mismatch;
  the safest fix is comparing SHA-256 digests of both sides rather than raw tokens). The official
  plugin already handles this; only hand-roll if avoiding the extra dependency is worth the risk.
- SQLite: Node's built-in `node:sqlite` is at **Stability 1.2 "Release candidate"** as of current
  Node docs (promoted from experimental in v22.13.0, RC in v25.7.0) — not yet fully "Stable". Given
  this is a thin/internal tool, `node:sqlite` is an acceptable, zero-native-dependency choice **if**
  the deployment target is Node ≥22.13; otherwise fall back to `better-sqlite3` (still recommended
  default in this plan for broadest compatibility and battle-tested maturity — see §7 budget, no LOC
  difference either way).

**Docker network isolation (confirmed, no gotchas found — re-verified round 3 with a live test):**
- `internal: true` on a Compose network genuinely removes the default gateway/NAT — containers on it
  cannot reach the internet, confirmed in current Compose docs (`docs.docker.com/compose/how-tos/networking/`
  and `docs.docker.com/reference/compose-file/networks/`). `driver: bridge` need not be stated
  explicitly — it's the implicit default for locally-scoped Compose networks and works fine combined
  with `internal: true`.
- **Live-tested (Docker 29.6.0):** `docker network create --internal test_net` +
  `docker run --rm --network test_net alpine sh -c "apk add curl; curl https://example.com"` →
  `apk add` itself failed (Alpine's package index is internet-hosted) and the fallback curl reported
  `UNREACHABLE` — direct confirmation the sandbox network has zero route out, not just a documented claim.
- A container attached to **both** the internal network and a normal bridge network (the proxy) is the
  documented pattern for exactly this "one bridging container" topology — Docker's own Compose networks
  page shows this exact shape verbatim (a `proxy` service on `[outside, default]` vs. an `app` service
  on `[default]` only, captioned as "the gateway to the outside world").
- Embedded DNS (127.0.0.11) still resolves same-network container names on an `internal: true` network
  — so the sandbox reaches the proxy by Compose service name (`http://sandbox-proxy:8080/...`) with zero
  extra config; only *external* DNS/routing is cut off. This confirms the compose sketch in §8 works as
  designed with no additional isolation code needed.
- Caddy v2 confirmed: `handle_path /prefix/* { reverse_proxy https://upstream { header_up Authorization
  "Bearer {env.VAR}" } }` is valid, current syntax (`caddyserver.com/docs/caddyfile/directives/reverse_proxy`,
  "Strip a path prefix before proxying" example + "Headers" section). **Exact placeholder syntax
  double-checked and confirmed: `{env.VAR_NAME}`** (runtime placeholder, substituted per-request) —
  **not** `{$VAR_NAME}`, which is a *different*, Caddyfile-parse-time text-substitution macro expanded
  before the config is even parsed and unsuitable for a `header_up` value needing runtime semantics.
  No custom Node/nginx proxy needed — Caddy is the smallest option (nginx would need extra `envsubst`
  templating since nginx.conf has no native env-var syntax; a hand-written Node `http-proxy` script is
  ~30-40 LOC vs. Caddy's ~20-line declarative config).

**GitHub `issue_comment` webhook (confirmed against current GitHub docs, round 3 re-verification):**
- Trust check must read **`comment.author_association`** (the commenter's association), not
  `issue.author_association` (the original issue/PR author's association) — these are independent
  fields on independent payload objects (`comment` = "the comment itself", `issue` = "the issue the
  comment belongs to"). **Re-confirmed** against
  `docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment`. Verify this in `webhook.js`.
- Distinguish "comment on a PR" vs. "comment on a plain issue" via presence of the `issue.pull_request`
  key in the payload (present only when the parent issue is actually a PR) — no separate event type
  exists; GitHub unifies both under `issue_comment`, exactly as the source doc implies. **Re-confirmed**
  per `docs.github.com/en/rest/using-the-rest-api/issue-event-types` ("every pull request is an issue…
  pull requests have a `pull_request` property in the `issue` object").
- Signature: `X-Hub-Signature-256: sha256=<hex hmac-sha256 of raw body>`, verified with
  `crypto.timingSafeEqual`. **Caution on the test vector:** GitHub's own docs page
  (`using-webhooks/validating-webhook-deliveries`) publishes `secret="It's a Secret to Everybody"`,
  `body="Hello, World!"` → a digest string that is **65 hex chars** (one char too many for a 32-byte
  SHA-256 digest) — almost certainly a copy/rendering artifact on GitHub's docs page itself. **Do
  not hardcode that string in a test fixture** — compute the real expected digest locally at test
  time with `node:crypto` (`createHmac('sha256', secret).update(body).digest('hex')`) instead of
  trusting the doc's literal text.
- Additional delivery headers confirmed available beyond signature/event type — worth logging for
  observability: `X-GitHub-Delivery` (dedup GUID, already used by this plan's dedupe logic),
  `X-GitHub-Event`, `X-GitHub-Hook-ID`, `X-GitHub-Hook-Installation-Target-Type/ID`, and a legacy
  `X-Hub-Signature` (SHA-1, ignore — only verify `X-Hub-Signature-256`).
- **Timeout: GitHub requires a 2xx response within 10 seconds** or the delivery is marked failed —
  **re-confirmed verbatim**: "Your server should respond with a 2XX response within 10 seconds of
  receiving a webhook delivery... If your server takes longer than that... GitHub terminates the
  connection and considers the delivery a failure" (`using-webhooks/handling-webhook-deliveries`).
  The webhook handler must ACK immediately (enqueue session creation, return `200`/`202`) and do any
  slower work (spawning the Docker container) asynchronously after responding, not before.

**Docker named volumes (confirmed, no changes needed to the design in §2/§8):**
- `docker run -v <name>:/path` auto-creates the volume if absent — confirmed Docker docs, no
  special "create volume" step needed before first sandbox run for a session.
- Named volumes are NOT removed by `docker rm <container>` (only anonymous volumes are, and only with
  `-v`/`--rm`) — confirming the reaper design (§9 step 10) is the only place volumes get deleted.
- Existence/state check before deciding `docker run` vs. reattach: `docker inspect -f
  '{{.State.Status}}' <name>` — exits non-zero with "No such object" if it doesn't exist yet, exits 0
  with a status string (`running`/`exited`/...) otherwise. Use this exact command in `sandbox.js`
  rather than parsing `docker ps` output.
- For the reaper, label session volumes at creation time (`docker run -v ... --label
  session=<id>` doesn't label the volume itself — use `docker volume create --label session=<id>
  --name session-<id>` explicitly first, or just track the session→volume mapping in SQLite, which
  this plan already does) so cleanup is targeted (`docker volume rm session-<id>`) rather than a
  blanket `docker volume prune` that could remove unrelated volumes.

---

## 7. LOC budget (from research; validate against actuals during implementation)

| Component | Est. LOC |
|---|---|
| Fastify routes + WS handler + SQLite queries (`server.js`, `db.js`) | 250-300 |
| Static bearer auth hook (`auth.js`) | 15 |
| Docker spawn/inspect/logs helper (`sandbox.js`) | 50-60 |
| GitHub webhook HMAC verify + handler (`webhook.js`) | 60-80 |
| Reaper — volume/container cleanup (`reaper.js`) | 25-30 |
| Sandbox bridge, SSE + poll loop (`sandbox/bridge.js`) | 60-80 |
| Config/schema/misc glue (`config.js`, Dockerfiles, Caddyfile, compose) | 50-80 |
| **Total** | **~550-650**, comfortably under the 1000 LOC budget |

---

## 8. Docker network topology (compose sketch)

**Updated per §12 gap 1 / §14:** the control plane is now attached to *both* networks so
`bridge.js` inside each sandbox can actually reach it — the sandbox itself still never touches
`egress-net`, so the "sandbox cannot reach the internet" property is unaffected; only the control
plane gains a second interface.

```yaml
networks:
  sandbox-net:
    internal: true   # structurally no route to the internet
  egress-net:          # normal bridge, has NAT to the host

services:
  control-plane:
    build: ./control-plane
    networks: [egress-net, sandbox-net]   # both: egress for its own use, sandbox-net so bridge.js can reach it
    ports: ["3000:3000"]
    volumes:
      - ./data:/data
      - /var/run/docker.sock:/var/run/docker.sock   # to spawn sandbox containers
    environment:
      OAUTH2_CLIENTS: ${OAUTH2_CLIENTS}                 # client_id:secret_sha256hex pairs, comma-separated (§17) — replaces API_BEARER_TOKENS
      JWT_SIGNING_SECRET: ${JWT_SIGNING_SECRET}         # 32 random bytes, HS256 (§17.3)
      GITHUB_WEBHOOK_SECRET: ${GITHUB_WEBHOOK_SECRET}
      GITHUB_TOKEN: ${GITHUB_TOKEN}                    # host-side only, used by bootstrap.js (§14.4); never passed into a sandbox container

  sandbox-proxy:
    image: caddy:2-alpine
    networks: [sandbox-net, egress-net]     # the ONLY container bridging both for LLM/GitHub API egress
    volumes: [./proxy/Caddyfile:/etc/caddy/Caddyfile:ro]
    environment:
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      MODEL_GATEWAY_API_KEY: ${MODEL_GATEWAY_API_KEY}

  # sandbox containers are spawned dynamically by control-plane via `docker run`,
  # always attached to `sandbox-net` only (never egress-net, never the docker socket).
  # Each gets a per-session INTERNAL_TOKEN env var (minted by the control plane at spawn
  # time, §4/§12 gap 1) to authenticate bridge.js -> control-plane /internal/* calls.
```

```caddyfile
# proxy/Caddyfile
:8080 {
  handle_path /github/* {
    reverse_proxy https://api.github.com {
      header_up Authorization "Bearer {env.GITHUB_TOKEN}"
      header_up Host api.github.com
    }
  }
  handle_path /gateway/* {
    reverse_proxy https://gateway.internal.example.com {
      header_up Authorization "Bearer {env.MODEL_GATEWAY_API_KEY}"
    }
  }
}
```

---

## 9. Implementation order (supersedes the original ordering — updated per §12/§13/§14, sync-proxy model per §16.1)

0. `control-plane/bootstrap.js` — clone/checkout target repo (branch per trigger source) + sparse-clone
   platform config (hard-fail) + sparse-checkout team config `.opencode/` (skip-vs-fail via stderr
   classification) + SHA-pin all three (§14.4). Runs before any `docker run`.
1. `control-plane/db.js` — SQLite schema: `sessions` (incl. `ws_token`/`ws_token_prev`/
   `ws_token_prev_expires_at` §14.2, and `predecessor_id`/`successor_id`/`continuation_reason`/
   `current_attempt`/`workspace_expires_at` §15.3), a **minimal** `events` table (§16.1 — decoupled
   from delivery, kept only for replay/cursor-history), `deliveries` (webhook dedup, §13 retraction
   fix) tables + query wrappers. **No `prompts` table** — removed per §16.1, prompt/stop delivery no
   longer queues anything.
2. `control-plane/oauth2.js` — `POST /oauth2/token` handler (`OAUTH2_CLIENTS` allowlist lookup,
   digest-based `timingSafeEqual`, `jose` HS256 signing) plus the `onRequest` bearer-verify hook for
   `/api/*` (§17) — supersedes the plain static-bearer-token version of `auth.js` originally planned
   here. A separate internal per-session token check (unrelated to OAuth2, §4) is used both
   directions: control-plane→bridge calls (§16.1) and the bridge's event-ingest calls into the
   control plane.
3. `control-plane/server.js` — session CRUD routes, wired to `db.js` + `oauth2.js`, including
   `GET /api/models`, `GET /api/sessions/:id/artifacts` (proxy to OpenCode diff, §14.1), and
   `GET /api/sessions/:id/sandbox/diagnostics` (first cut candidate, §16.2, if budget requires).
4. `control-plane/sandbox.js` — `docker run`/`inspect`/`logs`/`stop` helpers; mints and passes the
   per-session `INTERNAL_TOKEN` env var at spawn time; exposes a `waitForHealthy(container)` helper
   polling `GET /global/health` through to the bridge (§16.1's spawn-race mitigation) before the
   control plane makes its first `/prompt` call.
5. Wire `POST /api/sessions` to: call `bootstrap.js` (step 0), then spawn a container via
   `sandbox.js`, mounting the bootstrapped repo/config directories.
6. `sandbox/bridge.js` + `sandbox/Dockerfile` — install `opencode`, run `opencode serve` + bridge.
   The bridge is now a small HTTP server (§16.1, §6) exposing `POST /prompt` and `POST /stop`,
   authenticated by `INTERNAL_TOKEN`, reachable directly by the control plane over `sandbox-net` — not
   a poller. It still persists/restores `ocSessionId` (§12 gap 3) and still pushes OpenCode SSE events
   out to `POST /internal/sessions/:id/events` on the control plane (unchanged push relay).
7. Wire `POST /api/sessions/:id/prompt` and `POST /api/sessions/:id/stop` in `server.js` to call
   directly into the bridge's `/prompt`/`/stop` routes over `sandbox-net` (§16.1) — this *is* the
   "internal API," there is no separate queue/ack layer to build.
8. WebSocket handler in `server.js` (`subscribe`/`prompt`/`ping`/`presence`/`fetch_history`/`stop`,
   all six per §15.2), event replay from SQLite's minimal `events` table, `ws_token` grace-window
   validation (§14.2), and the in-memory subscriber registry + `session_continued` broadcast to
   predecessor sockets (§14.3) — trigger logic per §15.3's `resolveActiveSession`/`spawnContinuation`.
9. `proxy/Caddyfile` + compose network topology (§8, control plane on both networks) — verify sandbox
   truly cannot reach internet directly (`docker exec sandbox curl -m3 https://example.com` should
   fail/hang) while confirming the control plane *can* reach the bridge's `/prompt`/`/stop` routes over
   `sandbox-net`.
10. `control-plane/webhook.js` — GitHub HMAC verify + delivery-ID dedup check against the `deliveries`
    table (§13 retraction fix) + trust check + prompt builder (§15.6) + async 202-then-`setImmediate`
    bootstrap split (§15.4) + `issue_comment` → session spawn (via step 5's flow).
11. `control-plane/reaper.js` — hourly stale-session/volume cleanup, **skipping any session whose
    current attempt status is `pending`/`starting`/`running`** regardless of `last_active_at` age
    (§13 gap 8).
12. End-to-end test: create session via curl → bootstrap clones repo/config → control plane waits for
    bridge healthcheck → connect WS → send prompt (sync proxy call, §16.1) → observe streamed events →
    send `stop` (sync proxy call) → confirm OpenCode `abort` fires before any container kill → confirm
    container exits after idle timeout → send another prompt → confirm reattach via same named volume
    AND same `ocSessionId` (continuation, trigger per §15.3) → confirm `session_continued` reaches a
    still-open predecessor-session socket → fetch `/api/sessions/:id/artifacts` and confirm it reflects
    the turn's file changes.

---

## 10. Open questions / things to verify empirically during implementation

- ~~Confirm exact opencode `serve` REST/SSE payload shapes~~ **RESOLVED (round 3)** — verified live
  against a real two-turn `opencode serve` v1.18.16 run: exact SSE `data:`-only frame format, the
  observed `type` values (`server.connected/heartbeat`, `session.updated/status/idle/diff`,
  `message.updated`, `message.part.updated`, `message.part.delta`), and full turn-ordering with and
  without a tool call. See §"Verified live (round 3, Aug 2026): exact SSE event shapes" above. Also
  discovered `GET /session/{id}/event` **does not exist** — all events flow through the single
  global `GET /event` stream, filtered client-side on `sessionID` (simpler than assumed: one stream
  to relay, not N).
- ~~Confirm Docker embedded DNS behavior on an `internal: true` network~~ **RESOLVED** — confirmed via
  current Compose docs: embedded DNS resolution is per-network-membership, independent of the
  `internal` flag, so the sandbox resolves the proxy by Compose service name with no extra config.
  **Round 3 addendum:** also live-tested the isolation itself (Docker 29.6.0) — a container on an
  `internal: true` network genuinely cannot reach the internet (`UNREACHABLE`, confirmed by attempted
  `curl` to `example.com` from inside the network). Also confirmed the exact Caddy env-placeholder
  syntax is `{env.VAR_NAME}` (runtime), not `{$VAR_NAME}` (a different, parse-time macro) — use the
  former in `proxy/Caddyfile`.
- ~~Decide whether `OPENCODE_CONFIG_DIR` sparse-checkout... is done by control plane or bridge~~
  **RESOLVED** — do it in the control plane (before spawn, mounted read-only). **Round 3 addendum:**
  empirically confirmed `OPENCODE_CONFIG_DIR` is a full config layer that sits *above* project
  `opencode.json` (not merely an asset-discovery dir as the docs' wording suggests) and *below*
  `OPENCODE_CONFIG_CONTENT` — safe for our design since we only ever use it for platform/team
  assets and never expect it to lose to repo config. Also refuted the earlier draft's claim that an
  empty `OPENCODE_CONFIG_DIR` breaks the model/provider catalog (`opencode models` output was
  byte-identical with/without it set) — `config.js` can simply skip setting the env var at all when
  a team config repo has no `.opencode/` subtree, no special-casing required. Full precedence chain
  (lowest→highest) confirmed via `opencode debug config` (the ideal introspection tool — dumps
  merged config with no auth/API round-trip needed): remote → global → `OPENCODE_CONFIG` → project
  `opencode.json`/`.opencode/` → `OPENCODE_CONFIG_DIR` → `OPENCODE_CONFIG_CONTENT` → managed/MDM.
- ~~Verify the actual `issue_comment` webhook payload field list against a real GitHub delivery~~
  **RESOLVED (docs re-verified, round 3)** — `comment.author_association` vs.
  `issue.author_association`, and `issue.pull_request` presence as the PR-vs-issue discriminator,
  both re-confirmed against current `docs.github.com` pages (exact URLs in §6a). One new caution:
  GitHub's own published HMAC test-vector digest string has a length anomaly (65 hex chars instead
  of 64) — likely a docs rendering bug; **compute the expected digest locally with `node:crypto`
  rather than hardcoding GitHub's literal string** in a test fixture. A live delivery capture (smee.io
  tunnel or "Redeliver webhook") is still cheap extra insurance before shipping `webhook.js`, but is
  no longer blocking — the field names/locations are now doc-confirmed from two independent GitHub
  docs pages, not just the source doc's own paraphrase.
- Choose Node runtime version pin for the control-plane image: use Node ≥22.13 (flag-free
  `node:sqlite`) if adopting the built-in module per §6a, or any current LTS if sticking with
  `better-sqlite3` (no version constraint beyond native-addon prebuild availability). **Still open**
  — no strong signal either way; default to `better-sqlite3` + any current LTS unless a specific
  reason to minimize dependencies arises during implementation.

## 11. Round 5 (Aug 2026): further empirical findings against a live `opencode serve` v1.18.16

A fifth pass re-verified the doc's server API surface against the current, official
`opencode.ai/docs/server/` page (fetched live) and directly exercised a fresh local `opencode serve`
instance, closing a few more design decisions rather than leaving them to be discovered mid-implementation:

- **`OPENCODE_SERVER_PASSWORD` is real and documented** (`opencode.ai/docs/server/#authentication`):
  setting it enables HTTP Basic auth on the whole server (`opencode` as the default username, or
  override with `OPENCODE_SERVER_USERNAME`); unset, the server prints `Warning:
  OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` and accepts unauthenticated requests
  (confirmed live: `POST /session` → `200` with zero credentials on a freshly started `opencode
  serve --port <n>`). **Design implication:** since `opencode serve` in this plan's sandbox only
  ever listens on `127.0.0.1` inside its own container — reached exclusively by `bridge.js` in the
  same process namespace, never exposed on `sandbox-net` — leaving it unauthenticated is an
  acceptable, deliberate simplification (nothing else in the container can reach it; the sandbox has
  no other process). Setting `OPENCODE_SERVER_PASSWORD` to a per-session random value generated by
  the control plane and passed as an env var is a **zero-cost, optional hardening** the bridge can
  adopt later (one extra header on every `bridge.js` → `opencode serve` call) but is not required for
  the threat model in §1 — noted here so it isn't rediscovered as a surprise, not because it blocks
  anything.
- **Confirmed via the official server API table** (supersedes the `docker-thin-cp-research.md` draft
  list, which was reconstructed from an OpenAPI spec dump and slightly incomplete): the bridge should
  use these exact endpoints, all real and stable in v1.18.16:
  - `POST /session/:id/abort` → `boolean` — this is the correct native endpoint for the doc's `stop`
    message, not a bridge-invented mechanism. `sandbox.js`/`bridge.js` should map the control plane's
    `stop` WS message straight to this call instead of killing the container outright (killing the
    container is the fallback if `opencode serve` itself is wedged).
  - `DELETE /session/:id` → `boolean` — deletes a session and all its data; useful for an explicit
    "delete session" API action if ever added, distinct from letting the reaper's volume-level cleanup
    handle expiry.
  - `GET /session/status` → `{ [sessionID]: SessionStatus }` for **all** sessions in one call — since
    each sandbox only ever runs one `opencode` session, this is equivalent to (and slightly cheaper
    than) `GET /session/:id` for the bridge's own idle/busy polling, if it prefers polling over relying
    solely on the `session.idle` SSE event.
  - `GET /global/health` → `{ healthy: true, version }` — the right Docker `HEALTHCHECK` target for
    the sandbox container (cheaper and more meaningful than a bare TCP check), and a shell one-liner
    (`curl -f 127.0.0.1:4096/global/health`) the bridge itself can use before its first `POST
    /session` call, to avoid a race against `opencode serve`'s own startup time.
  - `POST /session/:id/message` (synchronous, waits for the full reply) exists alongside
    `prompt_async` — **not used** by this plan's bridge (`prompt_async` + SSE relay is strictly
    better for streaming UX), but worth knowing it exists so nobody re-derives it as "missing"
    functionality during implementation.
- No changes to the LOC budget, architecture, or any other section — this round only tightens
  endpoint choices and closes the auth-of-`opencode-serve` question that was implicit but unstated in
  earlier rounds.
- ~~Whether the control plane needs PostgreSQL (as in the original doc) for `opencode serve`'s
  non-ephemeral session model to "make sense"~~ **RESOLVED (round 4)** — empirically confirmed
  `opencode serve` already persists all conversation state (sessions/messages/parts) to its own local
  SQLite file (`~/.local/share/opencode/opencode.db`), independent of the control plane's DB engine;
  a killed-and-restarted `opencode serve` process transparently recovers full history from that file.
  The control plane's bookkeeping DB and `opencode serve`'s conversation store are fully decoupled,
  connected only via the bridge's HTTP/SSE relay — so SQLite remains correct for the control plane
  under this plan's single-host, single-process constraints. See §"Verified live (round 4)" above.

## 12. Round 6 (Aug 2026): endpoint-coverage audit against `ai-coding-agent-doc.md` — gaps found

A dedicated audit checked every endpoint in `docs/ai-coding-agent-doc.md` against this plan's routed
architecture (full findings archived at
`.agents/sw/research/2026-08-11-endpoint-architecture-coverage.md`). Verdict: **this plan is not yet a
holistic functional project** — it has both declared compatibility reductions (acceptable) and real
functional-chain breaks (not acceptable, must be fixed before implementation starts).

### Endpoint coverage

Of the source doc's 13 service endpoints, §4 routes 10. Covered: `POST /api/sessions`,
`GET /api/sessions`, `GET /api/sessions/:id`, `PATCH /api/sessions/:id`,
`POST /api/sessions/:id/stop`, `POST /api/sessions/:id/prompt`, `GET /api/sessions/:id/events`,
`GET /api/sessions/:id/sandbox/logs`, `GET /api/ws/sessions/:id`, `POST /webhooks/github`.

**Not covered** (declared or accidental):
- `GET /api/sessions/:id/sandbox/diagnostics` — dropped without a stated reason. **Decision: add it**
  (cheap — same `docker inspect`/`docker logs` primitives §4 already uses for `sandbox/logs`).
- `GET /api/models` — dropped, but `POST /api/sessions` and the WS `prompt` message still validate
  `provider/model` format per the doc's rule (§ "Model format" in `ai-coding-agent-doc.md`). Without
  this endpoint, clients have no way to discover valid values. **Decision: add it**, backed by a static
  allowlist in `config.js` (no new infrastructure — just the two hardcoded `opencode/...` model IDs this
  thin deployment actually supports).
- `GET /api/sessions/:id/artifacts` — dropped. **Decision: add it**, implemented as a projection of
  OpenCode's own `GET /session/:id/diff` (confirmed real, §11) — zero new sandbox-side code, only a
  control-plane route that proxies/caches that call through the bridge's event relay.
- Dashboard routes (`/`, `/sessions/new`, `/sessions/:id`) — **deliberately out of scope**, unchanged
  from earlier drafts (this plan is API/curl-first, §2 "Client (curl / dashboard-less API user)").
  Documented here as an explicit, permanent compatibility deviation, not an oversight.
- `/oauth2/token` — ~~**deliberately out of scope**, replaced by static bearer tokens (§1, §4)~~
  **retracted, §17**: reinstated as a ~55-65 LOC hand-rolled route (`jose`, HS256, static
  `OAUTH2_CLIENTS` env allowlist) so the source doc's own curl quickstart works unchanged — the
  original "out of scope" call in this section overestimated the cost of client_credentials as
  requiring a full IdP, which §17's research shows is not the case.

### Functional-chain gaps (blocking — not simplifications)

These are breaks in the plan's own internal logic, independent of what the source doc requires:

1. **Bridge cannot reach the control plane.** §8's Compose topology puts the control plane on
   `egress-net` only and dynamically spawned sandboxes on `sandbox-net` only (§8, §2 diagram) — the
   two share no network, so `CONTROL_PLANE_URL` in §6's bridge pseudocode is unreachable. **Fix:**
   attach the control plane to both `egress-net` and `sandbox-net`; the sandbox still never touches
   `egress-net`, so the "sandbox can't reach the internet" property is preserved. Bridge→control-plane
   calls should carry a per-session internal token (distinct from `API_BEARER_TOKENS`, which gates the
   external client-facing API).
2. **Queue/ack has no schema.** §6's bridge polls `${CP}/api/sessions/${sessionId}/queue` and posts to
   `.../ack`, but §4's route table and the `sessions`/`events` schema (research doc §2) never define
   these. An append-only `events` table cannot safely double as mutable queue-claim state. **Fix:** add
   a `prompts` table (`id, session_id, content, model, reasoning_effort, status, position, created_at,
   claimed_at`) and two authenticated **internal** routes (`GET /internal/sessions/:id/queue`,
   `POST /internal/sessions/:id/ack`) — separate from and not listed in §4's public API surface.
3. **Continuation doesn't actually reuse the OpenCode conversation.** §6's bridge always does
   `POST /session {}` on startup — it never looks up a prior `ocSessionId`. The named volume preserves
   `opencode`'s SQLite file (per §11's proof), but a fresh `opencode` session ID still starts a *new*
   conversation against that same durable store. **Fix:** persist `ocSessionId` to a file inside the
   volume (e.g. `/workspace/.control-plane/opencode-session-id`); on bridge startup, read and verify it
   via `GET /session/:id` before deciding whether to create a new one.
4. **No executable repo/config bootstrap.** §5 says config layers are "sparse-cloned into
   `OPENCODE_CONFIG_DIR`... before container start," and the source doc requires cloning the target
   repo itself — but §3's file layout and §9's implementation order contain no clone/checkout step,
   no GitHub token plumbing for it, and no volume/mount wiring for the cloned tree. The §8 proxy only
   forwards already-authenticated HTTP calls under `/github/*`; it doesn't turn a plain `git clone`
   into an authenticated one. **Fix:** add an explicit control-plane-side clone step (using a host-held
   GitHub token, never passed into the sandbox) that populates the session's named volume before
   `docker run`, and add this as implementation-order step 0 in §9.
5. **Stop bypasses the durable command path.** §4 maps `POST /api/sessions/:id/stop` straight to
   `docker stop`, but §11 separately identifies `POST /session/:id/abort` as the correct native
   operation, and the source doc requires `stop` to be a *durable, queued* command for the active
   attempt, not an immediate kill. **Fix:** route `stop` through the same internal command path as
   prompts (item 2) — bridge receives it, calls OpenCode's `abort`, and only `docker stop`/`kill` as a
   fallback if the bridge itself is unresponsive after a timeout.

### LOC budget impact

Items 2-4 above add roughly one more table, ~2 internal routes, and a clone/bootstrap helper not
previously budgeted in §7. Estimated addition: **+80-120 LOC** (prompts table + queries ~30, internal
queue/ack routes ~25, clone/bootstrap helper ~40-60). Revised total: **~630-770 LOC**, still
comfortably under the 1000 LOC ceiling, but this is called out explicitly so the budget isn't silently
exceeded during implementation.

### Revised minimal completion order (supersedes §9 ordering where it conflicts)

1. Fix network membership (control plane on both networks) + internal auth token for bridge calls.
2. Add `prompts` table + internal queue/ack routes; move stop onto the same command path.
3. Add repo/config clone-and-bootstrap step before `docker run` (new §9 step 0).
4. Persist/restore `ocSessionId` in the named volume in `bridge.js`.
5. Add `GET /api/models` (static allowlist) and `GET /api/sessions/:id/artifacts` (diff projection)
   and `GET /api/sessions/:id/sandbox/diagnostics` (docker inspect/logs, mirroring `sandbox/logs`).
6. End-to-end test (extends §9 step 11): create → clone → bridge connects to control plane → prompt
   queued → OpenCode SSE → event replay/WS → stop via abort → idle exit → restart → same OpenCode
   session id → artifact retrieval.

Full audit evidence, line-by-line citations, and the endpoint matrix:
`.agents/sw/research/2026-08-11-endpoint-architecture-coverage.md`.

## 13. Round 7 (Aug 2026): adversarial review of §12 — retractions, new gaps, corrected budget

An adversarial sub-agent independently re-derived the endpoint count and re-checked every §12 claim
and citation against the rest of this document. Verdict: §12's diagnosis was directionally right on
4 of its 5 gaps, but contained one fabricated citation, systematically under-priced its own fixes,
and missed further blocking gaps of the same severity class. **This supersedes §12 where they
conflict; §12 is not retracted, only corrected.**

### Retractions (§12 claims that do not hold up)

- **The `GET /session/:id/diff` citation is fabricated.** §12's artifacts fix (original text: "a
  projection of OpenCode's own `GET /session/:id/diff` (confirmed real, §11)") cites §11 as having
  confirmed this endpoint. §11 (lines ~600-652 above) confirms `abort`, `DELETE /session/:id`,
  `GET /session/status`, `GET /global/health`, and `POST /session/:id/message` — **it never mentions a
  `GET /session/:id/diff` REST route.** The only real evidence anywhere in this document for
  session-diff data is the `session.diff` **SSE event** captured in round 3 (§2, "Verified live
  (round 3)"), which is a push notification, not a queryable REST resource. **Correction:** before
  implementing `GET /api/sessions/:id/artifacts`, verify against a live `opencode serve --port N`
  instance's `/doc` OpenAPI spec whether a diff-fetching REST route exists at all. If it doesn't, the
  control plane must instead derive artifacts by having the bridge accumulate `session.diff` SSE
  events into its own relay state (real new code, not "zero new sandbox-side code" as §12 claimed).
- **The webhook delivery-ID dedup logic does not exist despite being asserted as already handled.**
  §6a states: "`X-GitHub-Delivery` (dedup GUID, already used by this plan's dedupe logic)" — but no
  `deliveries` table, schema field, or dedup route logic is defined anywhere in this document. This is
  a second fabricated cross-reference of the same kind as the diff-endpoint one above. **Correction:**
  add a `deliveries` table (`delivery_id PRIMARY KEY, received_at`) and a dedup check in `webhook.js`
  before any session-spawn logic runs, returning `200 { status: "duplicate" }` per the source doc's
  own contract (`ai-coding-agent-doc.md:282`). Budget: +15-20 LOC, previously uncounted.

### Confirmed correct from §12 (unchanged)

Endpoint recount (13 service endpoints), and gaps 1 (network unreachability), 2 (queue/ack schema),
3 (OpenCode conversation continuity), and 5 (stop bypassing durable command path) all hold up under
independent re-derivation and are retained as-is.

### New gaps §12 missed

6. **`wsToken` rotation is unimplemented.** The source doc requires `GET /api/sessions/:id` to rotate
   and return a fresh `wsToken` (`ai-coding-agent-doc.md:97`), and the entire `4001`-disconnect recovery
   flow depends on this (`ai-coding-agent-doc.md:118, 145, 373-375`). Nothing in §4's route description
   (line ~242 above) or anywhere else in this document implements rotation or invalidation of the prior
   token — the only `wsToken` behavior specified is issuing it once at `POST /api/sessions`. **Fix:**
   `GET /api/sessions/:id` must generate a new `wsToken`, persist it (invalidating the previous one),
   and return it in the response body; the WS `subscribe` handler must accept only the current token.
   Budget: +10-20 LOC.
7. **No design for `session_continued` predecessor-subscriber broadcast, and an unresolved contradiction
   with gap 3's fix.** The source doc requires *both* the new session's subscribers and the *old
   (predecessor)* session's already-connected subscribers to receive `session_continued`
   (`ai-coding-agent-doc.md:186-196`). This requires the WS layer to maintain a live subscriber registry
   keyed by session id, including registry entries for a session id that has since been superseded —
   nothing of the kind is described anywhere in this plan. Worse, §12's gap-3 fix ("persist/restore
   `ocSessionId`... do not create a successor control-plane session merely because the container
   restarted") is in direct tension with this requirement: if continuation no longer creates a new
   control-plane session row, there is no "predecessor" session id left to broadcast to, and the
   doc's `session_continued`/`predecessorSessionId`/`successorSessionId` semantics become vestigial.
   **This must be resolved as a design decision, not left ambiguous:** either (a) continuation always
   creates a new control-plane session row with `predecessorSessionId` set (matching the doc's model)
   while *also* restoring the same `ocSessionId` inside it (satisfying gap 3), or (b) explicitly declare
   that this plan's continuation model collapses predecessor/successor into a single unchanging session
   id and drop `session_continued`/successor tracking as an intentional, documented deviation from the
   source doc. Option (a) is the smaller change given §4 already lists a `continuation` object; adopt it.
   Budget: +20-30 LOC (subscriber registry keyed by session id, broadcast fan-out on continuation).
8. **Reaper has no guard against removing an actively-running session's volume/container.** The
   reaper (`docker-thin-cp-research.md:117-128`) force-removes any session whose `last_active_at`
   exceeds 7 days with no check of current container/attempt status. Because the reaper runs hourly
   while `last_active_at` only advances on accepted prompts, a session with a very long single
   in-flight turn combined with any clock/scheduling skew has no explicit protection — the "only one
   attempt is ever active per session" invariant (`ai-coding-agent-doc.md:201`) is about concurrency
   control, not expiry safety. **Fix:** reaper must skip any session whose current attempt status is
   `pending`/`starting`/`running` (per the same DB row the invariant already tracks), regardless of
   `last_active_at` age. Budget: +5-10 LOC (one extra `WHERE` clause), but called out because it was
   entirely unaddressed, not because it's expensive.

### Internal consistency now flagged as stale (not yet fixed)

§5 states "no custom config-merging code is required — we just set these env vars" (§5, opening
paragraph). §12's gap-4 fix requires the control plane to clone, sparse-checkout, SHA-pin, and mount
three separate trees (target repo, platform config, team config) before spawn — this is unavoidably
new code, even though it isn't config *merging* (opencode still does that natively). §5's framing is
misleading as written and should be amended to read: "no custom config-*merging* logic is required
(opencode resolves layer precedence natively) — but cloning, sparse-checking-out, SHA-pinning, and
mounting the three source trees onto the right paths is new control-plane code, budgeted separately
under the clone/bootstrap helper (§12 gap 4, repriced below)." §8 (network topology YAML) and §9
(implementation order) still reflect the pre-§12 design and are superseded by §12's "revised minimal
completion order" — both should be edited in place during implementation rather than left as two
parallel, partially-conflicting orderings in the same document.

### Corrected LOC budget

§12's own delta (+80-120 LOC) only priced items 2-4 of its 5 gaps, leaving items 1 (network + internal
auth token) and 5 (stop-via-abort bridge logic) unbudgeted, and under-priced item 4's clone/bootstrap
helper by roughly 2-3x against the source doc's own 5-branch failure-mode table
(`ai-coding-agent-doc.md:340-346`) plus SHA-pinning plus dual-repo sparse-checkout plus target-repo
branch selection (PR head branch vs. default branch, `ai-coding-agent-doc.md:265-267` — never mentioned
as separate work in §12's fix).

| Addition | §12 estimate | Corrected estimate |
|---|---|---|
| Prompts table + queries (gap 2) | ~30 | 30 |
| Internal queue/ack routes (gap 2) | ~25 | 25 |
| Internal auth token: mint, env-inject, verify middleware (gap 1) | 0 (unbudgeted) | 20-40 |
| Stop-via-abort bridge logic + timeout fallback (gap 5) | 0 (unbudgeted) | 15-25 |
| Clone/bootstrap helper: 5 failure modes, SHA-pin, dual sparse-checkout, target-repo branch selection (gap 4) | 40-60 | 100-150 |
| Webhook delivery-ID dedup table + check (new gap, retraction above) | 0 (falsely assumed done) | 15-20 |
| `wsToken` rotation logic (new gap 6) | 0 (not identified) | 10-20 |
| WS subscriber registry + predecessor broadcast fan-out (new gap 7) | 0 (not identified) | 20-30 |
| Reaper active-session guard (new gap 8) | 0 (not identified) | 5-10 |
| **Total addition** | **80-120** | **235-350** |

Starting from §7's original ~550-650 LOC baseline: **corrected realistic total ≈ 785-1000 LOC**,
sitting at or above the plan's own stated <1000 LOC ceiling (§1) once every real functional-chain gap
identified across §12 and this section is actually fixed — not "comfortably under 1000" as both §12
and the original research doc (`docker-thin-cp-research.md:142`) claimed. This does not yet include
normal implementation overrun (error handling, retries, tests) that line-count estimates never fully
capture. **The <1000 LOC constraint should be treated as at-risk, not settled, going into
implementation** — track actual LOC per component against this table as each piece is built, and be
prepared to cut scope (e.g., drop artifacts or diagnostics endpoints, §12's declared-optional items)
if the budget is exceeded, rather than silently ship an over-budget system without revisiting §1's
premise.

### Revised readiness verdict

**Not yet implementation-ready as a single unbroken pass.** Before coding starts, resolve: (1) the two
fabricated citations above (verify or replace), (2) the predecessor-session-row design ambiguity (gap
7) — this is a genuine fork in the data model, not a wording fix, and must be decided before `db.js`'s
schema is written, (3) add the three new gaps (6, 7, 8) to the implementation-order and budget, and
(4) edit §5, §8, and §9 in place to match §12/§13's fixes instead of leaving superseded text alongside
corrected text. Once those four items are resolved, this document (§1-§13 read as a whole, later
sections superseding earlier ones on conflict) is a sufficient basis to start implementation.

## 14. Round 8 (Aug 2026): open-topic resolution — live verification + design closure

Three parallel research passes closed all four blocking items from §13's readiness verdict: one
empirically re-verified the retracted diff-endpoint citation against a live local `opencode serve`
instance (v1.18.16, actually installed at `/home/tom/.opencode/bin/opencode` on this machine), one
resolved the `wsToken` rotation and predecessor-broadcast designs against real `@fastify/websocket`
v11.x docs, and one empirically tested git's error-classification behavior against real github.com
to close the clone/bootstrap failure-mode design. All four items are now resolved.

### 14.1 Correction to §13's retraction: `GET /session/:id/diff` is real

§13 retracted §12's citation of `GET /session/:id/diff` as unverified. **That retraction was
itself too strong — the endpoint does exist**, confirmed by starting a real `opencode serve --port
4599` locally, fetching its live OpenAPI 3.1 spec from `/doc`, and calling the endpoint against a
real session:

```
$ curl -X POST http://127.0.0.1:4599/session -d '{}'
{"id":"ses_00d910f2dffeqb4v3x2GXjv7SL", ...}

$ curl http://127.0.0.1:4599/session/ses_00d910f2dffeqb4v3x2GXjv7SL/diff
[]
HTTP:200
```

OpenAPI spec confirms `operationId: "session.diff"`, response schema `SnapshotFileDiff[]` —
`{ file, patch, additions, deletions, status: "added"|"deleted"|"modified" }`. Also independently
confirmed on the live docs page `https://opencode.ai/docs/server/`, Sessions table: `GET
/session/:id/diff` → query `messageID?` → `FileDiff[]`.

**Corrected artifacts implementation:** `GET /api/sessions/:id/artifacts` is a thin 1:1 field-mapping
proxy to `GET /session/{ocSessionId}/diff` (optionally filtered by `messageID`) — no custom diffing,
no git shelling in the bridge, no message-part reconstruction. This restores §12's original "zero new
sandbox-side code" claim for this one item (it was correct after all) and removes it from the
corrected LOC-addition table in §13 (net **-10 to -15 LOC** vs. the reconstruct-from-messages fallback
§13 implied might be needed).

The other §13 retraction — the webhook delivery-ID dedup logic being falsely asserted as
already-implemented — was **not** re-examined by this round and stands as correctly retracted; it
still needs the `deliveries` table + dedup check as §13 specified.

### 14.2 wsToken rotation: resolved — 2-token sliding window, no new table

Confirmed race condition is real: `GET /api/sessions/:id` rotating the token on every call
(`ai-coding-agent-doc.md:97`) can invalidate a token a concurrently-open WS client is about to use for
`subscribe`, causing a spurious `4001`. **Resolution:** add two columns to `sessions` (no new table —
full token history was considered and rejected as unnecessary state for a single-tenant/no-HA system):

```sql
ALTER TABLE sessions ADD COLUMN ws_token_prev TEXT;
ALTER TABLE sessions ADD COLUMN ws_token_prev_expires_at INTEGER; -- epoch ms, 30s grace window
```

`GET /api/sessions/:id` still rotates unconditionally on every call (matching the doc's literal
behavior — no "only rotate if idle" heuristic, which would silently change the doc's contract for no
real benefit): it moves the current `ws_token` into `ws_token_prev` with a 30-second expiry, then
issues a fresh `ws_token`. The `subscribe` handler accepts either the current token or a still-valid
`ws_token_prev`; anything else closes `4001` per the doc's contract. **LOC: ~15-20**, confirming §13's
own estimate for this gap.

### 14.3 Predecessor-subscriber broadcast: resolved — in-memory `Map<sessionId, Set<socket>>`

Confirmed via fresh `@fastify/websocket` v11.x docs that the handler signature is `(socket, request)`
with `socket` as the raw `ws` instance (no `connection.socket` wrapper — matches this document's own
§6a finding) and that the library has no built-in per-topic pub/sub; broadcast must be done via a
self-maintained registry, which is exactly what's needed here regardless.

**Resolution:** a module-level `Map<sessionId, Set<WebSocket>>` in `server.js`, populated on
`subscribe` and cleaned up on socket `close`. This directly satisfies the doc's requirement that a
predecessor session's already-open sockets receive `session_continued` without resubscribing — they
remain registered under the predecessor's session id, and `broadcastToSession(predecessorId, msg)`
reaches them directly. No Redis/pub-sub needed, consistent with this plan's single-process,
single-host constraint (§2, §11 round 4). This also confirms §13 gap 7's data-model resolution
(continuation always creates a new session row with `predecessorSessionId` set) is the right choice:
it's exactly what gives the broadcast a valid predecessor session id to key on. **LOC: ~20-30**,
confirming §13's own estimate.

### 14.4 Clone/bootstrap failure-mode classification: resolved — stderr pattern matching, not exit codes

Empirically tested against real `github.com` (git 2.43.0): **exit code is always 128 for every
failure case** (repo doesn't exist, org doesn't exist, bad token, unauthenticated access to an
existing-but-private repo, unresolvable host, connection timeout) — exit code alone cannot
distinguish "doesn't exist" from "unreachable" from "auth failure" as §12's fix assumed was
straightforward. Differentiation requires **stderr text pattern-matching**:

| Pattern | Classification | Doc-mandated behavior |
|---|---|---|
| `/repository .* not found/i` | not_found (also covers unauthenticated access to a real private repo — GitHub deliberately makes these indistinguishable) | silent skip (team layer only) |
| `/authentication failed\|invalid username or token/i` | auth | hard failure |
| `/could not resolve host\|failed to connect\|couldn't connect to server\|timed out/i` | network | hard failure |
| anything else | unknown | hard failure (fail-closed default) |

**Important caveat, not paperable over:** GitHub returns byte-identical `Repository not found` text
and exit code for a genuinely nonexistent repo and an existing-but-inaccessible private repo — this
ambiguity is by GitHub's own design (anti-enumeration) and cannot be resolved client-side. The doc's
"team repo doesn't exist → silent skip" behavior (`ai-coding-agent-doc.md:343`) implicitly relies on
this resolving safely because the token used should already be scoped to have access via
`readOrgRepos`/`additionalRepos` — matching the doc's own troubleshooting note
(`ai-coding-agent-doc.md:385-387`) that a scope mismatch silently looks like "doesn't exist."

**Confirmed minimal git command sequence per requirement:**
1. Target repo (branch selection): `git ls-remote <url> refs/pull/<N>/head` (PR) or `HEAD` (default
   branch, issue-triggered) to resolve a SHA, hard-fail on any classified error.
2. Platform config: same resolve-then-clone pattern, wholesale (`sparsePaths=null`), any error
   (including `not_found`) is a hard failure per the doc's table.
3. Team config: same resolve step, but only `not_found` is a silent skip; `git sparse-checkout init
   --cone` + `git sparse-checkout set .opencode` for the sparse subtree.
4. SHA-pin: resolve every ref to a SHA via `ls-remote` once at bootstrap start (all three repos
   resolved up front), then `git fetch --depth 1 origin <sha>` + `git checkout <sha>` — never a
   branch-name checkout, closing the concurrent-push race the doc requires (`ai-coding-agent-doc.md:348`).
5. Before the cloned directory is bind-mounted into the sandbox: `git remote set-url origin
   <url-without-credential>` strips the embedded token from `.git/config`, preserving the "sandbox
   never holds a secret" property even for the config/repo bind mounts, not just the model-gateway/GitHub
   API proxy path.

**Corrected LOC: ~95** for the full 3-repo, SHA-pinned, dual-failure-mode `bootstrap.js` helper — within
§13's corrected 100-150 LOC bucket (rounds down slightly once actually sketched), and confirms §13's
correction of §12's original 40-60 LOC estimate was necessary, not excessive.

### 14.5 Updated LOC budget

Net changes from this round: artifacts endpoint drops back to near-zero incremental cost (14.1,
-10 to -15 LOC vs. §13's contingency), clone/bootstrap settles at ~95 LOC (within §13's range, no
change to the bucket), wsToken and predecessor-broadcast both land at the low end of §13's estimates
(~15-20 and ~20-30 respectively, no change to the bucket). **Revised realistic total: ~770-985 LOC** —
essentially unchanged from §13's ~785-1000 LOC, still at-risk against the <1000 LOC ceiling but not
worse. The <1000 LOC constraint remains a live tracking concern for implementation, not a resolved one.

### 14.6 Updated readiness verdict

All four blocking items from §13's verdict are now resolved: (1) both fabricated-citation concerns are
addressed — the diff endpoint citation is confirmed real (14.1) and the webhook-dedup citation remains
correctly retracted with a concrete fix already specified in §13, (2) the predecessor-session data-model
fork is resolved and independently re-confirmed as the right choice by the broadcast design (14.3),
(3) all three new gaps (6, 7, 8) now have concrete, sized, cited implementations (14.2, 14.3, and §13's
existing 5-10 LOC reaper guard, unchanged), (4) §5/§8/§9 have now been edited in place (this round) to
match the accumulated fixes: §4's route table gained the internal-routes note plus `diagnostics`/
`models`/`artifacts`, §5's framing was narrowed to "no custom config-*merging* logic", §6's bridge
pseudocode now persists/restores `ocSessionId` and routes through `/internal/*` with the per-session
token, §8's Compose sketch attaches the control plane to both networks, and §9's implementation order
now starts with the bootstrap step and threads every §12/§13/§14 fix through to the final end-to-end
test. **Verdict (retracted by §15.1 — see below): "design-complete for the four items §13 flagged;
this was not a general completeness claim."** Five further gaps were found in a second adversarial
round (§15) — see §15 for the corrected verdict.

## 15. Round 9 (Aug 2026): second adversarial pass — three fresh context-less reviewers

Three independent, context-less agents were spawned: one adversarially cross-checked every route/
message-type in `ai-coding-agent-doc.md` against this document with zero prior context (not trusting
any of this document's own "resolved" claims), and two others drew architecture diagrams from scratch
— one from `ai-coding-agent-doc.md` alone, one from this document's final (post-§14) state alone. The
diagrams converged structurally (same entry points, same secret-custody partition, same continuation/
broadcast sub-flows), which is a positive signal for this document's internal readability — but the
adversarial pass found real gaps that survived eight prior audit rounds. **§14.6's "design-complete and
implementation-ready" verdict is retracted as overstated; it was true only for the four specific items
§13 had flagged, not as a general completeness claim.**

### 15.1 Retraction: §14.6 overstated completeness

§14.6 (previous section) is corrected: replace "**Verdict: design-complete and implementation-ready.**
No open mechanical or research items remain" with **"design-complete for the four items §13 flagged;
five further gaps identified in §15 below still require closure before implementation starts."**

### 15.2 Two WebSocket message types were dropped since §1 and never once acknowledged

Grep-verified: `presence` and `fetch_history` (`ai-coding-agent-doc.md:139-140`) have **zero**
mentions anywhere in this document. Unlike `/oauth2/token` or the dashboard routes — both explicitly
declared out of scope with a rationale — these two were silently absent from §1's very first "kept
as-is" inventory (`INITIAL.md:48`, which lists only `subscribe`/`prompt`/`ping`/`stop`) and never
resurfaced in either "endpoint-coverage audit" (§12, §13), despite both purporting to be exhaustive.

**Resolution — add both, minimally:**
- `presence`: client reports viewing state (`{ type: "presence", state: "viewing"|"away" }`). The
  bridge/control-plane need no new persistence for this — it only affects in-memory UI/telemetry
  state, not session/prompt logic. **Minimal fix:** the `subscribe` handler's socket record (used for
  the §14.3 subscriber registry) gains a `presence` field, updated in place on receipt; no broadcast
  is required unless a future dashboard wants to show "who's viewing" (out of scope, per §1's
  dashboard-less deviation — so this message type can be accepted and stored but is a no-op until/
  unless a dashboard exists). **LOC: ~5.**
- `fetch_history`: client requests additional past events beyond the initial replay
  (`ai-coding-agent-doc.md:140`). This is **not** a no-op — it's a real read against the `events`
  table already defined in §9 step 1, using the same cursor format (`timestamp,id`) as
  `GET /api/sessions/:id/events` (§4). **Minimal fix:** `fetch_history` reuses the exact same
  cursor-paginated query the REST `events` route already has — `{ type: "fetch_history", cursor }` →
  server replies with a batch of `{ type: "event", ...payload }` messages plus a
  `{ type: "history_complete" }` sentinel, mirroring the existing `replay_complete` pattern
  (`ai-coding-agent-doc.md:126`). No new table, no new query — just a WS-message wrapper around the
  same `db.js` query function used by the REST route. **LOC: ~15-20** (message dispatch + reuse of
  existing query).

Both message types are now added to §4's WS route description and §9's WS-handler implementation
step (step 7): `subscribe`/`prompt`/`ping`/`presence`/`fetch_history`/`stop` — the full six-message set
from the source doc, not four.

### 15.3 Continuation data model: schema and trigger, now made concrete (was asserted, not specified)

§13 gap 7 decided continuation must create a new control-plane session row with `predecessorSessionId`
set; §14.3 built the broadcast mechanism assuming such a row exists — but no schema columns or trigger
logic were ever written down. This is the same "asserted as already handled" failure §13 caught in
§12, recurring uncaught one round later. Closing it now, concretely:

**Schema addition to `sessions` (§9 step 1):** `predecessor_id TEXT`, `successor_id TEXT`,
`continuation_reason TEXT`, `current_attempt INTEGER DEFAULT 1`, `workspace_expires_at INTEGER`
(sliding 7-day window, updated on every accepted prompt per `ai-coding-agent-doc.md:149`).

**Trigger logic (the concrete answer to "when does a new row get created"):** lives in the handler
shared by `POST /api/sessions/:id/prompt` and the WS `prompt` message (§4) — both paths must call one
function before enqueuing:

```js
async function resolveActiveSession(session) {
  const status = await sandbox.inspect(session.containerName) // §9 step 4 helper
  if (status.exists && ['running', 'starting'].includes(status.state)) return session // no continuation needed
  if (Date.now() > session.workspace_expires_at) {
    return spawnContinuation(session, 'workspace_expired')
  }
  if (!status.exists) {
    return spawnContinuation(session, 'workspace_missing') // volume present, container gone — idle-exit case, the common path
  }
  return spawnContinuation(session, 'workspace_corrupt') // container exists but in a failed/errored state
}

function spawnContinuation(oldSession, reason) {
  const successor = db.insertSession({
    ...oldSession, id: newId(), predecessor_id: oldSession.id, current_attempt: oldSession.current_attempt + 1,
  })
  db.updateSession(oldSession.id, { successor_id: successor.id, continuation_reason: reason })
  sandbox.run(successor) // docker run against the SAME named volume as oldSession (§7 research doc)
  broadcastToSession(oldSession.id, { type: 'session_continued', sessionId: successor.id, predecessorSessionId: oldSession.id, reason })
  broadcastToSession(successor.id, { type: 'session_continued', sessionId: successor.id, predecessorSessionId: oldSession.id, reason })
  return successor
}
```

This directly maps the source doc's 4-value `continuationReason` enum
(`workspace_expired|workspace_missing|workspace_corrupt|workspace_origin_mismatch`,
`ai-coding-agent-doc.md:180`) onto concrete conditions (`workspace_origin_mismatch` is not reachable in
this plan since there's no org-wide repo-access model to mismatch against — omit it from the enum,
document as a declared, permanent deviation, not a gap). **LOC: ~35-45** (schema columns ~5, trigger
function ~30-40).

### 15.4 Webhook 10-second-ACK vs. synchronous bootstrap: resolved with a background-job split

§6a requires GitHub's webhook handler to ACK within 10 seconds and do slow work (spawning the
container) asynchronously; §9 currently routes `issue_comment` straight into the same synchronous
`bootstrap.js` flow (SHA-pinned clone of up to 3 repos) used by `POST /api/sessions` — a real,
previously-unreconciled contradiction across three separate webhook-focused verification passes.

**Resolution — minimal async split, no job-queue library needed:** `webhook.js` inserts a row into
the existing `sessions` table with `status: 'pending_bootstrap'` and returns `200`/`202` immediately
(within GitHub's 10s window — an INSERT is sub-millisecond), then calls `bootstrapWorkspace(session)`
and `sandbox.run(session)` via `setImmediate(...)` (or `process.nextTick`, already how Node schedules
deferred work — no new dependency) so the actual clone/spawn happens *after* the HTTP response is
sent, not before. `GET /api/sessions/:id` and the WS `subscribe` flow already tolerate a session
existing before its container does (this is exactly the `pending`/`starting`/`running` attempt-status
model §13 gap 8's reaper guard already relies on) — no new state machine, just reusing states this
plan's own reaper section already assumes exist. **This same split should also apply to
`POST /api/sessions` itself for consistency** (the source doc's own quickstart doesn't require the
create-session call to block on the full clone either — `ai-coding-agent-doc.md:73` describes a `201`
response with the session + `wsToken`, not a description of clone latency) — one code path, both
callers. **LOC: ~10-15** (status field already added in 15.3, plus `setImmediate` wiring at the two
call sites).

### 15.5 Model-selection path conflict: resolved — non-negotiable layer sets model, per-prompt override is the source doc's own documented exception

Re-reading the source doc precisely: `POST /api/sessions/:id/prompt` and the WS `prompt` message both
explicitly document an optional per-prompt `model?` field (`ai-coding-agent-doc.md:108, 114, 137`) that
overrides the session's default — this is not a bug INITIAL.md introduced, it's a real feature of the
source contract that §5/§6 simply never connected to each other. **Resolution:** §5's
`OPENCODE_CONFIG_CONTENT.model` sets the *session default* (used when a prompt omits `model`); the
bridge's `splitModel(c.model)` in the `prompt_async` call (§6) is what actually reaches
`opencode serve` per-turn — and since `prompt_async`'s own `model` field is passed at the *message*
level, not the config level, it naturally overrides the config-layer default for that one call without
needing the config-layer precedence rules (§5's precedence table) to be re-litigated at all: OpenCode's
config precedence governs what `opencode.json`/env vars resolve to as a *default*, while an explicit
per-call `model` argument to `prompt_async` is a per-request parameter, not a config value, so §5's
"non-negotiable layer" claim is about config resolution and was never actually in tension with a
per-message override — this was a documentation gap (the two paths were never connected in prose), not
a design defect. **Fix is purely editorial:** add one sentence to §5 clarifying that
`OPENCODE_CONFIG_CONTENT.model` is the *session-level default*, and the doc's own per-prompt `model?`
field (already in §4's route table implicitly via "same shapes" — now made explicit) is a per-call
override passed straight through by the bridge, not a config layer. **LOC: 0** (documentation-only;
`prompts` table (§9 step 1) already has a `model` column per §12 gap 2's original schema, which already
supports per-prompt overrides with no additional code). **See also** §5's note on `small_model` and
per-agent overrides — both are further model-selection surfaces that also require zero new code,
riding on the same config-layer precedence rather than the per-message path described here.

### 15.6 Webhook trust/prompt-construction rules: reproduced concretely, closing the last hand-waved reference

§4 previously said the webhook route has "same trust/prompt-construction rules as doc" with no further
detail — the only place in this 1000+ line document using pointer-reference instead of concrete
reproduction. Closing that gap:

**Trust check** (`ai-coding-agent-doc.md:255-263`): `webhook.js` must read
`payload.comment.author_association` (not `payload.issue.author_association` — confirmed distinct
fields, §6a) and only proceed if its value is exactly `OWNER`, `MEMBER`, or `COLLABORATOR`; anything
else (`CONTRIBUTOR`, `NONE`, etc.) returns `200 { status: "ignored" }` per the doc's own failure-mode
table (`ai-coding-agent-doc.md:281`).

**Prompt construction** (`ai-coding-agent-doc.md:224-253`), as an explicit branch in `webhook.js`:
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
      `PR title: ${payload.issue.title}\n` +
      `PR description: ${payload.issue.body}\n` +
      `PR url: ${payload.issue.pull_request.html_url}\n` +
      `PR dif url: ${payload.issue.pull_request.diff_url}`
  }
  return `Issue #${payload.issue.number} (${payload.issue.title}): ${bodyWithoutMention}`
}
```
Branch selection (`ai-coding-agent-doc.md:265-267`): PR comment → `bootstrapWorkspace` uses
`refs/pull/<N>/head` (already specified in §14.4); issue comment → default branch (`HEAD`, also
already in §14.4). **LOC: ~20-25** (trust check ~5, prompt builder ~20) — previously entirely
unbudgeted since the whole mechanism was pointer-referenced rather than sized.

### 15.7 `GET /api/models` scope narrowing: now an explicit, declared deviation

§14.1's implementation note that `/api/models` returns "the two hardcoded opencode/... model IDs this
thin deployment actually supports" is a real behavior reduction vs. the source doc's implied
open-ended provider catalog (`ai-coding-agent-doc.md:102`) that was never listed in §1's simplification
table. **Resolution:** add to §1's table: "Open-ended `GET /models` provider catalog | Static
allowlist of pre-approved `provider/model` strings in `config.js`, env-configurable | No multi-provider
catalog requirement — this deployment only ever talks to one model gateway endpoint with a small, operator-
curated model list." No code change, documentation-only. **LOC: 0.**

### 15.8 Updated LOC budget

| Addition | LOC |
|---|---|
| `presence` + `fetch_history` WS messages (15.2) | 20-25 |
| Continuation schema + trigger logic (15.3) | 35-45 |
| Async webhook/session-spawn split (15.4) | 10-15 |
| Model-selection clarification (15.5) | 0 |
| Webhook trust check + prompt builder (15.6) | 20-25 |
| `/api/models` scope note (15.7) | 0 |
| **Total addition** | **85-110** |

Starting from §14.5's ~770-985 LOC: **revised realistic total ≈ 855-1095 LOC** — this now plausibly
**exceeds** the plan's own <1000 LOC ceiling (§1) at the high end. This is the most important
practical consequence of this round: the budget can no longer be called "at-risk but comfortable" —
it must be actively managed. **Recommended scope cuts if the ceiling is hit during implementation, in
priority order** (least damaging to the core UX first): drop `GET /api/sessions/:id/sandbox/diagnostics`
(§4, redundant with `sandbox/logs`), drop `presence` handling beyond accept-and-ignore (15.2 already
describes it as a no-op absent a dashboard), narrow `fetch_history` to a fixed-size single batch
instead of full pagination. Do **not** cut the continuation schema/trigger (15.3) or the webhook async
split (15.4) — both are correctness fixes for already-declared-in-scope behavior, not optional
features.

### 15.9 Updated readiness verdict

**Superseded by §16 — see below.** §15.9 originally read "design-complete... LOC budget now flagged as
actively at-risk rather than comfortable." A colleague review found a genuine architectural
simplification (§16.1) that recovers most of that budget risk without cutting any declared
requirement — read §16 for the corrected budget and verdict.

## 16. Round 10 (Aug 2026): colleague review — synchronous proxy replaces poll/queue/ack, LOC-scope boundaries formalized

An external colleague review (not a subagent — human review of the §14 diagram) pushed back on the
accumulated design as "closer to a real production system than an ultra-thin PoC." Most of that
pushback separated into two categories on inspection: **one real architectural flaw** (the bridge
polling the control plane was never necessary once the control plane sat on `sandbox-net`, §12's own
fix), and **several items that looked like bloat but are actually restatements of already-declared
requirements** (continuation metadata, webhook trust/prompt rules, wsToken rotation — the source doc's
own contract, not scope creep this plan invented). This round adopts the real fix, keeps the genuine
requirements, and formalizes the LOC-accounting boundary the review correctly identified as previously
undefined. **The <1000 LOC total ceiling from §1 is retained as the single binding number** — no new,
stricter, or component-specific ceiling is introduced; a suggested ≤500-for-control-plane-alone
sub-target discussed during review is explicitly not adopted as a hard requirement, since achieving it
would require cutting an actual declared requirement (e.g. continuation or webhook trust rules) rather
than incidental complexity, and no such cut was requested.

### 16.1 Architectural change: synchronous control-plane→bridge proxy replaces poll/queue/ack

**This is the single most valuable correction found across all ten rounds of review.** Previously
(§12 gap 2, carried through §14/§15), the bridge polled `GET /internal/sessions/:id/queue` every 2
seconds and posted to `/internal/sessions/:id/ack`, backed by a `prompts` table recording queued/
claimed/acknowledged state. This was never architecturally necessary: once the control plane is
attached to `sandbox-net` (§8, the fix for §12 gap 1), it can reach the bridge directly — so the
control plane should **call the bridge**, not wait for the bridge to call it. `POST /api/sessions/:id/
prompt` and `POST /api/sessions/:id/stop` become synchronous proxy calls straight into the bridge's own
small HTTP server (§6). This removes: the `prompts` table, `/internal/sessions/:id/queue`,
`/internal/sessions/:id/ack`, the idempotent-ack bookkeeping, and the bridge's 2-second poll loop.
**Net: ~-55 to -70 LOC** versus §15.8's budget.

**The one trade-off this introduces, stated explicitly rather than hand-waved:** the poll model was
naturally resilient to spawn-order races (the bridge picks up work whenever it's ready); the sync model
requires the control plane to avoid calling a bridge that isn't listening yet. This is cheap to close
because the healthcheck primitive already exists in this document (`GET /global/health`, §11): the
control plane waits for the container's Docker healthcheck to pass before making its first sync call,
and retries with backoff on connection-refused. **~+10 LOC**, not a new subsystem — net simplification
still stands.

**What did NOT change:** the OpenCode event relay (bridge → `POST /internal/sessions/:id/events` on the
control plane) was always a push, never had a poll/ack problem, and is unchanged by this round. Only
the *prompt/stop delivery* direction needed fixing — the fix is smaller than it first looks because
half the pipe was already built correctly.

`stop` specifically: the control plane calls the bridge's `POST /stop` directly; the bridge calls
OpenCode's native `abort` (§12 gap 5, unchanged); the control plane falls back to `docker stop` only on
a timeout waiting for the bridge's response — same fallback semantics as §12 gap 5's original fix, just
reached via a direct call instead of a queued command.

### 16.2 What stays, and why it isn't bloat (the review's imprecision, corrected)

The review's list of "accumulated control-plane behavior" conflated genuine requirements with
incidental complexity. Restated precisely, per item:

| Item | Verdict | Reasoning |
|---|---|---|
| Continuation schema (predecessor/successor/reason/attempt, §15.3) | **Keep** | Orchestration metadata, not conversation-state duplication — the review's own suggested minimal schema keeps the equivalent fields (`sandbox_id`, `opencode_session_id`, `workspace_path`) under different names. Not double-bookkeeping OpenCode's own state; it's the control plane's own attempt-lineage record, which OpenCode has no concept of. |
| Minimal `events` table (§16.1 — now decoupled from delivery, no queue/ack coupling) | **Keep, but only this much** | Needed for `GET /api/sessions/:id/events` cursor semantics and WS reconnect replay — both explicit source-doc contract items, not invented scope. Shrunk from its §15 form since it no longer carries any delivery-state responsibility. |
| `wsToken` 2-token rotation (§14.2) | **Keep** | ~15-20 LOC fixing a real disconnect-storm bug in the doc's own contract (`GET /api/sessions/:id` "rotates... every call"), not new scope. |
| Subscriber registry + `session_continued` broadcast (§14.3) | **Keep** | Required for the doc's predecessor-notification behavior; a `Map<sessionId,Set<socket>>` is close to the cheapest possible implementation of a real requirement. |
| Webhook trust check + prompt builder + async 202 split (§15.4, §15.6) | **Keep** | This *is* the webhook feature the source doc specifies, not an add-on to it. |
| Reaper active-session guard (§13 gap 8) | **Keep** | One `WHERE` clause preventing data loss on an already-planned component. |
| `OPENCODE_CONFIG_CONTENT` (§5) | **Keep, justification narrowed** | Not "the control plane understands OpenCode's config schema" — it's the one non-negotiable fact (provider `baseURL` → proxy) that must survive team/repo override, and round-3 research (§5) empirically confirmed it's the only layer that reliably does. It has never contained agent/tool/skill config — only `model`/`autoupdate`/`provider`, already narrow. Reframed: *the control plane owns only provider-routing enforcement, expressed as the minimal non-negotiable layer; it does not own the broader OpenCode config schema (agents, tools, skills, models catalog), which remain platform/team/repo-owned files.* |
| `prompts` table + `/internal/queue`/`/internal/ack` | **Removed** | §16.1 — this was the one genuine flaw. |
| `GET /api/sessions/:id/sandbox/diagnostics` | **First cut candidate** | Redundant with `sandbox/logs`; unchanged from §15.8's own prioritization — not moved, just re-confirmed. |
| `presence`/`fetch_history` beyond minimal handling | **Second/third cut candidates** | Unchanged from §15.8 — `presence` stays a no-op absent a dashboard, `fetch_history` can shrink to a single fixed-size batch if budget pressure requires it. |
| Per-session `INTERNAL_TOKEN` | **Already correct, no change** | The review suggested this as an improvement; it was already specified this way since §4/§9 (per-session, minted at spawn, distinct from `API_BEARER_TOKENS`) — confirming alignment, not a gap. |
| SQLite over PostgreSQL | **Already correct, no change** | Unchanged since §1; the review independently re-derived the same conclusion. |

### 16.3 LOC-scope delegation boundary, formalized (adopted from the review, previously undefined)

§1's <1000 LOC target never precisely defined what counts. Adopting the review's boundary definition
verbatim, since it's more precise than anything previously written:

**Counts toward the budget:** control-plane application logic, the sandbox bridge, and proxy
configuration glue (the Caddyfile) — i.e., code this plan's own authors write.

**Does NOT count toward the budget** (delegated infrastructure, already excluded in spirit but now
explicit): Fastify itself, the SQLite driver, the Docker CLI/SDK, the Caddy/proxy base image, OpenCode
itself, container manifests (Dockerfiles, `docker-compose.yml`), raw SQL schema/migration files, and
any generated types. This matters for one reason: it keeps the budget honest about what's actually
being *written* versus what's being *assembled from existing tools* — which was always the plan's
intent (§1: "make heavy use of present libraries, concentrate on glue code" is the project's own KISS
principle, just never connected explicitly to the LOC count before now).

### 16.4 Reconciled LOC budget

| Component | §15.8 estimate | §16 (best-of-both-worlds) |
|---|---|---|
| Public API (sessions CRUD, models, artifacts-proxy, logs; diagnostics = first cut) | ~70-90 | ~90-100 |
| WS relay + wsToken rotation + subscriber registry | ~70 (bare, undercounted) | ~100-110 |
| Sandbox lifecycle (`docker run`/inspect/logs/stop, per-session token mint) | ~60 | ~60 |
| Bootstrap (3-repo clone/SHA-pin/failure-classification, §14.4) | ~95-100 | ~90-100 |
| Prompt/stop delivery | ~55-70 (queue+ack) | **~15-20** (sync proxy, §16.1) |
| SQLite (sessions w/ continuation cols, minimal events, deliveries) | ~90-100 | ~70-80 |
| Webhook (HMAC, dedup, trust check, prompt builder, async split) | ~70-90 | ~70-80 |
| Reaper w/ active-session guard | ~30-35 | ~30-35 |
| Auth (external bearer + per-session internal token, both directions) | ~30 | ~30 |
| Bridge (small HTTP server + healthcheck-gated readiness, not a poller) | ~60-80 | ~50-70 |
| Proxy config glue (Caddyfile) | ~25 | ~25 |
| **Total** | **~855-1095** | **~630-750** |

The sync-proxy fix (§16.1) accounts for essentially the entire reduction. This lands comfortably under
the <1000 LOC ceiling (§1) **without cutting a single item from §16.2's "keep" list** — the actual
"best of both worlds" outcome: the simplification recovered enough budget that none of the
correctness fixes from rounds 12-15 needed to be sacrificed to afford it. The three first/second/third
cut candidates (diagnostics, presence, fetch_history-pagination) remain available as extra headroom if
implementation runs over these estimates, but are no longer load-bearing for hitting the ceiling.

### 16.5 Updated readiness verdict

**Design-complete and implementation-ready, LOC budget now comfortable rather than at-risk.** Ten
rounds of review (self-audit ×4, adversarial subagent ×2, fresh-context diagram cross-check ×1,
external colleague review ×1, plus the two live-verification rounds) have each found and closed a real
issue, and the pattern is now converging rather than discovering new categories of gap: §16.1 recovered
budget instead of consuming it, and §16.2's table found the remaining "bloat" concerns were
mischaracterized restatements of requirements already in scope, not new problems. No open design
questions remain. Implementation can begin against §9's implementation order (which should be read
with §16.1's sync-proxy model replacing the poll/ack steps it originally described) and §16.4's budget
table, tracking actual LOC per component as building proceeds.

---

## 17. Round 11 (Aug 2026): reinstating `/oauth2/token` — client_credentials via a hand-rolled route, not a full IdP

A dedicated three-angle research pass (embeddable OAuth2 libraries, off-the-shelf proxy/gateway
components, JWT/security best practice) revisited §1's and §12's "deliberately out of scope" call on
`/oauth2/token`. **Finding: that call was based on an inflated cost estimate.** The source doc's
quickstart —

```
curl -s https://<control-plane-host>/oauth2/token \
  -d grant_type=client_credentials \
  -d client_id=$OIDC_CLIENT_ID \
  -d client_secret=$OIDC_CLIENT_SECRET \
  | jq -r .access_token
```

— is a plain RFC 6749 §4.4 `client_credentials` exchange: no browser, no login/consent UI, no JWKS
endpoint, no refresh tokens, no third-party IdP federation. §1's original framing ("full OIDC is a mini
auth-server we don't need") conflated this narrow grant with a full OpenID Connect provider. It isn't
one, and implementing it costs barely more than the static-bearer-token approach it was traded for.

### 17.1 Embeddable OAuth2 libraries — none fit, hand-rolling is cheaper than any of them

- `@node-oauth/oauth2-server` (v5.3.0, ~194k dl/week, actively maintained) natively supports
  `client_credentials`, but its model-based abstraction is designed around persistent opaque-token
  storage shared with `authorization_code`/`refresh_token`/PKCE flows — none of which this plan needs.
  Wiring it in (model implementation + a Fastify request/response adapter shim, since it has no native
  Fastify support) is a realistic **150-250 LOC**, and it still issues opaque tokens by default — JWT
  signing would be bolted on separately, adding yet more glue.
- `express-oauth-server` wraps the same abandoned (`oauth2-server` 3.x, unmaintained since 2022) core
  and is Express-specific — same cost, worse maintenance.
- `@fastify/oauth2` and `simple-oauth2` are **client-side only** — they implement *this app logging
  into a third party* (browser redirect, `simple-oauth2`'s outgoing token requests), not *this app
  issuing its own tokens*. Structurally the wrong direction; cannot be adapted into an issuer.
- **Decision: hand-roll it directly with `jose` (v6.2.8, ~113M dl/week, zero runtime dependencies,
  actively maintained, no CVE history) + `@fastify/formbody`** (official Fastify plugin, parses the
  `application/x-www-form-urlencoded` body the curl example sends) — the only approach that doesn't
  cost more than the feature is worth.

### 17.2 Proxy/gateway alternatives — none replace real complexity here (unlike the `sandbox-proxy` precedent)

Checked whether a reverse-proxy/gateway component could issue+validate the token entirely outside
Fastify, the same way stock Caddy's `reverse_proxy`/`header_up` directives already replaced
`iptables-init`+`NET_ADMIN` for egress credential injection (§2). None qualify:

- **`caddy-security`** (greenpau/caddy-security, actively maintained, 2.2k★) is a browser-SSO identity
  broker (form login, LDAP, OIDC-as-a-client, SAML) — not an OAuth2 authorization server for
  `client_credentials`. Bending it to this shape needs a custom `xcaddy` build (the stock
  `caddy:2-alpine` image already used for `sandbox-proxy` won't do) and a **60-120 line** `security`
  app block modeling machine clients as "users" in an identity store — more complex than the feature,
  and architecturally the wrong idiom.
- **`oauth2-proxy`** is built entirely around browser-redirect/session-cookie login (CNCF project, very
  actively maintained, but categorically a relying-party proxy, not an authorization server) — has no
  `client_credentials`/M2M grant support at all. Wrong tool, not a matter of configuration.
- **Traefik + forward-auth + a token-issuer sidecar** just relocates the exact same hand-written
  issuer/validator code into a new sidecar container, while adding a brand-new proxy layer (this
  project doesn't otherwise run Traefik) plus its own dynamic/static config (~30-50 LOC) — strictly
  more containers and more total LOC for zero functional gain.
- **KrakenD** (lightweight, genuinely well-suited to Compose for JWT *validation*) gates
  `client_credentials` *issuance* to its paid Enterprise tier — the free Community Edition still
  requires the Fastify app to do the actual credential check, so nothing is removed, only a second
  ~80-150 line `krakend.json` config surface is added on top.

**Decision: no new container.** Every candidate either can't do the issuance half at all, or requires
writing the same code anyway just relocated — failing the project's own bar for adding infrastructure
(replace much more complexity than it adds, per the `sandbox-proxy` precedent).

### 17.3 JWT mechanics — HS256, `jose`, 1-hour TTL, reuse the existing digest-comparison pattern

- **Algorithm: HS256**, not RS256/ES256. Asymmetric signing exists to let a party that only *verifies*
  do so without holding the signing key — irrelevant here since the control plane is both issuer and
  sole verifier (self-contained, single process). Asymmetric keys would only add key-pair
  generation/rotation overhead and larger tokens for zero security benefit in this topology.
- **Library: `jose`**, not `jsonwebtoken` — zero transitive dependencies (vs. `jsonwebtoken`'s ~10,
  including a CVE history around algorithm-confusion defaults), and its `jwtVerify` API forces an
  explicit `algorithms: ['HS256']` allowlist, closing the classic alg-confusion vulnerability class by
  construction rather than by convention.
- **Client secret storage**: plaintext-friendly, matching the project's own existing
  `API_BEARER_TOKENS` convention — a `OAUTH2_CLIENTS` env var (`client_id:client_secret,...` or a JSON
  map), not a new SQLite table or bcrypt/argon2 (the wrong tool for high-entropy machine secrets,
  which aren't subject to the offline-dictionary-attack threat model password hashing defends
  against). **Comparison must reuse this document's own already-documented fix** (§6a: "a naive
  `crypto.timingSafeEqual` hook has a subtle length-check timing leak... the safest fix is comparing
  SHA-256 digests of both sides rather than raw tokens") — applied here to `client_secret` comparison,
  not just the webhook HMAC check it was originally written for.
- **Token lifetime: `expires_in: 3600`** (1 hour) — long enough to avoid excessive re-auth chatter for
  an internal thin control plane, short enough to bound the blast radius of a leaked token.
  **No refresh tokens** — RFC 6749 §4.4 has none for this grant; a client simply re-POSTs its
  `client_id`/`client_secret` when its token expires, which it can always do since it already holds
  the long-lived secret.
- **Validation is signature + `exp` only, no revocation list** — sound for this threat model
  (internal service-to-service, not user-facing), with one explicit caveat: if a `client_secret` is
  compromised, tokens already issued before rotation remain valid until natural expiry (up to 1 hour).
  This is the accepted, standard trade-off for stateless JWTs and mirrors the risk the project already
  accepts with static `API_BEARER_TOKENS` (no revocation short of a restart with new env vars) — not a
  new risk introduced by this design, just the same one expressed with a bounded TTL instead of none.
- **Not a weaker design than an external IdP for this threat model**: an external IdP's value is
  establishing trust *across* organizational/process boundaries; here there is exactly one trust
  domain (the control plane trusting itself), so self-issuance/self-validation loses nothing relevant
  — no JWKS endpoint, no federation, no multi-party revocation semantics are needed because there is
  no second party.

### 17.4 What gets built (supersedes the plain-bearer-token plan in §1/§4/§9)

- **`control-plane/oauth2.js`** (~55-65 LOC, replacing the plain-bearer-token half of what §9 step 2
  originally called `auth.js`):
  - Load `OAUTH2_CLIENTS` (client_id → secret, or secret-digest) and `JWT_SIGNING_SECRET` (32 random
    bytes) from env at boot.
  - `POST /oauth2/token`: parse form body (`@fastify/formbody`), reject non-`client_credentials`
    `grant_type` with `400 {error: "unsupported_grant_type"}`, look up `client_id`, compare
    `client_secret` via the SHA-256-digest `timingSafeEqual` pattern, reject mismatches with
    `401 {error: "invalid_client"}`, else sign `{ sub: client_id }` as an HS256 JWT
    (`iss`/`iat`/`exp` set via `jose`'s `SignJWT`) and return
    `{access_token, token_type: "Bearer", expires_in: 3600}`.
  - `onRequest` hook on `/api/*`: extract `Authorization: Bearer <token>`, `jose.jwtVerify(token,
    JWT_SIGNING_SECRET, { algorithms: ['HS256'] })`, attach `request.client`, else `401`.
- **§4**: `POST /oauth2/token` added to the public route table; `/api/*` auth description changed from
  a raw bearer-token compare to HS256 JWT verification (edits applied above).
- **§1**: the "OIDC `client_credentials` → static bearer tokens" simplification row corrected — it's
  reinstated, not simplified away, because the real cost was overestimated (edit applied above).
- **§12 (`/oauth2/token` — deliberately out of scope)**: retracted (edit applied above).
- **Compose (§8)**: `API_BEARER_TOKENS` env var replaced by `OAUTH2_CLIENTS` + `JWT_SIGNING_SECRET`
  (edit applied above). The per-session `INTERNAL_TOKEN` used for control-plane↔bridge calls is
  unrelated and unchanged — it was never `API_BEARER_TOKENS`/OAuth2-based to begin with (§16.2).

```js
// control-plane/oauth2.js — ~55-65 LOC total (pseudocode, not final code)
const secret = new TextEncoder().encode(process.env.JWT_SIGNING_SECRET)
const clients = parseClientsEnv(process.env.OAUTH2_CLIENTS)  // Map<client_id, secretDigestHex>

const digest = (s) => crypto.createHash('sha256').update(s).digest()
function secretsMatch(provided, expectedHex) {
  return crypto.timingSafeEqual(digest(provided), Buffer.from(expectedHex, 'hex'))
}

fastify.post('/oauth2/token', async (req, reply) => {
  const { grant_type, client_id, client_secret } = req.body
  if (grant_type !== 'client_credentials')
    return reply.code(400).send({ error: 'unsupported_grant_type' })
  const expected = clients.get(client_id)
  if (!expected || !secretsMatch(client_secret ?? '', expected))
    return reply.code(401).send({ error: 'invalid_client' })
  const token = await new jose.SignJWT({ sub: client_id })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(secret)
  return { access_token: token, token_type: 'Bearer', expires_in: 3600 }
})

fastify.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return reply.code(401).send({ error: 'invalid_token' })
  try {
    const { payload } = await jose.jwtVerify(auth.slice(7), secret, { algorithms: ['HS256'] })
    req.client = payload.sub
  } catch { return reply.code(401).send({ error: 'invalid_token' }) }
})
```

### 17.5 Updated LOC budget

Supersedes the "Auth" row in §16.4's table:

| Component | §16.4 estimate | §17 (with reinstated OAuth2) |
|---|---|---|
| Auth (`oauth2.js`: token endpoint + bearer-JWT verify hook + per-session internal token, both directions) | ~30 | ~55-70 |
| Everything else (unchanged from §16.4) | ~600-720 | ~600-720 |
| **Total** | **~630-750** | **~655-790** |

Still comfortably under the <1000 LOC ceiling (§1) — the reinstatement costs roughly +25-40 LOC net
over the static-bearer-token version it replaces, not the "mini auth-server" originally assumed.

### 17.6 Updated readiness verdict

**Design-complete.** This closes the one item (`/oauth2/token`) that was previously marked
"deliberately out of scope" based on a cost assumption that didn't hold up under research — every
other §16.5 conclusion is unchanged. The source doc's own quickstart curl example now works verbatim
against this plan with no client-side changes required. §1's simplification table and §12's endpoint-
coverage audit are both corrected in place (struck through / annotated) to point here rather than left
silently stale, consistent with this document's own evidence-first, retraction-when-warranted
convention.
