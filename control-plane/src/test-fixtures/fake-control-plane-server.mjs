#!/usr/bin/env node
/**
 * Minimal fake control-plane HTTP server used only by `src/sandbox.test.js`'s "real Docker
 * integration" suite. Runs *inside a container* on the same user-defined bridge network as the
 * sandbox-under-test (addressed by container name via that network's embedded DNS) instead of
 * being bound on the host and reached via the `docker0` gateway IP — the latter is not
 * universally routable (see docs/plan/steps/.../00603-*.md's Root cause).
 *
 * Replies `200 {}` to any request, which is all `sandbox/bridge.js`'s
 * `POST /internal/sessions/:id/oc-session` call needs to proceed past its own startup gate.
 */

import http from 'node:http';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});

server.listen(PORT, () => {
  console.log(`[fake-control-plane] listening on ${PORT}`);
});
