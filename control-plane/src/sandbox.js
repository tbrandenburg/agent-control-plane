/**
 * Sandbox lifecycle via the Docker CLI — `run()`, `inspect()`, `waitForHealth()`.
 * Plain `docker run`/`docker inspect` via `child_process.spawn`, the direct analog of one K8s
 * Job per session (ARCHITECTURE.md §13). Every call uses an argv array, never a shell string, so
 * session/repo values can never be shell-injected (see this step's "Error Handling").
 */

import { spawn } from 'node:child_process';

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

/**
 * @typedef {object} SandboxSession
 * @property {string} id - Session id, used to derive the container name.
 * @property {string} model - `provider/model` string, layered into `OPENCODE_CONFIG_CONTENT`.
 */

/**
 * Builds the minimal, non-negotiable `OPENCODE_CONFIG_CONTENT` layer (ARCHITECTURE.md §8):
 * `model`, `autoupdate: false`, and the `provider.litellm` block. In this phase `baseURL` points
 * straight at LiteLLM — PHASE-4: repointed at `http://sandbox-proxy:8080/litellm`.
 *
 * Custom (`npm`-based) opencode providers only expose models declared under their own
 * `models` map (found via this phase's E2E spec) — omitting it makes every prompt fail with
 * `Model not found`, so the session's own model id is always registered here.
 * @param {SandboxSession} session - Session to configure.
 * @param {NodeJS.ProcessEnv} env - Environment source for LiteLLM connection details.
 * @returns {string} JSON-stringified opencode config.
 */
function buildOpencodeConfig(session, env) {
  const modelID = session.model.slice(session.model.indexOf('/') + 1);
  return JSON.stringify({
    model: session.model,
    autoupdate: false,
    provider: {
      litellm: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: env.LITELLM_BASE_URL ?? '',
          apiKey: env.LITELLM_API_KEY ?? '',
        },
        models: { [modelID]: {} },
      },
    },
  });
}

/**
 * Starts a sandbox container for a session via `docker run -d`.
 * @param {SandboxSession} session - Session to spawn a sandbox for.
 * @param {NodeJS.ProcessEnv} [env] - Environment source, defaults to `process.env`.
 * @returns {Promise<{containerName: string, containerId: string}>} The started container's name/id.
 * @throws {Error} With trimmed `docker` stderr if the spawn fails, or if required env is missing.
 */
export async function run(session, env = process.env) {
  const name = containerName(session.id);
  const image = env.SANDBOX_IMAGE;
  const hostRepoPath = env.WORKSPACE_HOST_PATH;
  if (!image) throw new Error('SANDBOX_IMAGE is not set');
  if (!hostRepoPath) throw new Error('WORKSPACE_HOST_PATH is not set');

  const args = [
    'run',
    '-d',
    '--name',
    name,
    // PHASE-4: becomes `sandbox-net` with `internal: true` (ARCHITECTURE.md §12). The network
    // name is project-prefixed by compose, so it's resolved from env, never hardcoded here.
    '--network',
    env.SANDBOX_NETWORK ?? 'egress-net',
    // The control plane itself runs in a container, so this must be a HOST path, not a path
    // inside the control-plane container — threaded through WORKSPACE_HOST_PATH.
    '-v',
    `${hostRepoPath}:/workspace/repo:ro`,
    '-e',
    `SESSION_ID=${session.id}`,
    '-e',
    `CONTROL_PLANE_URL=${env.CONTROL_PLANE_URL ?? ''}`,
    '-e',
    `OPENCODE_CONFIG_CONTENT=${buildOpencodeConfig(session, env)}`,
    // PHASE-4: injected by the Caddy sandbox-proxy instead of a raw env var.
    '-e',
    `LITELLM_BASE_URL=${env.LITELLM_BASE_URL ?? ''}`,
    '-e',
    `LITELLM_API_KEY=${env.LITELLM_API_KEY ?? ''}`,
    image,
  ];

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
