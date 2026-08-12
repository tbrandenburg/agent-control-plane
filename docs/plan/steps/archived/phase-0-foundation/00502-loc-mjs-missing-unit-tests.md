> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap: missing unit tests for `scripts/loc.mjs`

Found during review of `docs/plan/steps/in-review/00500-make-targets-loc-gate-and-container-manifests.md`.

### Why it matters

The step's Tests section explicitly requires:

> `loc.mjs` counting logic against fixtures: blank lines, comment-only lines, and excluded paths all
> contribute zero; a file over the ceiling triggers exit code 1.

No such test exists anywhere in the repo:

```
$ find . -path '*/node_modules' -prune -o -iname '*loc*.test.*' -print
(no output)
```

`scripts/loc.mjs` is exercised only manually via `make loc` / `pnpm run loc` against the real repo
tree, which currently passes (`TOTAL 91 / 1000 ✅`) but gives zero regression protection for the
gate's actual counting rules (blank-line stripping, comment-only stripping across `//`, `/* */`,
Caddyfile `#`, exclusion-pattern matching, missing-glob-target-is-zero, and the exit-1-over-ceiling
behaviour). A future edit to the include/exclude arrays or the `isBlankOrComment`/`countFile` logic
could silently break the gate (e.g. start counting comments, or stop failing over budget) with
nothing catching it before it reaches CI.

### Actions

1. Add `scripts/loc.test.mjs` (or `scripts/loc.test.js`, matching the existing project test
   conventions) using small fixture files (e.g. under a `scripts/__fixtures__/` or inline temp-file
   fixtures) covering:
   - a file with blank lines only contributes 0,
   - a file with comment-only lines (`//`, `/* */` block, Caddyfile `#`) contributes 0,
   - a path matching an `EXCLUDE_PATTERNS` entry contributes 0 even if it has authored lines,
   - a glob matching zero files (e.g. `proxy/Caddyfile` before it exists) contributes 0 without
     throwing,
   - a synthetic total above `CEILING` causes the process to exit with code 1.
2. Wire the new test file into whichever `test` script currently covers root-level scripts (add a
   `vitest`/`node --test` invocation and register it under `pnpm run test:all` or a dedicated
   `scripts` test target), so `make test` exercises it.
3. Run the new test suite and capture passing output as evidence before closing this gap.
