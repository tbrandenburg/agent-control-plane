.PHONY: help install run stop test lint build clean loc e2e typecheck sandbox-image

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
loc:
	pnpm run loc

## Bring up the real docker compose stack, run Playwright against it, then tear it down.
e2e:
	@trap 'docker compose down -v' EXIT; \
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

## Build the sandbox image (agent-sandbox:local) used by control-plane/src/sandbox.js.
sandbox-image:
	docker compose build sandbox
