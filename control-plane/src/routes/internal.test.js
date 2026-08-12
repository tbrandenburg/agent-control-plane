/**
 * Tests for the internal ingest routes (`sandbox/bridge.js`'s only callers) — event storage and
 * the once-only `opencode_session_id` report.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/** @type {string} */
let dataDir;
/** @type {string|undefined} */
let previousDataDir;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cp-internal-test-'));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * @param {import('node:sqlite').DatabaseSync} db - Open database handle.
 * @param {Partial<Record<string, unknown>>} overrides - Column overrides.
 * @returns {string} The inserted session's id.
 */
function seedSession(db, overrides = {}) {
  const row = {
    id: 'sess-1',
    title: 'Test session',
    repo_owner: 'acme',
    repo_name: 'widgets',
    model: 'litellm/claude-sonnet',
    reasoning_effort: 'medium',
    status: 'active',
    container_name: null,
    opencode_session_id: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO sessions
      (id, title, repo_owner, repo_name, model, reasoning_effort, status, container_name, opencode_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.title,
    row.repo_owner,
    row.repo_name,
    row.model,
    row.reasoning_effort,
    row.status,
    row.container_name,
    row.opencode_session_id,
  );
  return row.id;
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @returns {import('node:sqlite').DatabaseSync}
 */
function getDb(app) {
  return /** @type {any} */ (app).db;
}

describe('POST /internal/sessions/:id/events', () => {
  it('inserts a verbatim events row and returns 201', async () => {
    const app = buildServer();
    seedSession(getDb(app));
    await app.ready();

    const frame = {
      type: 'message.part.delta',
      properties: { sessionID: 'oc-1' },
    };
    const response = await app.inject({
      method: 'POST',
      url: '/internal/sessions/sess-1/events',
      payload: frame,
    });

    expect(response.statusCode).toBe(201);
    const row = /** @type {{payload: string}} */ (
      getDb(app)
        .prepare('SELECT * FROM events WHERE session_id = ?')
        .get('sess-1')
    );
    expect(JSON.parse(row.payload)).toEqual(frame);
    await app.close();
  });

  it('returns 404 for an unknown session', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/internal/sessions/missing/events',
      payload: { type: 'heartbeat' },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /internal/sessions/:id/oc-session', () => {
  it('sets opencode_session_id once', async () => {
    const app = buildServer();
    seedSession(getDb(app));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/internal/sessions/sess-1/oc-session',
      payload: { ocSessionId: 'oc-1' },
    });

    expect(response.statusCode).toBe(200);
    const row = /** @type {{opencode_session_id: string|null}} */ (
      getDb(app)
        .prepare('SELECT opencode_session_id FROM sessions WHERE id = ?')
        .get('sess-1')
    );
    expect(row.opencode_session_id).toBe('oc-1');
    await app.close();
  });

  it('returns 409 on a second report with a different id, without overwriting', async () => {
    const app = buildServer();
    seedSession(getDb(app), { opencode_session_id: 'oc-1' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/internal/sessions/sess-1/oc-session',
      payload: { ocSessionId: 'oc-2' },
    });

    expect(response.statusCode).toBe(409);
    const row = /** @type {{opencode_session_id: string|null}} */ (
      getDb(app)
        .prepare('SELECT opencode_session_id FROM sessions WHERE id = ?')
        .get('sess-1')
    );
    expect(row.opencode_session_id).toBe('oc-1');
    await app.close();
  });

  it('returns 200 unchanged when the same id is reported again', async () => {
    const app = buildServer();
    seedSession(getDb(app), { opencode_session_id: 'oc-1' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/internal/sessions/sess-1/oc-session',
      payload: { ocSessionId: 'oc-1' },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('returns 404 for an unknown session', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/internal/sessions/missing/oc-session',
      payload: { ocSessionId: 'oc-1' },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
