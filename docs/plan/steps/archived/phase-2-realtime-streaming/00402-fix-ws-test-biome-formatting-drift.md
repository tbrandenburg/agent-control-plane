> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Independent re-review of `docs/plan/steps/in-review/00401-implement-missing-websocket-subset-subscribe-prompt-ping.md`
found that `control-plane/src/routes/ws.test.js` (created by that step) has formatting drift that
fails CI's read-only lint gate:

```
pnpm exec biome check control-plane/src/routes/ws.test.js
```

reports 1 error — three `socket.send(JSON.stringify({...}))` call sites are wrapped onto a single
long line instead of Biome's expected multi-line wrapping (the "fans out a broadcast to two
sockets" and "replies to ping" test bodies).

This matters because `pnpm run lint` runs `biome check --write .` locally, which silently
auto-fixes this drift in place with no visible diff, masking the problem — but `.github/workflows/*.yml`
runs the read-only `pnpm exec biome check .` (no `--write`), which does fail on this exact file.
This is the exact class of pitfall already documented in this repo's `AGENTS.md` Key Pitfalls
("`pnpm run lint` ... silently auto-fixing formatting drift"). Left unfixed, the next `git push`
touching this branch will fail CI's `checks` job on a file that looks clean locally.

All 7 `ws.test.js` test cases pass functionally (`pnpm --filter control-plane exec vitest run
src/routes/ws.test.js` — 7 passed); this is a formatting-only gap, not a functional one.

## Actions

1. Run `pnpm exec biome check --write control-plane/src/routes/ws.test.js` (or manually reformat
   the three flagged `socket.send(JSON.stringify({...}))` call sites to Biome's multi-line form) so
   that:
   ```
   pnpm exec biome check control-plane/src/routes/ws.test.js
   ```
   exits 0 with no errors.
2. Re-run `pnpm --filter control-plane test` and confirm all `ws.test.js` cases still pass
   (formatting-only change, no behavior change expected).
3. Re-run `pnpm exec biome check .` from the repo root and confirm it exits 0 (no other drift
   introduced).
