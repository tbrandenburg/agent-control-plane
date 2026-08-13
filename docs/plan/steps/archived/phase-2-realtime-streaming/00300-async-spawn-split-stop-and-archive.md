> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

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
