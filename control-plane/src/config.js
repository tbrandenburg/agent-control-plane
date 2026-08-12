/**
 * Environment-driven configuration for the control plane, with safe defaults.
 * This is the future home of `MODEL_ALLOWLIST` (see ARCHITECTURE.md §5).
 */

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
