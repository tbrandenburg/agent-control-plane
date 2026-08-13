> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Step `00604` (`arbitrary-repo-e2e-proof-and-findings-closure`, in-review) declares Action 3: add an
E2E test creating two sessions against two distinct, real, always-clonable public target repos
(`e2e/fixtures/distinct-target-repos.mjs`: `octocat/Hello-World`, `octocat/Spoon-Knife`) and Action 5:
"Re-run `make e2e` ... and confirm the new variant passes." Independently re-running the new
`e2e/tests/arbitrary-repo-bootstrap.spec.ts` today (isolated stack, `-p acpreview00604d`, per this
repo's own documented isolation pattern, fully rebuilt images) shows it does **not** pass — both
target-repo fixtures are genuinely reachable/clonable (verified directly: `docker run --rm --network
egress-net agent-control-plane:local git clone ... octocat/Hello-World` succeeds), yet every session
created via `POST /api/sessions` still ends up `pending_bootstrap-failed` within ~4 seconds, with the
control-plane container's own log showing:

```
session <id> bootstrap/spawn failed: bootstrap failed for platform repo: fatal: could not read
Username for 'https://github.com': No such device or address
```

Root cause, independently verified: `control-plane/src/config.js`'s `PLATFORM_CONFIG_REPO` default
(`https://github.com/tbrandenburg/agent-control-plane.git`, used whenever `PLATFORM_CONFIG_REPO` env
var is unset, which is every current `docker-compose.yml`/e2e/dev invocation — confirmed via `grep -rn
PLATFORM_CONFIG_REPO` across every `.yml`/`.env` file in the repo, zero overrides exist anywhere) is a
**private** GitHub repository:

```
$ gh repo view tbrandenburg/agent-control-plane --json visibility,isPrivate
{"isPrivate":true,"visibility":"PRIVATE"}
```

`bootstrapWorkspace()` (`control-plane/src/bootstrap.js`) clones the platform-config repo
unconditionally for every session (`roles` always includes `role: 'platform'`, hard-fail on any
classification) — a plain, unauthenticated `git clone` of this URL fails identically from *any*
credential-less environment, reproduced with a standalone `docker run` against the exact
`agent-control-plane:local` image with no compose/network wrapping needed:

```
$ docker run --rm --network egress-net agent-control-plane:local git clone -q \
    https://github.com/tbrandenburg/agent-control-plane.git /tmp/x
fatal: could not read Username for 'https://github.com': No such device or address
```

`git ls-remote`/`git clone` of the same URL only ever "worked" on the author's own dev machine
because their local shell has `gh auth login`-managed credentials wired into git's global credential
store (`git config --get credential.helper` → `store`, `gh auth status` → logged in) — that
credential store is never available inside the `control-plane` container (no such volume/env is
mounted in `docker-compose.yml`), so **every** `POST /api/sessions` call against any target repo, in
any properly isolated/CI environment, has always failed bootstrap at the platform-repo-clone step,
regardless of which target repo is used. This is a pre-existing default in `config.js` (not
introduced by `00604`'s own `Changes`, which only touch E2E fixtures/specs/findings-doc), but it
directly blocks `00604`'s own Action 5 validation claim, and equally blocks step `00606`'s planned fix
(replacing `session-lifecycle.spec.ts`'s `acme/widgets` target-repo fixture) — even after `00606`
lands, every session will still fail at the platform-repo step for the same reason.

**Not a duplicate of `00606`:** `00606` fixes a stale, never-clonable *target*-repo fixture
(`acme/widgets`) in `session-lifecycle.spec.ts`. This gap is about the *platform*-config-repo default
in `control-plane/src/config.js` itself, which fails independently of which target repo is supplied
and affects every session-creation path (including `00604`'s own new distinct-target-repo test, which
uses genuinely valid, reachable target repos and still fails for this separate reason).

## Actions

1. Replace `control-plane/src/config.js`'s `PLATFORM_CONFIG_REPO` default with a real, public,
   always-clonable-without-credentials GitHub repository (containing a minimal `.opencode/` config,
   or an empty/placeholder repo if no default provider catalog is required — cross-check
   `docs/phase_02_findings.md`'s Option C decision for what, if anything, the default platform config
   needs to contain) — or, if a private default is intentional for production use, make the e2e/dev
   `docker-compose.yml` explicitly set `PLATFORM_CONFIG_REPO` to a real, public fixture repo so local
   `make e2e`/dev flows never depend on host git credentials leaking into the container.
2. Re-run `e2e/tests/arbitrary-repo-bootstrap.spec.ts` and `e2e/tests/bootstrap-platform-config.spec.ts`
   (isolated stack, per this repo's own `-p <project-name>` pattern) and confirm both pass with real
   evidence (pass/fail summary), not just "looks fixed."
3. Re-run the full `make e2e` suite (isolated) and confirm no other spec regresses from this change.
4. Update `docs/phase_02_findings.md` to record this finding and its resolution, cross-referencing
   `00604`'s own findings-doc-closure action (Action 4) so the two updates don't conflict — whichever
   step lands first should leave a clear pointer for the other.
