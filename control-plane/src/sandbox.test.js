import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = /** @type {typeof import('node:child_process')} */ (
    await importOriginal()
  );
  return { ...actual, spawn: vi.fn() };
});

const childProcess = await import('node:child_process');
const { containerName, inspect, run, stop, waitForHealth } = await import(
  './sandbox.js'
);

/**
 * Builds a fake child process that emits the given stdout/stderr then closes with `exitCode`.
 * @param {{stdout?: string, stderr?: string, exitCode?: number}} [options] - Fake process behavior.
 * @returns {import('node:child_process').ChildProcess} Fake child, cast to satisfy `spawn`'s
 *   mocked return type — only `stdout`/`stderr`/`close` are ever used by `sandbox.js`.
 */
function fakeChild({ stdout = '', stderr = '', exitCode = 0 } = {}) {
  const child = /** @type {any} */ (new EventEmitter());
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
  return /** @type {import('node:child_process').ChildProcess} */ (child);
}

beforeEach(() => {
  vi.mocked(childProcess.spawn).mockReset();
});

describe('containerName', () => {
  it('derives a deterministic, greppable name', () => {
    expect(containerName('abc123')).toBe('sandbox-abc123');
  });
});

describe('run', () => {
  it('spawns docker run with the exact argv, no shell string anywhere', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({ stdout: 'container-id-123\n' }),
    );

    const env = {
      SANDBOX_IMAGE: 'agent-sandbox:local',
      SANDBOX_NETWORK: 'my-project_egress-net',
      CONTROL_PLANE_URL: 'http://control-plane:3000',
      LITELLM_BASE_URL: 'http://litellm:4000',
      LITELLM_API_KEY: 'secret-key',
    };

    const result = await run(
      {
        id: 'sess-1',
        model: 'litellm/eu.anthropic.claude-sonnet-4-6',
        targetDir: '/host/workspace/sess-1/target',
        platformConfigDir: '/host/workspace/sess-1/platform',
      },
      env,
    );

    expect(result).toEqual({
      containerName: 'sandbox-sess-1',
      containerId: 'container-id-123',
    });

    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    const [command, args] = vi.mocked(childProcess.spawn).mock.calls[0];
    expect(command).toBe('docker');
    expect(Array.isArray(args)).toBe(true);

    expect(args).toEqual([
      'run',
      '-d',
      '--name',
      'sandbox-sess-1',
      '--network',
      'my-project_egress-net',
      '-v',
      '/host/workspace/sess-1/target:/workspace/repo:ro',
      '-v',
      '/host/workspace/sess-1/platform:/root/.config/opencode',
      '-e',
      'SESSION_ID=sess-1',
      '-e',
      'CONTROL_PLANE_URL=http://control-plane:3000',
      '-e',
      `OPENCODE_CONFIG_CONTENT=${JSON.stringify({
        model: 'litellm/eu.anthropic.claude-sonnet-4-6',
        autoupdate: false,
      })}`,
      '-e',
      'LITELLM_BASE_URL=http://litellm:4000',
      '-e',
      'LITELLM_API_KEY=secret-key',
      'agent-sandbox:local',
    ]);
  });

  it('bind-mounts and points OPENCODE_CONFIG_DIR at the team config dir when present', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({ stdout: 'id\n' }),
    );

    await run(
      {
        id: 's',
        model: 'litellm/x',
        targetDir: '/host/target',
        platformConfigDir: '/host/platform',
        teamConfigDir: '/host/team',
      },
      { SANDBOX_IMAGE: 'img' },
    );

    const [, args] = vi.mocked(childProcess.spawn).mock.calls[0];
    expect(args).toContain('-v');
    expect(args).toContain('/host/team:/workspace/team-config');
    expect(args).toContain('OPENCODE_CONFIG_DIR=/workspace/team-config');
  });

  it('falls back to the bare egress-net name when SANDBOX_NETWORK is unset', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({ stdout: 'id\n' }),
    );

    await run(
      {
        id: 's',
        model: 'litellm/x',
        targetDir: '/host/target',
        platformConfigDir: '/host/platform',
      },
      { SANDBOX_IMAGE: 'img' },
    );

    const [, args] = vi.mocked(childProcess.spawn).mock.calls[0];
    expect(args[args.indexOf('--network') + 1]).toBe('egress-net');
  });

  it.each([
    'litellm/eu.anthropic.claude-sonnet-4-6',
    'anthropic/claude-opus-4',
    'openai/gpt-5',
  ])(
    'composes OPENCODE_CONFIG_CONTENT with exactly model + autoupdate, nothing provider-shaped, for %s',
    async (model) => {
      vi.mocked(childProcess.spawn).mockReturnValue(
        fakeChild({ stdout: 'id\n' }),
      );

      await run(
        {
          id: 's',
          model,
          targetDir: '/host/target',
          platformConfigDir: '/host/platform',
        },
        { SANDBOX_IMAGE: 'img' },
      );

      const [, args] = vi.mocked(childProcess.spawn).mock.calls[0];
      const raw = args
        .find((arg) => arg.startsWith('OPENCODE_CONFIG_CONTENT='))
        .slice('OPENCODE_CONFIG_CONTENT='.length);
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({ model, autoupdate: false });
      expect(Object.keys(parsed).sort()).toEqual(['autoupdate', 'model']);
    },
  );

  it(
    'composes the same narrowed OPENCODE_CONFIG_CONTENT shape regardless of LITELLM_* env vars ' +
      '(Option C: no gateway/provider default is ever injected by the control plane)',
    async () => {
      vi.mocked(childProcess.spawn).mockReturnValue(
        fakeChild({ stdout: 'id\n' }),
      );

      await run(
        {
          id: 's',
          model: 'litellm/x',
          targetDir: '/host/target',
          platformConfigDir: '/host/platform',
        },
        {
          SANDBOX_IMAGE: 'img',
          LITELLM_BASE_URL: 'http://litellm:4000',
          LITELLM_API_KEY: 'secret-key',
        },
      );

      const [, args] = vi.mocked(childProcess.spawn).mock.calls[0];
      const raw = args
        .find((arg) => arg.startsWith('OPENCODE_CONFIG_CONTENT='))
        .slice('OPENCODE_CONFIG_CONTENT='.length);
      expect(JSON.parse(raw)).toEqual({
        model: 'litellm/x',
        autoupdate: false,
      });
    },
  );

  it('rejects with the trimmed docker stderr on a non-zero exit', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({ stderr: 'Error: no such image\n', exitCode: 1 }),
    );

    await expect(
      run(
        {
          id: 's',
          model: 'litellm/x',
          targetDir: '/host/target',
          platformConfigDir: '/host/platform',
        },
        { SANDBOX_IMAGE: 'img' },
      ),
    ).rejects.toThrow('Error: no such image');
  });

  it('throws without spawning when SANDBOX_IMAGE is missing', async () => {
    await expect(
      run(
        {
          id: 's',
          model: 'litellm/x',
          targetDir: '/host/target',
          platformConfigDir: '/host/platform',
        },
        {},
      ),
    ).rejects.toThrow('SANDBOX_IMAGE');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('throws without spawning when session.targetDir is missing', async () => {
    await expect(
      run(
        { id: 's', model: 'litellm/x', platformConfigDir: '/host/platform' },
        { SANDBOX_IMAGE: 'img' },
      ),
    ).rejects.toThrow('targetDir');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('throws without spawning when session.platformConfigDir is missing', async () => {
    await expect(
      run(
        { id: 's', model: 'litellm/x', targetDir: '/host/target' },
        { SANDBOX_IMAGE: 'img' },
      ),
    ).rejects.toThrow('platformConfigDir');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});

describe('inspect', () => {
  it('reports exists: false for a missing container, not an error', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({
        stderr: 'Error: No such object: sandbox-missing\n',
        exitCode: 1,
      }),
    );

    await expect(inspect('sandbox-missing')).resolves.toEqual({
      exists: false,
    });
  });

  it('reports running for a running container with no healthcheck', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({
        stdout: JSON.stringify([{ State: { Status: 'running' } }]),
      }),
    );

    await expect(inspect('sandbox-1')).resolves.toEqual({
      exists: true,
      state: 'running',
    });
  });

  it('reports starting while the Docker healthcheck is still starting', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({
        stdout: JSON.stringify([
          { State: { Status: 'running', Health: { Status: 'starting' } } },
        ]),
      }),
    );

    await expect(inspect('sandbox-1')).resolves.toEqual({
      exists: true,
      state: 'starting',
    });
  });

  it('reports running once the Docker healthcheck reports healthy', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({
        stdout: JSON.stringify([
          { State: { Status: 'running', Health: { Status: 'healthy' } } },
        ]),
      }),
    );

    await expect(inspect('sandbox-1')).resolves.toEqual({
      exists: true,
      state: 'running',
    });
  });

  it('reports unhealthy when the Docker healthcheck fails', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({
        stdout: JSON.stringify([
          { State: { Status: 'running', Health: { Status: 'unhealthy' } } },
        ]),
      }),
    );

    await expect(inspect('sandbox-1')).resolves.toEqual({
      exists: true,
      state: 'unhealthy',
    });
  });

  it('reports the raw state for an exited container', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({ stdout: JSON.stringify([{ State: { Status: 'exited' } }]) }),
    );

    await expect(inspect('sandbox-1')).resolves.toEqual({
      exists: true,
      state: 'exited',
    });
  });

  it('propagates non-"No such object" docker errors', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({ stderr: 'Error: permission denied\n', exitCode: 1 }),
    );

    await expect(inspect('sandbox-1')).rejects.toThrow('permission denied');
  });
});

describe('waitForHealth', () => {
  it('resolves once the container reports running', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({ stdout: JSON.stringify([{ State: { Status: 'running' } }]) }),
    );

    await expect(
      waitForHealth('sandbox-1', { timeoutMs: 1000, intervalMs: 10 }),
    ).resolves.toEqual({ exists: true, state: 'running' });
  });

  it('polls again while starting, then resolves once running', async () => {
    // `mockImplementationOnce`, not `mockReturnValueOnce` — the fake child's emit is scheduled
    // via `queueMicrotask` at *creation* time, so it must be created lazily at call time, not
    // eagerly here, or its events fire before `runDocker` attaches listeners on the 2nd call.
    vi.mocked(childProcess.spawn)
      .mockImplementationOnce(() =>
        fakeChild({
          stdout: JSON.stringify([
            { State: { Status: 'running', Health: { Status: 'starting' } } },
          ]),
        }),
      )
      .mockImplementationOnce(() =>
        fakeChild({
          stdout: JSON.stringify([{ State: { Status: 'running' } }]),
        }),
      );

    await expect(
      waitForHealth('sandbox-1', { timeoutMs: 1000, intervalMs: 10 }),
    ).resolves.toEqual({ exists: true, state: 'running' });
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
  });

  it('throws once the container exits instead of becoming healthy', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      fakeChild({ stdout: JSON.stringify([{ State: { Status: 'exited' } }]) }),
    );

    await expect(
      waitForHealth('sandbox-1', { timeoutMs: 1000, intervalMs: 10 }),
    ).rejects.toThrow(/exited/);
  });

  it('throws once the bounded timeout elapses', async () => {
    vi.mocked(childProcess.spawn).mockImplementation(() =>
      fakeChild({
        stdout: JSON.stringify([
          { State: { Status: 'running', Health: { Status: 'starting' } } },
        ]),
      }),
    );

    await expect(
      waitForHealth('sandbox-1', { timeoutMs: 50, intervalMs: 10 }),
    ).rejects.toThrow(/did not become healthy/);
  });
});

describe('stop', () => {
  it('always runs docker stop + docker rm even when the bridge abort succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.mocked(childProcess.spawn).mockImplementation(() =>
      fakeChild({ stdout: 'sandbox-1\n' }),
    );

    await expect(
      stop('sandbox-1', { fetchImpl, timeoutMs: 1000 }),
    ).resolves.toEqual({ method: 'docker' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://sandbox-1:8080/stop',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(childProcess.spawn).toHaveBeenCalledWith('docker', [
      'stop',
      'sandbox-1',
    ]);
    expect(childProcess.spawn).toHaveBeenCalledWith('docker', [
      'rm',
      'sandbox-1',
    ]);
  });

  it('still runs docker stop when the bridge call rejects (e.g. connection refused)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.mocked(childProcess.spawn).mockImplementation(() =>
      fakeChild({ stdout: 'sandbox-1\n' }),
    );

    await expect(
      stop('sandbox-1', { fetchImpl, timeoutMs: 1000 }),
    ).resolves.toEqual({ method: 'docker' });

    expect(childProcess.spawn).toHaveBeenCalledWith('docker', [
      'stop',
      'sandbox-1',
    ]);
  });

  it('still runs docker stop once the bridge-response timeout fires', async () => {
    const fetchImpl = vi.fn(
      (_url, { signal } = {}) =>
        new Promise((_resolve, reject) => {
          // Never settles on its own — matches a genuinely unresponsive bridge; only the
          // `AbortController`'s bounded timeout ends it, exactly like a real `fetch` would reject
          // once its `signal` aborts.
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.mocked(childProcess.spawn).mockImplementation(() =>
      fakeChild({ stdout: 'sandbox-1\n' }),
    );

    await expect(
      stop('sandbox-1', { fetchImpl, timeoutMs: 20 }),
    ).resolves.toEqual({ method: 'docker' });

    expect(childProcess.spawn).toHaveBeenCalledWith('docker', [
      'stop',
      'sandbox-1',
    ]);
  });

  it('propagates the docker stop error and never attempts docker rm', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.mocked(childProcess.spawn).mockImplementation(() =>
      fakeChild({ stderr: 'Error: No such container: sandbox-1', exitCode: 1 }),
    );

    await expect(
      stop('sandbox-1', { fetchImpl, timeoutMs: 1000 }),
    ).rejects.toThrow(/No such container/);

    expect(childProcess.spawn).not.toHaveBeenCalledWith('docker', [
      'rm',
      'sandbox-1',
    ]);
  });

  it('does not throw when docker rm fails after a successful docker stop', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.mocked(childProcess.spawn)
      .mockImplementationOnce(() => fakeChild({ stdout: 'sandbox-1\n' }))
      .mockImplementationOnce(() =>
        fakeChild({
          stderr: 'Error: No such container: sandbox-1',
          exitCode: 1,
        }),
      );

    await expect(
      stop('sandbox-1', { fetchImpl, timeoutMs: 1000 }),
    ).resolves.toEqual({ method: 'docker' });
  });
});

// Integration: against real Docker, using the actual sandbox image built by `make sandbox-image`.
// Skipped when that image hasn't been built (e.g. a bare `pnpm test` without the Make target),
// so the unit tests above stay runnable without Docker/image-build overhead.
const SANDBOX_IMAGE = 'agent-sandbox:local';

function sandboxImageExists() {
  try {
    execSync(`docker image inspect ${SANDBOX_IMAGE}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(sandboxImageExists())('real Docker integration', () => {
  const NAME = 'sandbox-integration-test';
  const NETWORK = 'sandbox-integration-test-net';
  const FAKE_CONTROL_PLANE_NAME = 'fake-control-plane-integration-test';
  const FAKE_CONTROL_PLANE_PORT = 3000;
  // Fixture runs *inside a container* on a dedicated user-defined bridge network and is reached
  // by that network's embedded DNS (container name), not via the `docker0` gateway IP — the
  // latter is not universally routable from every container (this step's Root cause).
  const FIXTURE_DIR = path.dirname(
    fileURLToPath(
      new URL('./test-fixtures/fake-control-plane-server.mjs', import.meta.url),
    ),
  );

  function removeTestResources() {
    for (const args of [
      ['rm', '-f', NAME],
      ['rm', '-f', FAKE_CONTROL_PLANE_NAME],
      ['network', 'rm', NETWORK],
    ]) {
      try {
        execSync(`docker ${args.join(' ')}`, { stdio: 'ignore' });
      } catch {
        // Already removed — fine.
      }
    }
  }

  beforeEach(async () => {
    removeTestResources();
    execSync(`docker network create ${NETWORK}`, { stdio: 'ignore' });
    execSync(
      `docker run -d --name ${FAKE_CONTROL_PLANE_NAME} --network ${NETWORK} ` +
        `-v ${FIXTURE_DIR}:/fixtures:ro -e PORT=${FAKE_CONTROL_PLANE_PORT} ` +
        `node:24-slim node /fixtures/fake-control-plane-server.mjs`,
      { stdio: 'ignore' },
    );
    // Bounded poll (via `docker exec` into the fixture container itself, hitting its own
    // localhost — no extra containers or gateway routing needed) for it to accept connections
    // before the sandbox under test starts and depends on it being reachable at startup.
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        execSync(
          `docker exec ${FAKE_CONTROL_PLANE_NAME} node -e ` +
            `"fetch('http://127.0.0.1:${FAKE_CONTROL_PLANE_PORT}').then(r=>{if(!r.ok)throw new Error(r.status);process.exit(0)})"`,
          { stdio: 'ignore' },
        );
        break;
      } catch {
        if (Date.now() >= deadline)
          throw new Error('fake control plane fixture never came up');
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }, 30000);

  afterEach(() => {
    removeTestResources();
  });

  it('runs, inspects as running, and waits for health against a real container', async () => {
    // Unmock spawn for this test only — it must hit the real `docker` binary.
    const realChildProcess =
      /** @type {typeof import('node:child_process')} */ (
        /** @type {unknown} */ (await vi.importActual('node:child_process'))
      );
    vi.mocked(childProcess.spawn).mockImplementation((...args) =>
      realChildProcess.spawn(...args),
    );

    const env = {
      SANDBOX_IMAGE,
      SANDBOX_NETWORK: NETWORK,
      CONTROL_PLANE_URL: `http://${FAKE_CONTROL_PLANE_NAME}:${FAKE_CONTROL_PLANE_PORT}`,
    };

    const started = await run(
      {
        id: 'integration-test',
        model: 'litellm/x',
        targetDir: process.cwd(),
        platformConfigDir: process.cwd(),
      },
      env,
    );
    expect(started.containerName).toBe(NAME);
    expect(started.containerId).toMatch(/^[0-9a-f]{12,64}$/);

    const status = await inspect(NAME);
    expect(status.exists).toBe(true);
    // Not asserted as 'running' here — the image's HEALTHCHECK `--start-period=10s` means
    // `docker inspect` legitimately reports 'starting' for several seconds right after `docker
    // run` resolves (this step's E2E findings, docs/phase_01_findings.md). `waitForHealth` below
    // is what's actually being tested for reaching 'running'.

    await expect(
      waitForHealth(NAME, { timeoutMs: 15000, intervalMs: 200 }),
    ).resolves.toEqual({ exists: true, state: 'running' });
  }, 30000);
});
