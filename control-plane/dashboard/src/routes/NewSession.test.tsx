import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import { NewSession } from './NewSession';

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

function renderNewSession() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NewSession />
    </QueryClientProvider>,
  );
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/title/i), {
    target: { value: 'Fix flaky test' },
  });
  fireEvent.change(screen.getByLabelText(/repository owner/i), {
    target: { value: 'acme' },
  });
  fireEvent.change(screen.getByLabelText(/repository name/i), {
    target: { value: 'widgets' },
  });
}

describe('NewSession — team config field', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits teamConfigRepo from the create body when the field is left empty', async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url).includes('/api/models'))
        return jsonResponse({ models: [{ id: 'litellm/model', name: 'M' }] });
      return jsonResponse({ id: 'sess-1', wsToken: 'tok-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderNewSession();
    await waitFor(() =>
      expect(screen.getByLabelText(/^model$/i)).toBeInTheDocument(),
    );
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: /create session/i }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(
        (c) => String(c[0]) === '/api/sessions',
      );
      expect(createCall).toBeDefined();
    });

    const createCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/sessions',
    );
    const body = JSON.parse(String(createCall?.[1]?.body));
    expect(body).not.toHaveProperty('teamConfigRepo');
  });

  it('submits teamConfigRepo in the create body when filled', async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url).includes('/api/models'))
        return jsonResponse({ models: [{ id: 'litellm/model', name: 'M' }] });
      return jsonResponse({ id: 'sess-1', wsToken: 'tok-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderNewSession();
    await waitFor(() =>
      expect(screen.getByLabelText(/^model$/i)).toBeInTheDocument(),
    );
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText(/team config/i), {
      target: { value: 'acme/team-config' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create session/i }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(
        (c) => String(c[0]) === '/api/sessions',
      );
      expect(createCall).toBeDefined();
    });

    const createCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/sessions',
    );
    const body = JSON.parse(String(createCall?.[1]?.body));
    expect(body.teamConfigRepo).toBe('acme/team-config');
  });
});
