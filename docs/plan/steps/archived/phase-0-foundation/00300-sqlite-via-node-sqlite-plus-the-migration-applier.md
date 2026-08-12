> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Implementation Steps

### Step 3: SQLite via `node:sqlite` plus the migration applier

#### Changes

##### Create
- `control-plane/src/db.js` — open `data/control-plane.db`, enable WAL, run migrations, export the handle.
- `control-plane/migrations/001_init.sql` — `_migrations` bookkeeping table only.
- `control-plane/src/db.test.js`.

##### Modify
- `control-plane/src/server.js` — open the DB during `buildServer()` and close it on Fastify `onClose`.

##### Remove
- Nothing.

#### Implementation

##### Database open
Use the built-in `node:sqlite` `DatabaseSync` — **not** `better-sqlite3`. This is the correction
[`ROADMAP.md`](./ROADMAP.md) Phase 0 records against [`ARCHITECTURE.md` §3/§4/"Tech stack summary"](./ARCHITECTURE.md),
which still name `better-sqlite3`; the API is near-identical and synchronous, so no call-site shape changes.
Set `journal_mode = WAL` immediately after open, per §4.

##### Migration applier
Read `migrations/*.sql` sorted by filename, compare against rows in `_migrations`, execute unapplied
files inside a transaction, then record the filename. Target ~8 lines. Schema complexity belongs in the
`.sql` files, which [`ARCHITECTURE.md` §1](./ARCHITECTURE.md) excludes from the LOC budget — exploit that
deliberately rather than expressing schema in JS.

##### Error Handling
A failing migration rolls back its transaction, logs the filename and SQLite error, and exits non-zero.
Never continue booting on a partially-applied schema.

##### Output / UX
One log line per applied migration; silence when nothing is pending.

#### Patterns & Constraints

##### Mirror
[`ARCHITECTURE.md` §4](./ARCHITECTURE.md) — raw SQL, no ORM, WAL mode, single-writer assumption.

##### Decisions
- `node:sqlite` (Release Candidate stability) closes [`ARCHITECTURE.md` §15](./ARCHITECTURE.md)'s open
  runtime question in favour of a zero-dependency, no-native-compile builtin.
- Migrations are forward-only; no `down` migrations (single host, single process).

##### Gotchas
- `node:sqlite` is still flagged as RC — a Node minor bump can shift its API surface. Pin Node via `.nvmrc`
  *and* `engines`, and re-check on any major upgrade.
- WAL creates `-wal`/`-shm` sidecar files; `.gitignore` and `.dockerignore` must cover them.

##### Out of Scope
The `sessions`, `events`, and `deliveries` tables — those land in Phase 1 as `002_sessions.sql` etc.

#### Tests

##### E2E
None yet.

##### Integration
Boot against a temp directory twice: first run applies `001_init.sql`, second run applies nothing and
leaves `_migrations` unchanged.

##### Unit
Applier ordering (`002` after `010`? no — lexicographic ordering with zero-padded prefixes) and the
rollback path on a deliberately malformed SQL fixture.

#### Validation

##### Commands
```
rm -rf /tmp/cp-test && DATA_DIR=/tmp/cp-test pnpm --filter control-plane test
```

##### Expected Results
`control-plane.db` created, `_migrations` contains exactly one row, idempotent on re-run.
