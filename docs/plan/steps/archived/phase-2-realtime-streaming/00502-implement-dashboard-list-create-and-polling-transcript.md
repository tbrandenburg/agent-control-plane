> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap: Step 5 (dashboard list, create, and polling transcript) is still not implemented

Review of `docs/plan/steps/in-review/00501-implement-dashboard-list-create-and-polling-transcript.md`
found that its own action items 1-9 were never carried out, despite the file having been placed in
`in-review/`. `control-plane/dashboard/src/` still contains only the Phase 0 placeholder shell
(`App.tsx`, `App.test.tsx`, `main.tsx`, `components/ui/button.tsx`, `lib/utils.ts`, `index.css`) — byte
for byte the same gap 00501 itself described. There is still no `src/api/client.ts`, no
`src/routes/{SessionList,NewSession,SessionDetail}.tsx`, no
`src/components/{Transcript,PromptComposer,StatusBadge}.tsx`, and no component tests for `StatusBadge`
or `Transcript`. `App.tsx` still renders "No sessions yet." and is not wired to any routing.

Independently re-run evidence confirming the gap is still present:

```
$ pnpm --filter dashboard test
 Test Files  1 passed (1)
      Tests  1 passed (1)
```
Only the pre-existing `App.test.tsx` placeholder — zero tests for `StatusBadge` or `Transcript`.

```
$ pnpm --filter dashboard build
✓ 70 modules transformed.
../public/index.html                   0.40 kB
../public/assets/index-BFvCXiDf.css   10.70 kB
../public/assets/index-CtvQA8J9.js   247.96 kB
✓ built in 444ms
```
Builds successfully — but it is still building the Phase 0 placeholder, not the session
list/create/transcript UI.

```
$ make loc
Dashboard (server glue)    52
TOTAL                     728 / 1000  ✅
```
Not sensitive to the frontend gap at all, as before.

Additionally, a **process violation** compounding the gap was found: `docs/plan/plan.md` step 00501's own
action item 10 explicitly states that
`docs/plan/steps/in-review/00500-dashboard-list-create-and-polling-transcript.md` must be moved to
`docs/plan/steps/closed/` **only after** all of 00501's actions (1-9) are verified complete. Despite
none of those actions having been performed, `00500-dashboard-list-create-and-polling-transcript.md` was
found already in `docs/plan/steps/closed/`. Future step reviewers must not treat presence in `closed/` as
evidence that a step's prerequisites were met — the directory move can happen (or be automated) without
the underlying work being done. This step supersedes both 00500 and 00501's action items and must not be
considered satisfied by re-running the same three validation commands; file-existence inspection of the
actual source tree is mandatory before trusting the result.

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
   not just re-confirming the placeholder test still passes. A reviewer must independently run
   `find control-plane/dashboard/src -type f` and confirm every file listed above actually exists
   with non-placeholder content before trusting any "tests passed" claim.
10. Do not move any further step file based on this gap's completion until a subsequent, independent
    review confirms items 1-9 above with fresh file-existence and command-output evidence — presence
    of a file in `docs/plan/steps/closed/` is not itself proof that its prerequisites were met.
