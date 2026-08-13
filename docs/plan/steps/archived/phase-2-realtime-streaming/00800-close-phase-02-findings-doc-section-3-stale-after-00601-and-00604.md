> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Step `00604` (`arbitrary-repo-e2e-proof-and-findings-closure`, in-review) declares Action 4: "Update
`docs/phase_02_findings.md` §3 to record: which parts of the original finding are now resolved
(Actions 1-3/6, with re-run evidence), and which parts (the arbitrary-repo E2E proof) remained open
until this gap step closed them." Independently re-reading `docs/phase_02_findings.md` §3 today shows
this action was never done: the section still reads verbatim as it did before `00604` — it still
says "This is a real gap in already-`closed` prior steps (00100/00200/00300) ... recorded here as
this step's own falsification finding and left for a dedicated follow-up gap step to close ...
Recommended next step: `00601`", with no mention that `00601`'s wiring (Actions 1-3/6) is now done,
nor that `00604` itself added the Platform-config-repo fixture and the distinct-target-repo E2E
variant (Actions 1-3), nor any acknowledgment of the still-open findings-doc gap this step's own
Action 4 was supposed to close.

This matters because `docs/phase_02_findings.md` is this phase's evidence-first exit artifact
(mirroring `docs/phase_01_findings.md`'s format, per root `AGENTS.md`'s evidence-first principle) —
leaving §3 stale after two more steps (`00601`, `00604`) resolved most of its own content makes the
document actively misleading to anyone reading it as the current state of the phase, and risks a
third step repeating the same "recommended next step" pointer instead of recognizing the wiring is
already done.

**Not a duplicate:** no existing file under `docs/plan/steps/planned/` updates
`docs/phase_02_findings.md` §3's specific stale content — `00605`/`00606`/`00607` each touch this
findings doc as one of several actions for their own, different gaps (lint/loc regressions,
`acme/widgets` fixture, private platform-config-repo default respectively); none of them is the
dedicated §3 rewrite `00604`'s own Action 4 promised.

## Actions

1. Rewrite `docs/phase_02_findings.md` §3 to accurately reflect the current, real state, following
   the same evidence-first format as the rest of the document:
   - Record that `control-plane/src/routes/sessions.js`'s `spawnSandbox()` now calls
     `bootstrapWorkspace()` per-session and `control-plane/src/sandbox.js`'s `run()` bind-mounts the
     real per-session layout (Step `00601`, closed) — with a pointer to `00601`'s own re-run
     evidence rather than re-deriving it here.
   - Record that a real Platform-config-repo fixture and a real, distinct-target-repo E2E proof now
     exist (`e2e/fixtures/platform-config-fixture.mjs`, `e2e/fixtures/distinct-target-repos.mjs`,
     `e2e/tests/bootstrap-platform-config.spec.ts`, `e2e/tests/arbitrary-repo-bootstrap.spec.ts` —
     Step `00604`), noting their current real pass/fail status honestly (as of this writing, the
     `arbitrary-repo-bootstrap.spec.ts` variant fails for the separate reason tracked in gap step
     `00607` — the findings doc must not claim it passes until `00607` actually resolves that).
   - Cross-reference gap steps `00606` (target-repo fixture in `session-lifecycle.spec.ts`) and
     `00607` (private default platform-config-repo) as the two remaining concrete blockers to the
     ROADMAP Phase 2 "arbitrary repository" exit criterion being demonstrably true end-to-end, rather
     than leaving a single generic "recommended next step: 00601" pointer that is now outdated.
2. Do not mark the ROADMAP Phase 2 exit criterion itself as satisfied until `00606` and `00607` are
   both closed and a full, real, isolated `make e2e` run is captured showing every bootstrap-related
   spec green — this action is documentation-accuracy only, not a claim of completion.
