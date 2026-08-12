/**
 * Control-plane HTTP server. Exposes `buildServer()` as the seam every later phase
 * registers routes and plugins onto, plus a `start()` guard for the entrypoint case.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerModelsRoutes } from './routes/models.js';
import { registerSessionsRoutes } from './routes/sessions.js';

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

  registerSessionsRoutes(app, db);
  registerInternalRoutes(app, db);
  registerModelsRoutes(app);

  // `@fastify/static` only warns (doesn't throw) when `publicDir` is missing, so `/health`
  // keeps working even before `make build` has produced a dashboard bundle.
  app.register(fastifyStatic, { root: publicDir });

  for (const route of ['/', '/sessions/new', '/sessions/:id']) {
    app.get(route, (_req, reply) => reply.sendFile('index.html'));
  }

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
