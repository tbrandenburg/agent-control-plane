> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Step 4 (`docs/plan/steps/in-review/00400-websocket-subset-subscribe-prompt-ping.md`) was moved to
`in-review/` claiming the WebSocket `subscribe`/`prompt`/`ping` subset was implemented, but **none of
it exists on disk**. Independent re-verification found:

- No `control-plane/src/routes/ws.js` or `control-plane/src/routes/ws.test.js` — `ls
  control-plane/src/routes/` shows only `internal.js`, `models.js`, `sessions.js` and their test
  files.
- `@fastify/websocket` is not a dependency in `control-plane/package.json` (`dependencies` only lists
  `fastify` and `@fastify/static`).
- `control-plane/src/server.js` never imports or registers a WS route or the `@fastify/websocket`
  plugin.
- `control-plane/src/routes/sessions.js`'s `POST /api/sessions/:id/prompt` handler
  (`sessions.js:387`) was never refactored into a shared function callable from both a REST and a WS
  entry point — the WS entry point doesn't exist to share it with.
- `control-plane/src/routes/internal.js`'s `POST /internal/sessions/:id/events` handler only inserts
  into the `events` table; it never calls a `broadcastToSession(...)` function (no such function
  exists anywhere in the repo).
- `git log --oneline -- control-plane/src/routes/ws.js control-plane/src/server.js` shows only the
  Phase 0/Phase 1 commits — no commit ever touched WS routing or `server.js` for this feature.

This is a total gap, not a partial one — this step must be implemented from scratch. Until it is,
Step 5 (`docs/plan/steps/planned/00500-dashboard-websocket-transcript-stop-archive-team-config-field.md`)
cannot be started: its `useSessionSocket` hook has no server-side WS endpoint to connect to.

## Actions

1. Add `@fastify/websocket` as a dependency in `control-plane/package.json`.
2. Create `control-plane/src/routes/ws.js`:
   - Register a WS route on the Fastify instance.
   - Maintain a module-level `Map<sessionId, Set<WebSocket>>` subscriber registry.
   - `subscribe`: required first message `{wsToken}`. Compare against the session's plaintext
     `ws_token` column. Mismatch or missing → close with code `4001`. On success, add the socket to
     the registry.
   - `prompt`: `{content, model?, reasoningEffort?}` → call the same synchronous bridge-proxy function
     used by `POST /api/sessions/:id/prompt`. Refactor `sessions.js:387`'s handler body into a shared
     exported function called from both the REST route and this WS handler — do not duplicate the
     logic.
   - `ping`: keepalive no-op reply.
   - Any socket that sends `prompt`/`ping` before `subscribe` is closed immediately (same as an
     invalid token) — `subscribe` is a hard precondition.
   - Clean up the subscriber registry entry on socket `close` (remove from the `Set`; delete the
     `sessionId` key if the `Set` becomes empty) to avoid leaking dead socket references.
   - Never log the plaintext `wsToken` anywhere.
   - Export a `broadcastToSession(sessionId, payload)` function that sends `payload` (JSON-stringified)
     to every socket currently subscribed to `sessionId`.
3. Modify `control-plane/src/routes/internal.js`'s `POST /internal/sessions/:id/events` handler to
   call `broadcastToSession(id, {type: 'event', ...req.body})` in addition to the existing DB insert.
4. Modify `control-plane/src/server.js` to register the `@fastify/websocket` plugin and the new WS
   route from `ws.js`.
5. Create `control-plane/src/routes/ws.test.js` covering:
   - Correct token subscribes and receives a broadcast event.
   - Wrong/missing token gets closed with code `4001`.
   - Two sockets subscribed to the same session both receive the same broadcast.
   - A socket sending `prompt` before `subscribe` is rejected/closed.
   - After all sockets close, the registry's `Map`/`Set` is empty (no dead-socket references leak).
6. Run `pnpm --filter control-plane test` and confirm all new WS integration cases pass green, with no
   regressions in the existing 126 passing tests (the pre-existing, out-of-scope
   `bootstrap.test.js` cone-mode failure documented in `AGENTS.md`'s Key Pitfalls is not this step's
   concern and must not be "fixed" here).
7. Only once this is verified working should `docs/plan/steps/in-review/00400-websocket-subset-subscribe-prompt-ping.md`
   be considered eligible to move to `closed/`.
