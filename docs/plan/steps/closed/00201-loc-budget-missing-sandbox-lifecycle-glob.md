> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Step `00200-sandbox-lifecycle-via-the-docker-cli` created `control-plane/src/sandbox.js` (124
authored LOC), which is exactly the "Sandbox lifecycle" row of
[`ARCHITECTURE.md`](../../../ARCHITECTURE.md) §14's LOC budget table. However `scripts/loc.mjs`'s
`COMPONENTS` array still has an empty `globs: []` for the `Sandbox lifecycle` row (the same
Phase 0 scaffolding placeholder already found and fixed once before for the `Public API` row in
`00101-loc-budget-missing-public-api-glob`), so `make loc` silently reports `0` for that row
instead of counting `sandbox.js`.

This matters because:
- `make loc` currently reports `TOTAL 218 / 1000`, but the true authored total including
  `sandbox.js` is `342 / 1000` — a ~57% undercount of the actual budget consumption.
- The LOC ceiling gate is the project's only automated guard against per-component scope creep.
  An empty glob makes that guard silently blind for the sandbox lifecycle component, and every
  later step that grows `sandbox.js` (or adds sibling files to that component) will compound the
  blind spot without any test or command ever catching it.
- This is the second time this exact class of bug has occurred (see `00101`), which suggests the
  "later phases add/adjust rows and globs here only" convention documented in `scripts/loc.mjs`'s
  own header comment is being missed when new component files are created — each step that adds a
  new §14 component's first file must also wire its `COMPONENTS` row glob in the same change.

## Actions

1. In `scripts/loc.mjs`, update the `Sandbox lifecycle` row's `globs` from `[]` to
   `['control-plane/src/sandbox.js']` (mirroring the `SQLite` and `Public API` rows' pattern of a
   concrete, scoped glob rather than a placeholder).
2. Run `make loc` and confirm the `Sandbox lifecycle` row now reports a non-zero count consistent
   with `control-plane/src/sandbox.js`'s actual authored-line count (124), and that `TOTAL` stays
   comfortably under the 1000 LOC ceiling.
3. Re-run `pnpm --filter control-plane test` to confirm no test asserts on the previous (wrong)
   `0` value for this row.
