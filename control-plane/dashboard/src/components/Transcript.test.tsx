import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import { Transcript } from './Transcript';

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

function renderTranscript() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Transcript sessionId="s1" />
    </QueryClientProvider>,
  );
}

describe('Transcript', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends two polled pages without duplicating or dropping events', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (!url.includes('cursor=')) {
        return jsonResponse({
          events: [
            {
              id: 1,
              sessionId: 's1',
              timestamp: '2026-01-01T00:00:00.000Z',
              payload:
                '{"type":"message.part.delta","properties":{"part":{"id":"p1","text":"Hel"}}}',
            },
          ],
          nextCursor: 'cursor-1',
        });
      }
      if (url.includes('cursor=cursor-1')) {
        return jsonResponse({
          events: [
            {
              id: 2,
              sessionId: 's1',
              timestamp: '2026-01-01T00:00:01.000Z',
              payload:
                '{"type":"message.part.delta","properties":{"part":{"id":"p2","text":"World"}}}',
            },
          ],
          nextCursor: 'cursor-2',
        });
      }
      return jsonResponse({ events: [], nextCursor: 'cursor-2' });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTranscript();

    await waitFor(() => expect(screen.getByText('Hel')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('World')).toBeInTheDocument(), {
      timeout: 3000,
    });

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
  }, 8000);
});
