import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = /** @type {typeof import('node:fs')} */ (
    await importOriginal()
  );
  return { ...actual, readdirSync: vi.fn(), readFileSync: vi.fn() };
});

const fs = await import('node:fs');
const { openDb } = await import('./db.js');

/** @type {string} */
let dataDir;

beforeEach(() => {
  vi.mocked(fs.readdirSync).mockReset();
  vi.mocked(fs.readFileSync).mockReset();
});

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const INIT_SQL = `CREATE TABLE _migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;

describe('applyMigrations ordering', () => {
  it('applies migrations in ascending lexicographic filename order', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-db-order-test-'));

    // Directory listing intentionally returned out of order to prove `.sort()`
    // (not readdir insertion order) determines application order.
    vi.mocked(fs.readdirSync).mockReturnValue(
      /** @type {any} */ (['010_second.sql', '002_first.sql']),
    );
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (String(path).endsWith('002_first.sql')) {
        return `${INIT_SQL}\nCREATE TABLE t_first (id INTEGER);`;
      }
      if (String(path).endsWith('010_second.sql')) {
        return 'CREATE TABLE t_second (id INTEGER);';
      }
      throw new Error(`unexpected readFileSync path: ${path}`);
    });

    const db = openDb(dataDir);
    const rows = db.prepare('SELECT filename FROM _migrations').all();
    db.close();

    expect(rows).toEqual([
      { filename: '002_first.sql' },
      { filename: '010_second.sql' },
    ]);
  });
});

describe('applyMigrations rollback on failure', () => {
  it('rolls back, logs the filename, and exits non-zero on malformed SQL', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-db-rollback-test-'));

    vi.mocked(fs.readdirSync).mockReturnValue(
      /** @type {any} */ (['001_init.sql', '002_bad.sql']),
    );
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (String(path).endsWith('001_init.sql')) return INIT_SQL;
      if (String(path).endsWith('002_bad.sql')) {
        return 'CREATE TABLE ((( this is not valid sql;';
      }
      throw new Error(`unexpected readFileSync path: ${path}`);
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => /** @type {never} */ (undefined));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const db = openDb(dataDir);
    const rows = db.prepare('SELECT filename FROM _migrations').all();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => /** @type {{ name: string }} */ (row).name);
    db.close();

    expect(rows).toEqual([{ filename: '001_init.sql' }]);
    expect(tables).not.toContain('this');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('002_bad.sql'),
      expect.any(String),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
