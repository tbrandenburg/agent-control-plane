/**
 * `GET /api/models` — static, hand-curated allowlist from `config.js` (ARCHITECTURE.md §5). No
 * Static allowlist query, no cache. UI/discovery only — not a validation gate (see `model.js`).
 */

import { MODEL_ALLOWLIST } from '../config.js';

/**
 * Registers `GET /api/models` on the given Fastify instance.
 * @param {import('fastify').FastifyInstance} app - Fastify instance to register routes on.
 * @returns {void}
 */
export function registerModelsRoutes(app) {
  app.get('/api/models', async () => ({ models: MODEL_ALLOWLIST }));
}
