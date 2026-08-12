/**
 * Typed `fetch` wrappers + TanStack Query hooks for the control plane's REST API
 * (ARCHITECTURE.md §5). One thin module — no client-side caching beyond TanStack Query's own,
 * no request retries beyond its defaults.
 */
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export interface Session {
  id: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  model: string | null;
  reasoningEffort: string | null;
  status: string;
  containerName: string | null;
  opencodeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail extends Session {
  /** Live `docker inspect` phase, or `null` until wired in (ARCHITECTURE.md §4/§7). */
  phase: string | null;
}

export interface ModelOption {
  id: string;
  name: string;
}

export interface EventRecord {
  id: number;
  sessionId: string;
  timestamp: string;
  /** JSON-encoded opencode SSE frame, stored verbatim (ARCHITECTURE.md §4). */
  payload: string;
}

export interface CreateSessionInput {
  title: string;
  repoOwner: string;
  repoName: string;
  model: string;
  reasoningEffort?: string;
}

export interface PromptInput {
  content: string;
  model?: string;
  reasoningEffort?: string;
}

/** Thrown on any non-2xx API response, carrying the server's `error` code when present. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    throw new ApiError(
      body?.error ?? `Request failed (${res.status})`,
      res.status,
    );
  }
  return body as T;
}

export function fetchSessions(): Promise<{ sessions: Session[] }> {
  return request('/api/sessions');
}

export function fetchSession(id: string): Promise<SessionDetail> {
  return request(`/api/sessions/${id}`);
}

export function fetchModels(): Promise<{ models: ModelOption[] }> {
  return request('/api/models');
}

export interface EventsPage {
  events: EventRecord[];
  nextCursor: string | null;
}

export function fetchSessionEvents(
  id: string,
  cursor: string | null,
): Promise<EventsPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return request(`/api/sessions/${id}/events${query}`);
}

export function createSession(
  input: CreateSessionInput,
): Promise<{ id: string }> {
  return request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function sendPrompt(id: string, input: PromptInput): Promise<unknown> {
  return request(`/api/sessions/${id}/prompt`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function useSessions(): UseQueryResult<
  { sessions: Session[] },
  ApiError
> {
  return useQuery({ queryKey: ['sessions'], queryFn: fetchSessions });
}

export function useSession(
  id: string,
): UseQueryResult<SessionDetail, ApiError> {
  return useQuery({
    queryKey: ['session', id],
    queryFn: () => fetchSession(id),
  });
}

export function useModels(): UseQueryResult<
  { models: ModelOption[] },
  ApiError
> {
  return useQuery({ queryKey: ['models'], queryFn: fetchModels });
}

export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useSendPrompt(sessionId: string) {
  return useMutation({
    mutationFn: (input: PromptInput) => sendPrompt(sessionId, input),
  });
}

/**
 * Polls `GET /api/sessions/:id/events` every second and accumulates pages into a single
 * append-only transcript, advancing the `timestamp,id` cursor between polls (ARCHITECTURE.md
 * §4) — never re-sorted or re-fetched from the start, and never dropping already-seen events.
 * @param sessionId - Session whose events to poll.
 * @returns Accumulated events plus a `reconnecting` flag for non-blocking poll-failure UX.
 */
export function useSessionTranscript(sessionId: string): {
  events: EventRecord[];
  reconnecting: boolean;
} {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const cursorRef = useRef<string | null>(null);

  const query = useQuery({
    queryKey: ['sessionEvents', sessionId],
    queryFn: () => fetchSessionEvents(sessionId, cursorRef.current),
    refetchInterval: 1000,
  });

  useEffect(() => {
    if (!query.data) return;
    const { events: page, nextCursor } = query.data;
    if (page.length === 0) return;
    setEvents((prev) => [...prev, ...page]);
    cursorRef.current = nextCursor;
  }, [query.data]);

  return { events, reconnecting: query.isError };
}
