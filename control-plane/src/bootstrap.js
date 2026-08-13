/**
 * Real git bootstrap: SHA resolution, shallow clone/checkout, credential stripping, and
 * stderr-based failure classification (ARCHITECTURE.md §10). All git invocations use
 * `child_process.spawn` with an argv array, never a shell string (ARCHITECTURE.md §13).
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

/** @typedef {Error & {stderr?: string, classification?: string, role?: string}} GitError */

/**
 * Runs `git <args>` via `spawn` (never a shell string), collecting stdout/stderr.
 * @param {string[]} args - Argv passed to `git`.
 * @param {string} [cwd] - Working directory for the git invocation.
 * @returns {Promise<string>} Trimmed stdout on a zero exit code.
 * @throws {Error} With `.stderr` set to the trimmed, credential-stripped stderr on failure.
 */
function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, cwd ? { cwd } : undefined);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const error = /** @type {GitError} */ (
        new Error(`git ${args[0]} timed out after 10000ms`)
      );
      error.stderr = error.message;
      reject(error);
    }, 10000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const cleanStderr = stripCredentialsFromText((stderr || stdout).trim());
      const error = /** @type {GitError} */ (
        new Error(cleanStderr || `git ${args[0]} exited with code ${code}`)
      );
      error.stderr = cleanStderr;
      reject(error);
    });
  });
}

/**
 * Strips an embedded `user:pass@`/`user@` credential from any `http(s)://` URL occurrence in a
 * block of text (e.g. git stderr), so raw tokens never reach logs.
 * @param {string} text - Text possibly containing credentialed URLs.
 * @returns {string} The same text with credentials removed.
 */
export function stripCredentialsFromText(text) {
  return text.replace(/(https?:\/\/)[^@\s/]+@/gi, '$1');
}

/**
 * Classifies a git failure by pattern-matching its stderr, per ARCHITECTURE.md §10's four-row
 * table. Never dispatches on exit code — git's own exit code is always 128 regardless of cause.
 * @param {string} stderr - The failing git command's stderr (or stdout fallback).
 * @returns {'not_found'|'auth'|'network'|'unknown'} The failure classification.
 */
export function classifyGitFailure(stderr) {
  const text = stderr ?? '';
  if (/repository .* not found/i.test(text)) return 'not_found';
  if (/authentication failed|invalid username or token/i.test(text))
    return 'auth';
  if (
    /could not resolve host|failed to connect|couldn't connect to server|timed out|timeout/i.test(
      text,
    )
  ) {
    return 'network';
  }
  return 'unknown';
}

/**
 * Resolves a ref to a concrete SHA via `git ls-remote`, up front and before any fetch — closes
 * the concurrent-push race called out in ARCHITECTURE.md §10.
 * @param {string} repoUrl - Repository URL (may carry an embedded credential).
 * @param {string} ref - Branch/tag name to resolve.
 * @returns {Promise<string>} The resolved 40-character SHA.
 * @throws {Error} With `.classification` set, on any `ls-remote` failure or an unresolvable ref.
 */
export async function resolveSha(repoUrl, ref) {
  let stdout;
  try {
    stdout = await runGit(['ls-remote', repoUrl, ref]);
  } catch (err) {
    const error = /** @type {GitError} */ (err);
    error.classification = classifyGitFailure(error.stderr ?? '');
    throw error;
  }
  const sha = stdout.split(/\s+/, 1)[0] ?? '';
  if (!sha) {
    const error = /** @type {GitError} */ (
      new Error(`ref '${ref}' not found on ${repoUrl}`)
    );
    error.classification = 'not_found';
    throw error;
  }
  return sha;
}

/**
 * Shallow-fetches a pinned SHA and checks it out directly — **never** a branch-name checkout, so
 * a concurrent push after `resolveSha` can never change what lands on disk.
 * @param {string} repoUrl - Repository URL (may carry an embedded credential).
 * @param {string} sha - The exact commit to fetch and check out.
 * @param {string} destPath - Destination directory (created if missing).
 * @param {{sparse?: boolean}} [options] - `sparse: true` enables cone-mode sparse checkout of
 *   `.opencode` only, used for the team config layer.
 * @returns {Promise<void>}
 * @throws {Error} With `.classification` set, on any git failure.
 */
export async function cloneAndCheckout(
  repoUrl,
  sha,
  destPath,
  { sparse = false } = {},
) {
  try {
    await mkdir(destPath, { recursive: true });
    await runGit(['init', '-q'], destPath);
    await runGit(['remote', 'add', 'origin', repoUrl], destPath);
    if (sparse) {
      await runGit(['sparse-checkout', 'init', '--cone'], destPath);
      await runGit(['sparse-checkout', 'set', '.opencode'], destPath);
    }
    await runGit(['fetch', '--depth', '1', 'origin', sha], destPath);
    await runGit(['checkout', sha], destPath);
  } catch (err) {
    const error = /** @type {GitError} */ (err);
    error.classification =
      error.classification ?? classifyGitFailure(error.stderr ?? '');
    throw error;
  }
}

/**
 * Strips any embedded credential from a cloned directory's `origin` remote URL, run on every
 * cloned directory **before** it is bind-mounted into a sandbox (ARCHITECTURE.md §2's
 * filesystem-path half of the secret-custody boundary).
 * @param {string} destPath - The cloned repository's working directory.
 * @returns {Promise<void>}
 */
export async function stripCredential(destPath) {
  const url = await runGit(['remote', 'get-url', 'origin'], destPath);
  const stripped = url.replace(/^(https?:\/\/)[^@/]+@/i, '$1');
  if (stripped !== url) {
    await runGit(['remote', 'set-url', 'origin', stripped], destPath);
  }
}

/**
 * @typedef {object} RepoRef
 * @property {string} url - Repository URL (may carry an embedded credential).
 * @property {string} ref - Branch/tag name to resolve and pin.
 */

/**
 * @typedef {object} BootstrapSession
 * @property {string} id - Session id, used to namespace the destination directories.
 * @property {RepoRef} targetRepo - The user-specified target repository (hard fail on any
 *   classification).
 * @property {RepoRef} platformConfigRepo - The platform config repository (hard fail on any
 *   classification).
 * @property {RepoRef} [teamConfigRepo] - Optional team config repository (silent skip on
 *   `not_found`; hard fail on `auth`/`network`/`unknown`).
 */

/**
 * Clones/checks-out target, platform-config, and (optionally) team-config repos into
 * `<baseDir>/<role>`, applying ARCHITECTURE.md §10's asymmetric failure handling: target/platform
 * hard-fail on any classification, team silently skips on `not_found` only.
 * @param {BootstrapSession} session - Session describing the repos to bootstrap.
 * @param {string} baseDir - Base directory under which `target`/`platform`/`team` are cloned.
 * @returns {Promise<{targetDir: string, platformConfigDir: string, teamConfigDir: string|null}>}
 *   The composed directory-tree layout `sandbox.run()` needs to mount.
 * @throws {Error} With `.role` and `.classification` set, on any hard-failure condition.
 */
export async function bootstrapWorkspace(session, baseDir) {
  const roles = [
    {
      role: 'target',
      repo: session.targetRepo,
      dir: `${baseDir}/target`,
      sparse: false,
      optional: false,
    },
    {
      role: 'platform',
      repo: session.platformConfigRepo,
      dir: `${baseDir}/platform`,
      sparse: false,
      optional: false,
    },
  ];
  if (session.teamConfigRepo) {
    roles.push({
      role: 'team',
      repo: session.teamConfigRepo,
      dir: `${baseDir}/team`,
      sparse: true,
      optional: true,
    });
  }

  /** @type {{targetDir: string|null, platformConfigDir: string|null, teamConfigDir: string|null}} */
  const layout = {
    targetDir: null,
    platformConfigDir: null,
    teamConfigDir: null,
  };

  for (const { role, repo, dir, sparse, optional } of roles) {
    let sha;
    try {
      sha = await resolveSha(repo.url, repo.ref);
      await cloneAndCheckout(repo.url, sha, dir, { sparse });
      await stripCredential(dir);
    } catch (err) {
      const error = /** @type {GitError} */ (err);
      if (optional && error.classification === 'not_found') {
        continue;
      }
      const bootstrapError = new Error(
        `bootstrap failed for ${role} repo: ${error.message}`,
      );
      /** @type {GitError} */ (bootstrapError).role = role;
      /** @type {GitError} */ (bootstrapError).classification =
        error.classification ?? 'unknown';
      throw bootstrapError;
    }
    if (role === 'target') layout.targetDir = dir;
    if (role === 'platform') layout.platformConfigDir = dir;
    if (role === 'team') layout.teamConfigDir = dir;
  }

  if (!layout.targetDir || !layout.platformConfigDir) {
    throw new Error(
      'bootstrap did not produce required repository directories',
    );
  }
  return {
    targetDir: layout.targetDir,
    platformConfigDir: layout.platformConfigDir,
    teamConfigDir: layout.teamConfigDir,
  };
}
