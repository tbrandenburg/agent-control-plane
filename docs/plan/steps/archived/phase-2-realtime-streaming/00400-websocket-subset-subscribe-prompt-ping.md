> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

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
