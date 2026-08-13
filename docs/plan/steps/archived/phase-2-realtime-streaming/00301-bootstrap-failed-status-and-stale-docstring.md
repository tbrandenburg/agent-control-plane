> Gap step raised during review of `docs/plan/steps/in-review/00300-async-spawn-split-stop-and-archive.md`.

## Why this matters

Reviewing Step 3 (`control-plane/src/routes/sessions.js`) found two Boy Scout issues within the
files that step touched:

1. **`pending_bootstrap-failed` is invisible to the dashboard's status badge.** `spawnSandbox()`
   (added by Step 3) sets `sessions.status = 'pending_bootstrap-failed'` when `sandbox.run`/
   `waitForHealth` throws. But `control-plane/dashboard/src/components/StatusBadge.tsx`'s
   `deriveStatus()` (Phase 1) only recognizes `'archived'` and `'active'` as special-cased
   `sessionStatus` values — anything else (including `'pending_bootstrap-failed'`) with a `null`
   Docker phase (true here: no container was ever spawned) falls through to `'stopped'`. A session
   whose bootstrap genuinely *failed* will render in the dashboard identically to one that was
   started and cleanly stopped, with no visual distinction and no way for a user to tell bootstrap
   failed versus succeeded-then-stopped. This directly affects Step 5 (dashboard rendering of
   `pending_bootstrap`/failure states), which is exactly the kind of hand-off gap the Gotchas
   section of Step 3 warned about ("the dashboard must render this state, not treat it as an
   error").

2. **Stale module docstring.** The header comment at the top of
   `control-plane/src/routes/sessions.js` still reads:
   > `POST /api/sessions` (synchronous sandbox bootstrap) ... `/stop` and `PATCH` remain out of
   > scope for this phase.

   Step 3 made `POST /api/sessions` asynchronous and implemented both `/stop` and `PATCH` in this
   same file — the comment is now factually wrong and will mislead whoever reads it next (e.g. the
   Step 5 or Phase 3 implementer skimming this file for current scope).

## Actions

- In `control-plane/dashboard/src/components/StatusBadge.tsx`, special-case
  `sessionStatus === 'pending_bootstrap-failed'` (or a status value agreed with the control-plane
  side) in `deriveStatus()` to return `'failed'` regardless of `dockerPhase`, and add/adjust a unit
  test in `StatusBadge.test.tsx` asserting a failed-bootstrap session renders the `failed` badge,
  not `stopped`.
- Update the module docstring at the top of `control-plane/src/routes/sessions.js` to describe the
  current (post-Step-3) route set and async behavior accurately — no route should be described as
  "out of scope" once it is implemented in the same file.
- Re-run `pnpm --filter dashboard test` and `pnpm --filter control-plane test` after both changes.
