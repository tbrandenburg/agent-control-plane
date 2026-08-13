/**
 * Session bootstrap/spawn orchestration — extracted from `routes/sessions.js` (step `00605`) to
 * keep that route file under the LOC budget. Runs after `POST /api/sessions`'s `202` response has
 * already been sent (the async split from step `00601`): bootstraps the session's
 * target/platform/team repos into a per-session directory tree (`bootstrapWorkspace()`, never the
 * single global workspace directory), spawns the sandbox against that layout, and waits for it to
 * become healthy, updating the row to `active` on success. On any bootstrap or spawn failure the
 * row is left in `pending_bootstrap-failed` — no structured diagnostics fields exist until Phase 3,
 * so only the coarse `status` value carries the outcome.
 */

import * as defaultBootstrap from './bootstrap.js';
import { loadConfig } from './config.js';
import * as defaultSandbox from './sandbox.js';
import { isValidTransition } from './session-state.js';

/**
 * Ref resolved for every bootstrapped repo (target/platform/team) — `HEAD` rather than a
 * hardcoded branch name (e.g. `main`) so bootstrap works against any repo regardless of its
 * default branch name; no per-session ref/branch selection exists this phase.
 */
const DEFAULT_REF = 'HEAD';

/**
 * Builds a `https://github.com/<path>.git` URL from an `owner/name` (or `owner`+`name`) path.
 * @param {string} path - `owner/name` repo path.
 * @returns {string} The resolved clone URL.
 */
function githubUrl(path) {
  return `https://github.com/${path}.git`;
}

/**
 * Updates `sessions.status`, but only if the row's current status allows that transition
 * (issue #28) — defensive, since both callers below only ever run from `pending_bootstrap`.
 * @param {import('node:sqlite').DatabaseSync} db - Open database handle.
 * @param {string} id - Session id.
 * @param {string} nextStatus - Target status.
 * @param {string} [containerName] - Container name to persist alongside an `active` transition.
 * @returns {void}
 */
function transitionStatus(db, id, nextStatus, containerName) {
  const row = /** @type {{status: string}|undefined} */ (
    db.prepare('SELECT status FROM sessions WHERE id = ?').get(id)
  );
  if (!row || !isValidTransition(row.status, nextStatus)) return;
  const sql =
    containerName !== undefined
      ? "UPDATE sessions SET container_name = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
      : "UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?";
  const params =
    containerName !== undefined
      ? [containerName, nextStatus, id]
      : [nextStatus, id];
  db.prepare(sql).run(...params);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db - Open database handle.
 * @param {typeof defaultSandbox} sandbox - Sandbox lifecycle module.
 * @param {typeof defaultBootstrap} bootstrap - Bootstrap module, swappable in tests.
 * @param {{id: string, model: string, repoOwner: string, repoName: string,
 *   teamConfigRepo?: string}} session - The session to bootstrap/spawn a sandbox for.
 * @returns {Promise<void>}
 */
export async function spawnSandbox(
  db,
  sandbox,
  bootstrap,
  { id, model, repoOwner, repoName, teamConfigRepo },
) {
  try {
    const workspaceHostPath = process.env.WORKSPACE_HOST_PATH;
    if (!workspaceHostPath) throw new Error('WORKSPACE_HOST_PATH is not set');
    const { platformConfigRepo } = loadConfig();

    const layout = await bootstrap.bootstrapWorkspace(
      {
        id,
        targetRepo: {
          url: githubUrl(`${repoOwner}/${repoName}`),
          ref: DEFAULT_REF,
        },
        platformConfigRepo: { url: platformConfigRepo, ref: DEFAULT_REF },
        ...(teamConfigRepo
          ? {
              teamConfigRepo: {
                url: githubUrl(teamConfigRepo),
                ref: DEFAULT_REF,
              },
            }
          : {}),
      },
      `${workspaceHostPath}/${id}`,
    );

    const started = await sandbox.run({
      id,
      model,
      targetDir: layout.targetDir,
      platformConfigDir: layout.platformConfigDir,
      teamConfigDir: layout.teamConfigDir,
    });
    await sandbox.waitForHealth(started.containerName);
    transitionStatus(db, id, 'active', started.containerName);
  } catch (err) {
    console.error(
      `session ${id} bootstrap/spawn failed:`,
      err instanceof Error ? err.message : String(err),
    );
    transitionStatus(db, id, 'pending_bootstrap-failed');
  }
}
