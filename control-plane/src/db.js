/**
 * SQLite access for the control plane. Opens `<dataDir>/control-plane.db` via the built-in
 * `node:sqlite` (`DatabaseSync` — not `better-sqlite3`, see ARCHITECTURE.md §15), enables WAL,
 * and applies any pending `migrations/*.sql` files before returning the handle.
 */

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const defaultMigrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/**
 * Applies every `migrations/*.sql` file not yet recorded in `_migrations`, in filename order,
 * each inside its own transaction. Exits the process on the first failing migration.
 * @param {import('node:sqlite').DatabaseSync} db - Open database handle.
 * @param {string} [migrationsDir] - Directory containing `.sql` migration files.
 * @returns {void}
 */
export function applyMigrations(db, migrationsDir = defaultMigrationsDir) {
  let applied;
  try {
    applied = new Set(
      db
        .prepare('SELECT filename FROM _migrations')
        .all()
        .map((row) => /** @type {{ filename: string }} */ (row).filename),
    );
  } catch {
    applied = new Set();
  }
  const pending = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !applied.has(f))
    .sort();

  for (const file of pending) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      db.exec('COMMIT');
      console.log(`Applied migration: ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(
        `Migration failed: ${file}:`,
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    }
  }
}

/**
 * Opens the control-plane SQLite database in WAL mode and applies pending migrations.
 * @param {string} dataDir - Directory holding `control-plane.db` (created if missing).
 * @param {string} [migrationsDir] - Directory containing `.sql` migration files.
 * @returns {import('node:sqlite').DatabaseSync} The open, migrated database handle.
 */
export function openDb(dataDir, migrationsDir = defaultMigrationsDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'control-plane.db'));
  db.exec('PRAGMA journal_mode = WAL');
  applyMigrations(db, migrationsDir);
  return db;
}
