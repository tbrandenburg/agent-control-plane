/**
 * Sessions API — reads (`GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/events`),
 * `POST /api/sessions` (creates the row synchronously with `status = 'pending_bootstrap'` and kicks
 * off sandbox bootstrap asynchronously in the background, updating `status` to `'active'` or
 * `'pending_bootstrap-failed'` once bootstrap settles), `POST /api/sessions/:id/stop` (stops and
 * removes the sandbox container), `PATCH /api/sessions/:id` (updates mutable session fields), and
 * `POST /api/sessions/:id/prompt` (synchronous proxy to the bridge).
 */

import { randomUUID } from 'node:crypto';
import * as defaultBootstrap from '../bootstrap.js';
import {
  isValidModelReference,
  isValidRepoSegment,
  isValidTitle,
} from '../model.js';
import { promptSession } from '../prompt-session.js';
import * as defaultSandbox from '../sandbox.js';
import { spawnSandbox } from '../spawn-session.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * @typedef {object} SessionRow
 * @property {string} id
 * @property {string|null} title
 * @property {string|null} repo_owner
 * @property {string|null} repo_name
 * @property {string|null} model
 * @property {string|null} reasoning_effort
 * @property {string} status
 * @property {string|null} container_name
 * @property {string|null} opencode_session_id
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * Maps a `sessions` row (snake_case columns) to the camelCase wire shape.
 * `node:sqlite` returns `null` (not `undefined`) for NULL columns, so no `??` coalescing is
 * needed here — `null` already round-trips correctly through `JSON.stringify`.
 * @param {SessionRow} row - Raw database row.
 * @returns {object} Camel-cased session, ready for JSON serialization.
 */
export function sessionRowToJson(row) {
  return {
    id: row.id,
    title: row.title,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    status: row.status,
    containerName: row.container_name,
    opencodeSessionId: row.opencode_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * @typedef {object} EventRow
 * @property {number} id
 * @property {string} session_id
 * @property {string} timestamp
 * @property {string} payload
 */

/**
 * Maps an `events` row to the wire shape.
 * @param {EventRow} row - Raw database row.
 * @returns {object} Camel-cased event, ready for JSON serialization.
 */
export function eventRowToJson(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    payload: row.payload,
  };
}

/**
 * Encodes a `(timestamp, id)` pair into an opaque cursor string. The cursor must carry both
 * fields — two events can share the same `timestamp`, so `id` alone or `timestamp` alone would
 * both be ambiguous tie-break keys.
 * @param {string} timestamp - `events.timestamp` of the last row on the current page.
 * @param {number} id - `events.id` of the last row on the current page.
 * @returns {string} Opaque base64url cursor.
 */
export function encodeCursor(timestamp, id) {
  return Buffer.from(`${timestamp}\u0000${id}`, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor produced by {@link encodeCursor}.
 * @param {string} cursor - Opaque cursor string.
 * @returns {{timestamp: string, id: number}} The decoded `(timestamp, id)` pair.
 * @throws {Error} If the cursor is malformed.
 */
export function decodeCursor(cursor) {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.indexOf('\u0000');
  if (sep === -1) throw new Error('malformed cursor');
  const timestamp = decoded.slice(0, sep);
  const id = Number.parseInt(decoded.slice(sep + 1), 10);
  if (!timestamp || Number.isNaN(id)) throw new Error('malformed cursor');
  return { timestamp, id };
}

/**
 * Parses and validates a non-negative integer query param.
 * @param {unknown} value - Raw query param value.
 * @param {number} fallback - Default when `value` is absent.
 * @returns {number|null} The parsed integer, or `null` if present but invalid.
 */
function parseNonNegativeInt(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(/** @type {string} */ (value), 10);
  if (Number.isNaN(parsed) || parsed < 0 || String(value) !== String(parsed)) {
    return null;
  }
  return parsed;
}

/**
 * @typedef {object} SessionsRoutesDeps
 * @property {typeof defaultSandbox} [sandbox] - Sandbox lifecycle module, swappable in tests.
 * @property {typeof defaultBootstrap} [bootstrap] - Bootstrap module, swappable in tests.
 * @property {typeof fetch} [fetchImpl] - `fetch` implementation, swappable in tests.
 */

/**
 * Registers the sessions routes on the given Fastify instance.
 * @param {import('fastify').FastifyInstance} app - Fastify instance to register routes on.
 * @param {import('node:sqlite').DatabaseSync} db - Open, migrated database handle.
 * @param {SessionsRoutesDeps} [deps] - Injectable sandbox/fetch, defaulting to the real ones.
 * @returns {void}
 */
export function registerSessionsRoutes(
  app,
  db,
  {
    sandbox = defaultSandbox,
    bootstrap = defaultBootstrap,
    fetchImpl = (...args) => fetch(...args),
  } = {},
) {
  app.get('/api/sessions', async (req, reply) => {
    const query = /** @type {Record<string, unknown>} */ (req.query ?? {});
    const limit = parseNonNegativeInt(query.limit, DEFAULT_LIMIT);
    const offset = parseNonNegativeInt(query.offset, 0);

    if (limit === null || limit > MAX_LIMIT || offset === null) {
      reply.code(400);
      return { error: 'INVALID_PAGINATION' };
    }

    const status = query.status;
    const clauses = [];
    const params = [];
    if (typeof status === 'string' && status.length > 0) {
      clauses.push('status = ?');
      params.push(status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = /** @type {SessionRow[]} */ (
      db
        .prepare(
          `SELECT * FROM sessions ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset)
    );

    return { sessions: rows.map(sessionRowToJson) };
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = /** @type {{id: string}} */ (req.params);
    const row = /** @type {SessionRow|undefined} */ (
      db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    );

    if (!row) {
      reply.code(404);
      return { error: 'SESSION_NOT_FOUND' };
    }

    // `docker inspect` phase lands in Step 2 — Phase 1's schema has no live-container
    // column, so this is always `null` until that step wires in `sandbox.inspect()`.
    return { ...sessionRowToJson(row), phase: null };
  });

  app.get('/api/sessions/:id/events', async (req, reply) => {
    const { id } = /** @type {{id: string}} */ (req.params);
    const query = /** @type {Record<string, unknown>} */ (req.query ?? {});

    const exists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id);
    if (!exists) {
      reply.code(404);
      return { error: 'SESSION_NOT_FOUND' };
    }

    const limit = parseNonNegativeInt(query.limit, DEFAULT_LIMIT);
    if (limit === null || limit > MAX_LIMIT) {
      reply.code(400);
      return { error: 'INVALID_PAGINATION' };
    }

    let after = null;
    if (typeof query.cursor === 'string' && query.cursor.length > 0) {
      try {
        after = decodeCursor(query.cursor);
      } catch {
        reply.code(400);
        return { error: 'INVALID_CURSOR' };
      }
    }

    const rows = /** @type {EventRow[]} */ (
      after
        ? db
            .prepare(
              `SELECT * FROM events
               WHERE session_id = ? AND (timestamp > ? OR (timestamp = ? AND id > ?))
               ORDER BY timestamp ASC, id ASC LIMIT ?`,
            )
            .all(id, after.timestamp, after.timestamp, after.id, limit)
        : db
            .prepare(
              'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC, id ASC LIMIT ?',
            )
            .all(id, limit)
    );

    const last = rows.at(-1);
    const nextCursor = last ? encodeCursor(last.timestamp, last.id) : null;

    return { events: rows.map(eventRowToJson), nextCursor };
  });

  app.post('/api/sessions', async (req, reply) => {
    const body = /** @type {Record<string, unknown>} */ (req.body ?? {});
    const {
      title,
      repoOwner,
      repoName,
      model,
      reasoningEffort,
      teamConfigRepo,
    } = body;

    if (
      typeof title !== 'string' ||
      !title ||
      typeof repoOwner !== 'string' ||
      !repoOwner ||
      typeof repoName !== 'string' ||
      !repoName
    ) {
      reply.code(400);
      return { error: 'INVALID_SESSION_BODY' };
    }
    if (!isValidTitle(title)) {
      reply.code(400);
      return { error: 'INVALID_TITLE' };
    }
    if (!isValidRepoSegment(repoOwner)) {
      reply.code(400);
      return { error: 'INVALID_REPO_OWNER' };
    }
    if (!isValidRepoSegment(repoName)) {
      reply.code(400);
      return { error: 'INVALID_REPO_NAME' };
    }
    if (!isValidModelReference(model)) {
      reply.code(400);
      return { error: 'INVALID_MODEL_REFERENCE' };
    }
    if (
      reasoningEffort !== undefined &&
      reasoningEffort !== null &&
      typeof reasoningEffort !== 'string'
    ) {
      reply.code(400);
      return { error: 'INVALID_SESSION_BODY' };
    }
    if (teamConfigRepo !== undefined && typeof teamConfigRepo !== 'string') {
      reply.code(400);
      return { error: 'INVALID_SESSION_BODY' };
    }

    const id = randomUUID();
    const wsToken = randomUUID();
    db.prepare(
      `INSERT INTO sessions
        (id, title, repo_owner, repo_name, model, reasoning_effort, status, ws_token)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_bootstrap', ?)`,
    ).run(
      id,
      title,
      repoOwner,
      repoName,
      model,
      reasoningEffort ?? null,
      wsToken,
    );

    // Async split (this step's Decisions): the row is already queryable and the response is
    // already sent by the time this runs — spawn/bootstrap happens after, never blocking the
    // request. Written generically enough for Phase 5's webhook handler to reuse verbatim.
    setImmediate(() => {
      spawnSandbox(db, sandbox, bootstrap, {
        id,
        model,
        repoOwner,
        repoName,
        teamConfigRepo: teamConfigRepo || undefined,
      });
    });

    reply.code(202);
    return { id, wsToken };
  });

  app.post('/api/sessions/:id/stop', async (req, reply) => {
    const { id } = /** @type {{id: string}} */ (req.params);
    const row = /** @type {SessionRow|undefined} */ (
      db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    );
    if (!row) {
      reply.code(404);
      return { error: 'SESSION_NOT_FOUND' };
    }

    // No attempted `docker stop` against a container name that was never spawned (this step's
    // Error Handling) — a clear, immediate error instead.
    if (!row.container_name) {
      reply.code(409);
      return { error: 'NO_LIVE_CONTAINER' };
    }

    try {
      const result = await sandbox.stop(row.container_name);
      return { status: 'stopped', method: result.method };
    } catch (err) {
      reply.code(502);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.patch('/api/sessions/:id', async (req, reply) => {
    const { id } = /** @type {{id: string}} */ (req.params);
    const body = /** @type {Record<string, unknown>} */ (req.body ?? {});
    const { status } = body;

    // `active` <-> `archived` only this phase — no continuation-driven status values yet
    // (this step's Implementation).
    if (status !== 'active' && status !== 'archived') {
      reply.code(400);
      return { error: 'INVALID_STATUS' };
    }

    const exists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id);
    if (!exists) {
      reply.code(404);
      return { error: 'SESSION_NOT_FOUND' };
    }

    db.prepare(
      "UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(status, id);

    const row = /** @type {SessionRow} */ (
      db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    );
    return sessionRowToJson(row);
  });

  app.post('/api/sessions/:id/prompt', async (req, reply) => {
    const { id } = /** @type {{id: string}} */ (req.params);
    const body = /** @type {Record<string, unknown>} */ (req.body ?? {});
    const result = await promptSession(db, fetchImpl, id, body);
    reply.code(result.status);
    return result.body;
  });
}
