> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap: Step 5 (dashboard list, create, and polling transcript) was never implemented

Review of `docs/plan/steps/in-review/00500-dashboard-list-create-and-polling-transcript.md` found that
**none** of the files the step specified exist on disk. `control-plane/dashboard/src/` contains only the
Phase 0 placeholder shell (`App.tsx`, `App.test.tsx`, `main.tsx`, `components/ui/button.tsx`, `lib/utils.ts`,
`index.css`) exactly as committed in `07ee2a8 feat: add phase 0 control plane foundation`. There is no
`src/api/client.ts`, no `src/routes/{SessionList,NewSession,SessionDetail}.tsx`, no
`src/components/{Transcript,PromptComposer,StatusBadge}.tsx`, and no component tests for `StatusBadge` or
`Transcript`. `App.tsx` still renders the Phase 0 placeholder ("No sessions yet.") and was never wired to
any routing.

This matters because the step's own validation commands give a false-positive "pass" without the gap being
implemented at all:
- `pnpm --filter dashboard test` → 1 test file, 1 test passed — but that is only the pre-existing
  `App.test.tsx` placeholder test; zero tests exist for the new components this step was supposed to add.
- `pnpm --filter dashboard build` → succeeds — but it is building the Phase 0 placeholder, not the
  session list/create/transcript UI.
- `make loc` → `Dashboard (server glue)` shows 52 LOC (server-side static hosting glue only) and the
  dashboard client source is correctly excluded from the LOC budget — this check is not sensitive to the
  frontend gap at all.

None of the three validation commands the step specifies can detect that the actual feature is missing,
so this must be caught by manual file-existence inspection (as done here) rather than by re-running the
step's own checks.

## Actions

1. Implement `control-plane/dashboard/src/api/client.ts` with typed `fetch` wrappers and TanStack Query
   hooks for `GET /api/sessions`, `POST /api/sessions`, `GET /api/models`, `GET /api/sessions/:id`,
   `GET /api/sessions/:id/events`.
2. Implement `src/routes/SessionList.tsx`, `src/routes/NewSession.tsx`, `src/routes/SessionDetail.tsx`
   and wire `src/App.tsx` to route across exactly `/`, `/sessions/new`, `/sessions/:id` (remove the
   Phase 0 placeholder body).
3. Implement `src/components/StatusBadge.tsx` as a small pure function deriving
   `active`/`running`/`stopped`/`failed`/`archived` from `sessions.status` combined with the live
   `docker inspect` phase, per `docs/UI.md` §1. Add a unit test covering every
   `(sessionStatus, dockerPhase)` combination.
4. Implement `src/components/Transcript.tsx` polling `GET /api/sessions/:id/events` on a 1s TanStack
   Query interval, appending via the server's `timestamp,id` cursor (no client-side re-sorting), and
   rendering `message.part.delta` frames as incremental text. Add a component test proving two polled
   pages append without duplicates.
5. Implement `src/components/PromptComposer.tsx` per `docs/UI.md` §3.
6. Implement the create form per `docs/UI.md` §2: title, repoOwner + repoName, model (dropdown from
   `GET /api/models`), reasoning effort (Low/Medium/High/Max). Omit "Team config",
   `additionalRepos`, and `readOrgRepos` entirely (not just hidden).
7. Implement inline error surfacing on create-session failure and a non-blocking "reconnecting"
   indicator on polling failure (transcript must not clear).
8. Add a header connection indicator and a pending state on the create submit button during the
   synchronous create request.
9. Re-run and pass, with real evidence (paste actual command output):
   `pnpm --filter dashboard test && pnpm --filter dashboard build && make loc`
   — this time verifying the test file count/names actually cover `StatusBadge` and `Transcript`,
   not just re-confirming the placeholder test still passes.
10. Move `docs/plan/steps/in-review/00500-dashboard-list-create-and-polling-transcript.md` to
    `docs/plan/steps/closed/` only after all of the above is verified complete (do not edit the file
    itself — it is immutable; only its directory location changes as part of the normal step
    lifecycle, performed by the implementer, not this gap step).
