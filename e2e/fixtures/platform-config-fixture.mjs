/**
 * Builds a minimal, real (not mocked) Platform-config-repo fixture: a bare git repo, seeded and
 * pushed exactly the way `control-plane/src/bootstrap.test.js`'s own `beforeAll` already builds
 * its bare-repo fixture, with one addition — an `.opencode/opencode.json` file containing a
 * caller-supplied distinguishing marker value, so a test can assert `bootstrapWorkspace()`
 * actually cloned *this* fixture's content (not some other tree) into the resulting
 * `platformConfigDir`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * @param {string} marker - Distinguishing value written into `.opencode/opencode.json`.
 * @returns {{repoPath: string, cleanup: () => void}} The real bare repo path (a valid `git`
 *   remote URL as-is) and a synchronous cleanup function removing every temp dir created.
 */
export function buildPlatformConfigFixture(marker) {
  const root = mkdtempSync(path.join(tmpdir(), 'platform-config-fixture-'));
  const repoPath = path.join(root, 'bare.git');
  execFileSync('git', ['init', '-q', '--bare', repoPath]);

  const seedDir = path.join(root, 'seed');
  execFileSync('git', ['clone', '-q', repoPath, seedDir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: seedDir,
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seedDir });
  mkdirSync(path.join(seedDir, '.opencode'), { recursive: true });
  writeFileSync(
    path.join(seedDir, '.opencode', 'opencode.json'),
    JSON.stringify({ marker }, null, 2),
  );
  execFileSync('git', ['add', '.'], { cwd: seedDir });
  execFileSync('git', ['commit', '-q', '-m', 'seed platform config fixture'], {
    cwd: seedDir,
  });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: seedDir });

  return {
    repoPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
