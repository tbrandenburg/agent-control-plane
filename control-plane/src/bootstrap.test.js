import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapWorkspace,
  classifyGitFailure,
  cloneAndCheckout,
  resolveSha,
  stripCredential,
  stripCredentialsFromText,
} from './bootstrap.js';

/** Real bare repo fixture path, built once for the whole suite. */
let bareRepoPath;
let sha;
const workDirs = [];

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'bootstrap-fixture-'));
  bareRepoPath = path.join(root, 'bare.git');
  execFileSync('git', ['init', '-q', '--bare', bareRepoPath]);

  const seedDir = path.join(root, 'seed');
  execFileSync('git', ['clone', '-q', bareRepoPath, seedDir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: seedDir,
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seedDir });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: seedDir,
  });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: seedDir });
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seedDir })
    .toString()
    .trim();
  workDirs.push(root);
});

afterEach(() => {
  for (const dir of workDirs.splice(1)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDest() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bootstrap-dest-'));
  workDirs.push(dir);
  return path.join(dir, 'checkout');
}

describe('classifyGitFailure', () => {
  it('classifies a real "repository not found" GitHub stderr as not_found', () => {
    const stderr =
      "fatal: repository 'https://github.com/nope-org-zzz/nope.git/' not found";
    expect(classifyGitFailure(stderr)).toBe('not_found');
  });

  it('classifies a real GitHub auth-failure stderr as auth (case-insensitive)', () => {
    const stderr =
      'remote: Invalid username or token. Password authentication is not supported for Git operations.\n' +
      "fatal: Authentication failed for 'https://github.com/octocat/private.git/'";
    expect(classifyGitFailure(stderr)).toBe('auth');
    expect(classifyGitFailure('AUTHENTICATION FAILED for x')).toBe('auth');
  });

  it('classifies a real unreachable-host stderr as network', () => {
    const stderr =
      "fatal: unable to access 'http://10.255.255.1/x.git/': Failed to connect to 10.255.255.1 port 80 after 13 ms: Couldn't connect to server";
    expect(classifyGitFailure(stderr)).toBe('network');
  });

  it('classifies a multi-line "could not resolve host" stderr as network', () => {
    const stderr =
      "Cloning into 'x'...\nfatal: Could not resolve host: nonexistent.invalid";
    expect(classifyGitFailure(stderr)).toBe('network');
  });

  it('falls back to unknown for an unrecognized synthetic stderr (fail-closed default)', () => {
    expect(
      classifyGitFailure('fatal: something totally unexpected happened'),
    ).toBe('unknown');
  });

  it('never dispatches on exit code — classification is stderr-text-based only', () => {
    // git's own exit code is always 128 regardless of cause; classifyGitFailure only ever sees text.
    expect(classifyGitFailure('')).toBe('unknown');
  });
});

describe('stripCredentialsFromText', () => {
  it('strips an embedded token from an https URL inside arbitrary text', () => {
    const text =
      "fatal: repository 'https://ghp_faketoken123@github.com/a/b.git/' not found";
    expect(stripCredentialsFromText(text)).toBe(
      "fatal: repository 'https://github.com/a/b.git/' not found",
    );
  });

  it('leaves text with no embedded credential unchanged', () => {
    const text = 'fatal: Could not resolve host: nonexistent.invalid';
    expect(stripCredentialsFromText(text)).toBe(text);
  });
});

describe('resolveSha (real git ls-remote)', () => {
  it('resolves a real local bare repo ref to its SHA up front', async () => {
    const resolved = await resolveSha(bareRepoPath, 'main');
    expect(resolved).toBe(sha);
  });

  it('throws classified not_found for a real nonexistent GitHub repo', async () => {
    await expect(
      resolveSha(
        'https://github.com/this-org-should-not-exist-zzz/nope.git',
        'main',
      ),
    ).rejects.toMatchObject({ classification: 'not_found' });
  }, 20000);

  it('throws classified network for a real unreachable host', async () => {
    await expect(
      resolveSha('http://10.255.255.1/x.git', 'main'),
    ).rejects.toMatchObject({ classification: 'network' });
  }, 20000);

  it('throws classified not_found when the ref itself does not exist on a real repo', async () => {
    await expect(
      resolveSha(bareRepoPath, 'no-such-branch'),
    ).rejects.toMatchObject({
      classification: 'not_found',
    });
  });
});

describe('cloneAndCheckout (real git fetch/checkout)', () => {
  it('fetches and checks out the pinned SHA, never a branch name', async () => {
    const dest = tmpDest();
    await cloneAndCheckout(bareRepoPath, sha, dest);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dest })
      .toString()
      .trim();
    expect(head).toBe(sha);
  });

  it('sparse mode restricts the checkout to .opencode via cone-mode sparse-checkout', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bootstrap-sparse-'));
    workDirs.push(root);
    const sparseBare = path.join(root, 'bare.git');
    execFileSync('git', ['init', '-q', '--bare', sparseBare]);
    const seed = path.join(root, 'seed');
    execFileSync('git', ['clone', '-q', sparseBare, seed]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: seed,
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
    mkdirSync(path.join(seed, '.opencode'), { recursive: true });
    writeFileSync(path.join(seed, '.opencode', 'config.json'), '{}');
    writeFileSync(path.join(seed, 'other.txt'), 'x');
    execFileSync('git', ['add', '.'], { cwd: seed });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: seed });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: seed });
    const sparseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seed })
      .toString()
      .trim();

    const dest = tmpDest();
    await cloneAndCheckout(sparseBare, sparseSha, dest, { sparse: true });

    const entries = readdirSync(dest);
    expect(entries).toContain('.opencode');
    expect(entries).not.toContain('other.txt');
  });

  it('throws classified not_found for a real nonexistent GitHub repo (fetch call site)', async () => {
    const dest = tmpDest();
    await expect(
      cloneAndCheckout(
        'https://github.com/this-org-should-not-exist-zzz/nope.git',
        '0'.repeat(40),
        dest,
      ),
    ).rejects.toMatchObject({
      classification: expect.stringMatching(/not_found|unknown/),
    });
  }, 20000);
});

describe('stripCredential', () => {
  it('rewrites an https origin URL to drop its embedded credential', async () => {
    const dest = tmpDest();
    await cloneAndCheckout(bareRepoPath, sha, dest);
    execFileSync(
      'git',
      [
        'remote',
        'set-url',
        'origin',
        'https://x-access-token:secrettoken@github.com/a/b.git',
      ],
      { cwd: dest },
    );

    await stripCredential(dest);

    const url = execFileSync('git', ['remote', '-v'], { cwd: dest }).toString();
    expect(url).toContain('https://github.com/a/b.git');
    expect(url).not.toContain('secrettoken');
  });

  it('leaves an already-clean origin URL unchanged', async () => {
    const dest = tmpDest();
    await cloneAndCheckout(bareRepoPath, sha, dest);
    await stripCredential(dest);
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dest,
    })
      .toString()
      .trim();
    expect(url).toBe(bareRepoPath);
  });
});

describe('bootstrapWorkspace', () => {
  function makeBaseDir() {
    const dir = mkdtempSync(path.join(tmpdir(), 'bootstrap-workspace-'));
    workDirs.push(dir);
    return dir;
  }

  it('bootstraps target and platform repos and returns their directory layout', async () => {
    const baseDir = makeBaseDir();
    const layout = await bootstrapWorkspace(
      {
        id: 's1',
        targetRepo: { url: bareRepoPath, ref: 'main' },
        platformConfigRepo: { url: bareRepoPath, ref: 'main' },
      },
      baseDir,
    );

    expect(layout.targetDir).toBe(path.join(baseDir, 'target'));
    expect(layout.platformConfigDir).toBe(path.join(baseDir, 'platform'));
    expect(layout.teamConfigDir).toBeNull();
  });

  it('hard-fails when the target repo is a real nonexistent GitHub repo', async () => {
    const baseDir = makeBaseDir();
    await expect(
      bootstrapWorkspace(
        {
          id: 's2',
          targetRepo: {
            url: 'https://github.com/this-org-should-not-exist-zzz/nope.git',
            ref: 'main',
          },
          platformConfigRepo: { url: bareRepoPath, ref: 'main' },
        },
        baseDir,
      ),
    ).rejects.toMatchObject({ role: 'target', classification: 'not_found' });
  }, 20000);

  it('hard-fails when the platform config repo is unreachable (network)', async () => {
    const baseDir = makeBaseDir();
    await expect(
      bootstrapWorkspace(
        {
          id: 's3',
          targetRepo: { url: bareRepoPath, ref: 'main' },
          platformConfigRepo: { url: 'http://10.255.255.1/x.git', ref: 'main' },
        },
        baseDir,
      ),
    ).rejects.toMatchObject({ role: 'platform', classification: 'network' });
  }, 20000);

  it('silently skips a team config repo that is not_found, target/platform still succeed', async () => {
    const baseDir = makeBaseDir();
    const layout = await bootstrapWorkspace(
      {
        id: 's4',
        targetRepo: { url: bareRepoPath, ref: 'main' },
        platformConfigRepo: { url: bareRepoPath, ref: 'main' },
        teamConfigRepo: {
          url: 'https://github.com/this-org-should-not-exist-zzz/nope.git',
          ref: 'main',
        },
      },
      baseDir,
    );

    expect(layout.targetDir).toBe(path.join(baseDir, 'target'));
    expect(layout.platformConfigDir).toBe(path.join(baseDir, 'platform'));
    expect(layout.teamConfigDir).toBeNull();
  }, 20000);

  it('hard-fails (does not silently skip) when the team config repo is unreachable (network)', async () => {
    const baseDir = makeBaseDir();
    await expect(
      bootstrapWorkspace(
        {
          id: 's5',
          targetRepo: { url: bareRepoPath, ref: 'main' },
          platformConfigRepo: { url: bareRepoPath, ref: 'main' },
          teamConfigRepo: { url: 'http://10.255.255.1/x.git', ref: 'main' },
        },
        baseDir,
      ),
    ).rejects.toMatchObject({ role: 'team', classification: 'network' });
  }, 20000);
});
