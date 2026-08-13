/**
 * Sandbox lifecycle via the Docker CLI — `run()`, `inspect()`, `waitForHealth()`.
 * Plain `docker run`/`docker inspect` via `child_process.spawn`, the direct analog of one K8s
 * Job per session (ARCHITECTURE.md §13). Every call uses an argv array, never a shell string, so
 * session/repo values can never be shell-injected (see this step's "Error Handling").
 */

import { spawn } from 'node:child_process';

/** Port the bridge listens on inside the sandbox (matches `sandbox/bridge.js`'s own default). */
const DEFAULT_BRIDGE_PORT = 8080;

/**
 * Deterministic, greppable container name for a session (Phase 3 adds an attempt suffix on
 * continuation).
 * @param {string} sessionId - Session id.
 * @returns {string} The `sandbox-<sessionId>` container name.
 */
export function containerName(sessionId) {
  return `sandbox-${sessionId}`;
}

/**
 * Runs `docker <args>` via `spawn`, collecting stdout/stderr, never a shell string.
 * @param {string[]} args - Argv passed to `docker`.
 * @returns {Promise<string>} Trimmed stdout on a zero exit code.
 * @throws {Error} Carrying trimmed stderr (or stdout) on a non-zero exit code.
 */
function runDocker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          (stderr || stdout).trim() ||
            `docker ${args[0]} exited with code ${code}`,
        ),
      );
    });
  });
}

/** Path inside the sandbox container opencode reads as its Global config (step 2, ARCHITECTURE.md §8). */
const GLOBAL_CONFIG_CONTAINER_PATH = '/root/.config/opencode';
/** Path inside the sandbox container the team config layer is mounted at (`OPENCODE_CONFIG_DIR`, step 5). */
const TEAM_CONFIG_CONTAINER_PATH = '/workspace/team-config';

/**
 * @typedef {object} SandboxSession
 * @property {string} id - Session id, used to derive the container name.
 * @property {string} model - `provider/model` string, layered into `OPENCODE_CONFIG_CONTENT`.
 * @property {string} targetDir - Host path to the bootstrapped target repo (`bootstrapWorkspace()`'s
 *   `targetDir`), bind-mounted read-only at `/workspace/repo`.
 * @property {string} platformConfigDir - Host path to the bootstrapped platform config repo
 *   (`bootstrapWorkspace()`'s `platformConfigDir`), bind-mounted at opencode's Global config
 *   path (ARCHITECTURE.md §8 step 2) — read-write, not read-only: opencode itself writes local
 *   state (session/auth cache) under this path even for a session that never edits config, so a
 *   `:ro` mount here makes every session's first request fail with a 500 (verified live).
 * @property {string|null} [teamConfigDir] - Host path to the bootstrapped team config repo
 *   (`bootstrapWorkspace()`'s `teamConfigDir`), bind-mounted read-write for the same reason and
 *   pointed at via `OPENCODE_CONFIG_DIR` (step 5) when present; omitted entirely when bootstrap
 *   skipped it.
 */

/**
 * Builds the minimal, non-negotiable `OPENCODE_CONFIG_CONTENT` layer (ARCHITECTURE.md §8,
 * declared correction): exactly `model` + `autoupdate: false`, nothing provider-shaped. The full
 * provider/gateway catalog is Platform-config-repo territory (opencode's own step-2 Global
 * config), resolved natively by opencode's 8-step precedence chain — never enumerated here (see
 * `docs/phase_02_findings.md`'s Option C decision, GitHub issue #1).
 * @param {SandboxSession} session - Session to configure.
 * @returns {string} JSON-stringified opencode config.
 */
function buildOpencodeConfig(session) {
  return JSON.stringify({
    model: session.model,
    autoupdate: false,
  });
}

/**
 * Starts a sandbox container for a session via `docker run -d`, bind-mounting the three
 * `bootstrapWorkspace()`-produced host directories (target repo, platform config, optional team
 * config) instead of a single static workspace path — every session gets its own, per-session
 * clone, never a directory shared across sessions.
 * @param {SandboxSession} session - Session to spawn a sandbox for.
 * @param {NodeJS.ProcessEnv} [env] - Environment source, defaults to `process.env`.
 * @returns {Promise<{containerName: string, containerId: string}>} The started container's name/id.
 * @throws {Error} With trimmed `docker` stderr if the spawn fails, or if required env/session
 *   fields are missing.
 */
export async function run(session, env = process.env) {
  const name = containerName(session.id);
  const image = env.SANDBOX_IMAGE;
  if (!image) throw new Error('SANDBOX_IMAGE is not set');
  if (!session.targetDir) throw new Error('session.targetDir is required');
  if (!session.platformConfigDir) {
    throw new Error('session.platformConfigDir is required');
  }

  const args = [
    'run',
    '-d',
    '--name',
    name,
    // PHASE-4: becomes `sandbox-net` with `internal: true` (ARCHITECTURE.md §12). The network
    // name is project-prefixed by compose, so it's resolved from env, never hardcoded here.
    '--network',
    env.SANDBOX_NETWORK ?? 'egress-net',
    // The control plane itself runs in a container, so these must be HOST paths, not paths
    // inside the control-plane container — `bootstrapWorkspace()`'s directories are cloned onto
    // a bind mount shared identically between the control-plane container and the host.
    '-v',
    `${session.targetDir}:/workspace/repo:ro`,
    '-v',
    `${session.platformConfigDir}:${GLOBAL_CONFIG_CONTAINER_PATH}`,
  ];
  if (session.teamConfigDir) {
    args.push('-v', `${session.teamConfigDir}:${TEAM_CONFIG_CONTAINER_PATH}`);
  }
  args.push(
    '-e',
    `SESSION_ID=${session.id}`,
    '-e',
    `CONTROL_PLANE_URL=${env.CONTROL_PLANE_URL ?? ''}`,
  );
  if (session.teamConfigDir) {
    args.push('-e', `OPENCODE_CONFIG_DIR=${TEAM_CONFIG_CONTAINER_PATH}`);
  }
  args.push(
    '-e',
    `OPENCODE_CONFIG_CONTENT=${buildOpencodeConfig(session)}`,
    // PHASE-4: injected by the Caddy sandbox-proxy instead of a raw env var.
    '-e',
    `LITELLM_BASE_URL=${env.LITELLM_BASE_URL ?? ''}`,
    '-e',
    `LITELLM_API_KEY=${env.LITELLM_API_KEY ?? ''}`,
    image,
  );

  const containerId = await runDocker(args);
  return { containerName: name, containerId };
}

/**
 * Inspects a container by name. A missing container resolves to `{ exists: false }` — never an
 * error — matching the shape ARCHITECTURE.md §7's `resolveActiveSession` will consume in Phase 3.
 * @param {string} name - Container name.
 * @returns {Promise<{exists: boolean, state?: string}>} The container's existence/state.
 */
export async function inspect(name) {
  let stdout;
  try {
    stdout = await runDocker(['inspect', name]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('No such object')) return { exists: false };
    throw err;
  }

  const [info] = JSON.parse(stdout);
  const state = info.State ?? {};

  if (state.Status === 'running') {
    // Health only appears here when the image declares HEALTHCHECK (see this step's Gotchas).
    const health = state.Health?.Status;
    if (health === 'unhealthy') return { exists: true, state: 'unhealthy' };
    if (health === 'starting') return { exists: true, state: 'starting' };
    return { exists: true, state: 'running' };
  }

  return { exists: true, state: state.Status ?? 'unknown' };
}

/**
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>} Resolves after `ms` milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `docker inspect`'s state/health with backoff until the container is running/healthy or a
 * bounded timeout elapses (ARCHITECTURE.md §8's healthcheck-gated readiness).
 * @param {string} name - Container name.
 * @param {{timeoutMs?: number, intervalMs?: number}} [options] - Polling bounds.
 * @returns {Promise<{exists: boolean, state?: string}>} The final healthy inspect result.
 * @throws {Error} If the container exits, is missing, or never becomes healthy in time.
 */
export async function waitForHealth(
  name,
  { timeoutMs = 30000, intervalMs = 500 } = {},
) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const status = await inspect(name);
    if (status.exists && status.state === 'running') return status;
    if (
      status.exists &&
      (status.state === 'exited' || status.state === 'unhealthy')
    ) {
      throw new Error(
        `sandbox container ${name} is ${status.state}, not becoming healthy`,
      );
    }
    if (!status.exists) {
      throw new Error(`sandbox container ${name} does not exist`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `sandbox container ${name} did not become healthy within ${timeoutMs}ms`,
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Stops a session's sandbox: best-effort, bounded-timeout call to the bridge's `POST /stop`
 * (which calls OpenCode's native `abort`, aborting any in-flight prompt) followed
 * *unconditionally* by a real `docker stop` + `docker rm` — the bridge call's outcome (success,
 * error, or timeout) never gates the actual stop (GitHub issue #10: a healthy bridge responding
 * `ok` used to be treated as "stopped" even though it never touched the container's lifecycle,
 * so clicking Stop on a healthy session never actually terminated it).
 * @param {string} name - Container name.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options] - Injectable fetch (tests) and
 *   the bounded timeout for the best-effort bridge abort.
 * @returns {Promise<{method: 'docker'}>} Always `'docker'` — `docker stop`/`docker rm` is always
 *   the path that actually stops the sandbox now.
 * @throws {Error} With trimmed `docker stop` stderr if `docker stop` itself fails.
 */
export async function stop(name, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(`http://${name}:${DEFAULT_BRIDGE_PORT}/stop`, {
      method: 'POST',
      signal: controller.signal,
    });
  } catch {
    // Bridge unreachable, non-ok, or the bounded timeout fired — best-effort only, ignored
    // either way: the real stop below always runs regardless.
  } finally {
    clearTimeout(timer);
  }
  await runDocker(['stop', name]);
  try {
    await runDocker(['rm', name]);
  } catch {
    // Already removed (e.g. a concurrent stop) or racing removal — not fatal, `docker stop`
    // above already succeeded so the sandbox is no longer running.
  }
  return { method: 'docker' };
}
