> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

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
- The bridge must not hold any external secret ([§3](./ARCHITECTURE.md)); in Phase 1 the model gateway key
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
SSE chunk-boundary buffering; `splitModel` on `opencode/big-pickle`; `variant` omitted
vs. present in the `prompt_async` body.

#### Validation

##### Commands
```
pnpm --filter sandbox test && pnpm --filter control-plane test
```

##### Expected Results
Frames arrive verbatim in `events`; `opencode_session_id` set exactly once; a duplicate oc-session report
returns 409.
