> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Step `00600-end-to-end-vertical-slice-and-assumption-falsification.md` was moved to
`in-review/` (and is being reviewed as such) but neither of its two primary deliverables were
ever created:

- `e2e/tests/session-lifecycle.spec.ts` does not exist. `make e2e` only runs Phase 0's
  `e2e/tests/smoke.spec.ts` (3 tests: dashboard shell, `/health`, SPA fallback for
  `/sessions/new`) — none of which exercise create → spawn → prompt → streaming transcript →
  `opencode_session_id` persistence.
- `docs/phase_01_findings.md` does not exist. None of the three assumptions from
  [`ROADMAP.md`](../../../ROADMAP.md) have recorded answers/evidence.

Per root `AGENTS.md`'s evidence-first principle, this phase is not complete on infrastructure
being green alone — it requires the recorded findings artifact and the real E2E flow. Neither
exists, so Phase 1's exit criterion ("you click New Session in a browser, type a prompt, and
watch tokens appear") has not been demonstrated.

This matters because Phase 2 is blocked on this exit criterion per the roadmap, and because an
unverified/undemonstrated assumption (e.g. whether the SSE relay is frame-by-frame, whether
`/prompt` + relay is the right seam, whether the transcript is bounded or a firehose) can silently
propagate into Phase 2+ architecture decisions that are expensive to unwind later.

## Actions

1. Create `e2e/tests/session-lifecycle.spec.ts` covering, against the real `docker compose`
   stack (no mocks — root `AGENTS.md`, [§1](../../../ARCHITECTURE.md)):
   - Happy path: create session → spawn sandbox → send `/prompt` → observe streaming transcript
     frames arrive → assert `opencode_session_id` is persisted (verify via direct SQL against the
     control-plane's SQLite DB, not just the API response).
   - At least one variant and one error path (e.g. prompting a session whose sandbox has not
     finished starting, or a sandbox crash/teardown mid-stream).
   - Use a trivially short, deterministic-enough prompt; assert on frame arrival and event
     persistence, not on model output text (per step 00600's Gotchas).
   - Ensure teardown removes every spawned sandbox container even on test failure (use
     `test.afterEach`/`afterAll` with cleanup that runs unconditionally), so CI does not leak
     containers across runs.
2. Create `docs/phase_01_findings.md` answering, with evidence gathered from running the new
   E2E spec and/or manual inspection of the real stack:
   1. Is the SSE stream relayable frame-by-frame? Attach an observed frame-type histogram.
   2. Is `/prompt` + relay the right seam? Note any place the contract leaked.
   3. Transcript or firehose? Report events-per-turn and bytes-per-turn. If it is a firehose,
      explicitly escalate [§15](../../../ARCHITECTURE.md)'s `events` retention decision from
      Phase 6 to now, and say so explicitly in the document.
3. Re-run `make build && make sandbox-image && make e2e && make lint && make test && make loc`
   and confirm all are green, with `session-lifecycle.spec.ts` visibly executing (not just
   `smoke.spec.ts`).
4. Verify via direct SQL against the running stack's SQLite DB that the `events` table contains
   `message.part.delta` rows for the session created by the new spec.
