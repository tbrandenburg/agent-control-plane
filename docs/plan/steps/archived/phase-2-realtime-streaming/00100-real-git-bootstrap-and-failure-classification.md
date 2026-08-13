> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 1: Real git bootstrap and failure classification

#### Changes

##### Create
- `control-plane/src/bootstrap.js`.
- `control-plane/src/bootstrap.test.js`.
- `e2e/fixtures/` additions: a deliberately-private/nonexistent repo reference, an unreachable-host
  reference, for the real-failure E2E variants.

##### Modify
- `control-plane/src/config.js` — add `PLATFORM_CONFIG_REPO` default, `WORKSPACE_HOST_PATH` (already
  present from Phase 1; confirm it's still correct for the new clone-based flow, not just the old
  hardcoded mount).

##### Remove
- The Phase 1 hardcoded pre-cloned repo path constant.

#### Implementation

##### `resolveSha(repoUrl, ref)`
`git ls-remote <repoUrl> <ref>` for each of target/platform/team repos, **up front**, before any fetch —
closes the concurrent-push race [§10](./ARCHITECTURE.md) calls out explicitly.

##### `cloneAndCheckout(repoUrl, sha, destPath, { sparse })`
`git fetch --depth 1 origin <sha>` + `git checkout <sha>` — **never** a branch-name checkout. When
`sparse` is set (team config layer): `git sparse-checkout init --cone` + `git sparse-checkout set
.opencode` before checkout.

##### `stripCredential(destPath)`
`git remote set-url origin <url-without-credential>` — run on every cloned directory **before** it is
bind-mounted into a sandbox, preserving the filesystem-path half of the secret-custody boundary
([§2](./ARCHITECTURE.md)), not just the network-path half Phase 4 closes.

##### `classifyGitFailure(stderr)`
Pattern match, in order, against the four-row table:
`/repository .* not found/i` → `not_found`; `/authentication failed|invalid username or token/i` →
`auth`; `/could not resolve host|failed to connect|couldn't connect to server|timed out/i` → `network`;
else → `unknown`. Never dispatch on exit code — `git`'s own exit code is always 128 regardless.

##### `bootstrapWorkspace(session)`
Orchestrates all three trees (target repo — hard fail on any classification; platform config repo — hard
fail on any classification; team config repo, if given — **silent skip on `not_found`**, hard fail on
`auth`/`network`/`unknown`). Returns the composed directory-tree layout `sandbox.run()` needs to mount.

##### Error Handling
Every classification failure carries the original (credential-stripped) stderr for logging, but the
classification tag — not the raw string — drives control-plane behavior (hard fail vs. silent skip).
Never let an unclassified failure default to "success."

##### Output / UX
Bootstrap failures are logged with the classification tag and repo role (target/platform/team) so a
human reading `docker logs`/control-plane logs can immediately tell which of the three trees failed and
why — this is the only observability this phase has until Phase 3's structured diagnostics land.

#### Patterns & Constraints

##### Mirror
[§10](./ARCHITECTURE.md)'s bootstrap failure-mode table and sequence description verbatim.

##### Decisions
- `child_process.spawn('git', [...])` with an argv array — never string-interpolated shell commands,
  same rule as Phase 1's `sandbox.js` ([§13](./ARCHITECTURE.md)).
- Team-layer `not_found` is a silent skip; target/platform-layer `not_found` is a hard failure. This
  asymmetry is load-bearing and must have its own explicit test, not be inferred from the happy path.

##### Gotchas
- `git`'s exit code is **always 128** on failure regardless of cause — classification must be
  stderr-text-based, and the regex patterns are only as good as this environment's actual `git`
  version's message strings; verify against real output, not assumed strings (Verification #2).
- `git ls-remote` failures use different stderr phrasing than `git fetch` failures for the same
  underlying cause in some `git` versions — test both call sites, not just one.
- Sparse checkout (`--cone` mode) requires `git` ≥ 2.25; confirm the sandbox/CI image's `git` version.

##### Out of Scope
`OPENCODE_CONFIG_CONTENT` composition (Step 2 — sequenced strictly after this step, per the Design
section's non-negotiable dependency), structured diagnostics fields (Phase 3).

#### Tests

##### E2E
Covered in Step 5 (`bootstrap-failures.spec.ts`).

##### Integration
Against real `git` (no mocking, per root `AGENTS.md`): a real local bare repo fixture for the happy
path; a genuinely nonexistent repo path for `not_found`; a repo requiring a credential with none
supplied for `auth`; an unreachable host (e.g. a non-routable IP) for `network`; a synthetic stderr
string for `unknown` (since a real `unknown`-classified git failure is hard to construct on demand).

##### Unit
`classifyGitFailure()` against each of the four patterns plus edge cases (mixed-case matches, multi-line
stderr); `stripCredential()`'s URL rewriting for both HTTPS-with-token and SSH remote forms.

#### Validation

##### Commands
```
pnpm --filter control-plane test && make loc
```

##### Expected Results
All four classification rows pass against real `git` output captured in this environment; credential
stripping verified via `git remote -v` on the resulting clone.
