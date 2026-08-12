> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap: production image never includes the built dashboard bundle

Found during review of `docs/plan/steps/in-review/00500-make-targets-loc-gate-and-container-manifests.md`.

### Why it matters

`.dockerignore` at the repo root excludes `control-plane/public`:

```
control-plane/public
```

`control-plane/Dockerfile` copies the whole `control-plane` directory (`COPY control-plane
control-plane`) expecting the dashboard's built static assets to already be present at
`control-plane/public` (produced by `make build` / `pnpm run build:dashboard` on the host). Because
`.dockerignore` excludes that exact path, Docker's build context never contains it — even if a
developer runs `make build` immediately before `docker compose up --build`, the directory is
silently dropped from the image.

Verified independently:

```
$ docker build --no-cache -t acp-test-nocache -f control-plane/Dockerfile .
$ docker run --rm acp-test-nocache ls -la /app/control-plane/public
ls: cannot access '/app/control-plane/public': No such file or directory
```

The running container logs confirm the resulting fastify-static misconfiguration on every start:

```
{"level":40,...,"msg":"\"root\" path \"/app/control-plane/public\" must exist"}
```

`GET /health` still returns `{"status":"ok"}` (the Step 5 validation command only checks `/health`),
so this gap is invisible to the documented validation, but the dashboard SPA can never be served
from the production image as-is — every future phase that relies on `docker compose up` serving
the dashboard will silently regress.

### Actions

1. Remove `control-plane/public` from the root `.dockerignore` (or scope the exclusion to
   `**/dashboard/node_modules` etc. instead of the build output), so the directory is included in
   the Docker build context when present.
2. Decide and document the build contract explicitly: either (a) keep requiring `make build` to run
   on the host before `docker build`/`docker compose up --build`, and add a Dockerfile `RUN test -d
   control-plane/public` guard (or equivalent) that fails the build loudly if the directory is
   missing/empty instead of silently producing a broken image, or (b) move the dashboard build into
   the Dockerfile itself via an extra build stage that runs `pnpm --filter dashboard run build`
   before the production stage copies only the output — this is the more robust long-term fix but is
   explicitly out of scope for the immutable Step 5 file (which excludes multi-stage optimisation),
   so prefer option (a) now and file a later step for (b) if desired.
3. Add a regression check (e.g. as part of `make build` or a new integration test) that fails if
   `control-plane/public/index.html` is missing after `pnpm run build:dashboard`, and/or verify via
   `docker build` in CI that the image actually contains the dashboard bundle before merging changes
   to `.dockerignore` or the Dockerfile.
4. Re-run the Step 5 validation command end-to-end (`make help && make build && make loc && docker
   compose up -d && curl -fsS localhost:3000/health && docker compose down -v`) and additionally
   assert `docker compose exec control-plane test -f control-plane/public/index.html` passes.
