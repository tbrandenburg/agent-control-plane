> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Independent re-review of `docs/plan/steps/in-review/00402-fix-ws-test-biome-formatting-drift.md`
(which itself fixed a Biome formatting drift in `control-plane/src/routes/ws.test.js`) found that
`pnpm exec biome check .` from the repo root still fails with 1 error, unrelated to that step's
scope:

```
control-plane/dashboard/src/components/StatusBadge.test.tsx format
  × Formatter would have printed the following content:
    109 │ - ······<StatusBadge·sessionStatus="pending_bootstrap-failed"·dockerPhase={null}·/>,
    109 │ + ······<StatusBadge
    110 │ + ········sessionStatus="pending_bootstrap-failed"
    111 │ + ········dockerPhase={null}
    112 │ + ······/>,
```

This is the exact same class of pitfall already documented in this repo's `AGENTS.md` Key
Pitfalls: `pnpm run lint` runs `biome check --write .` locally, which silently auto-fixes this
drift with no visible diff, while CI's `checks` job runs the read-only `pnpm exec biome check .`
and fails on it. This file was last touched by the Phase 1 "spawn an agent from the dashboard"
commit (`2e79eb0`), not by step 00402 — so it is out of scope for that step (per this repo's own
00202 precedent: out-of-scope steps must not silently absorb and "fix" a failure that isn't
theirs) and is raised here as its own gap instead.

Left unfixed, the next `git push` touching this branch will fail CI's `checks` job on a file that
looks clean locally, exactly as previously happened with `ws.test.js`.

## Actions

1. Run `pnpm exec biome check --write control-plane/dashboard/src/components/StatusBadge.test.tsx`
   (or manually reformat the flagged `<StatusBadge sessionStatus="pending_bootstrap-failed"
   dockerPhase={null} />` call site to Biome's multi-line form) so that:
   ```
   pnpm exec biome check control-plane/dashboard/src/components/StatusBadge.test.tsx
   ```
   exits 0 with no errors.
2. Re-run `pnpm --filter dashboard test` (or the equivalent StatusBadge test command) and confirm
   all `StatusBadge.test.tsx` cases still pass (formatting-only change, no behavior change
   expected).
3. Re-run `pnpm exec biome check .` from the repo root and confirm it exits 0 (no other drift
   remaining).
