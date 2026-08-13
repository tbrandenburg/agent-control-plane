import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession, fetchSessions, stopSession } from './client';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe('client request()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not set content-type on a bodyless POST (stopSession), so Fastify does not reject it as empty JSON', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ status: 'stopped' }));
    vi.stubGlobal('fetch', fetchMock);

    await stopSession('s1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('still sets content-type on a POST with a JSON body (createSession)', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ id: 's1', wsToken: 'tok' }));
    vi.stubGlobal('fetch', fetchMock);

    await createSession({
      title: 'Test',
      repoOwner: 'acme',
      repoName: 'widgets',
      model: 'litellm/model',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
  });
});

describe('fetchSessions()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /api/sessions with no query string when no params are given', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ sessions: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessions();

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', expect.anything());
  });

  it('builds a query string from status/limit/offset params', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ sessions: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessions({ status: 'active', limit: 20, offset: 40 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('status=active');
    expect(url).toContain('limit=20');
    expect(url).toContain('offset=40');
  });
});
