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
  { id: 'opencode/big-pickle', name: 'Big Pickle' },
  { id: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (Free)' },
  { id: 'opencode/hy3-free', name: 'HY3 (Free)' },
  { id: 'opencode/laguna-s-2.1-free', name: 'Laguna S 2.1 (Free)' },
  { id: 'opencode/ling-3.0-tiny-free', name: 'Ling 3.0 Tiny (Free)' },
  { id: 'opencode/mimo-v2.5-free', name: 'Mimo V2.5 (Free)' },
  { id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (Free)' },
  {
    id: 'opencode/nemotron-3.5-lightning-free',
    name: 'Nemotron 3.5 Lightning (Free)',
  },
];

/**
 * Default platform config repo URL, cloned by `bootstrap.js` as the second of the three trees
 * (ARCHITECTURE.md §10/§8). No hardcoded pre-cloned repo path remains from Phase 1 — every tree
 * (target/platform/team) is now resolved and cloned by real `git` at bootstrap time; only this
 * default *URL* (overridable via env) is a config-time constant.
 *
 * Must be a real, public, always-clonable-without-credentials repo. Step `00700` found this
 * repo's own URL unusable as this default because it was **private** at the time, so it was
 * swapped for `octocat/Hello-World` (content-irrelevant, only clonability mattered — see
 * `docs/phase_02_findings.md`). This repo (`tbrandenburg/agent-control-plane`) was subsequently
 * made **public**, which reopens using it directly: its own root `opencode.jsonc` (repo-root,
 * committed) becomes the platform config every spawned sandbox actually gets, bind-mounted
 * verbatim at `/root/.config/opencode` (`sandbox.js`'s `GLOBAL_CONFIG_CONTAINER_PATH`) — the
 * first time the platform-config layer carries real, intentional content instead of an
 * arbitrary placeholder repo. Verified with a real, credential-less `git clone` before switching
 * (root `AGENTS.md`'s evidence-first rule). `docs/phase_02_findings.md`'s Option C decision still
 * holds: the control plane itself never injects a provider/gateway default — this repo's
 * `opencode.jsonc` sets `model`/`autoupdate`/`mcp`/`provider` as a normal opencode config file,
 * layered under the control plane's own non-negotiable `OPENCODE_CONFIG_CONTENT` (step 6, which
 * still wins on `model`).
 * @type {string}
 */
export const PLATFORM_CONFIG_REPO =
  'https://github.com/tbrandenburg/agent-control-plane.git';

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
