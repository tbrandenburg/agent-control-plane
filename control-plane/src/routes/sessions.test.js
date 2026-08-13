import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../server.js';
import { decodeCursor, encodeCursor } from './sessions.js';

vi.mock('../sandbox.js', () => ({
  run: vi.fn(),
  waitForHealth: vi.fn(),
  stop: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock('../bootstrap.js', () => ({
  bootstrapWorkspace: vi.fn(),
}));

const sandbox = await import('../sandbox.js');
const bootstrap = await import('../bootstrap.js');

/** @type {string} */
let dataDir;
/** @type {string|undefined} */
let previousDataDir;
/** @type {string} */
let workspaceHostPath;
/** @type {string|undefined} */
let previousWorkspaceHostPath;

/** Waits for `setImmediate`-scheduled work (this step's async spawn split) to have run. */
function flushAsyncSpawn() {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cp-sessions-test-'));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  workspaceHostPath = mkdtempSync(join(tmpdir(), 'cp-sessions-workspace-'));
  previousWorkspaceHostPath = process.env.WORKSPACE_HOST_PATH;
  process.env.WORKSPACE_HOST_PATH = workspaceHostPath;
  vi.mocked(sandbox.run).mockReset();
  vi.mocked(sandbox.waitForHealth).mockReset();
  vi.mocked(sandbox.stop).mockReset();
  vi.mocked(sandbox.inspect).mockReset();
  vi.mocked(bootstrap.bootstrapWorkspace).mockReset();
  vi.mocked(bootstrap.bootstrapWorkspace).mockResolvedValue({
    targetDir: '/workspace/target',
    platformConfigDir: '/workspace/platform',
    teamConfigDir: null,
  });
});

afterEach(async () => {
  if (previousWorkspaceHostPath === undefined) {
    delete process.env.WORKSPACE_HOST_PATH;
  } else {
    process.env.WORKSPACE_HOST_PATH = previousWorkspaceHostPath;
  }
  rmSync(workspaceHostPath, { recursive: true, force: true });
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
    model: 'opencode/big-pickle',
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
  it('returns a null phase when the session has no container', async () => {
    const app = buildServer();
    seedSession(getDb(app), { container_name: null });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/sess-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'sess-1', phase: null });
    expect(sandbox.inspect).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the real docker inspect phase for a live container', async () => {
    const app = buildServer();
    seedSession(getDb(app), { container_name: 'sandbox-sess-1' });
    vi.mocked(sandbox.inspect).mockResolvedValue({
      exists: true,
      state: 'running',
    });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/sess-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'sess-1', phase: 'running' });
    expect(sandbox.inspect).toHaveBeenCalledWith('sandbox-sess-1');
    await app.close();
  });

  it('returns a null phase when the container no longer exists', async () => {
    const app = buildServer();
    seedSession(getDb(app), { container_name: 'sandbox-sess-1' });
    vi.mocked(sandbox.inspect).mockResolvedValue({ exists: false });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/sess-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'sess-1', phase: null });
    await app.close();
  });

  it('falls back to a null phase when sandbox.inspect throws', async () => {
    const app = buildServer();
    seedSession(getDb(app), { container_name: 'sandbox-sess-1' });
    vi.mocked(sandbox.inspect).mockRejectedValue(new Error('docker not found'));
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
  it('returns 202 immediately with { id, wsToken }, before bootstrap completes', async () => {
    /** @type {(value?: unknown) => void} */
    let resolveRun;
    vi.mocked(sandbox.run).mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'My session',
        repoOwner: 'acme',
        repoName: 'widgets',
        model: 'opencode/big-pickle',
      },
    });

    // The 202 already arrived even though `sandbox.run` has not resolved yet — proves the
    // response is decoupled from the (deliberately unresolved) bootstrap stub.
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(typeof body.id).toBe('string');
    expect(typeof body.wsToken).toBe('string');

    const row = getDb(app)
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(body.id);
    expect(row?.status).toBe('pending_bootstrap');
    expect(row?.container_name).toBeNull();

    vi.mocked(sandbox.waitForHealth).mockResolvedValue({
      exists: true,
      state: 'running',
    });
    resolveRun({ containerName: 'sandbox-x', containerId: 'abc123' });
    await flushAsyncSpawn();
    await app.close();
  });

  it('transitions to active with the container name once bootstrap/spawn succeeds', async () => {
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
        model: 'opencode/big-pickle',
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    await flushAsyncSpawn();

    expect(sandbox.run).toHaveBeenCalledWith(
      expect.objectContaining({ id: body.id, model: 'opencode/big-pickle' }),
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
        model: 'opencode/not-in-allowlist',
      },
    });

    expect(response.statusCode).toBe(202);
    await flushAsyncSpawn();
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

  it('rejects an invalid repoOwner with 400 INVALID_REPO_OWNER', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'My session',
        repoOwner: '../../etc',
        repoName: 'widgets',
        model: 'opencode/big-pickle',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'INVALID_REPO_OWNER' });
    expect(sandbox.run).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an invalid repoName with 400 INVALID_REPO_NAME', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'My session',
        repoOwner: 'acme',
        repoName: 'weird name!!',
        model: 'opencode/big-pickle',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'INVALID_REPO_NAME' });
    expect(sandbox.run).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a title exceeding the max length with 400 INVALID_TITLE', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'x'.repeat(201),
        repoOwner: 'acme',
        repoName: 'widgets',
        model: 'opencode/big-pickle',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'INVALID_TITLE' });
    expect(sandbox.run).not.toHaveBeenCalled();
    await app.close();
  });

  it('leaves the row queryable in a failed status on spawn failure', async () => {
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
        model: 'opencode/big-pickle',
      },
    });

    expect(response.statusCode).toBe(202);
    await flushAsyncSpawn();

    const rows = getDb(app).prepare('SELECT * FROM sessions').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending_bootstrap-failed');
    await app.close();
  });

  it('leaves the row queryable in a failed status when bootstrapWorkspace() itself fails, never calling sandbox.run()', async () => {
    const bootstrapError = new Error(
      'bootstrap failed for target repo: repository not found',
    );
    bootstrapError.role = 'target';
    bootstrapError.classification = 'not_found';
    vi.mocked(bootstrap.bootstrapWorkspace).mockRejectedValue(bootstrapError);
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'My session',
        repoOwner: 'this-org-should-not-exist-zzz',
        repoName: 'nope',
        model: 'opencode/big-pickle',
      },
    });

    expect(response.statusCode).toBe(202);
    await flushAsyncSpawn();

    expect(sandbox.run).not.toHaveBeenCalled();
    const rows = getDb(app).prepare('SELECT * FROM sessions').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending_bootstrap-failed');
    await app.close();
  });

  it('resolves the target repo URL from repoOwner/repoName and passes the optional teamConfigRepo through to bootstrapWorkspace()', async () => {
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

    await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'My session',
        repoOwner: 'acme',
        repoName: 'widgets',
        model: 'opencode/big-pickle',
        teamConfigRepo: 'acme/team-config',
      },
    });
    await flushAsyncSpawn();

    expect(bootstrap.bootstrapWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRepo: { url: 'https://github.com/acme/widgets.git', ref: 'HEAD' },
        teamConfigRepo: {
          url: 'https://github.com/acme/team-config.git',
          ref: 'HEAD',
        },
      }),
      expect.stringContaining(workspaceHostPath),
    );
    expect(sandbox.run).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDir: '/workspace/target',
        platformConfigDir: '/workspace/platform',
      }),
    );
    await app.close();
  });
});

describe('POST /api/sessions/:id/stop', () => {
  it('returns 404 for an unknown session', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/does-not-exist/stop',
    });

    expect(response.statusCode).toBe(404);
    expect(sandbox.stop).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 409 with no attempted stop when no sandbox has been spawned yet', async () => {
    const app = buildServer();
    seedSession(getDb(app), { id: 'sess-1', container_name: null });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/sess-1/stop',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'NO_LIVE_CONTAINER' });
    expect(sandbox.stop).not.toHaveBeenCalled();
    await app.close();
  });

  it('proxies to sandbox.stop(), reports which path stopped it, and clears container_name', async () => {
    vi.mocked(sandbox.stop).mockResolvedValue({ method: 'docker' });
    const app = buildServer();
    seedSession(getDb(app), { id: 'sess-1', container_name: 'sandbox-1' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/sess-1/stop',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'stopped', method: 'docker' });
    expect(sandbox.stop).toHaveBeenCalledWith('sandbox-1');

    const row = getDb(app)
      .prepare('SELECT container_name FROM sessions WHERE id = ?')
      .get('sess-1');
    expect(row.container_name).toBeNull();
    await app.close();
  });

  it('returns 502 and leaves container_name untouched when sandbox.stop() fails', async () => {
    vi.mocked(sandbox.stop).mockRejectedValue(
      new Error('docker: no such container'),
    );
    const app = buildServer();
    seedSession(getDb(app), { id: 'sess-1', container_name: 'sandbox-1' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/sess-1/stop',
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'docker: no such container' });

    const row = getDb(app)
      .prepare('SELECT container_name FROM sessions WHERE id = ?')
      .get('sess-1');
    expect(row.container_name).toBe('sandbox-1');
    await app.close();
  });
});

describe('PATCH /api/sessions/:id', () => {
  it('returns 404 for an unknown session', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/does-not-exist',
      payload: { status: 'archived' },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('returns 400 on an invalid status value', async () => {
    const app = buildServer();
    seedSession(getDb(app), { id: 'sess-1' });
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/sess-1',
      payload: { status: 'pending_bootstrap' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'INVALID_STATUS' });
    await app.close();
  });

  it('transitions active -> archived', async () => {
    const app = buildServer();
    seedSession(getDb(app), { id: 'sess-1', status: 'active' });
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/sess-1',
      payload: { status: 'archived' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'sess-1', status: 'archived' });

    const row = getDb(app)
      .prepare('SELECT status FROM sessions WHERE id = ?')
      .get('sess-1');
    expect(row?.status).toBe('archived');
    await app.close();
  });

  it('transitions archived -> active', async () => {
    const app = buildServer();
    seedSession(getDb(app), { id: 'sess-1', status: 'archived' });
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/sess-1',
      payload: { status: 'active' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'sess-1', status: 'active' });
    expect(sandbox.stop).not.toHaveBeenCalled();
    await app.close();
  });

  it('archiving a session with a live container stops it and clears container_name', async () => {
    vi.mocked(sandbox.stop).mockResolvedValue({ method: 'docker' });
    const app = buildServer();
    seedSession(getDb(app), {
      id: 'sess-1',
      status: 'active',
      container_name: 'sandbox-1',
    });
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/sess-1',
      payload: { status: 'archived' },
    });

    expect(response.statusCode).toBe(200);
    expect(sandbox.stop).toHaveBeenCalledWith('sandbox-1');

    const row = getDb(app)
      .prepare('SELECT status, container_name FROM sessions WHERE id = ?')
      .get('sess-1');
    expect(row.status).toBe('archived');
    expect(row.container_name).toBeNull();
    await app.close();
  });

  it('archiving still succeeds (status flips) even if sandbox.stop() throws', async () => {
    vi.mocked(sandbox.stop).mockRejectedValue(
      new Error('docker: no such container'),
    );
    const app = buildServer();
    seedSession(getDb(app), {
      id: 'sess-1',
      status: 'active',
      container_name: 'sandbox-1',
    });
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/sess-1',
      payload: { status: 'archived' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'sess-1', status: 'archived' });
    expect(sandbox.stop).toHaveBeenCalledWith('sandbox-1');

    // Stop failed, so container_name is left as-is for later manual cleanup, but the
    // archive status itself still took effect.
    const row = getDb(app)
      .prepare('SELECT status, container_name FROM sessions WHERE id = ?')
      .get('sess-1');
    expect(row.status).toBe('archived');
    expect(row.container_name).toBe('sandbox-1');
    await app.close();
  });

  it('archiving a session with no live container skips calling sandbox.stop()', async () => {
    const app = buildServer();
    seedSession(getDb(app), {
      id: 'sess-1',
      status: 'active',
      container_name: null,
    });
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/sess-1',
      payload: { status: 'archived' },
    });

    expect(response.statusCode).toBe(200);
    expect(sandbox.stop).not.toHaveBeenCalled();

    const row = getDb(app)
      .prepare('SELECT status FROM sessions WHERE id = ?')
      .get('sess-1');
    expect(row.status).toBe('archived');
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

describe('DELETE /api/sessions', () => {
  it('returns { deleted: 0 } when there are no sessions', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: 0 });
    await app.close();
  });

  it('deletes all sessions and their events, best-effort stopping live containers', async () => {
    const app = buildServer();
    const db = getDb(app);
    seedSession(db, { id: 'sess-1', container_name: 'sandbox-1' });
    seedSession(db, { id: 'sess-2', container_name: null });
    seedEvent(db, 'sess-1', '2024-01-01T00:00:00Z', '{"a":1}');
    seedEvent(db, 'sess-2', '2024-01-01T00:00:01Z', '{"b":1}');
    vi.mocked(sandbox.stop).mockResolvedValue({ method: 'docker' });
    await app.ready();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: 2 });
    expect(sandbox.stop).toHaveBeenCalledWith('sandbox-1');
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT * FROM sessions').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM events').all()).toEqual([]);
    await app.close();
  });

  it('still deletes the sessions and events when sandbox.stop() fails', async () => {
    const app = buildServer();
    const db = getDb(app);
    seedSession(db, { id: 'sess-1', container_name: 'sandbox-1' });
    seedEvent(db, 'sess-1', '2024-01-01T00:00:00Z', '{"a":1}');
    vi.mocked(sandbox.stop).mockRejectedValue(new Error('docker not found'));
    await app.ready();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: 1 });
    expect(db.prepare('SELECT * FROM sessions').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM events').all()).toEqual([]);
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
