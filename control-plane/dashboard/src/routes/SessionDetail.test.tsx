import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import { storeWsToken } from '@/api/client';
import { SessionDetail } from './SessionDetail';

/** Minimal controllable fake WebSocket — no real network. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(cb);
  }
  send() {}
  close() {}
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const SESSION_BODY = {
  id: 's1',
  title: 'Fix flaky test',
  repoOwner: 'acme',
  repoName: 'widgets',
  model: 'opencode/big-pickle',
  reasoningEffort: 'high',
  status: 'active',
  containerName: 'sandbox_s1',
  opencodeSessionId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  phase: 'running',
};

function renderSessionDetail(id: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionDetail id={id} />
    </QueryClientProvider>,
  );
}

describe('SessionDetail — missing session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a styled not-found state and a link back to sessions, without retry-polling the 404', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'SESSION_NOT_FOUND' }), {
          status: 404,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderSessionDetail('nonexistent-id');

    await waitFor(() =>
      expect(
        screen.getByText(/this session does not exist or has been removed/i),
      ).toBeInTheDocument(),
    );

    expect(screen.queryByText('SESSION_NOT_FOUND')).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /back to sessions/i }),
    ).toHaveAttribute('href', '/');

    // Requests fired for /api/sessions/:id (session) and /api/models — a definitive 404
    // on the session fetch must not be retried.
    const sessionCalls = fetchMock.mock.calls.filter((args) =>
      String(args[0]).includes('/api/sessions/nonexistent-id'),
    );
    expect(sessionCalls).toHaveLength(1);
  });
});

describe('SessionDetail — Stop/Archive buttons', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeWebSocket.instances = [];
  });

  it('calls POST /api/sessions/:id/stop when Stop is clicked', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url).includes('/api/models'))
        return jsonResponse({ models: [] });
      if (String(url).endsWith('/stop'))
        return jsonResponse({ status: 'stopped', method: 'bridge' });
      return jsonResponse(SESSION_BODY);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSessionDetail('s1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /stop/i }));

    await waitFor(() => {
      const stopCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).endsWith('/api/sessions/s1/stop'),
      );
      expect(stopCall).toBeDefined();
      expect(stopCall?.[1]?.method).toBe('POST');
    });
  });

  it('shows a connected indicator once the socket opens, then a disconnected one on close', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url).includes('/api/models'))
        return jsonResponse({ models: [] });
      return jsonResponse(SESSION_BODY);
    });
    vi.stubGlobal('fetch', fetchMock);

    storeWsToken('s1', 'tok-1');
    renderSessionDetail('s1');
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];

    socket.listeners.open?.forEach((cb) => {
      cb({});
    });

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/connected/i),
    );

    socket.listeners.close?.forEach((cb) => {
      cb({ code: 1006 });
    });

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /reconnecting|disconnected/i,
      ),
    );
  });

  it('calls PATCH /api/sessions/:id {status: archived} when Archive is clicked', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url).includes('/api/models'))
        return jsonResponse({ models: [] });
      return jsonResponse(SESSION_BODY);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSessionDetail('s1');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /archive/i }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /archive/i }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) => c[1]?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
        status: 'archived',
      });
    });
  });
});

describe('SessionDetail — archived composer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeWebSocket.instances = [];
  });

  it('renders a read-only notice instead of the composer when the session is archived', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url).includes('/api/models'))
        return jsonResponse({ models: [] });
      return jsonResponse({ ...SESSION_BODY, status: 'archived' });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSessionDetail('s1');

    await waitFor(() =>
      expect(
        screen.getByText(/this session is archived/i),
      ).toBeInTheDocument(),
    );

    expect(
      screen.queryByPlaceholderText(/prompt|message/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /send/i }),
    ).not.toBeInTheDocument();
  });

  it('still renders the composer for an active session', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url).includes('/api/models'))
        return jsonResponse({ models: [] });
      return jsonResponse(SESSION_BODY);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSessionDetail('s1');

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /send/i }),
      ).toBeInTheDocument(),
    );

    expect(
      screen.queryByText(/this session is archived/i),
    ).not.toBeInTheDocument();
  });
});
