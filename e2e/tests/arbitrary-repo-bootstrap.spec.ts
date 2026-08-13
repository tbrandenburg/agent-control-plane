import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

import {
  TARGET_REPO_A,
  TARGET_REPO_B,
} from '../fixtures/distinct-target-repos.mjs';

/**
 * Arbitrary-repo bootstrap-wiring proof (gap step `00604`, Action 3) — against the real
 * `docker compose` stack (`make e2e`, no mocks), creates two sessions against two distinct real
 * public GitHub repos (`e2e/fixtures/distinct-target-repos.mjs`) and asserts, via a real `docker
 * exec` into each spawned sandbox (no bridge/diagnostic endpoint exists for this yet — Phase 3),
 * that each container's `/workspace/repo/README(.md)` actually contains that repo's own unique
 * content — falsifying the still-open finding in `docs/phase_02_findings.md` §3 that
 * `repoOwner`/`repoName` might be ignored (a hardcoded/shared workspace bind-mount across every
 * session, or a swapped directory) rather than genuinely driving a per-session real `git` clone.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

const spawnedContainers = new Set();

async function createSession(request, title, repo) {
  const response = await request.post(`${BASE_URL}/api/sessions`, {
    data: {
      title,
      repoOwner: repo.owner,
      repoName: repo.name,
      model: 'opencode/big-pickle',
    },
  });
  expect(response.status()).toBe(202);
  const body = await response.json();
  expect(body.id).toBeTruthy();
  spawnedContainers.add(`sandbox-${body.id}`);
  return body;
}

async function waitForStatus(request, id, predicate, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; containerName?: string };
  for (;;) {
    const response = await request.get(`${BASE_URL}/api/sessions/${id}`);
    last = await response.json();
    if (predicate(last.status)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for session status; last saw: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Real `docker exec` into a live sandbox container — no bridge diagnostic endpoint exists yet. */
function readFileInContainer(containerName, filePath) {
  return execFileSync('docker', ['exec', containerName, 'cat', filePath], {
    encoding: 'utf8',
  });
}

/**
 * Reads whichever of `README.md`/`README` actually exists at the repo root — GitHub's own
 * `octocat/Hello-World` fixture ships a plain `README` (no extension), while `octocat/Spoon-Knife`
 * ships `README.md`; asserting a single hardcoded filename across both real, distinct fixture
 * repos is incorrect regardless of which target repo is used.
 */
function readReadmeInContainer(containerName) {
  try {
    return readFileInContainer(containerName, '/workspace/repo/README.md');
  } catch {
    return readFileInContainer(containerName, '/workspace/repo/README');
  }
}

test.describe('arbitrary-repo bootstrap wiring (real docker compose stack, two distinct real repos)', () => {
  test.afterEach(() => {
    for (const name of spawnedContainers) {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        // Already removed — fine, teardown must be unconditional either way.
      }
    }
    spawnedContainers.clear();
  });

  test('two sessions against two distinct repos end up with distinct, correct /workspace/repo content', async ({
    request,
  }) => {
    test.setTimeout(120000);

    const [sessionA, sessionB] = await Promise.all([
      createSession(request, 'E2E arbitrary-repo A', TARGET_REPO_A),
      createSession(request, 'E2E arbitrary-repo B', TARGET_REPO_B),
    ]);

    const [rowA, rowB] = await Promise.all([
      waitForStatus(request, sessionA.id, (status) => status === 'active'),
      waitForStatus(request, sessionB.id, (status) => status === 'active'),
    ]);

    expect(rowA.containerName).toBeTruthy();
    expect(rowB.containerName).toBeTruthy();
    // Different sessions must never end up sharing (or swapping) the same bind-mounted
    // workspace/container — the exact wiring mistake this proof exists to catch.
    expect(rowA.containerName).not.toBe(rowB.containerName);

    const readmeA = readReadmeInContainer(rowA.containerName);
    const readmeB = readReadmeInContainer(rowB.containerName);

    expect(readmeA).toContain('Hello World');
    expect(readmeB).not.toContain('Hello World');
    expect(readmeA).not.toBe(readmeB);
  });
});
