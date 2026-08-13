> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Step `00601` (`wire-real-bootstrap-into-session-spawn-path`, closed) fully implements Actions 1-3
and 6: `control-plane/src/routes/sessions.js`'s `spawnSandbox()` now calls `bootstrapWorkspace()`
per-session, `control-plane/src/sandbox.js`'s `run()` bind-mounts the resulting
`targetDir`/`platformConfigDir`/`teamConfigDir` layout instead of the single global
`WORKSPACE_HOST_PATH`, and `control-plane/src/routes/sessions.test.js` covers both the mocked
`bootstrapWorkspace()` call and the `pending_bootstrap-failed` classification when bootstrap itself
fails.

However, three of the step's own declared Actions were never done, independently re-verified live:

1. **Action 4 (Platform-config-repo fixture) — missing.** `ls e2e/fixtures/` contains only
   `git-failure-fixtures.mjs` and `stub-model-server.mjs`; no bare-git-repo fixture with an
   `.opencode/opencode.json` exists anywhere under `e2e/`.
2. **Action 5 (distinct-repo E2E variant) — missing.** `grep -n "distinct\|arbitrary"
   e2e/tests/*.spec.ts` matches nothing. `e2e/tests/session-lifecycle.spec.ts` still only exercises
   a single hardcoded `repoOwner: 'acme'` / `repoName: 'widgets'` pair; no test asserts that two
   sessions created against two different `repoOwner`/`repoName` values actually end up with
   different cloned content inside their sandboxes. The ROADMAP Phase 2 exit criterion ("a human
   creates a session against an **arbitrary** repository") therefore remains unverified end-to-end,
   even though the wiring code itself is now real.
3. **Action 8 (findings doc closure) — missing.** `docs/phase_02_findings.md` §3 ("Separate,
   still-open finding: real bootstrap for *arbitrary* target repos is not wired in") still reads as
   an open finding verbatim from before this step, with no update recording that Actions 1-3/6 are
   now resolved or that Actions 4-5 remain outstanding.

This matters because without Action 5, nothing actually falsifies whether `bootstrapWorkspace()`'s
wiring works against two genuinely different repos in a real container — only unit tests with a
mocked `bootstrapWorkspace()` exist, which cannot catch a wiring mistake (e.g. an accidental shared
`targetDir` across sessions, or a swapped `platformConfigDir`/`teamConfigDir` bind-mount) that a real
git clone + container inspection would catch.

## Actions

1. Add a minimal, real Platform-config-repo fixture under `e2e/fixtures/` (a small bare git repo,
   built the same way `e2e/fixtures/git-failure-fixtures.mjs` already builds its fixtures) with an
   `.opencode/opencode.json` containing a distinguishing marker file/value.
2. Add a second, distinct target-repo fixture (or reuse an existing distinct public repo already
   used elsewhere in the suite) so two sessions can be created against two different
   `repoOwner`/`repoName` values in the same E2E run.
3. Add an E2E test (in `e2e/tests/session-lifecycle.spec.ts` or a new spec) that creates two
   sessions against the two distinct repos from steps 1-2 and asserts, via the bridge or a
   diagnostic endpoint, that each sandbox's `/workspace/repo` actually contains content unique to
   its own repo — proving `repoOwner`/`repoName` are no longer ignored and no session accidentally
   shares another session's cloned directory.
4. Update `docs/phase_02_findings.md` §3 to record: which parts of the original finding are now
   resolved (Actions 1-3/6, with re-run evidence), and which parts (the arbitrary-repo E2E proof)
   remained open until this gap step closed them — following the same evidence-first format as the
   rest of that document.
5. Re-run `make e2e` (isolated, per this repo's own documented `-p <project-name>` isolation
   pattern if a stack is already running on the host) and confirm the new variant passes.
