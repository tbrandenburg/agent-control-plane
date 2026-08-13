/**
 * Session list — `/` (UI.md §1). Backed by `GET /api/sessions`. The `docker inspect` phase is
 * `null` until a later step wires `sandbox.inspect()` into the list response, so every badge
 * currently derives from `sessions.status` alone with `dockerPhase: null`.
 */
import { useState } from 'react';
import { type Session, useDeleteAllSessions, useSessions } from '@/api/client';
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
  const [confirmingClear, setConfirmingClear] = useState(false);
  const deleteAllSessions = useDeleteAllSessions();

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

  function handleClearAll() {
    deleteAllSessions.mutate(undefined, {
      onSuccess: () => {
        setSessions([]);
        setOffset(0);
        setLoadedKey(null);
        setConfirmingClear(false);
      },
    });
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

      <div className="mt-4 flex flex-col items-end gap-2">
        {deleteAllSessions.isError && (
          <p className="text-sm text-red-600">
            {deleteAllSessions.error.message}
          </p>
        )}
        <Button
          size="sm"
          variant="destructive"
          disabled={deleteAllSessions.isPending}
          onClick={() => setConfirmingClear(true)}
        >
          {deleteAllSessions.isPending ? 'Clearing…' : 'Clear all sessions'}
        </Button>
      </div>

      {confirmingClear && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="clear-sessions-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        >
          <div className="w-full max-w-sm rounded-md border bg-background p-4 shadow-lg">
            <h3 id="clear-sessions-title" className="text-base font-medium">
              Clear all sessions?
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This permanently deletes every session and its history. This
              cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={deleteAllSessions.isPending}
                onClick={() => setConfirmingClear(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={deleteAllSessions.isPending}
                onClick={handleClearAll}
              >
                {deleteAllSessions.isPending ? 'Clearing…' : 'Clear all'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
