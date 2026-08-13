# Contributing

Thanks for your interest in improving the Agent Control Plane. This project intentionally stays
small (see the `< 1000 authored LOC` budget in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)) —
please keep that in mind before proposing new abstractions or dependencies.

## Getting started

```bash
make install     # install all workspace dependencies
make run         # start the control-plane server directly (no Docker)
```

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/UI.md`](docs/UI.md) before making
non-trivial changes — they describe the current, final design and the binding constraints
(single Docker host, no multi-tenant HA, deliberate deviations from the original spec).

## Development workflow

1. Create a branch off `main`.
2. Make your change. Keep it modular and scoped — avoid bundling unrelated refactors.
3. Run the full local gate before opening a PR:
   ```bash
   make lint typecheck test
   ```
4. If your change touches model-resolution or config-composition logic (e.g.
   `OPENCODE_CONFIG_CONTENT` composition, bootstrap/clone wiring, provider defaults, `OPENCODE_*`
   env vars passed into the sandbox), also run a real end-to-end check — see the Validation
   Conventions in [`AGENTS.md`](AGENTS.md) for why this is required, not optional.
5. For changes to Docker-based session lifecycle, sandbox spawning, or the dashboard's WebSocket
   handling, run the full E2E suite:
   ```bash
   make e2e
   ```
   For ad-hoc manual verification alongside an already-running stack, use
   `make dev-stack` / `make dev-stack-down` instead of a bare `docker compose up`.
6. Re-check the LOC budget if you added non-trivial code:
   ```bash
   make loc
   ```

## Commit and PR conventions

- Write concise, action-oriented commit messages (conventional-commits style, e.g.
  `fix: stop button now removes the sandbox container`).
- Group related changes; avoid bundling unrelated refactors into the same commit or PR.
- Include the actual command output you used to verify your change in the PR description — this
  repo follows an evidence-first policy: a completion claim without command output/logs to back it
  up is not considered verified.
- Never force-push over shared branches, skip commit hooks, or leave failing tests in a PR.

## Reporting bugs / requesting features

Open a GitHub issue with:
- What you expected to happen vs. what actually happened
- Exact steps/commands to reproduce
- Relevant logs (`docker compose logs`, `make test` output, etc.) — never include credentials or
  tokens in a bug report

## Security issues

Do not open a public issue for security vulnerabilities — see [`SECURITY.md`](SECURITY.md).
