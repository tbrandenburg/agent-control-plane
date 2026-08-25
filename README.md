# Agent Control Plane

A thin, Docker-only control plane for running non-interactive, background [`opencode`](https://opencode.ai)
coding-agent sessions in isolated sandbox containers — no Kubernetes, no Helm, no service mesh, no
PostgreSQL. One control-plane process, one SQLite database, one Docker host.

Each session spawns a dedicated sandbox container that clones a target GitHub repo, runs `opencode
serve` against a chosen model, and streams prompt/response events back to a dashboard over
WebSocket. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and
[`docs/UI.md`](docs/UI.md) for the dashboard's screen-by-screen behavior.

## Quickstart

```bash
make install   # install all workspace deps (pnpm)
make run       # bring up the persistent, real docker compose stack
```

Or run the control-plane locally via pnpm, no Docker/sandboxing:

```bash
make run-dev
```

The dashboard is served at `http://localhost:${HOST_PORT:-3000}`. Stop the Docker stack with
`make stop`.

## Make targets

Run `make help` for the full list. Most common:

| Target | Description |
|---|---|
| `make install` | Install all workspace dependencies |
| `make run` | Bring up the persistent, real docker compose stack (fresh dev bring-up) |
| `make stop` | Stop the docker compose stack |
| `make run-dev` | Start the control-plane server locally via pnpm (no Docker) |
| `make test` | Run all unit/integration tests |
| `make lint` | Check and fix code quality with Biome |
| `make typecheck` | Type-check all workspaces with `tsc` |
| `make build` | Build the dashboard static bundle |
| `make e2e` | Build the sandbox image, bring up the real docker compose stack, run Playwright, tear down |
| `make dev-stack` / `make dev-stack-down` | Isolated, ad-hoc verification stack (unique port + compose project + network) safe to run alongside another already-running stack |
| `make sandbox-image` | Build the `agent-sandbox:local` image used by spawned sessions |
| `make deploy` | Rebuild and redeploy the control-plane with the current commit's `GIT_SHA` baked in |
| `make release BUMP=patch\|minor\|major` | Bump the version, tag, push, and cut a GitHub release |
| `make loc` | Print the authored-LOC budget table and fail if over the ceiling |
| `make clean` | Remove build artifacts and `node_modules` |

## Project layout

- `control-plane/` — the Fastify server, SQLite schema/migrations, and dashboard SPA (`dashboard/`)
- `sandbox/` — the sandbox container image and bridge process that runs inside each spawned session
- `e2e/` — Playwright end-to-end tests run against a real docker compose stack
- `scripts/` — repo-maintenance scripts (e.g. the LOC budget checker)
- `docs/` — architecture, UI, roadmap, and phase implementation plans

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Dashboard UI](docs/UI.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

[MIT](LICENSE)
