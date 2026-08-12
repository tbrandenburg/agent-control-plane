> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 5: Dashboard — list, create, and polling transcript

#### Changes

##### Create
- `src/api/client.ts` — typed `fetch` wrappers + TanStack Query hooks.
- `src/routes/SessionList.tsx`, `src/routes/NewSession.tsx`, `src/routes/SessionDetail.tsx`.
- `src/components/Transcript.tsx`, `src/components/PromptComposer.tsx`, `src/components/StatusBadge.tsx`.
- Component tests for `StatusBadge` and `Transcript`.

##### Modify
- `src/App.tsx` — routing across exactly `/`, `/sessions/new`, `/sessions/:id`.

##### Remove
- The Phase 0 placeholder shell content.

#### Implementation

##### Session list — [`UI.md` §1](./UI.md)
Table of title / repository / model / status. `StatusBadge` **derives** its value: `sessions.status`
(`active`/`archived`/`pending_bootstrap`) combined with the live `docker inspect` phase to render
`active`/`running`/`stopped`/`failed`/`archived`. The backend never stores the derived values — encode this
in one small pure function with its own unit test.

##### Create form — [`UI.md` §2](./UI.md)
Fields map 1:1 to the Phase 1 `POST /api/sessions` body: title, repoOwner + repoName, model (dropdown from
`GET /api/models`), reasoning effort (Low/Medium/High/Max) — every rendered field is stored and used
([§8](./ARCHITECTURE.md)'s `reasoning_effort` default). **No "Team config" field this phase** — it is
omitted, not just visually hidden, since [`UI.md` §2](./UI.md)'s full wireframe includes it but this
phase has no bootstrap path to override (Scope, above); re-add it in Phase 2 alongside real git bootstrap.
**`additionalRepos`/`readOrgRepos` must not appear** — permanent declared deviation
([§13](./ARCHITECTURE.md), restated in [`UI.md` §2](./UI.md)).

##### Session detail — [`UI.md` §3](./UI.md)
Conversation transcript + prompt composer + a minimal Overview panel (status, model, sandbox,
OpenCode session). Events are read via `GET /api/sessions/:id/events` on a **1s TanStack Query poll**
([`ROADMAP.md`](./ROADMAP.md) Phase 1) using the cursor to append rather than refetch. Render
`message.part.delta` frames as incremental text so the "watch tokens appear" exit criterion is literally true.

**Do not render** Participants, Artifacts, Diagnostics, or Logs panels — [`UI.md`](./UI.md)'s design goal
is that no functionality is implied that the backend does not provide. Those arrive in Phases 3 and 6.

##### Error Handling
Create-session failures surface the server's message inline on the form. A polling failure shows a
non-blocking "reconnecting" indicator rather than clearing the transcript.

##### Output / UX
Header shows a connection indicator; during a synchronous create the submit button shows a pending state,
since the request blocks on container spawn (Step 4 gotcha).

#### Patterns & Constraints

##### Mirror
[`UI.md`](./UI.md) wireframes for layout and [`UI.md` "Implementation note"](./UI.md) for component decomposition:
small, independent, `fetch`-driven units.

##### Decisions
- Polling now, WebSocket in Phase 2 — the polling path is **deleted**, not layered over
  ([`ROADMAP.md`](./ROADMAP.md) deferral table).
- Dashboard source stays outside the [§14](./ARCHITECTURE.md) LOC budget; verify `make loc` still excludes it.

##### Gotchas
- Appending by cursor requires stable ordering; reuse the server's `timestamp,id` cursor rather than
  client-side sorting.
- A 1s poll against a token-delta firehose can be heavy — this is exactly [`ROADMAP.md`](./ROADMAP.md)
  assumption 3; record the observed volume rather than tuning it away silently.

##### Out of Scope
Search/filter controls beyond what [`UI.md` §1](./UI.md) shows, the mobile tab layout ([`UI.md` §4](./UI.md),
Phase 6), login UI (Phase 4).

#### Tests

##### E2E
Covered in Step 6.

##### Integration
React Testing Library against a mocked API layer: create form submits the right body; transcript appends
across two polled pages without duplicates.

##### Unit
The status-derivation function across every `(sessionStatus, dockerPhase)` combination.

#### Validation

##### Commands
```
pnpm --filter dashboard test && pnpm --filter dashboard build && make loc
```

##### Expected Results
Component tests green; bundle builds into `control-plane/public/`; LOC total unchanged by dashboard source.
