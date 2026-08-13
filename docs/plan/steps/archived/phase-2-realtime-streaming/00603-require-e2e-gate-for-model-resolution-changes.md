> Mandatory: read the overall plan in full before proceeding: docs/plan/plan.md

## Gap

Step `00200` (`opencode-config-content-composition-and-the-open-gateway-default-decision`, closed)
changed `control-plane/src/sandbox.js`'s `buildOpencodeConfig()` in a way that silently broke every
session's ability to resolve a model provider in this stack (see `docs/phase_02_findings.md` §2) —
but its own `Validation` block only required `pnpm --filter control-plane test` (unit-level). No
step re-ran `make e2e` (or any real end-to-end prompt) against the changed code until step `00600`,
four steps and several `closed` gates later. Each of those intervening steps' own validation passed
green, giving false confidence the stack still worked end-to-end when it did not.

This is a structural gap, not a one-off mistake: any future step that changes model-resolution or
config-composition logic (`OPENCODE_CONFIG_CONTENT` composition, bootstrap wiring, provider
defaults, sandbox env vars threaded into the container) can reintroduce the exact same class of
regression, silently, for as many steps as happen to follow before the phase's own final E2E step
(if any) catches it — or forever, if a phase has no such step.

## Actions

1. Add a new, clearly-titled rule to this repo's own `AGENTS.md` (not the global
   `~/.config/opencode/AGENTS.md`) — e.g. under a "Validation Conventions" section (create if none
   exists) — stating: any implementation step whose `Changes` touch model-resolution or
   config-composition logic (non-exhaustive examples: `OPENCODE_CONFIG_CONTENT` composition,
   bootstrap/clone wiring, provider defaults, `LITELLM_*`/`OPENCODE_*` env vars passed into the
   sandbox container) **must** include a real, executed end-to-end prompt check in its own
   `Validation` → `Commands` — at minimum, a single real prompt against a real, already-passing
   session scenario (e.g. `opencode/big-pickle`, per step `00602`) proving a model still resolves —
   not deferred solely to the phase's final E2E step.
2. Cross-reference this rule from `docs/ARCHITECTURE.md` §8 (the config-precedence section) and/or
   `docs/plan/plan.md`'s "Patterns & Constraints" for any phase whose scope touches model
   resolution, so future phase plans inherit the rule structurally, not just by convention.
3. Retroactively note in `docs/phase_02_findings.md` (a short addendum, not a rewrite) that this
   process gap is what let the Option C regression go undetected for 4 steps, linking to this step
   as the corrective action — evidence-first, per root `AGENTS.md`.
4. No code changes are required for this step; it is documentation/process only. Validation is
   confirming the new rule text is unambiguous and discoverable (e.g. `grep -i "model-resolution"
   AGENTS.md` finds it) and that the cross-references in Action 2 resolve correctly.
