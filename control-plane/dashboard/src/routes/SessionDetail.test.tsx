import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import { SessionDetail } from './SessionDetail';

function renderSessionDetail(id: string) {
  const queryClient = new QueryClient();
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
