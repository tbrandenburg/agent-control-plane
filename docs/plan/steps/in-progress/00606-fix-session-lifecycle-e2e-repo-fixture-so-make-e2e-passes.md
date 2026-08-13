> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Step `00602` (`retire-stub-model-adopt-opencode-big-pickle-default`, in-review) declares Action 5:
"Re-run `make e2e` ... to confirm the updated default still passes." Independently re-running the
full suite today (isolated stack, `-p acp-review-00602`, per this repo's own documented isolation
pattern) shows it does **not** pass:

```
✓ tests/bootstrap-failures.spec.ts (4/4)
✘ tests/session-lifecycle.spec.ts:166 › create (202) → pending_bootstrap → active → ... (55.6s)
✘ tests/session-lifecycle.spec.ts:226 › variant: two concurrent WS subscribers ... (55.2s)
```

Both failures show the same root cause, captured in the first test's own error output:

```
Error: timed out waiting for session status; last saw: {..., "status":"pending_bootstrap-failed", ...}
```

`e2e/tests/session-lifecycle.spec.ts`'s `createSession()` still hardcodes `repoOwner: 'acme'`,
`repoName: 'widgets'` — a placeholder that was never a real, clonable GitHub repo. This was harmless
before step `00601` (`bootstrapWorkspace()` was implemented but never actually wired into
`spawnSandbox()`), but `00601` wired it for real: every session created by this spec now genuinely
attempts `git clone https://github.com/acme/widgets`, which fails (GitHub returns 401/`could not read
Username` for a private-or-nonexistent repo, not a 404), classifying the session as
`pending_bootstrap-failed` before it ever reaches model resolution. This is **not** a regression
caused by step `00602`'s own model-default change — the fixture was already stale — but it does mean
`00602`'s own Action 5 validation claim ("confirm the updated default still passes") is not actually
true today, and this repo's `AGENTS.md` Key Pitfalls already flags this exact gap as "out of scope
for step 00602 ... needs its own follow-up gap step," which had not yet been created.

**Not a duplicate of step `00604`:** `00604` (planned) adds a *new*, additional E2E variant proving
two *distinct* real repos clone correctly (Action 5 there: "creates two sessions against two distinct
repos ... asserts each sandbox's `/workspace/repo` contains content unique to its own repo"). It does
not fix the *existing* two tests in `session-lifecycle.spec.ts` that are failing today for every
single run of `make e2e` — those tests must pass on their own, independent of whatever `00604` adds.
Fixing the fixture (Action 1 below) happens to unblock both this gap and `00604`'s Action 2, so
whichever step lands first should leave a pointer for the other to avoid re-doing the work.

## Actions

1. Replace the hardcoded `repoOwner: 'acme'`, `repoName: 'widgets'` in
   `e2e/tests/session-lifecycle.spec.ts` with a real, public, always-clonable GitHub repository (a
   small, stable, well-known public repo, or a fixture repo owned by this project) so
   `bootstrapWorkspace()`'s real `git clone` succeeds during every `make e2e` run.
2. Re-run the full suite (`make e2e`, isolated per this repo's `-p <project-name>` pattern if a
   stack is already running on the host) and confirm all `session-lifecycle.spec.ts` tests pass —
   capture the actual pass/fail summary as evidence, not just "looks fixed."
3. Update `docs/phase_02_findings.md` to record that this specific fixture gap (previously noted as
   open in `AGENTS.md`) is now resolved, with the re-run evidence from Action 2.
4. Cross-check with step `00604` (if still open) to avoid picking a second, different fixture repo
   for the same purpose — reuse whichever repo this step selects, or explicitly note in `00604`'s
   own actions that Action 1 here already supplies its distinct-repo fixture.
