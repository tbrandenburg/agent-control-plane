> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

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
