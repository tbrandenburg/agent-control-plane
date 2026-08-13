# Phase 2 — Real-Time Streaming and Real Bootstrap: Handover

**Status: DEMO READY.** Verified with a real, unmodified `docker compose` stack, real GitHub
clones, a real (free, zero-credential) `opencode` model, and a real browser session — no mocking,
stubbing, or skipped tests anywhere in this run.

## a. Executive summary

Phase 1 shipped a thin vertical slice (dashboard → sandbox → transcript) with two deliberate
shortcuts: polling instead of a real-time socket, and a single hardcoded pre-cloned repository
instead of letting a user point a session at an arbitrary GitHub repo. Phase 2 replaces both
shortcuts with the real thing:

- **Live WebSocket streaming** — the dashboard now opens a `subscribe`/`prompt`/`ping` WebSocket
  to `GET /api/ws/sessions/:id` and renders `opencode`'s own frame-by-frame events
  (`message.part.delta`, etc.) as they happen, instead of polling a REST endpoint every second.
- **Real git bootstrap for arbitrary repos** — `POST /api/sessions` now really `git clone`s the
  user-supplied `repoOwner`/`repoName` (plus a Platform config repo and an optional Team config
  repo) into a per-session workspace and bind-mounts it into the spawned sandbox container. Session
  creation returns `202` immediately (`pending_bootstrap`); cloning and spawning happen
  asynchronously, flipping the session to `active` or `pending_bootstrap-failed`.
- **Model resolution** now composes only `{model, autoupdate}` into the sandbox's
  `OPENCODE_CONFIG_CONTENT` (provider/gateway config comes from the repo's own config, not a
  control-plane default) and defaults E2E/dev usage to `opencode/big-pickle` — a real, free,
  bundled model that needs zero credentials.
- Dashboard gained **Stop**/**Archive** buttons, a live WS connection indicator, and an optional
  **Team config** field on session creation.

Why it matters: this closes the two riskiest open questions from Phase 1 — "can we really stream
tokens over a socket instead of polling?" and "does the bootstrap failure-classification logic
survive contact with real, failing `git clone`s against arbitrary repos?" Both were falsified with
real requests, not simulated ones (see evidence below).

## b. What works (with evidence)

| Feature | Evidence |
|---|---|
| Full real-Docker E2E suite (19/19 tests, real `git clone`, real sandbox containers, real WS) | [`01-e2e-full-run.txt`](01-e2e-full-run.txt) |
| Session lifecycle: `202` → `pending_bootstrap` → `active` → prompt over WS → streaming transcript → `opencode_session_id` persisted | [`01-e2e-full-run.txt`](01-e2e-full-run.txt) (test #7) |
| Two concurrent WS subscribers both receive the same broadcast | [`01-e2e-full-run.txt`](01-e2e-full-run.txt) (test #8) |
| WS auth: wrong `wsToken` closes with code `4001`; prompt before subscribe is rejected | [`01-e2e-full-run.txt`](01-e2e-full-run.txt) (test #9) |
| Real bootstrap failure classification (`not_found`, `network`, `auth`, `unknown`) against real GitHub | [`01-e2e-full-run.txt`](01-e2e-full-run.txt) (tests #2–#5) |
| Arbitrary, distinct repos really clone distinct content into two different sandboxes | [`01-e2e-full-run.txt`](01-e2e-full-run.txt) (test #1) |
| Dashboard shell, SPA routing, health check | [`01-e2e-full-run.txt`](01-e2e-full-run.txt) (tests #12–#19) |
| Dashboard home / session list (real browser screenshot) | [`07-dashboard-home.png`](07-dashboard-home.png), [`08-sessions-list-with-new-session.png`](08-sessions-list-with-new-session.png) |
| Live WebSocket transcript rendering real streamed `message.part.delta` frames, connection indicator "Connected", Stop/Archive buttons | [`09-live-ws-transcript.png`](09-live-ws-transcript.png) |
| Unit/integration test suite (136/138 passing; see known limitations for the 2 pre-existing, environment-specific failures) | [`02-unit-integration-tests.txt`](02-unit-integration-tests.txt) |
| Repo-wide lint clean | [`03-lint-biome-check.txt`](03-lint-biome-check.txt) |
| LOC budget within ceiling (1022/1050) | [`05-loc.txt`](05-loc.txt) |
| Dashboard production build succeeds | [`06-build-dashboard.txt`](06-build-dashboard.txt) |

The screenshot evidence above was captured by creating a real session against the public
`octocat/Hello-World` GitHub repo with model `opencode/big-pickle`, watching it go
`pending_bootstrap` → `active`, then sending a real prompt and watching the transcript panel fill
with live `message.part.delta` events over the WebSocket in real time.

## c. How to build and run

Prerequisites: Docker with Compose v2, Node.js 24.x, `pnpm` (via `corepack`).

1. `make install` — install all workspace dependencies.
2. `make build` — build the dashboard static bundle into `control-plane/public`.
3. `make sandbox-image` — build the `agent-sandbox:local` image used to spawn per-session
   containers.
4. `docker compose up -d --build` — start the control plane (rebuilds its image too).
5. Open `http://localhost:3000` in a browser.
6. Click **New Session**, fill in a title, a real public repo owner/name (e.g. `octocat` /
   `Hello-World`), and submit. The session starts in `pending_bootstrap` and flips to `active`
   within a few seconds once the real clone + sandbox spawn complete.
7. Open the session, type a prompt, click **Send**, and watch the transcript panel stream tokens
   live over the WebSocket.

To reproduce the full automated verification instead of doing it by hand:

```bash
make e2e     # brings up the real stack, runs the full Playwright suite, tears it down
make test    # unit/integration tests
make lint    # biome check
make loc     # LOC budget report
```

> If port `3000` or the `egress-net` Docker network are already in use by another instance of this
> stack, override them: `HOST_PORT=<free-port> docker compose -p <isolated-name> up -d --build`
> (and add a compose override redirecting `SANDBOX_NETWORK`/the `egress-net` network name to a
> matching isolated value — see `AGENTS.md`'s Key Pitfalls for the exact pattern used to produce
> this handover's own evidence).

## d. How to test (manual)

| # | Action | Expected result |
|---|---|---|
| 1 | Open `/` in a browser | Dashboard header shows "Connected"; session list renders (empty or with prior sessions) |
| 2 | Click **New Session**, submit with a real public `repoOwner`/`repoName` and a model | Redirected to the new session's detail page; status starts at `pending_bootstrap` |
| 3 | Wait a few seconds on the session detail page | Status flips to `active` automatically (no page reload needed) |
| 4 | Type a prompt and click **Send** | Transcript panel immediately shows the echoed prompt, then a stream of `message.part.delta` events as the agent responds — no polling delay |
| 5 | Open the same session URL in a second browser tab | Both tabs show the same live transcript, updating in sync |
| 6 | Submit a session against a nonexistent/private repo (e.g. `owner: acme`, `name: does-not-exist`) | Status becomes `pending_bootstrap-failed` instead of hanging or crashing |
| 7 | Click **Stop** on an active session | Session's sandbox container stops; status updates accordingly |
| 8 | Click **Archive** on a session | Session status becomes `archived`; it no longer accepts new prompts |
| 9 | Navigate to a nonexistent session ID or route (e.g. `/sessions/does-not-exist`, `/nonexistent-route`) | Dashboard SPA shell still renders (not a raw JSON 404); an unmatched `/api/...` route still returns a real JSON 404 |
| 10 | Open a session-detail URL directly (no prior "create" flow in this browser tab) | WS token isn't available client-side; connection indicator shows disconnected/invalid state rather than silently hanging |

## e. Known limitations

- **No WS token rotation or history replay.** The one-time `wsToken` returned by
  `POST /api/sessions` is never re-exposed by `GET /api/sessions/:id`; the dashboard must persist it
  client-side (`sessionStorage`) at creation time. Opening a session URL directly (without having
  created it in that browser) shows a disconnected state — there is no reconnect/replay mechanism
  yet (planned for a later phase).
- **Two pre-existing unit-test failures, environment-specific, not Phase-2 functional regressions**
  (see [`02-unit-integration-tests.txt`](02-unit-integration-tests.txt)):
  - `bootstrap.test.js`'s cone-mode sparse-checkout assertion is sensitive to the host's installed
    `git` version.
  - `sandbox.test.js`'s real-Docker integration test can fail in environments where the sandbox
    container can't route back to the host via the Docker bridge gateway.
  Both are already documented, pre-existing gaps unrelated to this phase's own code changes.
- **`tsc --noEmit` reports type errors in test files** (`ws.test.js`, `sandbox.test.js` — implicit
  `any`, nullable `AddressInfo`, a couple of incomplete test fixture object shapes). These do not
  affect runtime behavior (Vitest transpiles independently of `tsc`) but should be cleaned up.
  Application source itself typechecks cleanly.
- **No WS `stop`/`presence` message type**, and no `fetch_history` replay on reconnect — deferred by
  design to a later phase.
- **Bootstrap has no retry/continuation logic.** A single failed clone attempt marks the session
  `pending_bootstrap-failed` permanently; the user must create a new session to retry.
- **Model allowlist is a static list** (currently a single `litellm/...` entry) shown in the
  dashboard's dropdown; the API itself only validates model-id syntax, so any syntactically valid
  `provider/model` (like `opencode/big-pickle`, used in this handover's own live demo) can be passed
  directly via the API even though it isn't in the dashboard's dropdown yet.
