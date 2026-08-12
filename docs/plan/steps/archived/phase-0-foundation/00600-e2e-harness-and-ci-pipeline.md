> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 6: E2E harness and CI pipeline

#### Changes

##### Create
- `e2e/playwright.config.ts`, `e2e/tests/smoke.spec.ts`.
- `.github/workflows/ci.yml`.

##### Modify
- `Makefile` — `make e2e` brings the compose stack up, runs Playwright, tears it down deterministically.

##### Remove
- Nothing.

#### Implementation

##### Playwright harness
`webServer` is **not** used to fake a server — the config points `baseURL` at the real compose stack.
[`ARCHITECTURE.md` §1](./ARCHITECTURE.md)'s evidence-first stance and the root `AGENTS.md` both forbid
mocking Docker in E2E. `make e2e` runs `docker compose up -d --build`, waits for the health endpoint,
runs the specs, then `docker compose down -v` in a trap so a failed run still cleans up.

##### Smoke spec
Navigate to `/`, assert the dashboard shell renders; assert `GET /health` returns 200; assert
`/sessions/new` serves the SPA rather than 404. This is the regression baseline every later phase inherits.

##### CI pipeline
Ordered jobs per [`ROADMAP.md`](./ROADMAP.md) Phase 0 "CI" row: typecheck → lint → unit → integration →
E2E on a real compose stack → `make loc`. Fail fast; upload the Playwright report on failure.

##### Error Handling
The health-wait loop has a bounded timeout (e.g. 60s) and, on expiry, dumps `docker compose logs` before
failing — otherwise CI E2E failures are undiagnosable.

##### Output / UX
CI surfaces the `make loc` table in the job summary so budget drift is visible on every PR, not only on failure.

#### Patterns & Constraints

##### Mirror
[`ROADMAP.md`](./ROADMAP.md) Phase 0 exit criterion: `make test` green on an empty skeleton, CI green,
LOC gate reporting `0 / 1000`, `vite build` producing a servable bundle.

##### Decisions
- The LOC gate runs in CI from commit #1, making §14 continuously falsified rather than end-checked.
- E2E always runs against `docker compose`, never against `vite dev` or a bare `node` process.

##### Gotchas
- GitHub Actions runners have Docker available but image builds are cold — cache the pnpm store and the
  Docker layer cache or E2E job time balloons.
- Playwright browsers must be installed with `--with-deps` in CI.

##### Out of Scope
Release/publish workflows, matrix builds across Node versions (one pinned Active LTS only), coverage
thresholds (introduce when there is code worth thresholding).

#### Tests

##### E2E
`smoke.spec.ts` — the three assertions above.

##### Integration
Covered by the compose-up health check inside `make e2e`.

##### Unit
None specific to this step.

#### Validation

##### Commands
```
make e2e && make lint && make test && make loc
```

##### Expected Results
Playwright smoke suite green against the real stack; CI green end-to-end on a pushed branch; `make loc`
reports a total far below 1000. This satisfies [`ROADMAP.md`](./ROADMAP.md)'s Phase 0 exit criterion and
unblocks [`docs/phase_01_plan.md`](./phase_01_plan.md).
