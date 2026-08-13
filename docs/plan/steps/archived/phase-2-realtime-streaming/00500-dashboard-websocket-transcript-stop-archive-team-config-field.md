> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 5: Dashboard — WebSocket transcript, Stop/Archive, Team config field

#### Changes

##### Create
- `control-plane/dashboard/src/hooks/useSessionSocket.ts`.
- Component tests for the new hook and the pending-bootstrap status rendering.

##### Modify
- `control-plane/dashboard/src/components/Transcript.tsx` — WS-driven, polling deleted.
- `control-plane/dashboard/src/routes/SessionDetail.tsx` — Stop/Archive buttons, connection indicator.
- `control-plane/dashboard/src/routes/NewSession.tsx` — Team config field restored.
- `control-plane/dashboard/src/components/StatusBadge.tsx` — render `pending_bootstrap` distinctly.

##### Remove
- The Phase 1 TanStack Query polling hook for events.

#### Implementation

##### WebSocket transcript
`useSessionSocket(sessionId, wsToken)` opens the socket, sends `subscribe` first, then handles incoming
`{type:"event",...}` messages by appending to the same rendering path Phase 1's polling used — the
**content** contract (render `message.part.delta` incrementally) is unchanged, only the transport is.

##### Stop/Archive buttons
Wired directly to `POST /api/sessions/:id/stop` and `PATCH /api/sessions/:id {status:"archived"}`
respectively, in the session-detail header per [`UI.md` §3](./UI.md) — this is explicitly called out in
[`ROADMAP.md`](./ROADMAP.md) as a previously-missed gap; treat it as first-class, not incidental.

##### Team config field
Restored to the create form exactly as [`UI.md` §2](./UI.md)'s wireframe shows — optional, overrides the
default team config repo, now meaningful because Step 1's real bootstrap actually clones it.

##### Pending-bootstrap status
`StatusBadge` renders a distinct visual state for `status: 'pending_bootstrap'` (e.g. a spinner/"Setting
up...") both in the session list and detail header — the create flow's 202-then-async-settle behavior
must be visible, not silently identical to `active`.

##### Error Handling
A WS close with code `4001` shows a clear "session token invalid, reload" message, not a silent
disconnect. A bootstrap failure (session stuck in a failed state) shows an inline error rather than an
infinite pending spinner.

##### Output / UX
Connection indicator in the header reflects actual WS state (connected/reconnecting/closed), replacing
Phase 1's polling-derived approximation.

#### Patterns & Constraints

##### Mirror
[`UI.md` §3](./UI.md)'s header layout (Stop/Archive buttons) and §2's Team config field placement.

##### Decisions
- The polling hook is deleted outright, not left as a fallback — [`ROADMAP.md`](./ROADMAP.md)'s deferral
  table is explicit that this is a deletion, not a layering.

##### Gotchas
- A reconnect after a dropped WS must not duplicate already-rendered transcript entries — dedupe by the
  same `timestamp,id` identity Phase 1's cursor used, even though this phase's WS path doesn't re-fetch
  via that cursor endpoint directly (no `fetch_history` yet — Phase 6).

##### Out of Scope
Participants panel, `fetch_history`-driven reconnect replay (both Phase 6); Diagnostics/Artifacts/Logs
panels (Phase 3).

#### Tests

##### E2E
Covered in Step 6.

##### Integration
React Testing Library: `useSessionSocket` connects, sends `subscribe`, renders incoming events; Stop
button calls the stop endpoint; Archive button calls `PATCH`; Team config field submits in the create
body when filled, omitted when empty.

##### Unit
`StatusBadge`'s `pending_bootstrap` rendering case added to Phase 1's existing table-driven test.

#### Validation

##### Commands
```
pnpm --filter dashboard test && pnpm --filter dashboard build && make loc
```

##### Expected Results
Component tests green; bundle builds; dashboard LOC still excluded from the [§14](./ARCHITECTURE.md)
budget.
