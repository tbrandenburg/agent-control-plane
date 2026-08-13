> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

While independently re-running step 00600's mandated validation command
(`make build && make sandbox-image && make e2e && make lint && make test && make loc`), `make test`
failed deterministically (reproduced twice, not flaky):

```
FAIL  src/sandbox.test.js > real Docker integration > runs, inspects as running, and waits for
health against a real container
AssertionError: expected 'starting' to be 'running'
```

`control-plane/src/sandbox.test.js:349-351` calls `inspect(NAME)` immediately after the container
is started and asserts `status.state === 'running'`, but Docker still reports the container as
`starting` at that point — a race between container start and the assertion, with no retry/poll
for the state transition.

This test was introduced in step `00200-sandbox-lifecycle-via-the-docker-cli.md` (closed), so it
predates step 00600. However step 00600 explicitly requires `make test` (full workspace suite) to
pass as part of its own validation gate, and it does not. Left unfixed, this either (a) blocks
CI/every future step's `make test` run non-deterministically, or (b) trains future implementers to
ignore red `make test` output as "pre-existing and not my problem," which erodes the "never leave
failing tests" rule.

## Actions

1. In `control-plane/src/sandbox.test.js`, fix the "real Docker integration" test so it waits for
   the container to actually reach `running` state before asserting on it — e.g. poll `inspect()`
   with a short bounded retry/backoff (mirroring the existing health-check polling pattern already
   used elsewhere in the same file), rather than asserting immediately after `run()` resolves.
2. Re-run `pnpm --filter control-plane test` (or `make test`) at least 3 times in a row to confirm
   the race is fixed and not merely narrowed.
3. Confirm `make test` is green end-to-end (all workspaces) as part of closing this gap.
