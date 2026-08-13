/**
 * Internal ingest routes — called only by `sandbox/bridge.js` over `sandbox-net`, never by
 * external clients (ARCHITECTURE.md §5's "internal-only surface").
 *
 * No auth in this phase. PHASE-4: check a per-session `INTERNAL_TOKEN` here, minted at spawn time.
 */

import { broadcastToSession } from './ws.js';

/**
 * Registers `/internal/sessions/:id/events` and `/internal/sessions/:id/oc-session` on the given
 * Fastify instance.
 * @param {import('fastify').FastifyInstance} app - Fastify instance to register routes on.
 * @param {import('node:sqlite').DatabaseSync} db - Open, migrated database handle.
 * @returns {void}
 */
export function registerInternalRoutes(app, db) {
  app.post('/internal/sessions/:id/events', async (req, reply) => {
    const { id } = /** @type {{id: string}} */ (req.params);

    const exists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id);
    if (!exists) {
      reply.code(404);
      return { error: 'SESSION_NOT_FOUND' };
    }

    // Every relayed SSE frame is stored verbatim, not just final snapshots (ARCHITECTURE.md §4).
    db.prepare(
      'INSERT INTO events (session_id, timestamp, payload) VALUES (?, ?, ?)',
    ).run(id, new Date().toISOString(), JSON.stringify(req.body ?? {}));

    const event = req.body && typeof req.body === 'object' ? req.body : {};
    broadcastToSession(id, { type: 'event', ...event });

    reply.code(201);
    return { status: 'stored' };
  });

  app.post('/internal/sessions/:id/oc-session', async (req, reply) => {
    const { id } = /** @type {{id: string}} */ (req.params);
    const { ocSessionId } = /** @type {{ocSessionId?: string}} */ (
      req.body ?? {}
    );

    const row = /** @type {{opencode_session_id: string|null}|undefined} */ (
      db
        .prepare('SELECT opencode_session_id FROM sessions WHERE id = ?')
        .get(id)
    );
    if (!row) {
      reply.code(404);
      return { error: 'SESSION_NOT_FOUND' };
    }
    if (!ocSessionId) {
      reply.code(400);
      return { error: 'MISSING_OC_SESSION_ID' };
    }
    if (row.opencode_session_id === ocSessionId) {
      return { status: 'unchanged' };
    }
    // Control plane is the source of truth (ARCHITECTURE.md §4) — a second report with a
    // different id is a conflict, never a silent overwrite.
    if (row.opencode_session_id) {
      reply.code(409);
      return { error: 'OC_SESSION_ALREADY_SET' };
    }

    db.prepare(
      "UPDATE sessions SET opencode_session_id = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(ocSessionId, id);

    return { status: 'set' };
  });
}
