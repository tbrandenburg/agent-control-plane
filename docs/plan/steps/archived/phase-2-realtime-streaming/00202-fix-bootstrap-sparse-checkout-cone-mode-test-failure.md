> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Step 00200's Validation section requires `pnpm --filter control-plane test` to pass. Re-running it
independently during this step's review fails deterministically (not flaky — reproduced twice,
including in isolation via `pnpm vitest run src/bootstrap.test.js -t "sparse mode"`):

```
FAIL  src/bootstrap.test.js > cloneAndCheckout (real git fetch/checkout) > sparse mode restricts
the checkout to .opencode via cone-mode sparse-checkout
AssertionError: expected [ '.git', '.opencode', 'other.txt' ] to not include 'other.txt'
```

`src/bootstrap.js`/`src/bootstrap.test.js` are Step 00100's files, not Step 00200's — so this is out
of Boy Scout scope to fix here — but the failure blocks Step 00200's own literal validation command
from passing today, and it must not be silently inherited by Step 00600's end-to-end verification
without a fix.

This matters because:
- Cone-mode sparse-checkout is only expected to restrict the working tree to the declared
  path (`.opencode`); a non-declared file (`other.txt`) leaking into the checkout means the sparse
  cone pattern in `bootstrap.js`'s `cloneAndCheckout()` is either not applied correctly, applied
  after the wrong ref/init step, or the test fixture itself creates `other.txt` in a location the
  cone pattern doesn't actually exclude.
- Silently leaking the full repo tree instead of the declared sparse subset undermines the
  Platform/Team config isolation guarantees ARCHITECTURE.md §10 relies on.

## Actions

1. Root-cause why `other.txt` survives cone-mode sparse-checkout in
   `control-plane/src/bootstrap.js`'s `cloneAndCheckout()` — check the order of
   `git sparse-checkout init --cone` / `git sparse-checkout set <path>` / `git checkout` calls, and
   confirm the test fixture (`e2e/fixtures/git-failure-fixtures.mjs` or equivalent) places
   `other.txt` outside, not inside, the declared cone path.
2. Fix `bootstrap.js` (or the test fixture, whichever is actually wrong) so
   `src/bootstrap.test.js`'s "sparse mode restricts the checkout to .opencode via cone-mode
   sparse-checkout" test passes deterministically.
3. Re-run `pnpm --filter control-plane test` in full and confirm all tests pass with zero failures.
