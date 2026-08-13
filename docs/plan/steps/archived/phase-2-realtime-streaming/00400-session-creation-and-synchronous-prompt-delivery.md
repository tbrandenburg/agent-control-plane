> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

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
Return `{ models: MODEL_ALLOWLIST }` from `config.js` — static, hand-curated, no live gateway query, no cache
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
Model syntax validation table: `opencode/x` valid, `x` invalid, `/x` invalid, `x/` invalid,
`opencode/a/b` valid with `modelID = "a/b"`, and a non-allowlisted but well-formed id **accepted**.

#### Validation

##### Commands
```
pnpm --filter control-plane test && make loc
```

##### Expected Results
All validation cases pass — most importantly the non-allowlisted-but-valid model returning 201, proving no
membership gate was added.
