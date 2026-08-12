import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from './db.js';

/** @type {string} */
let dataDir;
/** @type {string} */
let migrationsDir;

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (migrationsDir) rmSync(migrationsDir, { recursive: true, force: true });
});

describe('openDb', () => {
  it('creates the database and applies 001_init.sql', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-db-test-'));

    const db = openDb(dataDir);
    const rows = db.prepare('SELECT filename FROM _migrations').all();
    db.close();

    expect(rows).toEqual([{ filename: '001_init.sql' }]);
  });

  it('is idempotent on re-run', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-db-test-'));

    const first = openDb(dataDir);
    first.close();
    const second = openDb(dataDir);
    const rows = second.prepare('SELECT filename FROM _migrations').all();
    second.close();

    expect(rows).toEqual([{ filename: '001_init.sql' }]);
  });

  it('applies migrations in ascending lexicographic filename order, not creation order', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-db-test-'));
    migrationsDir = mkdtempSync(join(tmpdir(), 'cp-migrations-test-'));

    // Write the higher-numbered file first so naive creation-order iteration would misorder it.
    writeFileSync(
      join(migrationsDir, '010_b.sql'),
      'CREATE TABLE b (id INTEGER PRIMARY KEY);',
    );
    writeFileSync(
      join(migrationsDir, '002_a.sql'),
      `CREATE TABLE _migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE a (id INTEGER PRIMARY KEY);`,
    );

    const db = openDb(dataDir, migrationsDir);
    const rows = db.prepare('SELECT filename FROM _migrations').all();
    db.close();

    expect(rows).toEqual([
      { filename: '002_a.sql' },
      { filename: '010_b.sql' },
    ]);
  });

  it('rolls back the transaction, logs the filename, and exits on a failing migration', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-db-test-'));
    migrationsDir = mkdtempSync(join(tmpdir(), 'cp-migrations-test-'));

    writeFileSync(
      join(migrationsDir, '001_bad.sql'),
      'CREATE TABLE ok (id INTEGER PRIMARY KEY); THIS IS NOT VALID SQL;',
    );

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let db;
    try {
      expect(() => {
        db = openDb(dataDir, migrationsDir);
      }).toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('001_bad.sql'),
        expect.anything(),
      );
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }

    // Confirm no partial schema objects from the failing file persisted (transaction
    // rolled back) by inspecting the same database file directly.
    const verifyDb = new DatabaseSync(join(dataDir, 'control-plane.db'));
    const tables = verifyDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ok'",
      )
      .all();
    verifyDb.close();
    expect(tables).toEqual([]);
  });
});
