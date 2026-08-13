/**
 * Environment-driven configuration for the control plane, with safe defaults.
 */

/**
 * Static, hand-curated list of approved models for `GET /api/models` (ARCHITECTURE.md §5).
 * UI/discovery only — `POST /api/sessions` and `POST /api/sessions/:id/prompt` validate `model`
 * against syntax only, never membership in this list.
 * @type {ReadonlyArray<{id: string, name: string}>}
 */
export const MODEL_ALLOWLIST = [
  { id: 'litellm/eu.anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
];

/**
 * Default platform config repo URL, cloned by `bootstrap.js` as the second of the three trees
 * (ARCHITECTURE.md §10/§8). No hardcoded pre-cloned repo path remains from Phase 1 — every tree
 * (target/platform/team) is now resolved and cloned by real `git` at bootstrap time; only this
 * default *URL* (overridable via env) is a config-time constant.
 *
 * Must be a real, public, always-clonable-without-credentials repo: the previous default
 * (`tbrandenburg/agent-control-plane`) is a **private** GitHub repo, so every credential-less
 * `bootstrapWorkspace()` call (any session, any environment without host git credentials leaked
 * into the container) failed at this unconditional platform-repo clone step (gap step `00700`).
 * `docs/phase_02_findings.md`'s Option C decision means the control plane never injects any
 * provider/gateway default itself, so this default's *content* is irrelevant to model resolution
 * — only that it is always, unconditionally clonable. `octocat/Hello-World` is GitHub's own
 * canonical, first-ever-created public sample repo (also reused as a target-repo fixture by
 * `e2e/fixtures/distinct-target-repos.mjs`, which is fine — platform and target trees are cloned
 * to distinct destinations regardless of URL overlap).
 * @type {string}
 */
export const PLATFORM_CONFIG_REPO =
  'https://github.com/octocat/Hello-World.git';

/**
 * @typedef {object} ControlPlaneConfig
 * @property {number} port - HTTP port the server listens on.
 * @property {string} dataDir - Directory used for persistent data (SQLite, uploads).
 * @property {string} platformConfigRepo - Platform config repo URL bootstrap.js clones.
 */

/**
 * Reads configuration from `process.env`, falling back to defaults.
 * @param {NodeJS.ProcessEnv} [env] - Environment source, defaults to `process.env`.
 * @returns {ControlPlaneConfig} Resolved configuration.
 */
export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.PORT ?? '3000', 10);
  const dataDir = env.DATA_DIR ?? './data';
  const platformConfigRepo = env.PLATFORM_CONFIG_REPO ?? PLATFORM_CONFIG_REPO;

  return { port, dataDir, platformConfigRepo };
}
