import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../server.js';
import { decodeCursor, encodeCursor } from './sessions.js';

vi.mock('../sandbox.js', () => ({
  run: vi.fn(),
  waitForHealth: vi.fn(),
}));

const sandbox = await import('../sandbox.js');

/** @type {string} */
let dataDir;
/** @type {string|undefined} */
let previousDataDir;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cp-sessions-test-'));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  vi.mocked(sandbox.run).mockReset();
  vi.mocked(sandbox.waitForHealth).mockReset();
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Inserts a session row directly, bypassing the (not-yet-built) write API.
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
 * Inserts an event row directly.
 * @param {import('node:sqlite').DatabaseSync} db - Open database handle.
 * @param {string} sessionId - Owning session id.
 * @param {string} timestamp - ISO timestamp string.
 * @param {string} payload - Verbatim SSE frame text.
 * @returns {void}
 */
function seedEvent(db, sessionId, timestamp, payload) {
  db.prepare(
    'INSERT INTO events (session_id, timestamp, payload) VALUES (?, ?, ?)',
  ).run(sessionId, timestamp, payload);
}

describe('GET /api/sessions', () => {
  it('lists sessions with camelCase fields', async () => {
    const app = buildServer();
    seedSession(getDb(app));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/sessions' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      id: 'sess-1',
      repoOwner: 'acme',
      repoName: 'widgets',
      opencodeSessionId: null,
    });
    await app.close();
  });

  it('filters by status', async () => {
    const app = buildServer();
    const db = getDb(app);
    seedSession(db, { id: 'a', status: 'active' });
    seedSession(db, { id: 'b', status: 'archived' });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions?status=archived',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe('b');
    await app.close();
  });

  it('respects limit and offset', async () => {
    const app = buildServer();
    const db = getDb(app);
    seedSession(db, { id: 'a' });
    seedSession(db, { id: 'b' });
    seedSession(db, { id: 'c' });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions?limit=1&offset=1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sessions).toHaveLength(1);
    await app.close();
  });

  it('returns 400 on invalid limit', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions?limit=not-a-number',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'INVALID_PAGINATION' });
    await app.close();
  });

  it('returns 400 on negative offset', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions?offset=-1',
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns the session with a null phase', async () => {
    const app = buildServer();
    seedSession(getDb(app));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/sess-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'sess-1', phase: null });
    await app.close();
  });

  it('returns 404 for an unknown session id', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/does-not-exist',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'SESSION_NOT_FOUND' });
    await app.close();
  });
});

describe('GET /api/sessions/:id/events', () => {
  it('returns 404 for an unknown session id', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/does-not-exist/events',
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('paginates by cursor without duplicates across page boundaries', async () => {
    const app = buildServer();
    const db = getDb(app);
    seedSession(db);
    seedEvent(db, 'sess-1', '2024-01-01T00:00:00.000Z', 'data: frame-1\n\n');
    seedEvent(db, 'sess-1', '2024-01-01T00:00:01.000Z', 'data: frame-2\n\n');
    seedEvent(db, 'sess-1', '2024-01-01T00:00:01.000Z', 'data: frame-3\n\n');
    seedEvent(db, 'sess-1', '2024-01-01T00:00:02.000Z', 'data: frame-4\n\n');
    await app.ready();

    const firstPage = await app.inject({
      method: 'GET',
      url: '/api/sessions/sess-1/events?limit=2',
    });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json();
    expect(firstBody.events.map((/** @type {any} */ e) => e.payload)).toEqual([
      'data: frame-1\n\n',
      'data: frame-2\n\n',
    ]);
    expect(firstBody.nextCursor).toBeTruthy();

    const secondPage = await app.inject({
      method: 'GET',
      url: `/api/sessions/sess-1/events?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json();
    expect(secondBody.events.map((/** @type {any} */ e) => e.payload)).toEqual([
      'data: frame-3\n\n',
      'data: frame-4\n\n',
    ]);

    const allIds = [...firstBody.events, ...secondBody.events].map(
      (/** @type {any} */ e) => e.id,
    );
    expect(new Set(allIds).size).toBe(allIds.length);
    await app.close();
  });

  it('returns 400 on a malformed cursor', async () => {
    const app = buildServer();
    seedSession(getDb(app));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/sess-1/events?cursor=not-valid-base64url!!!',
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('cursor encode/decode', () => {
  it('round-trips a timestamp/id pair', () => {
    const cursor = encodeCursor('2024-01-01T00:00:01.000Z', 42);
    expect(decodeCursor(cursor)).toEqual({
      timestamp: '2024-01-01T00:00:01.000Z',
      id: 42,
    });
  });

  it('distinguishes same-timestamp entries by id (tie-break)', () => {
    const a = encodeCursor('2024-01-01T00:00:01.000Z', 1);
    const b = encodeCursor('2024-01-01T00:00:01.000Z', 2);
    expect(decodeCursor(a).id).not.toBe(decodeCursor(b).id);
    expect(decodeCursor(a).timestamp).toBe(decodeCursor(b).timestamp);
  });

  it('throws on a malformed cursor', () => {
    expect(() => decodeCursor('not-a-real-cursor')).toThrow();
  });
});

describe('POST /api/sessions', () => {
  it('creates a session, spawns the sandbox, and returns 201 { id }', async () => {
    vi.mocked(sandbox.run).mockResolvedValue({
      containerName: 'sandbox-x',
      containerId: 'abc123',
    });
    vi.mocked(sandbox.waitForHealth).mockResolvedValue({
      exists: true,
      state: 'running',
    });
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'My session',
        repoOwner: 'acme',
        repoName: 'widgets',
        model: 'litellm/claude-sonnet',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(typeof body.id).toBe('string');
    expect(sandbox.run).toHaveBeenCalledWith(
      expect.objectContaining({ id: body.id, model: 'litellm/claude-sonnet' }),
    );
    expect(sandbox.waitForHealth).toHaveBeenCalledWith('sandbox-x');

    const row = getDb(app)
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(body.id);
    expect(row?.status).toBe('active');
    expect(row?.container_name).toBe('sandbox-x');
    await app.close();
  });

  it('accepts a well-formed model even if not in the allowlist (no membership gate)', async () => {
    vi.mocked(sandbox.run).mockResolvedValue({
      containerName: 'sandbox-x',
      containerId: 'abc123',
    });
    vi.mocked(sandbox.waitForHealth).mockResolvedValue({
      exists: true,
      state: 'running',
    });
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'My session',
        repoOwner: 'acme',
        repoName: 'widgets',
        model: 'litellm/not-in-allowlist',
      },
    });

    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it('rejects a malformed model with 400 INVALID_MODEL_REFERENCE', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'My session',
        repoOwner: 'acme',
        repoName: 'widgets',
        model: 'claude-sonnet',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'INVALID_MODEL_REFERENCE' });
    expect(sandbox.run).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 500 with a readable message on spawn failure, leaving the row queryable', async () => {
    vi.mocked(sandbox.run).mockRejectedValue(new Error('docker: bad image'));
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'My session',
        repoOwner: 'acme',
        repoName: 'widgets',
        model: 'litellm/claude-sonnet',
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'docker: bad image' });

    const rows = getDb(app).prepare('SELECT * FROM sessions').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    await app.close();
  });
});

describe('POST /api/sessions/:id/prompt', () => {
  it('returns 404 for an unknown session, without touching the sandbox', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/does-not-exist/prompt',
      payload: { content: 'hi' },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('proxies to the bridge and returns its ack', async () => {
    const app = buildServer();
    seedSession(getDb(app), { id: 'sess-1', container_name: 'sandbox-1' });
    await app.ready();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ messageId: 'm1', position: 1 }), {
        status: 200,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/sess-1/prompt',
      payload: { content: 'hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ messageId: 'm1', position: 1 });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://sandbox-1:8080/prompt',
      expect.objectContaining({ method: 'POST' }),
    );
    fetchSpy.mockRestore();
    await app.close();
  });

  it('returns 503 when the bridge is unreachable', async () => {
    const app = buildServer();
    seedSession(getDb(app), { id: 'sess-1', container_name: 'sandbox-1' });
    await app.ready();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/sess-1/prompt',
      payload: { content: 'hello' },
    });

    expect(response.statusCode).toBe(503);
    fetchSpy.mockRestore();
    await app.close();
  });

  it('returns 503 when no sandbox has been spawned yet', async () => {
    const app = buildServer();
    seedSession(getDb(app), { id: 'sess-1', container_name: null });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/sess-1/prompt',
      payload: { content: 'hello' },
    });

    expect(response.statusCode).toBe(503);
    await app.close();
  });
});

/**
 * Reaches into the Fastify instance's database handle, decorated in `server.js` as `app.db`.
 * @param {import('fastify').FastifyInstance} app - Fastify instance built by `buildServer()`.
 * @returns {import('node:sqlite').DatabaseSync} The instance's database handle.
 */
function getDb(app) {
  return /** @type {any} */ (app).db;
}
