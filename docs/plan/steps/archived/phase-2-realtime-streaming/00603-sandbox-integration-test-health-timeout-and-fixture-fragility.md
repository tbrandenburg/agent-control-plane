> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Independently re-running step `00601-implement-missing-e2e-vertical-slice-and-findings.md`'s
mandated validation command (`make build && make sandbox-image && make e2e && make lint && make
test && make loc`), `make e2e`, `make build`, `make sandbox-image`, `make lint`, and `make loc` are
all green (all 6 Playwright tests pass, including the new `session-lifecycle.spec.ts`'s 3 tests).
`make test` fails deterministically (reproduced 3 times, not flaky):

```
FAIL  src/sandbox.test.js > real Docker integration > runs, inspects as running, and waits for
health against a real container
AssertionError: promise rejected "Error: sandbox container sandbox-integrat…" instead of resolving
Caused by: Error: sandbox container sandbox-integration-test did not become healthy within 15000ms
```

Root cause, confirmed by manually reproducing the same container-launch parameters this test uses
(same image, same `docker network inspect bridge` gateway IP, same fake control-plane HTTP server
pattern): a container on the `bridge` network cannot reach a plain `http.createServer` bound on the
host at the `docker0` gateway IP (`172.17.0.1`) in this environment — the connection times out
(`UND_ERR_CONNECT_TIMEOUT`) rather than being refused. `sandbox/bridge.js`'s `start()` calls
`getOrCreateOcSession()` before marking itself ready, and that call's `postJSON` to
`CONTROL_PLANE_URL` is unwrapped at the top level (no try/catch around the `start()` call chain other
than the final `.catch` that logs and `process.exit(1)`s) — so an unreachable control-plane callback
at startup crashes the whole bridge process, the container exits, and its `HEALTHCHECK` can never
report `running`, no matter how long `waitForHealth`'s timeout is raised.

This matters because:
- `control-plane/src/sandbox.test.js`'s "real Docker integration" describe block hard-codes reaching
  the host via the `docker0` bridge gateway IP with a bare `http.createServer` — a pattern that is
  not universally routable (firewalled Docker hosts, rootless Docker, sandboxed CI runners, or any
  environment with `DOCKER-USER` iptables rules blocking bridge→host traffic, as observed here).
  Left as-is, `make test` — one of this step's own required green gates — will keep failing in any
  environment with this restriction, training future implementers to treat red `make test` as
  "environment noise" rather than a real signal (violating root `AGENTS.md`'s "never leave failing
  tests" rule).
- Separately, `sandbox/bridge.js`'s hard crash-on-unreachable-control-plane-at-startup behavior
  (already called out as a real leak in `docs/phase_01_findings.md`'s seam-contract section) means
  any transient control-plane unavailability at sandbox boot — not just a broken test fixture —
  permanently fails that sandbox's startup instead of retrying, which is a production robustness
  gap, not merely a test-fragility one.

## Actions

1. Make the "real Docker integration" test's fake control-plane fixture reachable from the
   container without depending on `docker0` gateway routing — e.g. run the fixture HTTP server
   inside a container on the same `bridge` network (or the network the sandbox uses) and address it
   by container name/DNS, or use `host.docker.internal` where supported, with a documented fallback.
   Verify by running `pnpm --filter control-plane test` at least 3 times in a row with no `docker0`
   connectivity assumptions.
2. Decide (and document in `docs/phase_01_findings.md` or a follow-up ADR) whether
   `sandbox/bridge.js`'s `start()` should retry `getOrCreateOcSession()`'s control-plane callback
   with bounded backoff instead of crashing the process outright on the very first unreachable
   attempt — this affects both real-world resilience (control-plane restarts, transient network
   blips) and test fixture reliability alike.
3. Re-run `make build && make sandbox-image && make e2e && make lint && make test && make loc` and
   confirm all six are green together, in this repo's actual CI/dev environment (not just green
   individually or in isolation).
