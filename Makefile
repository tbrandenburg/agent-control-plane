.PHONY: help install run run-dev stop test lint build clean loc e2e typecheck sandbox-image deploy release dev-stack dev-stack-down

# Optional corporate/self-signed CA cert (see docker-compose.yml's `secrets.ca_cert` and
# control-plane/Dockerfile) — pass CA_FILE=/path/to/ca.crt to any target that builds the
# control-plane image. CA_CERT_HASH busts BuildKit's cache for the secret-mount RUN step (secret
# mounts don't otherwise participate in the cache key, so a changed CA_FILE would silently reuse
# a stale layer).
CA_FILE ?=
CA_CERT_HASH := $(if $(CA_FILE),$(shell sha256sum "$(CA_FILE)" 2>/dev/null | cut -d' ' -f1),none)

## Default target — list all available targets.
help:
	@grep -E '^## ' -A1 $(MAKEFILE_LIST) | \
		awk '/^## / {sub(/^## /, "", $$0); desc=$$0} /^[a-zA-Z0-9_-]+:/ && !/^--/ {split($$0, a, ":"); printf "  \033[36m%-12s\033[0m %s\n", a[1], desc}'

## Install all workspace dependencies via pnpm.
install:
	pnpm run install:all

## Bring up the persistent, real docker compose stack for everyday development (fresh full-stack
## bring-up on a dev machine). Builds, starts detached, polls /health, prints the URL. Does not
## tear down on exit — use `make stop` when done. For a one-off, always-torn-down verification run
## use `make e2e`; for redeploying just the control-plane service onto an already-running stack
## with GIT_SHA tracking (prod-like), use `make deploy`. Pass CA_FILE=/path/to/ca.crt to trust a
## corporate/self-signed CA during the control-plane image build (e.g. on Windows/WSL:
## CA_FILE=/mnt/c/Users/<you>/.cert/ca.crt) — fixes corepack/git "self-signed certificate in
## certificate chain" errors; referenced directly from that path, never copied into the repo.
run: build
	GIT_SHA=$$(git rev-parse HEAD) CA_FILE=$(CA_FILE) CA_CERT_HASH=$(CA_CERT_HASH) docker compose up -d --build
	@timeout=60; \
	until curl -sf http://localhost:$${HOST_PORT:-3000}/health > /dev/null 2>&1; do \
		timeout=$$((timeout - 1)); \
		if [ $$timeout -le 0 ]; then \
			echo "ERROR: control-plane did not become healthy within 60s" >&2; \
			docker compose logs; \
			exit 1; \
		fi; \
		sleep 1; \
	done; \
	echo "Ready: http://localhost:$${HOST_PORT:-3000}"

## Stop the docker compose stack started by `make run`.
stop:
	docker compose down

## Start the control-plane server locally via pnpm, no Docker/sandboxing (today's `make run`
## behavior, kept under a new name). Runs in the foreground; stop with Ctrl+C. Deliberately no
## PID-file/background tracking — keeps this interactive dev-loop target simple.
run-dev: install
	pnpm run run:control-plane

## Run all unit/integration tests across the workspace.
test: install
	pnpm run test:all

## Check and fix code quality with biome.
lint: install
	pnpm run lint

## Build the dashboard static bundle into control-plane/public.
build: install
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

## Bring up the real docker compose stack, run Playwright against it, then tear it down. Pass
## CA_FILE=/path/to/ca.crt to trust a corporate/self-signed CA during the control-plane image
## build (see `make run`'s doc comment).
e2e: install
	@export GIT_SHA=$$(git rev-parse HEAD); \
	export CA_FILE=$(CA_FILE); \
	export CA_CERT_HASH=$(CA_CERT_HASH); \
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
typecheck: install
	pnpm run typecheck:all

## Bring up an isolated, ad-hoc verification stack safe to run alongside an already-running
## default stack: picks a free host port and uses a unique compose project name + SANDBOX_NETWORK
## so it never collides with another project's fixed-name `egress-net` or port bindings. Prints
## the URL and the `make dev-stack-down` command once healthy. Only smoke.spec.ts is safe to run
## against it (session-lifecycle.spec.ts hardcodes ../data/control-plane.db, the default stack's DB).
## Pass CA_FILE=/path/to/ca.crt to trust a corporate/self-signed CA during the build (see `make
## run`'s doc comment).
dev-stack:
	@project="acp-dev-$$(date +%s)"; \
	port=3400; \
	while ss -ltn 2>/dev/null | grep -q ":$$port "; do port=$$((port + 1)); done; \
	network="$${project}-net"; \
	echo "Starting isolated stack: project=$$project port=$$port network=$$network"; \
	SANDBOX_NETWORK="$$network" HOST_PORT="$$port" GIT_SHA=$$(git rev-parse HEAD) CA_FILE=$(CA_FILE) CA_CERT_HASH=$(CA_CERT_HASH) \
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
## `curl <host>/version` that `gitSha` matches `git rev-parse HEAD` afterward). Pass
## CA_FILE=/path/to/ca.crt to trust a corporate/self-signed CA during the build (see `make
## run`'s doc comment).
deploy: build
	GIT_SHA=$$(git rev-parse HEAD) CA_FILE=$(CA_FILE) CA_CERT_HASH=$(CA_CERT_HASH) docker compose build control-plane
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
