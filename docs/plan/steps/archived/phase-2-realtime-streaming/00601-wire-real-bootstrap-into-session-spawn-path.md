> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

`control-plane/src/bootstrap.js`'s `bootstrapWorkspace()` (Step 00100, closed) is fully implemented
and unit-tested (`bootstrap.test.js`, including real-network fixtures against real GitHub and a real
unreachable host) — but it is **never called** from `control-plane/src/routes/sessions.js`'s
`spawnSandbox()` (Step 00300, closed) or anywhere else in the request path. `POST /api/sessions`'s
`repoOwner`/`repoName`/`teamConfigRepo` body fields are validated (`isValidRepoSegment`) but
otherwise unused; `control-plane/src/config.js`'s `platformConfigRepo` (Step 00200, closed) is
likewise never read outside its own unit test.

Consequently `control-plane/src/sandbox.js`'s `run()` still bind-mounts the single, global,
Phase-1-era `WORKSPACE_HOST_PATH` directory (`docker-compose.yml`'s `./workspace`) for **every**
session, regardless of which `repoOwner`/`repoName` a caller supplies — the exact "hardcoded
pre-cloned repo" shortcut `docs/phase_02_plan.md` states was "replaced by real bootstrap output."
It has not been, for any session created via the HTTP API.

This was discovered and independently verified live during step `00600`'s manual E2E run (not
caught by any automated check, since `bootstrap.test.js` only unit-tests `bootstrapWorkspace()` in
isolation and `session-lifecycle.spec.ts` never asserted on which repo actually landed in the
sandbox): `POST /api/sessions` with an arbitrary `repoOwner`/`repoName` still spawns a working
session against whatever is already bind-mounted at `WORKSPACE_HOST_PATH`. Recorded as a finding in
`docs/phase_02_findings.md` §3.

This matters because [`ROADMAP.md`](../../../ROADMAP.md)'s Phase 2 exit criterion is explicitly "a
human creates a session against an **arbitrary** repository ... from the dashboard" — not yet
demonstrably true end-to-end, even though every other part of the phase (WebSocket transport, async
spawn split, stop, model/reasoning-effort passthrough, bootstrap-classification accuracy) is now
verified working with a real model (`opencode/big-pickle`, see step `00602`).

## Actions

1. In `control-plane/src/routes/sessions.js`'s `spawnSandbox()`, call `bootstrapWorkspace()` (with
   the session's `repoOwner`/`repoName` resolved to a target-repo URL/ref, `config.js`'s
   `platformConfigRepo`, and the optional `teamConfigRepo` from the request body) **before**
   `sandbox.run()`, per-session, into a per-session base directory (e.g.
   `<WORKSPACE_HOST_PATH>/<sessionId>/` or a dedicated bootstrap root env var) — never the single
   global `WORKSPACE_HOST_PATH` directory shared across sessions.
2. Update `control-plane/src/sandbox.js`'s `run()` to accept and bind-mount the
   `bootstrapWorkspace()`-produced `targetDir`/`platformConfigDir`/`teamConfigDir` layout instead of
   the static `WORKSPACE_HOST_PATH` — remember the control plane itself runs in a container, so
   these must resolve to HOST paths (mirroring the existing `WORKSPACE_HOST_PATH` comment's
   rationale), not paths inside the control-plane container.
3. On any hard-failure classification (`not_found`/`auth`/`network`/`unknown` for the
   target/platform layers), leave the session in `pending_bootstrap-failed` exactly as the existing
   catch-all in `spawnSandbox()` already does — no new status value needed this step.
4. Add a minimal, real Platform-config-repo fixture for `make e2e` (e.g. a small bare git repo
   under `e2e/fixtures/` with an `.opencode/opencode.json` — needed only if a *non-native* model
   requiring a Platform-config-repo provider block is ever exercised in E2E again; **not** required
   for `opencode/big-pickle`-based scenarios per step `00602`, but still needed to prove the
   "arbitrary repository" exit criterion clones a real, distinct target repo, not just the same
   static `WORKSPACE_HOST_PATH` under a new name).
5. Add/extend an E2E variant in `e2e/tests/session-lifecycle.spec.ts` (or a new spec) that creates a
   session against a *different*, distinct real repo than any other test in the suite and asserts
   the cloned content actually differs (e.g. checks for a file unique to that fixture repo inside
   the sandbox, via the bridge or a dedicated diagnostic — whatever is cheapest without adding scope
   beyond this gap) — proving `repoOwner`/`repoName` are no longer ignored.
6. Update `control-plane/src/sessions.test.js`/`sandbox.test.js` unit tests to cover the new
   `bootstrapWorkspace()` call (mocked, per existing unit-test conventions in this file) and the
   failure-classification → `pending_bootstrap-failed` path when bootstrap itself fails (as opposed
   to only `sandbox.run()`/`waitForHealth()` failing, which is all today's tests cover).
7. Re-run `make build && make sandbox-image && make e2e && make lint && make test && make loc` and
   confirm green, including the new arbitrary-repo variant.
8. Update `docs/phase_02_findings.md` §3 to record this gap as resolved, with the same evidence-first
   format as the rest of that document (what was verified, how, and the actual observed result).
