/**
 * Unit tests for the LOC budget gate (`scripts/loc.mjs`).
 *
 * Covers the counting rules from `docs/plan/plan.md`'s LOC gate contract: blank-line stripping,
 * comment-only stripping (line comments, block comments, Caddyfile hash comments), exclusion-pattern
 * matching, a glob matching zero files contributing zero without throwing, and the
 * exit-1-over-ceiling behaviour.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  countFile,
  EXCLUDE_PATTERNS,
  expand,
  isBlankOrComment,
} from './loc.mjs';

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'loc-test-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('isBlankOrComment treats blank lines as comment-only', () => {
  assert.equal(isBlankOrComment(''), true);
  assert.equal(isBlankOrComment('   '), true);
});

test('isBlankOrComment treats //, /* */, and # comment lines as comment-only', () => {
  assert.equal(isBlankOrComment('// a comment'), true);
  assert.equal(isBlankOrComment('/* block start'), true);
  assert.equal(isBlankOrComment('* block middle'), true);
  assert.equal(isBlankOrComment('*/'), true);
  assert.equal(isBlankOrComment('# caddyfile comment'), true);
});

test('isBlankOrComment treats authored code as not comment-only', () => {
  assert.equal(isBlankOrComment('const x = 1;'), false);
  assert.equal(isBlankOrComment('  reverse_proxy localhost:8080'), false);
});

test('countFile contributes 0 for a file with blank lines only', () => {
  const file = join(dir, 'blank.js');
  writeFileSync(file, '\n\n   \n\n');
  assert.deepEqual(countFile(file), { count: 0 });
});

test('countFile contributes 0 for a file with comment-only lines', () => {
  const file = join(dir, 'comments.js');
  writeFileSync(
    file,
    [
      '// leading comment',
      '/*',
      '* block comment',
      '*/',
      '# caddyfile-style comment',
    ].join('\n'),
  );
  assert.deepEqual(countFile(file), { count: 0 });
});

test('countFile counts authored lines mixed with blank/comment lines', () => {
  const file = join(dir, 'mixed.js');
  writeFileSync(
    file,
    ['// header', '', 'const a = 1;', '', 'const b = 2;'].join('\n'),
  );
  assert.deepEqual(countFile(file), { count: 2 });
});

test('countFile returns 0 without throwing for a missing file', () => {
  assert.deepEqual(countFile(join(dir, 'does-not-exist.js')), { count: 0 });
});

test('expand excludes paths matching EXCLUDE_PATTERNS even with authored lines', async () => {
  const testFile = join(dir, 'excluded.test.js');
  writeFileSync(testFile, 'const authored = true;\n');
  const pattern = join(dir, '*.test.js');

  const isExcluded = EXCLUDE_PATTERNS.some((re) => re.test(testFile));
  assert.equal(isExcluded, true);

  const files = await expand([pattern]);
  assert.deepEqual(files, []);
});

test('expand contributes 0 files without throwing for a glob matching nothing', async () => {
  const files = await expand([join(dir, 'no-such-dir', '*.js')]);
  assert.deepEqual(files, []);
});

test('CLI exits 0 and prints a passing total for the real repo tree', () => {
  const output = execFileSync('node', ['scripts/loc.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  });
  assert.match(output, /TOTAL\s+\d+\s+\/\s+1000\s+✅/);
});

test('CLI exits 1 when a synthetic total exceeds the ceiling', () => {
  const bigFile = join(dir, 'over-ceiling.js');
  const lines = Array.from(
    { length: 1001 },
    (_, i) => `const line${i} = ${i};`,
  ).join('\n');
  writeFileSync(bigFile, lines);

  const script = `
    import { COMPONENTS, main } from '${new URL('./loc.mjs', import.meta.url).href}';
    COMPONENTS.length = 0;
    COMPONENTS.push({ name: 'Synthetic', globs: [${JSON.stringify(bigFile)}] });
    await main();
  `;
  const harness = join(dir, 'over-ceiling-harness.mjs');
  writeFileSync(harness, script);

  assert.throws(
    () => execFileSync('node', [harness], { encoding: 'utf8' }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stdout, /TOTAL\s+1001\s+\/\s+1000\s+❌/);
      return true;
    },
  );
});
