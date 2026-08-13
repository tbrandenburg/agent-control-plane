/**
 * Repo/host references for the real-failure bootstrap E2E variants (`bootstrap-failures.spec.ts`,
 * Step 5). Deliberately real-network values, not stubs — ARCHITECTURE.md §10's failure
 * classification must be exercised against actual `git` stderr, not mocked strings.
 */

/** A GitHub repo path that does not exist, and is also unauthenticated — classifies `not_found`. */
export const NONEXISTENT_REPO_URL =
  'https://github.com/this-org-should-not-exist-zzz/nope.git';

/** A non-routable IPv4 address (TEST-NET-3-adjacent, RFC 5737-style unreachable host) — `git`
 * against it classifies `network` (`Failed to connect`/`Couldn't connect to server`). */
export const UNREACHABLE_HOST_REPO_URL = 'http://10.255.255.1/x.git';

/** A real GitHub repo requiring a credential, hit with an embedded bad token — classifies `auth`. */
export const AUTH_REQUIRED_REPO_URL =
  'https://x-access-token:bad-token@github.com/octocat/private-nonexistent-repo-test.git';
