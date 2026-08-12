> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap-fill step (review of 00300-sqlite-via-node-sqlite-plus-the-migration-applier.md)

### Why this matters

The closed step's "Tests > Unit" section requires two specific unit tests that are missing from
`control-plane/src/db.test.js`:

1. **Applier ordering** — verifying migrations are applied in lexicographic filename order with
   zero-padded numeric prefixes (e.g. `002_x.sql` before `010_x.sql`). Only one migration file
   (`001_init.sql`) exists today, so the current test suite never actually exercises the `.sort()`
   call in `applyMigrations()` (`control-plane/src/db.js`). A future step that adds `002_sessions.sql`,
   `003_events.sql`, etc. could silently regress ordering (e.g. if someone switches to unsorted
   `Object.keys` iteration or a locale-aware sort that breaks on numeric prefixes >= 10) without any
   test catching it.
2. **Rollback path on a malformed SQL fixture** — verifying that a failing migration rolls back its
   transaction, logs the filename and error, and that `process.exit(1)` (or an equivalent hard-stop)
   is invoked, per the step's "Error Handling" section. This is the only place in the codebase that
   guards against booting on a partially-applied schema; it is currently completely untested. If this
   regresses, the server could silently boot with a half-applied schema instead of refusing to start.

Both were explicitly called for in the step's Validation/Tests section but were not implemented,
which is a gap per the review's evidence-first standard (validation must be independently re-run
and confirmed, not assumed).

### Actions

1. In `control-plane/src/db.test.js` (or a new adjacent test file if that keeps `db.test.js` under
   the 200 LOC soft limit), add:
   - A test that creates a temp `migrations`-like directory with at least two dummy `.sql` files
     named with zero-padded numeric prefixes out of natural insertion order (e.g. `010_b.sql` created
     before `002_a.sql` on disk, or names chosen so naive iteration would misorder them), and asserts
     they are applied in ascending lexicographic order via the resulting `_migrations` rows (or an
     applied-order side effect, e.g. table creation order).
   - A test with a deliberately malformed `.sql` fixture (e.g. invalid SQL syntax) that verifies:
     - The transaction is rolled back (no partial schema objects from that file persist).
     - An error is logged referencing the failing filename.
     - The process exits non-zero (mock/stub `process.exit` in the test rather than letting it kill
       the test runner — do not duplicate `db.js` logic in the test, exercise the real `openDb`/
       `applyMigrations` code path).
2. Since `applyMigrations` is not currently exported from `control-plane/src/db.js`, either export it
   for direct unit testing or drive both new tests through the public `openDb()` entrypoint using a
   temp directory whose `migrations` layout is controllable per-test. Prefer testing through the
   public entrypoint if it avoids widening the module's public API unnecessarily (YAGNI).
3. Re-run `pnpm --filter control-plane test` and confirm all tests, including the two new ones, pass.
4. Do not modify `docs/plan/steps/in-review/00300-sqlite-via-node-sqlite-plus-the-migration-applier.md`
   or any other file under `docs/plan/steps/` — this gap-fill step file is the only permitted new file.
