> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 6: End-to-end verification and bootstrap-classification falsification

#### Changes

##### Create
- `e2e/tests/bootstrap-failures.spec.ts`.
- `docs/phase_02_findings.md`.

##### Modify
- `e2e/tests/session-lifecycle.spec.ts` — update for WS transport and async spawn split.
- `.github/workflows/ci.yml` — ensure any new E2E fixture repos/hosts are available in CI.

##### Remove
- Nothing.

#### Implementation

##### E2E specs
`session-lifecycle.spec.ts` updated to assert over WebSocket instead of polling, and to accommodate the
`202`-then-settle create flow. `bootstrap-failures.spec.ts` drives real failing clones for all four
classification rows against real `git` — no mocking of Docker or git, per root `AGENTS.md`.

##### Findings document
`docs/phase_02_findings.md`, mirroring `docs/phase_01_findings.md`'s evidence-first format: record
whether the stderr classification patterns matched this environment's real `git` output verbatim, any
regex adjustments needed, and the resolved Option A/B/C gateway-default decision with rationale.

##### Error Handling
E2E teardown removes every spawned sandbox container and any cloned fixture directories even on
failure, or CI leaks state across runs.

##### Output / UX
The findings document is this phase's evidence artifact, same evidentiary standard as Phase 1 — a green
test run alone does not close the phase.

#### Patterns & Constraints

##### Mirror
[`ROADMAP.md`](./ROADMAP.md)'s Phase 2 exit criterion and stated riskiest assumption
(bootstrap-classification accuracy).

##### Decisions
- Real git failures, not mocked stderr, for at least three of the four classification rows (the fourth,
  `unknown`, may need a synthetic fixture — state this explicitly rather than pretending it was also
  reproduced naturally).

##### Gotchas
- Network-failure E2E cases (`network` classification) need a genuinely unreachable host reference that
  won't flake against real CI network conditions — pick a non-routable address deliberately, document
  why it's expected to time out rather than resolve.

##### Out of Scope
Any Phase 3+ capability; any "small" security fix (Phase 4 closes them as one set, per
[`ROADMAP.md`](./ROADMAP.md)).

#### Tests

##### E2E
`session-lifecycle.spec.ts` (updated) and `bootstrap-failures.spec.ts` (new).

##### Integration
Full control-plane suite runs against the real DB and a stubbed sandbox in CI's integration job, as in
Phase 1.

##### Unit
No new unit coverage; this step consumes prior steps'.

#### Validation

##### Commands
```
make build && make sandbox-image && make e2e && make lint && make test && make loc
```

##### Expected Results
Green E2E against the real stack including real failing clones; `docs/phase_02_findings.md` records the
classification-accuracy findings and the resolved gateway-default decision;
[`ROADMAP.md`](./ROADMAP.md)'s Phase 2 exit criterion — "create a session against an arbitrary repository
from the dashboard and watch a live-streaming transcript" — demonstrably met, unblocking Phase 3.
