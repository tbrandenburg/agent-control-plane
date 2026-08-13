> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Step `00601` (`wire-real-bootstrap-into-session-spawn-path`, closed) declared Action 7: "Re-run
`make build && make sandbox-image && make e2e && make lint && make test && make loc` and confirm
green." Independently re-running these gates today shows two of them are **not** green:

1. **`pnpm exec biome check .` (the read-only lint gate `make lint`/CI's `checks` job actually
   runs) fails** with a real formatting-drift error in `control-plane/src/routes/sessions.js` — the
   exact file this step modified (`spawnSandbox()`'s destructuring of `body` and the
   `teamConfigRepo` object-literal branch inside the `bootstrapWorkspace()` call). This is the same
   class of drift already documented in this repo's `AGENTS.md` Key Pitfalls ("`pnpm run lint` runs
   `biome check --write .` locally, silently auto-fixing... CI's `checks` job runs the read-only
   `biome check .`... and fails on exactly that drift"): the implementer's local `pnpm run lint`
   auto-fixed the file in place without ever showing this as a failure, so the drift was pushed to
   `closed` undetected.
2. **`make loc` fails**: `1005 / 1000` (over budget by 5 lines), with
   `control-plane/src/routes/sessions.js` now the single largest file in the LOC budget at 340
   lines — this step added the `bootstrapWorkspace()` call, its config resolution, and doc-comment
   updates to that file without checking the budget impact, and the step's own Action 7 checklist
   was either never actually re-run before closing, or its output was not verified.

Both are objectively reproducible today with the exact commands the step itself specifies, so
Action 7 is not sufficient evidence that it was genuinely completed before this step was moved to
`closed`.

## Actions

1. Run `pnpm exec biome check --write control-plane/src/routes/sessions.js` (or equivalent) to fix
   the formatting drift, then re-run the read-only `pnpm exec biome check .` (no `--write`) and
   confirm it exits 0 — do not just trust `pnpm run lint`'s auto-fixing local wrapper.
2. Investigate `control-plane/src/routes/sessions.js`'s 340-line size against the `make loc` budget:
   either reduce it (e.g. extract the bootstrap/spawn-orchestration logic added by step `00601` into
   a separate, focused module) or, if the growth is justified, raise the LOC budget deliberately in
   `Makefile`'s `loc` target with a one-line rationale comment — do not leave `make loc` red.
3. Re-run `make build && make lint && make test && make loc` and confirm all four exit 0, capturing
   the actual output as evidence (not just re-asserting they pass).
4. Note in this gap step's own resolution (or in `docs/phase_02_findings.md` if a related entry
   exists) that step `00601`'s "confirm green" claim for these two gates was not actually true at
   time of closure.
