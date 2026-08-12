/**
 * Session list — `/` (UI.md §1). Backed by `GET /api/sessions`. The `docker inspect` phase is
 * `null` until a later step wires `sandbox.inspect()` into the list response, so every badge
 * currently derives from `sessions.status` alone with `dockerPhase: null`.
 */
import { useSessions } from '@/api/client';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Link } from '@/lib/router';

export function SessionList() {
  const { data, isLoading, isError, error } = useSessions();

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-medium">Sessions</h2>
        <Link to="/sessions/new">
          <Button size="sm">+ New Session</Button>
        </Link>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {isError && <p className="text-sm text-red-600">{error.message}</p>}

      {data && data.sessions.length === 0 && (
        <p className="text-sm text-muted-foreground">No sessions yet.</p>
      )}

      {data && data.sessions.length > 0 && (
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
            {data.sessions.map((session) => (
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
    </div>
  );
}
