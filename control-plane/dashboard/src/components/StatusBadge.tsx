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
  | 'archived'
  | 'pending_bootstrap';

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
  pending_bootstrap: {
    symbol: '◌',
    label: 'setting up…',
    className: 'animate-pulse text-amber-600',
  },
};

/**
 * Derives the dashboard's status badge from `sessions.status` and the live sandbox phase.
 * `archived` always wins (a stopped, archived session is still "archived", not "stopped").
 * `pending_bootstrap-failed` always renders as `failed`, regardless of `dockerPhase` (no
 * container was ever spawned, so `dockerPhase` is `null`, but this must not be confused with a
 * cleanly stopped session). A `pending_bootstrap` session with no live phase yet renders as its
 * own distinct `pending_bootstrap` state ("setting up…") — the create flow's 202-then-async-settle
 * behavior must be visible, not silently identical to `active`/`stopped`. Once a container phase
 * exists (bootstrap has produced a sandbox), the usual phase-derived rules below take over even
 * for a still-`pending_bootstrap` row. A `dead` container phase means the process crashed
 * (`failed`); `exited` covers a clean/expected stop; every other Docker phase (`created`,
 * `running`, `restarting`, `paused`, `removing`) is still doing something, so it renders as
 * `running`.
 * @param sessionStatus - `sessions.status` column value.
 * @param dockerPhase - Live `docker inspect` `.State.Status`, or `null` if unknown.
 * @returns The derived badge state.
 */
export function deriveStatus(
  sessionStatus: string,
  dockerPhase: DockerPhase,
): DerivedStatus {
  if (sessionStatus === 'archived') return 'archived';
  if (sessionStatus === 'pending_bootstrap-failed') return 'failed';
  if (dockerPhase === null) {
    if (sessionStatus === 'active') return 'active';
    if (sessionStatus === 'pending_bootstrap') return 'pending_bootstrap';
    return 'stopped';
  }
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
