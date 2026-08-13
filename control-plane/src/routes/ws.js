/**
 * WebSocket subset for live sessions — `subscribe`/`prompt`/`ping` (ARCHITECTURE.md's WS
 * surface). One WS connection per browser tab, gated by the session's plaintext `ws_token`
 * (minted alongside the session row, never persisted anywhere else).
 */

import { promptSession } from '../prompt-session.js';

/**
 * Module-level subscriber registry: `sessionId -> Set<WebSocket>`. Lives for the process
 * lifetime; entries are added on a successful `subscribe` and removed on socket `close`.
 * @type {Map<string, Set<import('ws').WebSocket>>}
 */
const subscribers = new Map();

const CLOSE_UNAUTHORIZED = 4001;

/**
 * Sends `payload` (JSON-stringified) to every socket currently subscribed to `sessionId`.
 * @param {string} sessionId - Session id whose subscribers should receive the payload.
 * @param {object} payload - Payload to broadcast.
 * @returns {void}
 */
export function broadcastToSession(sessionId, payload) {
  const sockets = subscribers.get(sessionId);
  if (!sockets) return;
  const message = JSON.stringify(payload);
  for (const socket of sockets) {
    socket.send(message);
  }
}

/**
 * Adds `socket` to `sessionId`'s subscriber set, creating the set if needed.
 * @param {string} sessionId - Session id to subscribe to.
 * @param {import('ws').WebSocket} socket - Socket to register.
 * @returns {void}
 */
function addSubscriber(sessionId, socket) {
  let sockets = subscribers.get(sessionId);
  if (!sockets) {
    sockets = new Set();
    subscribers.set(sessionId, sockets);
  }
  sockets.add(socket);
}

/**
 * Removes `socket` from `sessionId`'s subscriber set, deleting the set entirely once empty so
 * the registry never accumulates dead session keys.
 * @param {string} sessionId - Session id to unsubscribe from.
 * @param {import('ws').WebSocket} socket - Socket to remove.
 * @returns {void}
 */
function removeSubscriber(sessionId, socket) {
  const sockets = subscribers.get(sessionId);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) subscribers.delete(sessionId);
}

/**
 * @typedef {object} WsRoutesDeps
 * @property {typeof fetch} [fetchImpl] - `fetch` implementation, swappable in tests.
 */

/**
 * Registers the `/ws/sessions/:id` route on the given Fastify instance. Requires the
 * `@fastify/websocket` plugin to already be registered.
 * @param {import('fastify').FastifyInstance} app - Fastify instance to register the route on.
 * @param {import('node:sqlite').DatabaseSync} db - Open, migrated database handle.
 * @param {WsRoutesDeps} [deps] - Injectable fetch, defaulting to the real one.
 * @returns {void}
 */
export function registerWsRoutes(
  app,
  db,
  { fetchImpl = (...args) => fetch(...args) } = {},
) {
  app.get('/ws/sessions/:id', { websocket: true }, (socket, req) => {
    const { id } = /** @type {{id: string}} */ (req.params);
    let subscribed = false;

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(CLOSE_UNAUTHORIZED);
        return;
      }

      const type = message?.type;

      if (type === 'subscribe') {
        // `subscribe` is a hard precondition (never logged: the plaintext `wsToken` must not
        // appear anywhere, including error logs).
        const row = /** @type {{ws_token: string}|undefined} */ (
          db.prepare('SELECT ws_token FROM sessions WHERE id = ?').get(id)
        );
        if (!row || row.ws_token !== message.wsToken) {
          socket.close(CLOSE_UNAUTHORIZED);
          return;
        }
        subscribed = true;
        addSubscriber(id, socket);
        return;
      }

      if (!subscribed) {
        socket.close(CLOSE_UNAUTHORIZED);
        return;
      }

      if (type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (type === 'prompt') {
        const { type: _type, ...body } = message;
        promptSession(db, fetchImpl, id, body).then((result) => {
          socket.send(JSON.stringify({ type: 'prompt-result', ...result }));
        });
        return;
      }

      socket.close(CLOSE_UNAUTHORIZED);
    });

    socket.on('close', () => {
      if (subscribed) removeSubscriber(id, socket);
    });
  });
}
