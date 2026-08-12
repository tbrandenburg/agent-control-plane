> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 5: Make targets, LOC gate, and container manifests

#### Changes

##### Create
- `Makefile` — `help install run stop test lint build clean loc e2e typecheck`.
- `scripts/loc.mjs` — budget reporter/gate.
- `control-plane/Dockerfile`, `docker-compose.yml`.

##### Modify
- Root `package.json` — scripts the Makefile delegates to.

##### Remove
- Nothing.

#### Implementation

##### Make surface
Implement the standard command surface from the root `AGENTS.md` and [`ROADMAP.md`](./ROADMAP.md)
Phase 0 "Task runner" row: `install run stop test lint build clean`, plus `loc`, `e2e`, `typecheck`.
Default target is `help`, auto-generated from `##` comments on each target.

##### LOC gate
`scripts/loc.mjs` globs the counted paths, strips blank and comment-only lines, groups counts into the
§14 component rows, prints the table with a `TOTAL n / 1000` footer, and exits 1 above the ceiling.
Exclusions are exactly [`ARCHITECTURE.md` §1](./ARCHITECTURE.md)'s scope boundary — dashboard source,
tests, e2e, SQL, manifests, config, generated types. Encode the include/exclude lists as data at the top
of the script so later phases adjust one array rather than the logic.

##### Container manifests
`control-plane/Dockerfile`: Node 24 slim base, pnpm via corepack, production install, non-root user,
`HEALTHCHECK` hitting `/health`. `docker-compose.yml`: one `control-plane` service, `./data:/data`,
`/var/run/docker.sock:/var/run/docker.sock`, port 3000, **no `version:` key** (deprecated per
[`ROADMAP.md`](./ROADMAP.md)'s modernity check log). No `sandbox-net`/`egress-net`/`sandbox-proxy` yet.

**Deliberate exception, called out explicitly:** mounting the Docker socket here is a security-sensitive
resource grant introduced a full phase before any code exercises it — Phase 0 has zero session/sandbox
logic ("Excluded" section above). This is accepted anyway, as a stated trade-off rather than an oversight,
because the compose service definition is otherwise churn-prone to change later and the socket itself is
inert without `sandbox.run()` (Phase 1) actually calling `docker run`. If this is judged too early, the
alternative is to add the mount only in Phase 1's `docker-compose.yml` change instead.


##### Error Handling
`make loc` failure prints the per-row breakdown *and* the top offending files by count, so the failure is
actionable rather than a bare number.

##### Output / UX
`make loc` output shape:
```
Component                                   LOC
Public API                                    0
...
TOTAL                                    0 / 1000  ✅
```
Use `✅`/`❌` only in this generated CLI table — never in source or comments (root `AGENTS.md`).

#### Patterns & Constraints

##### Mirror
[`ARCHITECTURE.md` §14](./ARCHITECTURE.md)'s exact component row names, so the gate's output is directly
comparable to the documented budget.

##### Decisions
- The gate counts *authored* lines only; the exclusion list is normative and lives in one place.
- Docker socket is mounted from Phase 0 because Phase 1's `sandbox.run()` needs it and changing the compose
  contract later is churn.

##### Gotchas
- Counting `proxy/Caddyfile` must not fail when the file does not exist yet (Phase 4) — treat missing
  counted paths as zero, not as an error.
- Mounting the Docker socket into a non-root container requires matching the host docker group, or the
  Phase 1 spawn path fails with a permission error that looks unrelated.

##### Out of Scope
Multi-stage image optimisation, image publishing, compose profiles for sandboxes.

#### Tests

##### E2E
Deferred to Step 6.

##### Integration
`docker compose up -d` then `curl -fsS localhost:3000/health` returns 200.

##### Unit
`loc.mjs` counting logic against fixtures: blank lines, comment-only lines, and excluded paths all
contribute zero; a file over the ceiling triggers exit code 1.

#### Validation

##### Commands
```
make help && make build && make loc && docker compose up -d && curl -fsS localhost:3000/health && docker compose down -v
```

##### Expected Results
Help lists every target; `make loc` prints the table and exits 0 near zero; health check returns
`{"status":"ok"}`.
