> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 6: End-to-end vertical slice and assumption falsification

#### Changes

##### Create
- `e2e/tests/session-lifecycle.spec.ts`.
- `docs/phase_01_findings.md` — the written answers to [`ROADMAP.md`](./ROADMAP.md)'s three assumptions.

##### Modify
- `.github/workflows/ci.yml` — ensure the sandbox image is built before the E2E job.
- `docker-compose.yml` — final Phase 1 topology.

##### Remove
- Nothing.

#### Implementation

##### E2E spec
Full browser flow against a real `docker compose` stack, no mocks of any kind ([§1](./ARCHITECTURE.md),
root `AGENTS.md`): create → spawn → prompt → streaming transcript → assert `opencode_session_id`
persisted. Then the variants and error paths listed above.

##### Assumption findings
`docs/phase_01_findings.md` answers, with evidence:
1. Is the SSE stream relayable frame-by-frame? — attach an observed frame-type histogram.
2. Is `/prompt` + relay the right seam? — note any place the contract leaked.
3. Transcript or firehose? — report events-per-turn and bytes-per-turn; if it is a firehose, escalate
   [§15](./ARCHITECTURE.md)'s `events` retention decision from Phase 6 to now, and say so explicitly.

##### Error Handling
The E2E teardown removes every spawned sandbox container even on failure, or CI leaks containers across runs.

##### Output / UX
The findings document is the phase's evidence artifact — [§1](./ARCHITECTURE.md)'s evidence-first stance
means the phase is not complete on a green test alone, but on recorded answers to the questions it existed to ask.

#### Patterns & Constraints

##### Mirror
[`ROADMAP.md`](./ROADMAP.md)'s Phase 1 exit criterion and "assumptions falsified here" list.

##### Decisions
- The E2E stack is the real thing; nothing about Docker, opencode, or the bridge is stubbed at this level.
- Findings are committed, not left in a session transcript.

##### Gotchas
- Model calls cost money and are non-deterministic — use a trivially short prompt and assert on **frame
  arrival and event persistence**, not on model output text.
- Container startup dominates E2E runtime; set generous but bounded Playwright timeouts and prebuild images.

##### Out of Scope
Any Phase 2+ capability, and any "small" security fix — Phase 4 closes them **as one verifiable set**
([`ROADMAP.md`](./ROADMAP.md)).

#### Tests

##### E2E
`session-lifecycle.spec.ts` — happy path, variants, and error paths from the sections above.

##### Integration
The full control-plane suite runs against the real DB and a stubbed sandbox in CI's integration job.

##### Unit
No new unit coverage; this step consumes prior steps'.

#### Validation

##### Commands
```
make build && make sandbox-image && make e2e && make lint && make test && make loc
```

##### Expected Results
Green E2E against the real stack; `events` contains `message.part.delta` rows verified by direct SQL;
`make loc` under 1000; `docs/phase_01_findings.md` answers all three assumptions with evidence.
[`ROADMAP.md`](./ROADMAP.md)'s Phase 1 exit criterion — "you click New Session in a browser, type a
prompt, and watch tokens appear" — demonstrably met, unblocking Phase 2.
