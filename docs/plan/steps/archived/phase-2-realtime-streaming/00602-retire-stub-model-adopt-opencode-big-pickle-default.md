> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

`e2e/tests/session-lifecycle.spec.ts` and `docker-compose.yml` default to `opencode/big-pickle`,
resolved via `e2e/fixtures/stub-model-server.mjs` (a local OpenAI-Chat-Completions-compatible
stand-in) and `MODEL_GATEWAY_BASE_URL`/`MODEL_GATEWAY_API_KEY`. This only ever worked because Phase 1's original
`buildOpencodeConfig()` injected enough of a provider block directly for `opencode/big-pickle` to
resolve. Step `00200`'s Option C decision (closed, correct per `ARCHITECTURE.md` §8's corrected
precedence-chain analysis) removed that injection entirely — `OPENCODE_CONFIG_CONTENT` now composes
only `{model, autoupdate}` — but nothing re-ran `make e2e` against the new code until step `00600`,
four steps later. When it finally did, a real prompt against `opencode/big-pickle` failed with
`ProviderModelNotFoundError: Model not found: opencode/big-pickle` (recorded in
`docs/phase_02_findings.md` §2), since no real Platform config repo is ever cloned to supply the
a gateway provider (see step `00601`).

Step `00600` unblocked its own scope by switching `e2e/tests/session-lifecycle.spec.ts` to
`opencode/big-pickle` — a real, free, zero-credential model bundled natively with `opencode` itself
(no `auth.json` entry, no Platform-config-repo provider block, no `MODEL_GATEWAY_BASE_URL`/API key
required), confirmed live to stream a full, real turn from inside the sandbox image.

**Scope caution — do not over-fit to `opencode/big-pickle` specifically.** It is one convenient,
zero-config *E2E-fixture* option among several possible ones (a real bundled free model; a real
Platform-config-repo fixture pointed at a real/mock gateway; a locally-run OpenAI-compatible stub
paired with a *real* provider block, unlike today's broken pairing) — it says nothing about, and must
not be conflated with, this project's actual production model-selection design:

- **Custom/Platform/Team `opencode.json`/`opencode.jsonc` injection is already Phase 2's own scope**
  architecturally, not a future phase — `ARCHITECTURE.md` §8 already assigns it to precedence steps
  2/5 (Platform/Team) and 4 (the target repo's own Project config), resolved **natively by opencode
  itself**, no control-plane merge logic required. It only isn't *functionally real yet* because
  `00601` (real bootstrap wiring) hasn't landed — once it does, any repo's own `opencode.json` is
  discovered automatically, with zero new control-plane code.
- **Per-session model override currently always wins**, by design (`UI.md` §2 create-form model
  dropdown, `ARCHITECTURE.md` §5): `POST /api/sessions` requires an explicit `model`, and the
  control plane's `OPENCODE_CONFIG_CONTENT` (precedence step 6, inline) always outranks the target
  repo's own Project config (step 4) for the `model` key specifically. A "no override, defer to
  whatever the repo/Platform config declares" mode is **not planned in any current phase** — it would
  need its own explicit decision (optional `model` on session creation + `buildOpencodeConfig()`
  omitting `model` entirely when unset) if ever desired; this step does not add it.

This gap step's only job is retiring a stale, misleading E2E fixture — not making any statement about
which model/config mechanism is "the" production answer.

## Actions

1. In `docker-compose.yml`, change the `control-plane` service's default model expectations and the
   `stub-model` service's role: either (a) remove the `stub-model` service and
   `MODEL_GATEWAY_BASE_URL`/`MODEL_GATEWAY_API_KEY` defaults entirely and use a real, zero-config bundled model
   (e.g. `opencode/big-pickle`, or whichever such model is current/available at implementation time —
   treat the specific model id as a swappable fixture choice, not a pinned requirement) as the E2E
   default, or (b) keep `stub-model` only as an opt-in fixture for future tests that specifically need
   to exercise a Platform-config-repo-provided provider block (e.g. paired with step `00601`'s
   Platform-config-repo fixture, with a *correct* provider block this time). Pick whichever keeps the
   compose file simplest per root `AGENTS.md`'s KISS principle, and document the choice and rationale
   in this step's own commit/PR description.
2. Delete `e2e/fixtures/stub-model-server.mjs` if Action 1 chose removal; otherwise leave it in place
   but update its header comment to state it is no longer the default and why.
3. Grep the repo for any remaining references to `opencode/big-pickle`/`stub-model-server` outside
   what Action 1/2 intentionally keeps (e.g. stale comments in `docker-compose.yml`,
   `Makefile`, other E2E specs) and update or remove them.
4. Add a short, dated addendum section to `docs/phase_01_findings.md` (append-only, do not rewrite
   its existing evidence) stating: as of Phase 2 Step `00200`'s Option C decision, the exact
   `opencode/big-pickle` reproduction path this document describes no longer resolves standalone —
   point readers at whichever fixture Action 1 chose, or a real Platform config repo (step `00601`),
   instead. This prevents a future reader from treating stale, no-longer-reproducible evidence as
   still-current. Do not present the chosen E2E fixture model as a production design decision.
5. Re-run `make e2e` (or the isolated-stack equivalent, per this repo's own established
   `docker compose -p <name>` isolation pattern) to confirm the updated default still passes.
