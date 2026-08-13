# Sandbox image: `opencode` + the bridge (sandbox/bridge.js) + image-baked built-in tools.
FROM node:24-slim

WORKDIR /app

COPY sandbox/package.json ./
RUN npm install --omit=dev

ENV PATH="/app/node_modules/.bin:${PATH}"

# Built-in tools baked at image-build time (populated in Phase 5) — the directory must exist now
# so later phases can add files here without a Dockerfile change.
RUN mkdir -p tools

COPY sandbox/bridge.js ./

ENV BRIDGE_PORT=8080
EXPOSE 4096 8080

# Node's own `fetch` instead of `curl` — the `node:24-slim` base doesn't ship curl, and the bridge
# is zero-runtime-dependency by design (this step's Decisions).
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/global/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# `opencode serve` runs in the background; the bridge is the foreground process so its exit stops
# the container. No process supervisor — YAGNI for a single-sandbox, single-attempt Phase 1.
#
# `opencode serve` has no `--dir`/`--cwd` flag (verified via `opencode serve --help`) — its
# session working directory is purely its process cwd at launch. It must be launched from
# `/workspace/repo` (the bootstrapped, bind-mounted target repo — sandbox.js's `:ro` mount) so the
# agent defaults to operating on the target repo instead of the bridge's own `/app` (GitHub issue
# #9). The bridge itself still needs cwd `/app` to resolve its `node_modules` (`npm install` ran
# there), so it's launched from a separate `cd /app &&` clause rather than sharing `opencode
# serve`'s subshell.
CMD ["sh", "-c", "(cd /workspace/repo && opencode serve --hostname 127.0.0.1 --port 4096) & cd /app && exec node bridge.js"]
