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
CMD ["sh", "-c", "opencode serve --hostname 127.0.0.1 --port 4096 & exec node bridge.js"]
