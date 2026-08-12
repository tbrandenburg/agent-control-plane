> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 4: Dashboard skeleton and static-file serving

#### Changes

##### Create
- `control-plane/dashboard/`: `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`,
  `src/App.tsx`, `src/index.css`, `components.json`, `src/lib/utils.ts` (shadcn helper),
  `src/App.test.tsx`.

##### Modify
- `control-plane/src/server.js` — register `@fastify/static` with root `public/`, plus SPA fallbacks for
  `/`, `/sessions/new`, `/sessions/:id`.
- Root `Makefile` (Step 5) wires `vite build --outDir ../public`.

##### Remove
- Nothing.

#### Implementation

##### Dashboard shell
React 19 + TypeScript + Vite. Tailwind v4 configured CSS-first via `@theme` in `src/index.css` — no
`tailwind.config.js`. `QueryClientProvider` (TanStack Query) wraps the app at the root even though no
query exists yet, so Phase 1 adds queries without touching bootstrap. Render only an app shell
(header, empty content area) consistent with [`UI.md` §1](./UI.md)'s chrome — no session list yet.

##### shadcn/ui vendoring
Initialise `components.json` and vendor exactly one primitive (e.g. `button`) to prove the generation
path works. [`ARCHITECTURE.md` §5](./ARCHITECTURE.md) requires components to be vendored into the repo,
not consumed as an opaque npm package.

##### Static serving
Exactly the three routes from [`ARCHITECTURE.md` §5](./ARCHITECTURE.md) / [`UI.md` "Routes"](./UI.md) —
`/`, `/sessions/new`, `/sessions/:id` — each `sendFile('index.html')`. Do not add a wildcard catch-all;
the route list is explicit by design and extra screens are out of scope.

##### Error Handling
If `control-plane/public/index.html` is missing (dashboard not yet built), `@fastify/static` registration
must not crash the server — log a warning and continue serving `/health`, so `make test` works without a
prior `make build`.

##### Output / UX
Dev loop: `vite dev` with a proxy to `http://localhost:3000` for `/api` and `/health`. Prod: single
Fastify process serving both bundle and API — no second service ([`ARCHITECTURE.md` §5](./ARCHITECTURE.md)).

#### Patterns & Constraints

##### Mirror
[`UI.md` "Implementation note"](./UI.md) — React components per panel, `fetch`/WS-driven, independent units.

##### Decisions
- Vite output goes to `control-plane/public/`, which is gitignored and produced by `make build`.
- Full `.tsx` TypeScript here (not JSDoc) — a build step already exists, so there is nothing to save.

##### Gotchas
- Tailwind v4 uses the `@tailwindcss/vite` plugin and CSS-first config; v3-era `tailwind.config.js` and
  `postcss.config.js` instructions do not apply.
- The Vite `outDir` sits outside the dashboard root, so `emptyOutDir` must be set explicitly or Vite refuses.

##### Out of Scope
Session list, create form, transcript, any panel from [`UI.md` §3](./UI.md) — all Phase 1 or later.
Login/auth UI — Phase 4.

#### Tests

##### E2E
Deferred to Step 6.

##### Integration
`inject({ url: '/sessions/new' })` returns the SPA `index.html`, not a 404, after `make build`.

##### Unit
React Testing Library smoke test: `App` renders the header text.

#### Validation

##### Commands
```
pnpm --filter dashboard build && pnpm --filter dashboard test && ls control-plane/public/index.html
```

##### Expected Results
Hashed JS/CSS assets plus `index.html` in `control-plane/public/`; component test green.
