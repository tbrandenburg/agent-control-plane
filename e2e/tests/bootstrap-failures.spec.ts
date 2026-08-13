/**
 * Bootstrap-classification falsification (Step 6) — drives real failing `git` invocations
 * against real hosts (real GitHub, a real non-routable IP) through `bootstrap.js`'s own
 * exported functions, no mocking of `git` per root `AGENTS.md`. Three of
 * `ARCHITECTURE.md` §10's four classification rows (`not_found`, `auth`, `network`) are
 * reproduced this way; the fourth (`unknown`) is a fail-closed default for stderr text no real
 * `git` failure observed in this environment produces, so it is exercised with a synthetic
 * string against `classifyGitFailure()` directly — stated explicitly, not pretended to be a
 * real clone (this step's Decisions).
 *
 * This spec does not require the `docker compose` stack (`make e2e`'s `E2E_BASE_URL`) — it
 * exercises `control-plane/src/bootstrap.js` directly with real network calls, since real
 * bootstrap is not yet wired into `POST /api/sessions`'s spawn path (see
 * `docs/phase_02_findings.md`'s "bootstrap wiring gap" finding).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import {
  classifyGitFailure,
  resolveSha,
} from '../../control-plane/src/bootstrap.js';
import {
  AUTH_REQUIRED_REPO_URL,
  NONEXISTENT_REPO_URL,
  UNREACHABLE_HOST_REPO_URL,
} from '../fixtures/git-failure-fixtures.mjs';

test.describe('bootstrap failure classification (real git, real network)', () => {
  let workDir: string;

  test.beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'bootstrap-e2e-'));
  });

  test.afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test('not_found: a real nonexistent/unauthenticated GitHub repo', async () => {
    test.setTimeout(30000);
    let caught: Error & { classification?: string };
    try {
      await resolveSha(NONEXISTENT_REPO_URL, 'main');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.classification).toBe('not_found');
  });

  test('network: a real non-routable host times out unreachable', async () => {
    test.setTimeout(30000);
    let caught: Error & { classification?: string };
    try {
      await resolveSha(UNREACHABLE_HOST_REPO_URL, 'main');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.classification).toBe('network');
  });

  test('auth: a real repo hit with a bad embedded credential', async () => {
    test.setTimeout(30000);
    let caught: Error & { classification?: string };
    try {
      await resolveSha(AUTH_REQUIRED_REPO_URL, 'main');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // GitHub returns an identical "not found" response for a private repo hit with a bad
    // credential as it does for a genuinely nonexistent repo (deliberately indistinguishable,
    // ARCHITECTURE.md §10) — accept either `auth` or `not_found` here and record which one this
    // environment's real `git`/GitHub actually produced in `docs/phase_02_findings.md`.
    expect(['auth', 'not_found']).toContain(caught.classification);
  });

  test('unknown: a synthetic stderr string matching none of the known patterns (fail-closed default, not a real clone)', () => {
    const classification = classifyGitFailure(
      'fatal: some completely novel git error string never seen in this environment',
    );
    expect(classification).toBe('unknown');
  });
});
