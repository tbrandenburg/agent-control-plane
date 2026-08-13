/**
 * Two distinct, real, always-clonable public GitHub repos used by the arbitrary-repo E2E proof
 * (`e2e/tests/arbitrary-repo-bootstrap.spec.ts`, Action 2/3 of the gap step that added this file)
 * — small, stable, well-known GitHub sample repos, each with a distinct, unique `README.md` so a
 * real clone of each into a real sandbox container can be told apart by content, not by path.
 *
 * `docs/plan/steps/planned/00606-*.md` (a sibling, still-planned gap step fixing
 * `session-lifecycle.spec.ts`'s own stale `acme/widgets` placeholder fixture) may reuse
 * `TARGET_REPO_A` for that unrelated fix — see this file before picking a second, different repo
 * for that purpose.
 */

/** A tiny, stable, first-ever-created GitHub sample repo. `README.md` reads "Hello World!". */
export const TARGET_REPO_A = { owner: 'octocat', name: 'Hello-World' };

/** A distinct, equally tiny/stable GitHub sample repo with different `README.md` content. */
export const TARGET_REPO_B = { owner: 'octocat', name: 'Spoon-Knife' };
