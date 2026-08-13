/**
 * Tests for the WebSocket subset (`subscribe`/`prompt`/`ping`) — token gating, broadcast
 * fan-out, and subscriber registry cleanup on disconnect.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { broadcastToSession } from './ws.js';

/** @type {string} */
let dataDir;
/** @type {string|undefined} */
let previousDataDir;
/** @type {import('fastify').FastifyInstance} */
let app;
/** @type {string} */
let wsBaseUrl;

/**
 * Inserts a session row directly with a known `ws_token`.
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
    ws_token: 'correct-token',
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
  return row.id;
}

/**
 * Opens a WS connection to `wsBaseUrl` and resolves once it's open.
 * @param {string} id - Session id to connect to.
 * @returns {Promise<WebSocket>} The open socket.
 */
function connect(id) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBaseUrl}/ws/sessions/${id}`);
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', reject);
  });
}

/**
 * Resolves with the next parsed JSON message received on `socket`.
 * @param {WebSocket} socket - Socket to listen on.
 * @returns {Promise<object>} The parsed message.
 */
function nextMessage(socket) {
  return new Promise((resolve) => {
    socket.addEventListener(
      'message',
      (event) => resolve(JSON.parse(event.data.toString())),
      { once: true },
    );
  });
}

/**
 * Resolves with the close event's code once `socket` closes.
 * @param {WebSocket} socket - Socket to listen on.
 * @returns {Promise<number>} The close code.
 */
function nextClose(socket) {
  return new Promise((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code), {
      once: true,
    });
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'cp-ws-test-'));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  app = buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  wsBaseUrl = `ws://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await app.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('WebSocket subset', () => {
  it('subscribes with the correct token and receives a broadcast event', async () => {
    const id = seedSession(app.db);
    const socket = await connect(id);
    socket.send(
      JSON.stringify({ type: 'subscribe', wsToken: 'correct-token' }),
    );
    // Give the server a tick to process the subscribe before broadcasting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const messageReceived = nextMessage(socket);
    broadcastToSession(id, { type: 'event', payload: 'hello' });
    const message = await messageReceived;

    expect(message).toEqual({ type: 'event', payload: 'hello' });
    socket.close();
  });

  it('closes with code 4001 on a wrong token', async () => {
    const id = seedSession(app.db);
    const socket = await connect(id);
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: 'subscribe', wsToken: 'wrong-token' }));

    expect(await closed).toBe(4001);
  });

  it('closes with code 4001 on a missing token', async () => {
    const id = seedSession(app.db);
    const socket = await connect(id);
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: 'subscribe' }));

    expect(await closed).toBe(4001);
  });

  it('fans out a broadcast to two sockets subscribed to the same session', async () => {
    const id = seedSession(app.db);
    const socketA = await connect(id);
    const socketB = await connect(id);
    socketA.send(
      JSON.stringify({ type: 'subscribe', wsToken: 'correct-token' }),
    );
    socketB.send(
      JSON.stringify({ type: 'subscribe', wsToken: 'correct-token' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const messageA = nextMessage(socketA);
    const messageB = nextMessage(socketB);
    broadcastToSession(id, { type: 'event', payload: 'fan-out' });

    expect(await messageA).toEqual({ type: 'event', payload: 'fan-out' });
    expect(await messageB).toEqual({ type: 'event', payload: 'fan-out' });
    socketA.close();
    socketB.close();
  });

  it('rejects a socket sending prompt before subscribe', async () => {
    const id = seedSession(app.db);
    const socket = await connect(id);
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: 'prompt', content: 'hi' }));

    expect(await closed).toBe(4001);
  });

  it('replies to ping after a successful subscribe', async () => {
    const id = seedSession(app.db);
    const socket = await connect(id);
    socket.send(
      JSON.stringify({ type: 'subscribe', wsToken: 'correct-token' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const messageReceived = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'ping' }));

    expect(await messageReceived).toEqual({ type: 'pong' });
    socket.close();
  });

  it('leaves no dead-socket references in the registry after all sockets close', async () => {
    const id = seedSession(app.db);
    const socket = await connect(id);
    socket.send(
      JSON.stringify({ type: 'subscribe', wsToken: 'correct-token' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const closed = nextClose(socket);
    socket.close();
    await closed;
    // A subsequent broadcast to the now-empty session must not throw and must be a no-op.
    expect(() => broadcastToSession(id, { type: 'event' })).not.toThrow();
  });
});
