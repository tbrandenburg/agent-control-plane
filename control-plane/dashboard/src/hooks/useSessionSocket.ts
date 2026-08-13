/**
 * Live transcript over `GET /ws/sessions/:id` (ARCHITECTURE.md §6, this phase's subset: only
 * `subscribe`/`prompt`/`ping` exist server-side; `presence`/`fetch_history`/`stop` are Phase 6).
 * Opens the socket, sends `subscribe` first, then appends every incoming `{type:"event",...}`
 * frame to the transcript — the **content** contract (render `message.part.delta` incrementally)
 * is unchanged from Phase 1's polling hook, only the transport is. No `fetch_history` yet, so the
 * transcript starts empty on every fresh mount/reconnect (Out of Scope, this step).
 */
import { useEffect, useRef, useState } from 'react';
import type { EventRecord } from '@/api/client';

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** WS close code the server sends for a missing/stale `wsToken` (`routes/ws.js`). */
const CLOSE_UNAUTHORIZED = 4001;
/** WS close code the server sends when the session is in a terminal status (`routes/ws.js`). */
const CLOSE_SESSION_ARCHIVED = 4002;
/** Delay before a dropped, non-auth-failure socket reconnects. */
const RECONNECT_DELAY_MS = 1000;

function wsUrl(sessionId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/sessions/${sessionId}`;
}

/**
 * Connects to the session's WebSocket transcript. Returns accumulated events plus the live
 * connection state; reconnects automatically after an unexpected drop, but never after an
 * auth failure (`invalidToken`) or a terminal-status close (`4002`).
 * @param sessionId - Session whose transcript to stream.
 * @param wsToken - Plaintext token minted at session creation (§6); `null` disables connecting.
 * @param shouldConnect - Whether the socket should be open at all — `false` for a session in a
 *   terminal status (`archived`/`pending_bootstrap-failed`), so a lingering socket never shows a
 *   stale "Connected" indicator (issue #28). Defaults to `true`.
 */
export function useSessionSocket(
  sessionId: string,
  wsToken: string | null,
  shouldConnect = true,
): { events: EventRecord[]; status: SocketStatus; invalidToken: boolean } {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [invalidToken, setInvalidToken] = useState(false);
  const nextId = useRef(0);

  useEffect(() => {
    if (!shouldConnect) {
      setStatus('closed');
      return;
    }

    if (!wsToken) {
      setStatus('closed');
      setInvalidToken(true);
      return;
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect() {
      setStatus((prev) => (prev === 'closed' ? 'reconnecting' : prev));
      socket = new WebSocket(wsUrl(sessionId));

      socket.addEventListener('open', () => {
        if (cancelled) return;
        setStatus('open');
        socket?.send(JSON.stringify({ type: 'subscribe', wsToken }));
      });

      socket.addEventListener('message', (ev) => {
        if (cancelled) return;
        let message: { type?: string } | null = null;
        try {
          message = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (!message || message.type === 'pong') return;
        setEvents((prev) => [
          ...prev,
          {
            id: nextId.current++,
            sessionId,
            timestamp: new Date().toISOString(),
            payload: JSON.stringify(message),
          },
        ]);
      });

      socket.addEventListener('close', (ev) => {
        if (cancelled) return;
        if (ev.code === CLOSE_UNAUTHORIZED) {
          setInvalidToken(true);
          setStatus('closed');
          return;
        }
        if (ev.code === CLOSE_SESSION_ARCHIVED) {
          setStatus('closed');
          return;
        }
        setStatus('closed');
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [sessionId, wsToken, shouldConnect]);

  return { events, status, invalidToken };
}
