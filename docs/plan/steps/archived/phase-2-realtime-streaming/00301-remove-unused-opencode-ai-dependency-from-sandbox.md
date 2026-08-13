> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap: unused `opencode-ai` runtime dependency in `sandbox/package.json`

Found during review of `docs/plan/steps/in-review/00300-the-sandbox-bridge-and-sse-relay.md`.

`sandbox/package.json` declares `"opencode-ai": "^1.18.16"` under `dependencies`, but nothing in
`sandbox/bridge.js` or `sandbox/bridge.test.js` imports or references the `opencode-ai` package
(verified via `grep -rn "opencode-ai" sandbox/*.js` — zero matches). This directly contradicts the
step's own explicit Decision: "Node with zero runtime dependencies in the bridge if practical
(`node:http` + `fetch`), keeping the §14 bridge row near its ~50-70 LOC estimate."

Why it matters:
- It silently bloats the sandbox Docker image and `npm install --omit=dev` step in
  `sandbox/Dockerfile` with an unused package (and its own transitive dependency tree).
- It contradicts the "the bridge must not hold any external secret" / minimal-surface intent
  ([§3](./ARCHITECTURE.md)) by pulling in unreviewed, unused third-party code into the sandbox
  container's dependency graph for no functional benefit.
- Future implementers may assume this dependency is load-bearing (e.g. for Phase 3/4 work) and
  build around it, when in fact it was never wired up.

### Actions

1. Remove the `dependencies` block (or the specific `opencode-ai` entry) from `sandbox/package.json`
   unless a concrete, currently-implemented use is found upon re-inspection.
2. Re-run `pnpm --filter sandbox test` to confirm the bridge and its tests have no hidden reliance
   on the package.
3. Confirm `sandbox/Dockerfile`'s `RUN npm install --omit=dev` step still succeeds and produces a
   working image (or drop the `npm install` step entirely if no dependencies remain).
4. If a genuine future use is intended (e.g. Phase 3/4), do not restore the dependency here —
   add it in the step that actually wires it up, per this repo's YAGNI principle.
