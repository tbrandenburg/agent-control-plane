/**
 * Platform-config-repo fixture proof (Action 1/3 of the gap step that added this file) — proves
 * `bootstrapWorkspace()` clones a real, distinct Platform-config-repo fixture (a real bare git
 * repo, not mocked, built by `e2e/fixtures/platform-config-fixture.mjs`) and that its
 * `.opencode/opencode.json` marker lands, verbatim, in the resulting `platformConfigDir` — same
 * pattern as `bootstrap-failures.spec.ts`: exercises `control-plane/src/bootstrap.js` directly
 * with real `git`, no `docker compose` stack required.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import { bootstrapWorkspace } from '../../control-plane/src/bootstrap.js';
import { buildPlatformConfigFixture } from '../fixtures/platform-config-fixture.mjs';

test.describe('platform-config-repo fixture (real git, no docker stack required)', () => {
  test('bootstrapWorkspace() clones a real, distinct platform-config fixture and its marker lands verbatim', async () => {
    test.setTimeout(30000);

    const marker = `e2e-platform-fixture-${Date.now()}`;
    const fixture = buildPlatformConfigFixture(marker);
    // A minimal, real (local, bare) target repo too — bootstrapWorkspace() requires one and
    // hard-fails the whole session on any target-repo classification.
    const targetRoot = mkdtempSync(path.join(tmpdir(), 'target-fixture-'));
    const targetBare = path.join(targetRoot, 'bare.git');
    execFileSync('git', ['init', '-q', '--bare', targetBare]);
    const seedDir = path.join(targetRoot, 'seed');
    execFileSync('git', ['clone', '-q', targetBare, seedDir]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: seedDir,
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seedDir });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
      cwd: seedDir,
    });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], {
      cwd: seedDir,
    });

    const destRoot = mkdtempSync(path.join(tmpdir(), 'bootstrap-dest-'));
    try {
      const layout = await bootstrapWorkspace(
        {
          id: 'platform-config-fixture-test',
          targetRepo: { url: targetBare, ref: 'main' },
          platformConfigRepo: { url: fixture.repoPath, ref: 'main' },
        },
        destRoot,
      );

      expect(layout.platformConfigDir).toBeTruthy();
      const written = JSON.parse(
        readFileSync(
          path.join(layout.platformConfigDir, '.opencode', 'opencode.json'),
          'utf8',
        ),
      );
      expect(written.marker).toBe(marker);
    } finally {
      fixture.cleanup();
      rmSync(targetRoot, { recursive: true, force: true });
      rmSync(destRoot, { recursive: true, force: true });
    }
  });
});
