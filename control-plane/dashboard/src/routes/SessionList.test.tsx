import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import { SessionList } from './SessionList';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function makeSession(id: string, status = 'active') {
  return {
    id,
    title: `Session ${id}`,
    repoOwner: 'acme',
    repoName: 'widgets',
    model: 'opencode/big-pickle',
    reasoningEffort: null,
    status,
    containerName: null,
    opencodeSessionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderSessionList() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionList />
    </QueryClientProvider>,
  );
}

describe('SessionList — status filter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('re-fetches with the status query param when the filter changes', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('status=archived')) {
        return jsonResponse({ sessions: [makeSession('a1', 'archived')] });
      }
      return jsonResponse({ sessions: [makeSession('s1', 'active')] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSessionList();

    await waitFor(() =>
      expect(screen.getByText('Session s1')).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText(/status/i), {
      target: { value: 'archived' },
    });

    await waitFor(() =>
      expect(screen.getByText('Session a1')).toBeInTheDocument(),
    );

    const archivedCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('status=archived'),
    );
    expect(archivedCall).toBeDefined();
    expect(screen.queryByText('Session s1')).not.toBeInTheDocument();
  });
});

describe('SessionList — pagination', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('clicking Load more fetches the next offset and appends rows', async () => {
    const PAGE_SIZE = 20;
    const firstPage = Array.from({ length: PAGE_SIZE }, (_, i) =>
      makeSession(`s${i}`),
    );
    const secondPage = [makeSession('extra')];

    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('offset=20')) {
        return jsonResponse({ sessions: secondPage });
      }
      return jsonResponse({ sessions: firstPage });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSessionList();

    await waitFor(() =>
      expect(screen.getByText('Session s0')).toBeInTheDocument(),
    );

    const loadMoreButton = screen.getByRole('button', { name: /load more/i });
    fireEvent.click(loadMoreButton);

    await waitFor(() =>
      expect(screen.getByText('Session extra')).toBeInTheDocument(),
    );

    // Original rows must still be present (accumulated, not replaced).
    expect(screen.getByText('Session s0')).toBeInTheDocument();

    const offsetCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('offset=20'),
    );
    expect(offsetCall).toBeDefined();
  });
});

describe('SessionList — clear all sessions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not call DELETE until the confirmation dialog is accepted', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({ deleted: 1 });
      }
      return jsonResponse({ sessions: [makeSession('s1')] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSessionList();

    await waitFor(() =>
      expect(screen.getByText('Session s1')).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole('button', { name: /clear all sessions/i }),
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(
      false,
    );

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(
      false,
    );
  });

  it('clears the session list on confirm and calls DELETE /api/sessions', async () => {
    let deleted = false;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted = true;
        return jsonResponse({ deleted: 1 });
      }
      return jsonResponse({ sessions: deleted ? [] : [makeSession('s1')] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSessionList();

    await waitFor(() =>
      expect(screen.getByText('Session s1')).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole('button', { name: /clear all sessions/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^clear all$/i }));

    await waitFor(() =>
      expect(screen.queryByText('Session s1')).not.toBeInTheDocument(),
    );

    const deleteCall = fetchMock.mock.calls.find(
      (c) => c[1]?.method === 'DELETE',
    );
    expect(deleteCall?.[0]).toBe('/api/sessions');
  });

  it('shows an error message when the delete request fails', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({ error: 'BOOM' }, 500);
      }
      return jsonResponse({ sessions: [makeSession('s1')] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSessionList();

    await waitFor(() =>
      expect(screen.getByText('Session s1')).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole('button', { name: /clear all sessions/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^clear all$/i }));

    await waitFor(() => expect(screen.getByText('BOOM')).toBeInTheDocument());
    expect(screen.getByText('Session s1')).toBeInTheDocument();
  });
});
