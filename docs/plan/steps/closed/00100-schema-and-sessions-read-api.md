> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

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
