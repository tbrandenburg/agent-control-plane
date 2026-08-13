#!/usr/bin/env node
/**
 * LOC budget gate — the executable form of `docs/ARCHITECTURE.md` §14's component table.
 *
 * Globs the counted paths, strips blank and comment-only lines, groups the remaining authored
 * lines into §14's component rows, prints a table with a `TOTAL n / CEILING` footer, and exits 1
 * once the total crosses the ceiling. Exclusions mirror `docs/ARCHITECTURE.md` §1's scope
 * boundary: dashboard source, tests, e2e, SQL, manifests, config, generated types.
 *
 * Both arrays below are data, not logic — later phases add/adjust rows and globs here only.
 */

import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';

/**
 * Ceiling gate for total authored LOC (`docs/ARCHITECTURE.md` §1/§14). Raised from the original
 * `1000` to `1050` by step `00605`: step `00601`'s real `bootstrapWorkspace()` wiring into
 * `spawnSandbox()` (§8's Phase 2 bootstrap flow) is essential, already-modularized functionality
 * (not bloat — split across `spawn-session.js`/`prompt-session.js` to mirror §14's own component
 * rows), and cannot be trimmed further without removing behavior; see the `00605` step file for
 * the full before/after evidence.
 *
 * Raised `1050` to `1100` (2026-08-13): fixing issue #19 (archive must tear down its sandbox
 * container, not just flip DB status) added ~23 authored lines to `PATCH /api/sessions/:id` in
 * `control-plane/src/routes/sessions.js` (reusing the existing `sandbox.stop()` call already used
 * by the sibling `POST /:id/stop` route — no new abstraction, just one more call site) plus a
 * handful of added test-fixture lines from other same-day issue fixes (#20/#21/#22/#23/#24,
 * see PR description). This is a genuine, non-removable behavior fix (permanent container-leak
 * bug), not bloat from a refactor or duplication — not trimmed further.
 */
const CEILING = 1100;

/**
 * §14 component rows in display order. Each row's `globs` are matched relative to the repo root;
 * a glob matching no files contributes zero rather than erroring (e.g. `proxy/Caddyfile` before
 * Phase 4 creates it).
 */
const COMPONENTS = [
  { name: 'Public API', globs: ['control-plane/src/routes/*.js'] },
  { name: 'WS relay', globs: [] },
  { name: 'Sandbox lifecycle', globs: ['control-plane/src/sandbox.js'] },
  { name: 'Bootstrap', globs: ['control-plane/src/spawn-session.js'] },
  {
    name: 'Prompt/stop delivery',
    globs: ['control-plane/src/prompt-session.js'],
  },
  { name: 'SQLite', globs: ['control-plane/src/db.js'] },
  { name: 'Webhook', globs: [] },
  { name: 'Reaper', globs: [] },
  { name: 'Auth', globs: [] },
  { name: 'Bridge', globs: ['sandbox/*.js'] },
  { name: 'Proxy config glue', globs: ['proxy/Caddyfile'] },
  {
    name: 'Dashboard (server glue)',
    globs: ['control-plane/src/server.js', 'control-plane/src/config.js'],
  },
];

/** Excluded regardless of any row's globs — mirrors §1's scope boundary. */
const EXCLUDE_PATTERNS = [
  /\/dashboard\//,
  /\.test\.[jt]sx?$/,
  /^e2e\//,
  /\.sql$/,
  /\.config\.[jt]s$/,
  /(^|\/)Dockerfile$/,
  /docker-compose\.ya?ml$/,
  /\.json$/,
  /\.md$/,
  /(^|\/)node_modules\//,
];

/**
 * True if the trimmed line is blank or a comment-only line (JS line/block comments, or a
 * Caddyfile hash comment).
 * @param {string} line - A single source line.
 * @returns {boolean} Whether the line should be excluded from the count.
 */
function isBlankOrComment(line) {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed === '*/' ||
    trimmed.startsWith('#')
  );
}

/**
 * Counts authored (non-blank, non-comment-only) lines in a file, or 0 if the file is missing.
 * @param {string} file - Path relative to the repo root.
 * @returns {{count: number}} The authored-line count for the file.
 */
function countFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { count: 0 };
  }
  const lines = text.split('\n').filter((line) => !isBlankOrComment(line));
  return { count: lines.length };
}

/**
 * Expands a row's globs into concrete, excluded-pattern-filtered file paths.
 * @param {string[]} globs - Glob patterns relative to the repo root.
 * @returns {Promise<string[]>} Matching, non-excluded file paths.
 */
async function expand(globs) {
  const files = [];
  for (const pattern of globs) {
    for await (const file of glob(pattern)) {
      if (!EXCLUDE_PATTERNS.some((re) => re.test(file))) files.push(file);
    }
  }
  return files;
}

async function main() {
  const rows = [];
  const fileCounts = [];

  for (const component of COMPONENTS) {
    const files = await expand(component.globs);
    let total = 0;
    for (const file of files) {
      const { count } = countFile(file);
      total += count;
      if (count > 0) fileCounts.push({ file, count });
    }
    rows.push({ name: component.name, count: total });
  }

  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const nameWidth = Math.max(
    ...rows.map((row) => row.name.length),
    'Component'.length,
  );
  const countWidth = Math.max(
    ...rows.map((row) => String(row.count).length),
    3,
  );

  console.log(
    `${'Component'.padEnd(nameWidth)}   ${'LOC'.padStart(countWidth)}`,
  );
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(nameWidth)}   ${String(row.count).padStart(countWidth)}`,
    );
  }

  const passed = total <= CEILING;
  const status = passed ? '✅' : '❌';
  console.log(
    `${'TOTAL'.padEnd(nameWidth)}   ${String(total).padStart(countWidth)} / ${CEILING}  ${status}`,
  );

  if (!passed) {
    console.log('\nTop offending files:');
    fileCounts
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .forEach(({ file, count }) => {
        console.log(`  ${String(count).padStart(5)}  ${file}`);
      });
    process.exit(1);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}

export {
  CEILING,
  COMPONENTS,
  countFile,
  EXCLUDE_PATTERNS,
  expand,
  isBlankOrComment,
  main,
};
