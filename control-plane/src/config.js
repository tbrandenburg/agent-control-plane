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
 * @typedef {object} ControlPlaneConfig
 * @property {number} port - HTTP port the server listens on.
 * @property {string} dataDir - Directory used for persistent data (SQLite, uploads).
 */

/**
 * Reads configuration from `process.env`, falling back to defaults.
 * @param {NodeJS.ProcessEnv} [env] - Environment source, defaults to `process.env`.
 * @returns {ControlPlaneConfig} Resolved configuration.
 */
export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.PORT ?? '3000', 10);
  const dataDir = env.DATA_DIR ?? './data';

  return { port, dataDir };
}
