/**
 * Session status badge — combines the persisted `sessions.status` (`active`|`archived`|
 * `pending_bootstrap`) with the live `docker inspect` phase to derive the badge UI.md §1
 * describes (`running`/`stopped`/`failed` are never stored, only derived here).
 */

export type DockerPhase =
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'removing'
  | 'exited'
  | 'dead'
  | null;

export type DerivedStatus =
  | 'active'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'archived';

const BADGE: Record<
  DerivedStatus,
  { symbol: string; label: string; className: string }
> = {
  active: { symbol: '●', label: 'active', className: 'text-blue-600' },
  running: { symbol: '●', label: 'running', className: 'text-green-600' },
  stopped: {
    symbol: '○',
    label: 'stopped',
    className: 'text-muted-foreground',
  },
  failed: { symbol: '✕', label: 'failed', className: 'text-red-600' },
  archived: {
    symbol: '◇',
    label: 'archived',
    className: 'text-muted-foreground',
  },
};

/**
 * Derives the dashboard's status badge from `sessions.status` and the live sandbox phase.
 * `archived` always wins (a stopped, archived session is still "archived", not "stopped").
 * With no live phase yet (`null`) an `active` session shows as `active`; anything else falls
 * back to `stopped`. A `dead` container phase means the process crashed (`failed`); `exited`
 * covers a clean/expected stop; every other Docker phase (`created`, `running`, `restarting`,
 * `paused`, `removing`) is still doing something, so it renders as `running`.
 * @param sessionStatus - `sessions.status` column value.
 * @param dockerPhase - Live `docker inspect` `.State.Status`, or `null` if unknown.
 * @returns The derived badge state.
 */
export function deriveStatus(
  sessionStatus: string,
  dockerPhase: DockerPhase,
): DerivedStatus {
  if (sessionStatus === 'archived') return 'archived';
  if (dockerPhase === null)
    return sessionStatus === 'active' ? 'active' : 'stopped';
  if (dockerPhase === 'dead') return 'failed';
  if (dockerPhase === 'exited') return 'stopped';
  return 'running';
}

export function StatusBadge({
  sessionStatus,
  dockerPhase,
}: {
  sessionStatus: string;
  dockerPhase: DockerPhase;
}) {
  const status = deriveStatus(sessionStatus, dockerPhase);
  const { symbol, label, className } = BADGE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${className}`}>
      <span aria-hidden="true">{symbol}</span>
      {label}
    </span>
  );
}
