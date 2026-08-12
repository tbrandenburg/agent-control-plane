# Node 24 slim base with pnpm via corepack. Single-stage by design (Phase 0 explicitly excludes
# multi-stage image optimisation — see docs/plan/steps/*/00500-*.md "Out of Scope").
FROM node:24-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
RUN corepack enable

# `docker` CLI so `control-plane/src/sandbox.js` (`spawn('docker', ...)`) can talk to the host
# daemon over the bind-mounted `/var/run/docker.sock` (docker-compose.yml). This container runs
# as root (see the dropped `USER node` below) purely so it can read that host socket without
# fragile host-GID matching — deliberately insecure this phase, same "single flag to flip" pattern
# as every other PHASE-4 item in ARCHITECTURE.md §12.
RUN apt-get update && apt-get install -y --no-install-recommends docker.io \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first so `pnpm install` layers cache independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY control-plane/package.json control-plane/package.json
COPY control-plane/dashboard/package.json control-plane/dashboard/package.json
COPY e2e/package.json e2e/package.json

RUN pnpm install --frozen-lockfile --prod --filter control-plane...

COPY control-plane control-plane

# `make build` (host-side `pnpm run build:dashboard`) must run before `docker build` so the
# dashboard bundle is present in the build context — fail loudly instead of shipping a broken
# image (see docs/plan/steps/*/00501-dockerfile-missing-dashboard-build.md).
RUN test -f control-plane/public/index.html || \
  (echo "ERROR: control-plane/public/index.html missing — run 'make build' before 'docker build'" >&2 && exit 1)

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "control-plane/src/server.js"]
