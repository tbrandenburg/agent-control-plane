/**
 * Control-plane HTTP server. Exposes `buildServer()` as the seam every later phase
 * registers routes and plugins onto, plus a `start()` guard for the entrypoint case.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerModelsRoutes } from './routes/models.js';
import { registerSessionsRoutes } from './routes/sessions.js';
import { registerWsRoutes } from './routes/ws.js';

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
);

/**
 * Builds a configured Fastify instance without starting it. Opens the SQLite database and
 * closes it when the Fastify instance closes.
 * @returns {import('fastify').FastifyInstance} The configured Fastify instance.
 */
export function buildServer() {
  const app = Fastify({ logger: true });
  const { dataDir } = loadConfig();
  const db = openDb(dataDir);

  app.addHook('onClose', () => db.close());
  app.decorate('db', db);

  app.get('/health', async () => ({ status: 'ok' }));

  // Exposes the image's build-time git SHA (baked in via the `GIT_SHA` build arg —
  // `control-plane/Dockerfile`, `docker-compose.yml`) so a redeploy can be verified against
  // `git rev-parse HEAD` instead of trusting "code merged"/"tests passed" alone (issue #18: a
  // merged, unit-tested fix silently ran stale in a container built ~53 minutes before the fix
  // was authored). Falls back to `'unknown'` for a local `node control-plane/src/server.js` run
  // outside any Docker build.
  app.get('/version', async () => ({
    gitSha: process.env.GIT_SHA ?? 'unknown',
  }));

  // Encapsulated so the `await` on `@fastify/websocket`'s registration completes (and its
  // `onRoute` hook is installed) before `registerWsRoutes` declares the `{ websocket: true }`
  // route — declaring it in the same synchronous tick as an un-awaited `register()` leaves
  // `request.params` undefined in the handler (the plugin's route-wrapping hook isn't attached
  // yet when the route is added).
  app.register(async (instance) => {
    await instance.register(fastifyWebsocket);
    registerWsRoutes(instance, db);
  });

  registerSessionsRoutes(app, db);
  registerInternalRoutes(app, db);
  registerModelsRoutes(app);

  // `@fastify/static` only warns (doesn't throw) when `publicDir` is missing, so `/health`
  // keeps working even before `make build` has produced a dashboard bundle.
  app.register(fastifyStatic, { root: publicDir });

  // Any unmatched GET request outside `/api` and `/internal` is a client-side route: serve the
  // SPA shell and let the React router decide how to render it (including its own "not found"
  // state). API/internal 404s and non-GET methods keep Fastify's default JSON 404 behavior.
  app.setNotFoundHandler((req, reply) => {
    const isSpaRoute =
      req.method === 'GET' &&
      !req.url.startsWith('/api/') &&
      !req.url.startsWith('/internal/');

    if (isSpaRoute) {
      return reply.sendFile('index.html');
    }

    return reply.code(404).send({
      message: `Route ${req.method}:${req.url} not found`,
      error: 'Not Found',
      statusCode: 404,
    });
  });

  return app;
}

/**
 * Starts the server on the configured port, exiting the process on failure.
 * @returns {Promise<void>} Resolves once the server is listening.
 */
async function start() {
  const app = buildServer();
  const { port } = loadConfig();

  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const isEntrypoint = process.argv[1] === new URL(import.meta.url).pathname;

if (isEntrypoint) {
  start();
}
