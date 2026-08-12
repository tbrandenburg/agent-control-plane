# Phase 0 Handover — Foundation (Repo, Control Plane, Dashboard, CI/CD)

## a. Executive summary

Phase 0 delivers the project's foundation: a pnpm-workspace monorepo containing a Fastify-based
control-plane API, a React/Vite dashboard served from the same process, a SQLite-backed migration
system, a Make-driven developer workflow with an LOC budget gate, container build/run manifests,
and a full Playwright E2E suite wired into CI. Nothing user-facing (sessions, sandboxes, auth) is
built yet — this phase exists to prove the scaffolding is solid so every later phase can add
features without re-litigating build, test, lint, type-check, containerization, or CI wiring.

## b. What works

All items below were independently re-verified end-to-end on a clean checkout, with no mocking,
stubbing, or skipped steps. Evidence files are in this directory.

- **Workspace installs cleanly** — `pnpm install` resolves all four workspaces (root,
  `control-plane`, `control-plane/dashboard`, `e2e`) deterministically.
  Evidence: [`01-make-install.txt`](./01-make-install.txt)
- **Standard command surface** — `make help` lists every developer command
  (`install run stop test lint build clean loc e2e typecheck`).
  Evidence: [`02-make-help.txt`](./02-make-help.txt)
- **Type-checking gate** — `tsc --noEmit` passes with zero errors across both the JSDoc-typed
  control-plane and the TypeScript dashboard.
  Evidence: [`03-make-typecheck.txt`](./03-make-typecheck.txt)
- **Lint gate** — `biome check` runs clean (one non-blocking style warning, zero errors).
  Evidence: [`04-make-lint.txt`](./04-make-lint.txt)
- **Automated test suite** — 10 control-plane unit/integration tests, 1 dashboard component test,
  and 11 LOC-gate script tests, all passing (22 tests total, 0 failures).
  Evidence: [`05-make-test.txt`](./05-make-test.txt)
- **Dashboard build** — Vite produces a hashed, production-ready static bundle
  (`index.html` + JS/CSS assets) served by the control plane's own static file handler.
  Evidence: [`06-make-build.txt`](./06-make-build.txt)
- **LOC budget gate** — reports authored lines per architectural component
  (91 / 1000 total), enforcing the project's complexity ceiling from commit #1.
  Evidence: [`07-make-loc.txt`](./07-make-loc.txt)
- **Real Docker Compose stack + Playwright E2E** — `make e2e` builds the production image, starts
  the compose stack, waits for `/health`, and runs 3 Playwright specs against the live container
  (not against `vite dev` or a mocked server): dashboard shell renders, `/health` returns 200,
  and the `/sessions/new` SPA route serves the app instead of a 404. All 3 passed.
  Evidence: [`08-make-e2e.txt`](./08-make-e2e.txt)
- **Dashboard renders in a real browser** — manually verified against the running container on
  `http://localhost:3999/` and `http://localhost:3999/sessions/new`.
  Evidence: [`09-dashboard-home.png`](./09-dashboard-home.png),
  [`10-sessions-new-spa-route.png`](./10-sessions-new-spa-route.png)
- **Production image contains the dashboard bundle** — `docker compose exec` confirms
  `control-plane/public/index.html` exists inside the running container, and container logs show
  all requests (`/`, `/health`, `/sessions/new`, static assets) resolving with 200/304, closing the
  gap tracked in step `00501`.
  Evidence: [`11-container-static-assets.txt`](./11-container-static-assets.txt)

## c. How to build and run

Prerequisites: Node 24 (`.nvmrc` pinned), corepack-enabled pnpm, and Docker with Compose.

1. Clone the repository and `cd` into it.
2. `corepack enable && make install` — installs all workspace dependencies.
3. `make build` — builds the dashboard static bundle into `control-plane/public/`.
4. `docker compose up -d --build` — builds the production image and starts the control plane on
   `http://localhost:3000` (set `HOST_PORT=<port>` first if 3000 is already in use on your machine).
5. Open `http://localhost:<port>/` in a browser — the dashboard shell loads.
6. `docker compose down -v` — stops and removes the stack when done.

To run the full automated validation instead of a manual walkthrough:
```
make install && make typecheck && make lint && make test && make build && make loc && make e2e
```

## d. How to test

| # | Action | Expected result |
|---|--------|------------------|
| 1 | `curl http://localhost:<port>/health` | `200 {"status":"ok"}` |
| 2 | Open `http://localhost:<port>/` in a browser | Dashboard app shell (header + empty content area) renders |
| 3 | Open `http://localhost:<port>/sessions/new` | Same SPA shell is served (not a 404) |
| 4 | Open `http://localhost:<port>/sessions/some-id` | Same SPA shell is served (not a 404) |
| 5 | Stop the container, delete `control-plane/public`, restart | Server still boots and `/health` still returns 200 (static file registration degrades gracefully with a warning, does not crash) |
| 6 | `make loc` | Prints a per-component LOC table with a `TOTAL n / 1000 ✅` footer |
| 7 | `make e2e` | Builds the real image, runs 3 Playwright specs against it, exits 0 |

## e. Known limitations

- No authentication, sessions, sandboxes, WebSocket relay, or webhook/reaper logic exists yet —
  this is a Phase 0 foundation only; those land in Phase 1 onward per the roadmap.
- The dashboard renders only an empty app shell; there is no session list, create form, or
  transcript view yet.
- `node:sqlite` is used at Release Candidate stability in this Node version — its API surface may
  shift on a future Node major upgrade; the version is pinned via `.nvmrc`/`engines` to mitigate this.
- The Docker socket (`/var/run/docker.sock`) is mounted into the compose service starting in this
  phase even though no code calls `docker run` yet — a deliberate, documented early grant ahead of
  Phase 1's sandbox lifecycle work, not an oversight.
- One non-blocking lint warning remains in `control-plane/src/db.test.js` (an intentionally unused
  variable in a negative-path test); it does not fail the lint gate.
- CI pipeline (`.github/workflows/ci.yml`) exists in-repo but was not exercised as part of this
  handover; only the local equivalent commands (`typecheck`, `lint`, `test`, `build`, `loc`, `e2e`)
  were independently re-run as evidence above.
