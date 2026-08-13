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
  teamConfigRepo?: string;
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
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
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

export interface FetchSessionsParams {
  status?: string;
  limit?: number;
  offset?: number;
}

export function fetchSessions(
  params?: FetchSessionsParams,
): Promise<{ sessions: Session[] }> {
  const search = new URLSearchParams();
  if (params?.status) search.set('status', params.status);
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  if (params?.offset !== undefined) search.set('offset', String(params.offset));
  const qs = search.toString();
  return request(`/api/sessions${qs ? `?${qs}` : ''}`);
}

export function fetchSession(id: string): Promise<SessionDetail> {
  return request(`/api/sessions/${id}`);
}

export function fetchModels(): Promise<{ models: ModelOption[] }> {
  return request('/api/models');
}

export function createSession(
  input: CreateSessionInput,
): Promise<{ id: string; wsToken: string }> {
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

export function stopSession(id: string): Promise<unknown> {
  return request(`/api/sessions/${id}/stop`, { method: 'POST' });
}

export function archiveSession(id: string): Promise<unknown> {
  return request(`/api/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'archived' }),
  });
}

export function deleteAllSessions(): Promise<{ deleted: number }> {
  return request('/api/sessions', { method: 'DELETE' });
}

/**
 * The `wsToken` (ARCHITECTURE.md §6) is only ever returned once, from `POST /api/sessions`'s
 * response — this phase's backend has no rotation/hashing yet (a declared shortcut), so
 * `GET /api/sessions/:id` never re-exposes it. `sessionStorage` (tab-scoped, not persisted across
 * browser restarts) is the simplest place to hold it for the WS connection on `/sessions/:id`.
 */
const WS_TOKEN_PREFIX = 'acp:wsToken:';

export function storeWsToken(sessionId: string, wsToken: string): void {
  sessionStorage.setItem(`${WS_TOKEN_PREFIX}${sessionId}`, wsToken);
}

export function getStoredWsToken(sessionId: string): string | null {
  return sessionStorage.getItem(`${WS_TOKEN_PREFIX}${sessionId}`);
}

export function useSessions(
  params?: FetchSessionsParams,
): UseQueryResult<{ sessions: Session[] }, ApiError> {
  return useQuery({
    queryKey: ['sessions', params ?? null],
    queryFn: () => fetchSessions(params),
  });
}

export function useSession(
  id: string,
): UseQueryResult<SessionDetail, ApiError> {
  return useQuery({
    queryKey: ['session', id],
    queryFn: () => fetchSession(id),
    // A 404 is definitive (the session doesn't exist and never will) — retrying it
    // only produces a poll storm against an endpoint that can't ever succeed.
    retry: (failureCount, error) => error.status !== 404 && failureCount < 3,
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

export function useStopSession(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => stopSession(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });
}

export function useArchiveSession(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => archiveSession(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });
}

export function useDeleteAllSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteAllSessions,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
