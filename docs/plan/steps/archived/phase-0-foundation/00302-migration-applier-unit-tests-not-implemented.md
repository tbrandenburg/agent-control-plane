> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap-fill step (review of 00301-migration-applier-unit-tests.md)

### Why this matters

`00301-migration-applier-unit-tests.md` (in `docs/plan/steps/in-review/`) called for two specific
unit tests to be added to `control-plane/src/db.test.js`:

1. An ordering test proving migrations are applied in ascending lexicographic filename order
   using at least two dummy zero-padded `.sql` fixtures created out of natural insertion order.
2. A rollback test using a deliberately malformed `.sql` fixture proving the failing transaction
   is rolled back, an error is logged with the filename, and `process.exit(1)` is invoked (with
   `process.exit` mocked/stubbed in the test).

Independent re-verification shows **neither test exists**. `control-plane/src/db.test.js` still
only contains the original two tests from `00300` (`creates the database and applies
001_init.sql` and `is idempotent on re-run`) — confirmed by `pnpm --filter control-plane test`
reporting `4 passed (4)` test files / `7 passed (7)` tests total, with no ordering- or
rollback-related test names in the output, and by grepping the test file for
`010_b|002_a|malformed|rollback|process.exit`, which returns zero matches.

Additionally, action item 2 of `00301` ("either export `applyMigrations` ... or drive both new
tests through the public `openDb()` entrypoint using a temp directory whose `migrations` layout
is controllable per-test") is also unimplemented: `control-plane/src/db.js` still resolves
`migrationsDir` as a hardcoded path relative to the module file
(`join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')`) with no way to override it
per test, and `applyMigrations` is not exported. Without one of these two changes, the two
required tests cannot be written at all — this is a blocking prerequisite, not an optional nice-to-have.

Leaving this gap open means the `.sort()` ordering behavior and the transactional rollback /
hard-stop-on-failure behavior in `applyMigrations()` remain completely untested, exactly as
described in `00301`'s own rationale — a future migration-ordering or error-handling regression
would ship silently.

### Actions

1. In `control-plane/src/db.js`, make the migrations directory testable without widening the
   public API more than necessary. Prefer one of:
   - Add an optional second parameter to `openDb(dataDir, migrationsDir = <default>)` and thread
     it through to `applyMigrations(db, migrationsDir)`, or
   - Export `applyMigrations` directly for unit testing if that proves simpler and does not
     duplicate logic in the test.
2. Add the ordering test: create a temp directory with at least two `.sql` fixture files named
   with zero-padded numeric prefixes chosen so naive/insertion-order iteration would misorder them
   (e.g. write `010_b.sql` before `002_a.sql`), run migrations against that directory, and assert
   the resulting `_migrations` rows (or equivalent applied-order side effect) reflect ascending
   lexicographic order, not creation order.
3. Add the rollback test: create a temp directory with a deliberately malformed `.sql` fixture,
   stub/mock `process.exit` (do not let it kill the test runner), run migrations against that
   directory, and assert:
   - No partial schema objects from the failing file persist (transaction rolled back).
   - An error referencing the failing filename was logged.
   - The stubbed `process.exit` was called with a non-zero code.
4. Do not duplicate `db.js` logic in the tests — exercise the real `openDb`/`applyMigrations` code
   path per file's existing convention.
5. Re-run `pnpm --filter control-plane test` and confirm all tests, including the two new ones,
   pass, and paste the actual passing test count/output as evidence (not just "tests pass").
6. Do not modify any file under `docs/plan/steps/in-review/` or elsewhere under
   `docs/plan/steps/` — this gap-fill step file is the only permitted new file.
