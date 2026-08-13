import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { promptSession } from './prompt-session.js';

/** @type {string} */
let dataDir;
/** @type {import('node:sqlite').DatabaseSync} */
let db;

function seedSession(overrides = {}) {
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
    ws_token: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO sessions
      (id, title, repo_owner, repo_name, model, reasoning_effort, status, container_name, opencode_session_id, ws_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    row.ws_token,
  );
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cp-prompt-session-test-'));
  db = openDb(dataDir);
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('promptSession', () => {
  it('returns 503 SANDBOX_STARTING when the session is still pending_bootstrap', async () => {
    seedSession({ container_name: null, status: 'pending_bootstrap' });

    const result = await promptSession(db, fetch, 'sess-1', { content: 'hi' });

    expect(result).toEqual({
      status: 503,
      body: { error: 'SANDBOX_STARTING' },
    });
  });

  it('returns 503 SANDBOX_UNAVAILABLE when no container and status is not pending_bootstrap', async () => {
    seedSession({ container_name: null, status: 'pending_bootstrap-failed' });

    const result = await promptSession(db, fetch, 'sess-1', { content: 'hi' });

    expect(result).toEqual({
      status: 503,
      body: { error: 'SANDBOX_UNAVAILABLE' },
    });
  });

  it('returns 503 SANDBOX_UNAVAILABLE when the bridge fetch fails', async () => {
    seedSession({ container_name: 'sandbox-1', status: 'active' });
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await promptSession(db, fetchImpl, 'sess-1', {
      content: 'hi',
    });

    expect(result).toEqual({
      status: 503,
      body: { error: 'SANDBOX_UNAVAILABLE' },
    });
  });
});
