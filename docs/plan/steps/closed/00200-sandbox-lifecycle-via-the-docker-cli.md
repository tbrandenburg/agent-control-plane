> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 2: Sandbox lifecycle via the Docker CLI

#### Changes

##### Create
- `control-plane/src/sandbox.js` — `run()`, `inspect()`, `waitForHealth()`.
- `control-plane/src/sandbox.test.js`.
- `sandbox/Dockerfile`, `sandbox/package.json`.

##### Modify
- `docker-compose.yml` — build the sandbox image; expose `SANDBOX_IMAGE` to the control plane.
- `Makefile` — `make sandbox-image`.

##### Remove
- Nothing.

#### Implementation

##### `sandbox.run(session)`
`child_process.spawn('docker', ['run', '-d', ...])` per [§13](./ARCHITECTURE.md) (plain `docker run`, the
direct analog of one K8s Job per session). Arguments: `--name <container_name>`, `--network egress-net`
(**PHASE-4: becomes `sandbox-net` with `internal: true`**), `-v <host repo path>:/workspace/repo:ro`
(hardcoded pre-cloned repo this phase), `-e SESSION_ID`, `-e CONTROL_PLANE_URL`,
`-e OPENCODE_CONFIG_CONTENT`, `-e LITELLM_*` (**PHASE-4: injected by the Caddy proxy instead**).

`OPENCODE_CONFIG_CONTENT` is the minimal non-negotiable layer from [§8](./ARCHITECTURE.md): `model`,
`autoupdate: false`, and the `provider.litellm` block. In this phase `baseURL` points straight at
LiteLLM; Phase 4 repoints it at `http://sandbox-proxy:8080/litellm`.

##### `sandbox.inspect(name)`
`docker inspect` → `{ exists, state }`. Shape it exactly as [§7](./ARCHITECTURE.md)'s
`resolveActiveSession` will consume it in Phase 3, so continuation needs no refactor. A missing container
is `{ exists: false }`, not an error.

##### `sandbox.waitForHealth(name)`
Poll `docker inspect`'s health status (or the bridge's `GET /global/health`) with backoff until healthy or
a bounded timeout — [§8](./ARCHITECTURE.md)'s healthcheck-gated readiness.

##### Sandbox image
Base with `opencode` installed, `tools/` for the image-baked built-ins (populated in Phase 5), the bridge
copied in, `HEALTHCHECK` on the bridge's health route, and an entrypoint starting `opencode serve` on
`127.0.0.1:4096` plus the bridge.

##### Error Handling
Never use `exec` with string interpolation — `spawn` with an argv array, so repo/session values can never
be shell-injected. Non-zero `docker` exit → an `Error` carrying trimmed stderr; the route surfaces a
readable message, never a raw stack.

##### Output / UX
Container naming is deterministic and greppable: `sandbox-<sessionId>` (Phase 3 adds the attempt suffix
when continuation introduces multiple attempts per session).

#### Patterns & Constraints

##### Mirror
[§12](./ARCHITECTURE.md)'s compose topology and [§13](./ARCHITECTURE.md)'s `docker run` row.

##### Decisions
- Docker **CLI via spawn**, not dockerode — [§1](./ARCHITECTURE.md) excludes the Docker CLI from the budget
  while an SDK wrapper would add authored glue.
- No named volumes yet; the workspace is a read-only bind mount of a pre-cloned repo (Phase 3 adds volumes).

##### Gotchas
- `--network egress-net` requires the compose-created network name (project-prefixed) — resolve it from
  env rather than hardcoding the bare name.
- The control plane runs in a container; the bind-mount source path must be a **host** path, not a
  path inside the control-plane container. Thread it through `WORKSPACE_HOST_PATH`.
- Docker healthcheck status only appears in `docker inspect` when the image declares `HEALTHCHECK`.

##### Out of Scope
`docker stop`, `docker logs`, volume creation, the reaper, per-session `INTERNAL_TOKEN`.

#### Tests

##### E2E
Covered in Step 6.

##### Integration
Against real Docker: run a container from the sandbox image, assert `inspect` reports `running`, assert
`waitForHealth` resolves, then remove it.

##### Unit
Argv construction for `run()` (exact flag list, env pass-through, no shell string anywhere) and
`inspect()` output parsing for the missing/running/exited cases.

#### Validation

##### Commands
```
make sandbox-image && pnpm --filter control-plane test
```

##### Expected Results
Image builds; integration test spawns and reaps a real container; no `exec`/string-interpolated command
anywhere in `sandbox.js`.
