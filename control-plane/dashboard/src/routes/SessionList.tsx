/**
 * Session list — `/` (UI.md §1). Backed by `GET /api/sessions`. The `docker inspect` phase is
 * `null` until a later step wires `sandbox.inspect()` into the list response, so every badge
 * currently derives from `sessions.status` alone with `dockerPhase: null`.
 */
import { useState } from 'react';
import { type Session, useSessions } from '@/api/client';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Link } from '@/lib/router';

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
  { value: 'pending_bootstrap', label: 'Pending Bootstrap' },
];

export function SessionList() {
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [sessions, setSessions] = useState<Session[]>([]);

  const { data, isLoading, isError, error, isFetching } = useSessions({
    status: status || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  const pageKey = `${status}:${offset}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (data && loadedKey !== pageKey) {
    setLoadedKey(pageKey);
    setSessions((prev) =>
      offset === 0 ? data.sessions : [...prev, ...data.sessions],
    );
  }

  function handleStatusChange(next: string) {
    setStatus(next);
    setOffset(0);
    setSessions([]);
    setLoadedKey(null);
  }

  function handleLoadMore() {
    setOffset((prev) => prev + PAGE_SIZE);
  }

  const canLoadMore = (data?.sessions.length ?? 0) === PAGE_SIZE;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-medium">Sessions</h2>
        <Link to="/sessions/new">
          <Button size="sm">+ New Session</Button>
        </Link>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <label
          htmlFor="status-filter"
          className="text-sm text-muted-foreground"
        >
          Status
        </label>
        <select
          id="status-filter"
          className="rounded border px-2 py-1 text-sm"
          value={status}
          onChange={(e) => handleStatusChange(e.target.value)}
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {isError && <p className="text-sm text-red-600">{error.message}</p>}

      {!isLoading && sessions.length === 0 && (
        <p className="text-sm text-muted-foreground">No sessions yet.</p>
      )}

      {sessions.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="py-2 font-medium">Title</th>
              <th className="py-2 font-medium">Repository</th>
              <th className="py-2 font-medium">Model</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id} className="border-b">
                <td className="py-2">
                  <Link
                    to={`/sessions/${session.id}`}
                    className="hover:underline"
                  >
                    {session.title}
                  </Link>
                </td>
                <td className="py-2 text-muted-foreground">
                  {session.repoOwner}/{session.repoName}
                </td>
                <td className="py-2 text-muted-foreground">{session.model}</td>
                <td className="py-2">
                  <StatusBadge
                    sessionStatus={session.status}
                    dockerPhase={null}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canLoadMore && (
        <div className="mt-4">
          <Button
            size="sm"
            variant="outline"
            onClick={handleLoadMore}
            disabled={isFetching}
          >
            {isFetching ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
