> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap: SessionDetail header is missing a WS connection indicator

### Why this matters

Step 00500's own Output/UX section requires: "Connection indicator in the header reflects actual
WS state (connected/reconnecting/closed), replacing Phase 1's polling-derived approximation."

The implementation as reviewed (`control-plane/dashboard/src/routes/SessionDetail.tsx` and
`control-plane/dashboard/src/components/Transcript.tsx`) does not satisfy this:

- `SessionDetail.tsx`'s header (`<div className="mt-1 flex items-center justify-between">`)
  contains only the title, repo/model line, `StatusBadge` (session/docker status, unrelated to the
  WS transport), and the Stop/Archive buttons. It has no WS connection state at all.
- `Transcript.tsx` renders a `role="alert"` message only for `invalidToken`, and a `role="status"`
  "Reconnecting…" message only while `status === 'reconnecting'` — both inline above the transcript
  body, not in the header, and neither ever renders a positive "connected" state or a "closed"
  (non-auth) state. `useSessionSocket`'s returned `status` (`connecting`/`open`/`reconnecting`/
  `closed`) is otherwise unused by any component.
- No test in `SessionDetail.test.tsx` or `Transcript.test.tsx` asserts on a connection indicator,
  confirming the gap wasn't just missed by review but was never exercised.

Without this, a user has no way to tell, from the header, whether the live transcript is actually
connected, silently retrying, or dead — exactly the ambiguity this phase's plan called out replacing.

### Actions

1. In `SessionDetail.tsx`'s header row (next to/near `StatusBadge`, not buried in the transcript
   body), render a small WS connection indicator driven by `useSessionSocket`'s `status` value:
   - `open` → e.g. "Connected" (green/neutral dot).
   - `reconnecting` → e.g. "Reconnecting…" (amber).
   - `closed` (non-auth) → e.g. "Disconnected" (muted/red).
   - `connecting` → treat as an initial/neutral state (e.g. same visual as `reconnecting` or a
     dedicated "Connecting…" label — implementer's choice, but it must not look identical to
     `open`).
   This requires either lifting `useSessionSocket(sessionId, wsToken)` up into `SessionDetail` and
   passing `events`/`status`/`invalidToken` down into `Transcript` as props (preferred — avoids two
   competing socket connections), or exposing the hook's `status` via a shared context/prop so both
   `SessionDetail`'s header and `Transcript`'s body read the same live value.
2. Keep `Transcript.tsx`'s existing `invalidToken` alert and `reconnecting` message (or remove the
   latter if it becomes redundant with the new header indicator) — do not regress the token-invalid
   messaging.
3. Add a React Testing Library test in `SessionDetail.test.tsx` (or a new focused test file) that
   renders `SessionDetail` with the fake `WebSocket`, asserts the header shows a "connected"
   indicator once the socket's `open` event fires, and shows a "reconnecting"/"disconnected"
   indicator after a non-4001 `close` event.
4. Re-run `pnpm --filter dashboard test && pnpm --filter dashboard build` and confirm both remain
   green with the new test included.
