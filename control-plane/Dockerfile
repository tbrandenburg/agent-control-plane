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
# `git` so `control-plane/src/bootstrap.js` (`spawn('git', ...)`) can clone/checkout per-session
# target repos — required since step 00601 wired real bootstrap into the spawn path; `docker.io`
# alone does not pull in `git` as a dependency. `ca-certificates` so those git clones over HTTPS
# (e.g. github.com) can verify the remote's TLS certificate — without it every clone fails with
# "server certificate verification failed. CAfile: none CRLfile: none" regardless of the target
# repo actually existing.
RUN apt-get update && apt-get install -y --no-install-recommends docker.io git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Optional corporate/self-signed CA certificate (e.g. a TLS-inspecting proxy on a corporate
# Windows/WSL machine) — without it, `corepack`'s pnpm download and any `git clone` over HTTPS
# fail with "self-signed certificate in certificate chain" / "SELF_SIGNED_CERT_IN_CHAIN". Pass
# `make run CA_FILE=/path/to/ca.crt` (see root Makefile/docker-compose.yml); it's mounted at
# build time as a BuildKit secret — read directly from its original host path, never copied into
# this repo's build context as a source file. Its content IS installed into this image's system
# CA store below (needed so `git` clones inside the *running* container, e.g. bootstrap.js, also
# trust it) and set via NODE_EXTRA_CA_CERTS for Node's own TLS stack (used by corepack's fetch).
# When CA_FILE isn't set, the secret mount is simply empty and this is a no-op.
#
# `RUN --mount=type=secret` is deliberately excluded from BuildKit's cache key, so a changed
# CA_FILE would otherwise silently reuse a stale cached layer from a previous build. CA_CERT_HASH
# (a sha256 of CA_FILE's contents, computed by the root Makefile — never the cert itself) is a
# regular ARG referenced in the RUN command below purely to force cache invalidation whenever the
# cert's content actually changes.
ARG CA_CERT_HASH=none
RUN --mount=type=secret,id=ca_cert \
    : "cache-bust ${CA_CERT_HASH}" && \
    if [ -s /run/secrets/ca_cert ]; then \
      cp /run/secrets/ca_cert /usr/local/share/ca-certificates/custom-ca.crt \
        && update-ca-certificates; \
    else \
      : > /usr/local/share/ca-certificates/custom-ca.crt; \
    fi
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/custom-ca.crt

WORKDIR /app

# Build-time git SHA (issue #18: verify a live redeploy actually shipped a given commit via
# `GET /version` instead of trusting "merged"/"tests passed" alone). Passed as `--build-arg
# GIT_SHA=$(git rev-parse HEAD)` by `make build`/`docker-compose.yml`; defaults to `unknown` for
# a bare `docker build` invoked without that arg.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

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
