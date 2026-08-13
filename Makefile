.PHONY: help install run stop test lint build clean loc e2e typecheck sandbox-image deploy release dev-stack dev-stack-down

## Default target — list all available targets.
help:
	@grep -E '^## ' -A1 $(MAKEFILE_LIST) | \
		awk '/^## / {sub(/^## /, "", $$0); desc=$$0} /^[a-zA-Z0-9_-]+:/ && !/^--/ {split($$0, a, ":"); printf "  \033[36m%-12s\033[0m %s\n", a[1], desc}'

## Install all workspace dependencies via pnpm.
install:
	pnpm run install:all

## Start the control-plane server.
run:
	pnpm run run:control-plane

## Stop the docker compose stack.
stop:
	docker compose down

## Run all unit/integration tests across the workspace.
test:
	pnpm run test:all

## Check and fix code quality with biome.
lint:
	pnpm run lint

## Build the dashboard static bundle into control-plane/public.
build:
	pnpm run build:dashboard
	@test -f control-plane/public/index.html || \
		(echo "ERROR: control-plane/public/index.html missing after build:dashboard" >&2 && exit 1)

## Remove build artifacts and dependencies.
clean:
	rm -rf control-plane/public node_modules control-plane/node_modules control-plane/dashboard/node_modules e2e/node_modules

## Print the LOC budget table and fail if the total exceeds the ceiling.
## Ceiling raised 1000 -> 1050 by step 00605 (real bootstrap wiring from step 00601 is essential,
## already-modularized functionality, not bloat — see scripts/loc.mjs's CEILING doc comment).
loc:
	pnpm run loc

## Bring up the real docker compose stack, run Playwright against it, then tear it down.
e2e:
	@export GIT_SHA=$$(git rev-parse HEAD); \
	trap 'docker compose down -v' EXIT; \
	$(if $(SKIP_BUILD),,docker compose build sandbox;) \
	docker compose up -d $(if $(SKIP_BUILD),,--build); \
	timeout=60; \
	until curl -sf http://localhost:$${HOST_PORT:-3000}/health > /dev/null 2>&1; do \
		timeout=$$((timeout - 1)); \
		if [ $$timeout -le 0 ]; then \
			echo "ERROR: control-plane did not become healthy within 60s" >&2; \
			docker compose logs; \
			exit 1; \
		fi; \
		sleep 1; \
	done; \
	E2E_BASE_URL="http://localhost:$${HOST_PORT:-3000}" pnpm run e2e

## Type-check all workspaces with tsc (no build step).
typecheck:
	pnpm run typecheck:all

## Bring up an isolated, ad-hoc verification stack safe to run alongside an already-running
## default stack: picks a free host port and uses a unique compose project name + SANDBOX_NETWORK
## so it never collides with another project's fixed-name `egress-net` or port bindings. Prints
## the URL and the `make dev-stack-down` command once healthy. Only smoke.spec.ts is safe to run
## against it (session-lifecycle.spec.ts hardcodes ../data/control-plane.db, the default stack's DB).
dev-stack:
	@project="acp-dev-$$(date +%s)"; \
	port=3400; \
	while ss -ltn 2>/dev/null | grep -q ":$$port "; do port=$$((port + 1)); done; \
	network="$${project}-net"; \
	echo "Starting isolated stack: project=$$project port=$$port network=$$network"; \
	SANDBOX_NETWORK="$$network" HOST_PORT="$$port" GIT_SHA=$$(git rev-parse HEAD) \
		docker compose -p "$$project" up -d --build; \
	echo "$$project" > .dev-stack-last; \
	timeout=60; \
	until curl -sf "http://localhost:$$port/health" > /dev/null 2>&1; do \
		timeout=$$((timeout - 1)); \
		if [ $$timeout -le 0 ]; then \
			echo "ERROR: control-plane did not become healthy within 60s" >&2; \
			docker compose -p "$$project" logs; \
			exit 1; \
		fi; \
		sleep 1; \
	done; \
	echo "Ready: http://localhost:$$port  (project: $$project)"; \
	echo "Tear down with: make dev-stack-down"

## Tear down a stack started by `make dev-stack` (defaults to the most recently started one;
## pass PROJECT=<name> to target a specific one).
dev-stack-down:
	@project="$(PROJECT)"; \
	if [ -z "$$project" ]; then \
		if [ -f .dev-stack-last ]; then project=$$(cat .dev-stack-last); \
		else echo "ERROR: no PROJECT given and no .dev-stack-last found" >&2; exit 1; fi; \
	fi; \
	docker compose -p "$$project" down -v; \
	rm -f .dev-stack-last

## Build the sandbox image (agent-sandbox:local) used by control-plane/src/sandbox.js.
sandbox-image:
	docker compose build sandbox

## Rebuild control-plane with the current commit's GIT_SHA baked in and redeploy it live
## (issue #18: closing a code-fix issue must not be trusted without this — verify with
## `curl <host>/version` that `gitSha` matches `git rev-parse HEAD` afterward).
deploy: build
	GIT_SHA=$$(git rev-parse HEAD) docker compose build control-plane
	docker compose up -d control-plane
	@echo "Deployed. Verify with: curl http://localhost:$${HOST_PORT:-3000}/version"

## Bump the version (BUMP=patch|minor|major, default patch) across every workspace package via
## pnpm's own `version` command (kept in sync, not hand-edited — root + every `pnpm-workspace.yaml`
## package.json get the identical new version), then commit, tag, push, and cut a GitHub release
## via `gh`. Requires a clean tree on `main`, up to date with `origin/main`, and `make test`/`make
## lint` passing first — the release counterpart to `make deploy`'s "verify what's live" problem,
## a git tag plus GitHub release gives every redeploy an unambiguous, human-readable version to
## check `GET /version`'s `gitSha` against, rather than only a raw commit hash.
release:
	@BUMP=$${BUMP:-patch}; \
	case "$$BUMP" in major|minor|patch) ;; \
		*) echo "ERROR: BUMP must be major, minor, or patch (got '$$BUMP')" >&2; exit 1 ;; \
	esac; \
	if [ -n "$$(git status --porcelain)" ]; then \
		echo "ERROR: working tree is not clean — commit or stash first" >&2; exit 1; \
	fi; \
	branch=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$branch" != "main" ]; then \
		echo "ERROR: release must be run from main (currently on $$branch)" >&2; exit 1; \
	fi; \
	git fetch origin main; \
	if [ "$$(git rev-parse HEAD)" != "$$(git rev-parse origin/main)" ]; then \
		echo "ERROR: local main is not in sync with origin/main — pull/push first" >&2; exit 1; \
	fi; \
	$(MAKE) lint typecheck test; \
	new_version=$$(pnpm version "$$BUMP" --no-git-tag-version | sed 's/^v//'); \
	pnpm -r exec -- pnpm version "$$new_version" --no-git-tag-version --allow-same-version > /dev/null; \
	git add -A; \
	git commit -m "chore(release): v$$new_version"; \
	git tag -a "v$$new_version" -m "v$$new_version"; \
	git push origin main "v$$new_version"; \
	gh release create "v$$new_version" --title "v$$new_version" --generate-notes; \
	echo "Released v$$new_version — verify a redeploy with: curl <host>/version"
