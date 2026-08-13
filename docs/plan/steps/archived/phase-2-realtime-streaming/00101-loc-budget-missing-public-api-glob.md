> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Step `00100-schema-and-sessions-read-api` created `control-plane/src/routes/sessions.js` (~124
authored LOC), which is exactly the "Public API" row of [`ARCHITECTURE.md`](../../../ARCHITECTURE.md)
§14's LOC budget table. However `scripts/loc.mjs`'s `COMPONENTS` array still has an empty `globs: []`
for the `Public API` row (a placeholder left over from the Phase 0 scaffolding commit), so
`make loc` silently reports `0` for that row instead of counting `sessions.js`.

This matters because:
- Step 00100's own validation command (`make loc`) explicitly claims the total should be
  "consistent with §14's Public API and SQLite rows" — today it is not: `SQLite` is correctly
  wired (49 LOC) but `Public API` is unconditionally `0` regardless of how much route code exists.
- The LOC ceiling gate (`TOTAL n / 1000`) is the project's only automated guard against scope
  creep per component. An empty glob makes that guard silently blind for the single largest
  component in the budget table (~95-110 estimated LOC), and every later step that adds more
  routes to `control-plane/src/routes/*.js` (models, artifacts-proxy, logs, diagnostics) will
  compound the blind spot without any test or command ever catching it.

## Actions

1. In `scripts/loc.mjs`, update the `Public API` row's `globs` from `[]` to
   `['control-plane/src/routes/*.js']` (mirroring the `SQLite` row's pattern of a concrete,
   scoped glob rather than a placeholder).
2. Run `make loc` and confirm the `Public API` row now reports a non-zero count consistent with
   `control-plane/src/routes/sessions.js`'s actual authored-line count, and that `TOTAL` stays
   comfortably under the 1000 LOC ceiling.
3. Re-run `pnpm --filter control-plane test` to confirm no test asserts on the previous (wrong)
   `0` value for this row.
