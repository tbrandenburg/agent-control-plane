> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 2: Control-plane runtime skeleton with type-checking

#### Changes

##### Create
- `control-plane/src/server.js` — Fastify instance, `GET /health`, `listen` on `PORT` (default 3000).
- `control-plane/src/config.js` — env reading with defaults; the future home of §5's `MODEL_ALLOWLIST`.
- `tsconfig.json` (root) — `allowJs`, `checkJs`, `strict`, `noEmit`, `module: nodenext`.
- `biome.json` — shared lint/format config.
- `control-plane/vitest.config.js` + `control-plane/src/server.test.js`.

##### Modify
- `control-plane/package.json` — `type: module`, `scripts.dev/start/test/typecheck`.

##### Remove
- Nothing.

#### Implementation

##### Fastify bootstrap
A single exported `buildServer()` factory returning a configured (but not listening) Fastify instance,
plus a `start()` guard invoked only when the module is the entrypoint. This factory is the seam every
later phase registers routes/plugins onto, and the seam integration tests use via `fastify.inject()`
without opening a port.

##### Type-checking via JSDoc
Public functions carry `@param`/`@returns` JSDoc. `checkJs` makes `tsc --noEmit` a real gate with zero
build step and zero LOC cost — [`ROADMAP.md`](./ROADMAP.md) Phase 0 "Types" row.

##### Error Handling
`start()` catches listen failures, logs a single-line reason, and `process.exit(1)`. No silent failures
(root `AGENTS.md` quality standards). Fastify's own logger is enabled — no custom logging layer.

##### Output / UX
`GET /health` → `200 {"status":"ok"}`. Deliberately unauthenticated; the `/api/*`-scoped `onRequest`
auth hook from [`ARCHITECTURE.md` §11](./ARCHITECTURE.md) will not cover it by construction.

#### Patterns & Constraints

##### Mirror
[`ARCHITECTURE.md` §5](./ARCHITECTURE.md)'s `fastify.register(@fastify/static)` snippet — Step 4 wires it;
this step only establishes the factory it registers onto.

##### Decisions
- ESM (`type: module`) throughout; no CommonJS despite §5's illustrative `require()` snippets.
- `buildServer()` never listens — testability first.

##### Gotchas
`checkJs` with `module: nodenext` is strict about import specifiers: `node:`-prefixed builtins and
explicit `.js` extensions on relative imports are mandatory.

##### Out of Scope
Any `/api/*` route, auth hook, WebSocket, or CORS config.

#### Tests

##### E2E
None yet.

##### Integration
`buildServer().inject({ method: 'GET', url: '/health' })` returns 200 with the expected body.

##### Unit
`config.js` default/override resolution for `PORT` and `DATA_DIR`.

#### Validation

##### Commands
```
pnpm --filter control-plane test && pnpm exec tsc --noEmit && pnpm exec biome check .
```

##### Expected Results
Green tests, zero type errors, zero lint findings.
