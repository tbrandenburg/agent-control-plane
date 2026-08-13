import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionSocket } from './useSessionSocket';

/** Minimal controllable fake WebSocket — no real network, full control over lifecycle events. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  listeners: Record<string, ((ev: unknown) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(cb);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.emit('close', { code: 1000 });
  }

  emit(type: string, ev: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

describe('useSessionSocket', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
  });

  it('connects, sends subscribe first, then renders incoming events', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const { result } = renderHook(() => useSessionSocket('s1', 'tok-1'));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toContain('/ws/sessions/s1');

    socket.emit('open', {});
    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'subscribe', wsToken: 'tok-1' }),
    ]);

    socket.emit('message', {
      data: JSON.stringify({
        type: 'message.part.delta',
        properties: { part: { id: 'p1', text: 'Hi' } },
      }),
    });

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.status).toBe('open');
    expect(JSON.parse(result.current.events[0].payload)).toMatchObject({
      type: 'message.part.delta',
    });
  });

  it('shows an invalid-token state on a 4001 close, without reconnecting', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const { result } = renderHook(() => useSessionSocket('s1', 'bad-token'));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0].emit('close', { code: 4001 });

    await waitFor(() => expect(result.current.invalidToken).toBe(true));
    expect(result.current.status).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('marks invalidToken immediately when no wsToken is available', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const { result } = renderHook(() => useSessionSocket('s1', null));

    expect(result.current.invalidToken).toBe(true);
    expect(result.current.status).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('does not connect when shouldConnect is false', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const { result } = renderHook(() => useSessionSocket('s1', 'tok-1', false));

    expect(result.current.status).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('closes the existing socket and stops reconnecting once shouldConnect flips to false', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const { result, rerender } = renderHook(
      ({ shouldConnect }: { shouldConnect: boolean }) =>
        useSessionSocket('s1', 'tok-1', shouldConnect),
      { initialProps: { shouldConnect: true } },
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    rerender({ shouldConnect: false });

    await waitFor(() => expect(result.current.status).toBe('closed'));
    // No new socket should have been opened after disabling.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not reconnect after a 4002 (session archived) close', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const { result } = renderHook(() => useSessionSocket('s1', 'tok-1'));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0].emit('close', { code: 4002 });

    await waitFor(() => expect(result.current.status).toBe('closed'));
    // Give the reconnect delay a chance to fire, then confirm no new socket appeared.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
