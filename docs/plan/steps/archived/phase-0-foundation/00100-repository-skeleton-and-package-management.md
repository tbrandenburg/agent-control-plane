> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 1: Repository skeleton and package management

#### Changes

##### Create
- `.nvmrc` (`24`), root `package.json` with `engines.node`, `packageManager` (corepack-pinned pnpm), and `private: true`.
- `pnpm-workspace.yaml` listing `control-plane`, `control-plane/dashboard`, `e2e`.
- `.gitignore`, `.dockerignore`.
- `control-plane/package.json`, `control-plane/dashboard/package.json`, `e2e/package.json`.
- `sandbox/.gitkeep`, `proxy/.gitkeep`.

##### Modify
- `AGENTS.md` — link the phase plans alongside the existing steering documents.

##### Remove
- Nothing.

#### Implementation

##### Workspace layout
Mirror [`ROADMAP.md`](./ROADMAP.md) Phase 0's "Repo layout" row exactly: `docs/`, `control-plane/`,
`sandbox/`, `proxy/`, `e2e/`, `.github/`. The dashboard is nested at `control-plane/dashboard/` because
its build output is consumed by the control plane's own `@fastify/static` root
([`ARCHITECTURE.md` §5](./ARCHITECTURE.md)).

##### Dependency policy
Control plane runtime deps only: `fastify` (pinned `^5`), `@fastify/static`. `@fastify/websocket`,
`@fastify/secure-session`, and `openid-client` are **not** installed yet — they arrive with the phases
that use them (P2 and P4 respectively), keeping the dependency graph honest per phase.

**Reconciling with [`ROADMAP.md`](./ROADMAP.md)'s Phase 0 table:** that table's "Web framework" row lists
`Fastify v5.x (@fastify/static, @fastify/secure-session, @fastify/websocket)` together, which reads as if
all three plugins are chosen in Phase 0. This plan interprets that row as naming the overall framework
ecosystem decision (which plugins this project will use, eventually), not a mandate to install unused
auth/WebSocket plugins against Phase 0's own "zero authored logic beyond a health route" constraint —
installing them now would add dead dependency weight with nothing to exercise them. This is a deliberate,
stated reading of an ambiguous steering-doc row, not a silent deviation; flag the row for disambiguation
in `ROADMAP.md` itself if this interpretation is contested.

##### Error Handling
`make install` must fail loudly if the active Node major is not 24 — enforce via `engines` plus
`engine-strict=true` in `.npmrc`, not a hand-written check.

##### Output / UX
`pnpm install` at root installs all three workspaces in one command; `make install` is a thin wrapper.

#### Patterns & Constraints

##### Mirror
[`ROADMAP.md`](./ROADMAP.md) Phase 0 control-plane and dashboard tables, row for row.

##### Decisions
- pnpm, not Bun or npm — [`ROADMAP.md`](./ROADMAP.md) "the one tension" section.
- Lockfile committed; corepack pins the pnpm version.

##### Gotchas
- pnpm's strict `node_modules` means any phantom dependency surfaces immediately — good, but expect
  explicit installs for anything a transitive dep previously provided.
- Nesting the dashboard inside `control-plane/` requires it to be an explicit workspace entry, otherwise
  pnpm will not link it.

##### Out of Scope
Publishing config, changesets, release automation, Renovate/Dependabot.

#### Tests

##### E2E
None yet.

##### Integration
None yet.

##### Unit
None yet.

#### Validation

##### Commands
```
corepack enable && pnpm install && pnpm -r ls --depth 0
```

##### Expected Results
All three workspaces resolve; no phantom-dependency warnings; lockfile is deterministic on a second run.
