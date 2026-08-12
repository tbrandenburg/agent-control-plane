☰ Menu

ai-coding-agents

User guide

# ai-coding-agents

A control plane for running non-interactive, background coding agents in isolated Kubernetes sandboxes. Each sandbox runs <a href="https://github.com/sst/opencode" target="_blank" rel="noopener">opencode</a>, an open-source AI coding CLI, against a cloned repo — with credentials injected transparently by a sidecar proxy so the sandbox itself never holds a secret.

### How a session flows

ClientHTTP / WebSocket

→

Control planeFastify + PostgreSQL

→

Sandbox managerbuilds the K8s Job

→

K8s pod

iptables-initforces egress through proxy

sandbox-proxyinjects credentials

sandboxPython supervisor + opencode CLI

The sandbox's bridge process polls the control plane for queued prompts, forwards them to `opencode`, and streams the resulting events back over WebSocket to any connected client in real time — the dashboard, your own script, or a GitHub comment trigger.

This page covers **using** the service (creating sessions, sending prompts, the GitHub comment trigger) and **how agent behavior is configured** via the layered `opencode` config system. For deployment/operations (Helm chart, Terraform, security model internals), see the repo's `README.md`.

## Quickstart

### Authenticating

Requests to `/api/*` are authorized either by a browser session cookie (dashboard login) or, for scripts and services, an OIDC `client_credentials` bearer token from a client ID listed in `OIDC_SERVICE_CLIENT_IDS` on the control plane. There is no separate static API key.

    curl -s https://<control-plane-host>/oauth2/token \
      -d grant_type=client_credentials \
      -d client_id=$OIDC_CLIENT_ID \
      -d client_secret=$OIDC_CLIENT_SECRET \
      | jq -r .access_token

### Create a session

A session targets one repo and one model. `title`, `repoOwner`, `repoName`, and `model` are required. All session/prompt endpoints live under the `/api` prefix.

    curl -s -X POST https://<control-plane-host>/api/sessions \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{
        "title": "Fix flaky retry test",
        "repoOwner": "eBike",
        "repoName": "digitx-payments-service",
        "model": "litellm/eu.anthropic.claude-sonnet-4-6"
      }'

| Field                    | Required | Notes                                                                                                                           |
|--------------------------|----------|---------------------------------------------------------------------------------------------------------------------------------|
| `title`                  | yes      | Display name for the session.                                                                                                   |
| `repoOwner` / `repoName` | yes      | Target repo the sandbox clones.                                                                                                 |
| `model`                  | yes      | Must be `provider/model` — e.g. `litellm/eu.anthropic.claude-sonnet-4-6`. See [API reference](#api) for the valid-IDs endpoint. |
| `reasoningEffort`        | no       | `low` · `medium` · `high` · `max`                                                                                               |
| `additionalRepos`        | no       | Array of `{owner, name}`. Mutually exclusive with `readOrgRepos`.                                                               |
| `readOrgRepos`           | no       | Boolean, defaults to `true`. Grants read access across the org.                                                                 |
| `teamConfigRepo`         | no       | Overrides the auto-derived team config repo — see [OpenCode config layering](#opencode-config).                                 |

The response is `201` with the created session plus a `wsToken` — hold onto it, it's what authorizes the WebSocket connection described below.

## Using the dashboard

The dashboard SPA is served by the control plane at `/` and needs no separate setup.

| Route           | What it does                                                                                                                |
|-----------------|-----------------------------------------------------------------------------------------------------------------------------|
| `/`             | Session list.                                                                                                               |
| `/sessions/new` | Create-session form — the UI equivalent of `POST /api/sessions`.                                                            |
| `/sessions/:id` | Session detail. Opens the session's WebSocket live and lets you send prompts interactively while watching events stream in. |

For a quick, ad-hoc session this is the easiest path — no token handling or curl required. The API and the dashboard are just two clients of the same session/WebSocket protocol below.

## API reference

Everything below lives under the `/api` prefix (e.g. `/api/sessions`) — the only exception is the GitHub webhook, which is unprefixed (see [GitHub comment trigger](#webhook)).

### Sessions

| Endpoint                                    | Description                                                                                                                                                                           |
|---------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| POST `/api/sessions`                        | Create a session and spawn a sandbox.                                                                                                                                                 |
| GET `/api/sessions`                         | List sessions. Query: `limit` (default 20, max 100), `offset`, `status` (`active`\|`archived`).                                                                                       |
| GET `/api/sessions/:id`                     | Session + live sandbox state (pod status, k8s phase, failure info) + a `continuation` object (see [Session continuation](#continuation)). Also rotates and returns a fresh `wsToken`. |
| PATCH `/api/sessions/:id`                   | Body `{ status }`.                                                                                                                                                                    |
| POST `/api/sessions/:id/stop`               | Stop the session. Prefer the WebSocket `stop` message (below) — it durably queues a stop command for the active attempt.                                                              |
| GET `/api/sessions/:id/sandbox/diagnostics` | Pod-level diagnostics for a stuck or failed sandbox.                                                                                                                                  |
| GET `/api/sessions/:id/sandbox/logs`        | Query: `container` (`sandbox`\|`proxy`\|`iptables-init`), `tail` (up to 500).                                                                                                         |
| GET `/api/models`                           | → `{ models: [{ id, name }] }` — the exact, already-provider-qualified `model` strings you can pass elsewhere.                                                                        |

### Prompts, events, artifacts

| Endpoint                          | Description                                                                                            |
|-----------------------------------|--------------------------------------------------------------------------------------------------------|
| POST `/api/sessions/:id/prompt`   | Send a prompt over REST. Body `{ content, model?, reasoningEffort? }` → `201 { messageId, position }`. |
| GET `/api/sessions/:id/events`    | Query `limit`, `cursor` (format `timestamp,id`) → `{ events, hasMore }`.                               |
| GET `/api/sessions/:id/artifacts` | → `{ artifacts }`.                                                                                     |

Sending a prompt over REST vs. WebSocket has the same effect — pick whichever fits your client. For live streaming of agent output, you need the WebSocket connection either way.

**Model format:** any `model` field — on `POST /api/sessions`, `POST /api/sessions/:id/prompt`, or the WebSocket `prompt` message — must be `provider/model` (e.g. `litellm/eu.anthropic.claude-sonnet-4-6`). A bare model ID with no `/` is rejected with `400 INVALID_MODEL_REFERENCE`. Only the first `/` is a separator, so `openrouter/anthropic/claude-sonnet-4.5` is valid too (`providerID: "openrouter"`, `modelID: "anthropic/claude-sonnet-4.5"`). Fetch `GET /api/models` for ready-to-use values.

## WebSocket protocol

Connect to `GET /api/ws/sessions/:sessionId` (upgrade request, gated by the same cookie/token auth as the REST API). After the upgrade, you have a short window (`WS_AUTH_TIMEOUT_MS`) to send a `subscribe` message containing the session's `wsToken` — otherwise the socket closes with code `4001`.

    // 1. after upgrade, authenticate the socket
    { "type": "subscribe", "token": "<wsToken from POST /api/sessions or GET /api/sessions/:id>" }

    // server replies:
    { "type": "subscribed" }
    // ...replays recent events...
    { "type": "replay_complete" }

    // 2. send a prompt
    { "type": "prompt", "content": "Add a retry test for the payments client" }

    // server broadcasts:
    { "type": "prompt_queued", "messageId": "...", "sessionId": "...", "position": 0 }

| Client → server type | Purpose                                                                                                                                         |
|----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| `subscribe`          | Authenticate the socket with `wsToken`. Required first message.                                                                                 |
| `prompt`             | Send a prompt: `{ content, model?, reasoningEffort? }`. `model`, if given, must be `provider/model` — see the callout in [API reference](#api). |
| `ping`               | Keepalive.                                                                                                                                      |
| `presence`           | Report client presence (e.g. "viewing").                                                                                                        |
| `fetch_history`      | Request additional past events beyond the initial replay.                                                                                       |
| `stop`               | Durably queue a stop command for the active attempt.                                                                                            |

If the session's workspace needs continuing (its last sandbox attempt is gone), the `prompt_queued` broadcast carries a `predecessorSessionId` and you'll also receive a `session_continued` message — see [Session continuation](#continuation).

**Token expiry:** if your socket closes with code `4001`, the `wsToken` was missing, wrong, or stale — call `GET /api/sessions/:id` again to get a fresh one and reconnect.

## Session continuation

A session's workspace (cloned repo + OpenCode conversation state) is retained on a PVC for **7 days** of inactivity, sliding forward on every accepted prompt. If you send a prompt to a session whose sandbox has since exited, the control plane doesn't just fail — it spawns a fresh attempt that reattaches the retained workspace and continues the exact same underlying OpenCode conversation. This happens automatically; there's no separate "resume" call.

**Sandboxes exit on their own.** The watchdog shuts a sandbox down about **15 minutes** after the agent finishes responding and nothing else is queued, rather than leaving the pod running for the full Job timeout. That's the normal, expected way a sandbox "exits" between prompts — send another prompt any time within the 7-day retention window and it continues seamlessly as described below.

Old sessionsandbox exited

→

Send a promptREST or WS

→

New attempt spawnedsame PVC, same OpenCode session

→

Successor sessionnew session id

### Tracking it via the API

`GET /api/sessions/:id` includes a `continuation` object on every session:

    {
      "continuation": {
        "status": "available",          // provisioning | available | attached | expired | missing | corrupt | unavailable
        "expiresAt": "2026-08-05T12:00:00.000Z",
        "canResume": true,
        "isResuming": false,
        "currentAttempt": 1,
        "predecessorSessionId": null,   // set if THIS session continues an older one
        "successorSessionId": null,     // set once THIS session has been continued forward
        "continuationReason": null      // workspace_expired | workspace_missing | workspace_corrupt | workspace_origin_mismatch
      }
    }

If you're holding onto a session id and it stops responding, poll `GET /api/sessions/:id` — once `successorSessionId` is set, switch to that id for further prompts and events.

### Tracking it over WebSocket

When a prompt triggers continuation, both the **new** session's subscribers and the **old (predecessor)** session's subscribers receive a `session_continued` message — so a client still watching the old tab gets redirected without polling:

    {
      "type": "session_continued",
      "sessionId": "<new/successor session id>",
      "predecessorSessionId": "<the session id you were on>",
      "reason": "expired"   // expired | missing | corrupt | origin_mismatch
    }

### In the dashboard

`/sessions/:id` shows a continuation status banner (workspace state, or "Resuming attempt N" while a fresh attempt boots) with **Previous session** / **Continued session** links whenever a predecessor or successor exists.

Only one attempt (`pending`, `starting`, or `running`) is ever active per session — concurrent prompts during a resume are queued, not raced. Continuation never re-clones, checks out, or resets the repo; it only fetches metadata and reattaches the existing working tree.

## Triggering a session from a GitHub comment

Sessions can also be triggered by @mentioning the bot in an issue or PR comment — no API call needed. This is driven by a GitHub webhook wired to the control plane.

### 1. Enable the public webhook ingress in production

Set `webhookIngress.enabled=true` in the production Helm values. This exposes only the GitHub webhook route and keeps the existing GitHub App payload URL unchanged.

### 2. Configure the webhook

|              |                                                                                                   |
|--------------|---------------------------------------------------------------------------------------------------|
| Payload URL  | `https://<control-plane-host>/webhooks/github`                                                    |
| Content type | `application/json` — required. `application/x-www-form-urlencoded` breaks signature verification. |
| Secret       | Must match `GITHUB_WEBHOOK_SECRET` on the control plane.                                          |
| Events       | Subscribe to **Issue comments** only (`issue_comment`).                                           |

The endpoint returns `404` until `GITHUB_WEBHOOK_SECRET` is set on the control plane — that's the fastest way to check whether the trigger is enabled at all.

### 3. Comment to trigger a session

Any comment that contains `@<GITHUB_APP_BOT_USERNAME>` (case-insensitive, anywhere in the text) from a **trusted** commenter starts a session. What prompt the agent receives depends on whether the comment is on a pull request and whether there's any text besides the mention.

#### Mention-only comment on a pull request

If the comment is *just* the mention (ignoring surrounding whitespace) and it's on a pull request, the sandbox is given a fixed PR-review prompt instead of an empty one:

    @digitx-agent-bot

becomes the prompt:

    Please review this GitHub pull request and post your review comments. 
    You can reach GitHub Enterprise Server without authentication header. It will be added automatically by the authentication proxy.
    You can find the full repository code in the /workspace/repo directory.
    Use pull request review skill(s) if available
    PR title: <PR title>
    PR description: <PR description>
    PR url: <PR html url>
    PR dif url: <PR diff url>

The title, description, and URLs are read directly off the webhook payload (`issue.title`, `issue.body`, `issue.pull_request.html_url`, `issue.pull_request.diff_url`) — no extra GitHub API call is made to build this prompt.

#### Any other case

A comment with extra text after the mention (on an issue or a pull request), or a mention-only comment on a plain issue, strips the mention and uses the remaining text as the prompt verbatim:

    @digitx-agent-bot can you add a retry test for the flaky payments client call?

becomes the prompt:

    Issue #482 (Payments client intermittently times out): can you add a retry test for the flaky payments client call?

### 4. Who's trusted

The commenter's GitHub `author_association` on the repo must be one of:

- `OWNER`
- `MEMBER`
- `COLLABORATOR`

Comments from anyone else (e.g. `CONTRIBUTOR`, `NONE`) are ignored.

### 5. Which branch it runs against

Comment on a **pull request** → the sandbox checks out that PR's head branch. Comment on a plain **issue** → the sandbox uses the repo's default branch.

### 6. The agent replies on the triggering issue/PR

The sandbox has a `create-issue-comment` tool (mirroring `create-pull-request`'s GHES/github.com API handling) that the agent uses to post its result back as a comment on the issue or PR that triggered the run, before finishing. This is agent-driven, not a guaranteed webhook-infra behavior — if the run fails before the agent gets that far, no comment is posted.

### 7. What happens on failure

The webhook endpoint itself never posts a reply comment to GitHub — check the control plane's session list or logs to see whether a trigger fired.

| Situation                                                                  | Response                        |
|----------------------------------------------------------------------------|---------------------------------|
| Invalid signature                                                          | `401`                           |
| Missing delivery ID header                                                 | `400`                           |
| Untrusted association, wrong event type, no bot mention, malformed payload | `200 { status: "ignored" }`     |
| Duplicate delivery ID (retried webhook)                                    | `200 { status: "duplicate" }`   |
| Parse or session-spawn error                                               | `500`, delivery marked `failed` |

### Required environment variables

| Variable                   | Required | Notes                                                                                                   |
|----------------------------|----------|---------------------------------------------------------------------------------------------------------|
| `GITHUB_WEBHOOK_SECRET`    | yes      | Enables the endpoint; also used to verify the `x-hub-signature-256` header.                             |
| `GITHUB_APP_BOT_USERNAME`  | yes      | No `@` prefix — just the username, e.g. `digitx-agent-bot`.                                             |
| `GITHUB_WEBHOOK_BOT_EMAIL` | no       | Defaults to `agent-bot@ai-coding-inspect.dev`. Used as the git identity for webhook-triggered sessions. |
| `WEBHOOK_DEFAULT_MODEL`    | no       | Defaults to the dashboard's default model if unset.                                                     |

## OpenCode config layering

Every sandbox runs `opencode` against a config assembled from three layers, resolved in this order (later layers win on conflicts):

Platform → opencode "Global" slot

One org-wide repo (`PLATFORM_CONFIG_REPO`), sparse-cloned wholesale into `~/.config/opencode/`. Required — a session fails to spawn if this repo is unreachable.

↓ overridden by

Team → OPENCODE_CONFIG_DIR

Convention: `<repoOwner>/<team>-team-config`, where `team` is the first `-`-segment of the repo name (e.g. `digitx-payments-service` → `eBike/digitx-team-config`). Only its `.opencode/` subtree is checked out. Optional — silently skipped if the repo doesn't exist. Override the derived name with `teamConfigRepo` on `POST /api/sessions`.

↓ overridden by

Repo → opencode.json + .opencode/

The target repo's own `opencode.json` and `.opencode/` directory, discovered natively by opencode after cloning. Highest layer a team or contributor controls directly.

A fourth, non-negotiable layer sits above all of these: `OPENCODE_CONFIG_CONTENT`, set by the sandbox manager at spawn time with the model, LiteLLM connection details, and `autoupdate: false`. No platform, team, or repo config can override it.

### What a layer can contain

- `opencode.json` — model, agents, MCP servers, permissions, instructions, etc.
- `skills/<name>/SKILL.md` — reusable agent skills
- `agents/<name>.md` — custom agent definitions
- `commands/<name>.md` — custom slash commands
- `tools/<name>.js` — custom tools exposed to the agent
- `plugins/` — opencode plugins

Two built-in tools — `create-pull-request` and `create-issue-comment` — are always available in every sandbox. They're installed from the sandbox image into the Platform layer's `tools/` directory at startup, alongside (not instead of) whatever the platform config repo itself provides — a same-named `tools/` entry in that repo would be overridden. Unlike the provider catalog, tool discovery from this layer keeps working even when a session has a team config directory with no `tools/` of its own.

### Merge rules

- Deep merge; scalar values are overwritten by the higher layer.
- Arrays are **replaced**, not concatenated — e.g. a team's `instructions` list fully replaces the platform's, so re-include anything you still want.
- `mcp.<name>` entries merge by key — a team can add MCP servers without dropping platform ones.
- Skills are additive across all three layers. On a name collision: **repo \> team \> platform**. Platform skills are conventionally prefixed `platform-` to avoid collisions.

### Reference example

The platform config repo for this org is <a href="https://github.boschdevcloud.com/eBike/ai-opencode-ext" target="_blank" rel="noopener"><code>eBike/ai-opencode-ext</code></a> — browse it for a real example of the directory layout above. There's no local team-config template in this repo yet; teams creating `<org>/<team>-team-config` should follow the same `.opencode/` layout.

### Failure modes

| Scenario                                          | Behavior                                                                                                                                                                                                                                                                                    |
|---------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Platform config repo missing or unreachable       | Hard failure — session does not spawn.                                                                                                                                                                                                                                                      |
| Team config repo doesn't exist                    | Team layer silently skipped; session proceeds with platform + repo config.                                                                                                                                                                                                                  |
| Team config repo unreachable (network/auth error) | Hard failure — not silently ignored.                                                                                                                                                                                                                                                        |
| Team `.opencode/` directory absent                | `OPENCODE_CONFIG_DIR` is left unset entirely — setting it at all, even to an empty directory, breaks opencode's model/provider catalog. (Tool discovery from the Platform layer isn't affected by this, which is why `create-pull-request`/`create-issue-comment` keep working either way.) |
| Malformed `opencode.json` at any layer            | opencode ignores the unparseable file; session proceeds.                                                                                                                                                                                                                                    |

Sessions are reproducible: the control plane resolves and pins the exact platform/team config SHAs at spawn time, so two sessions launched simultaneously get identical config even if someone pushes to a config repo in between. A config change only affects the *next* session, never one already running.

## Environment variables

The variables most relevant to integrators and team leads (not internal deployment plumbing):

| Variable                                                | Scope                        | Notes                                                                                                                                                                                                                            |
|---------------------------------------------------------|------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `OIDC_SERVICE_CLIENT_IDS`                               | Auth                         | Comma-separated client IDs allowed to use OIDC service-token auth for the API.                                                                                                                                                   |
| `OPENCODE_MODEL`                                        | Config                       | Default model injected into sandbox config. Defaults to `eu.anthropic.claude-sonnet-4-6` — note this one is the bare LiteLLM model ID, not `provider/model`; the sandbox template wraps it as `litellm/<OPENCODE_MODEL>` itself. |
| `GITHUB_WEBHOOK_SECRET`                                 | Webhook                      | See [GitHub comment trigger](#webhook).                                                                                                                                                                                          |
| `GITHUB_APP_BOT_USERNAME`                               | Webhook                      | See [GitHub comment trigger](#webhook).                                                                                                                                                                                          |
| `GITHUB_WEBHOOK_BOT_EMAIL`                              | Webhook                      | See [GitHub comment trigger](#webhook).                                                                                                                                                                                          |
| `WEBHOOK_DEFAULT_MODEL`                                 | Webhook                      | See [GitHub comment trigger](#webhook).                                                                                                                                                                                          |
| `PLATFORM_CONFIG_REPO` / `PLATFORM_CONFIG_GITHUB_TOKEN` | Config (platform-admin only) | Currently set to `eBike/ai-opencode-ext` for this org.                                                                                                                                                                           |

## Tech stack

This section documents the underlying implementation stack behind the behavior described above — split
into what the original developer has explicitly **confirmed**, and what has only been **reverse-engineered
or inferred** from behavior, screenshots, and public `opencode`/library documentation. Treat the second
table as provisional; it exists to make assumptions visible, not to assert fact.

### Confirmed by the original developer

| Component | Technology | Task |
|---|---|---|
| Control plane runtime | Fastify (Node.js) | REST API (`/api/*`), WebSocket upgrade/relay, session and auth orchestration |
| Control plane database | PostgreSQL + Drizzle ORM | Durable session rows, continuation lineage (`predecessor`/`successor`), queue/message/event data |
| Session id / message mirror | `opencode_session_id` / `opencodeSessionId` column, full event mirror | Lets the dashboard show session/message history independent of a live sandbox |
| `ws_token` storage | Hashed (`ws_token_hash`), never plaintext | Rotation state compared by hash, not by stored raw token |
| Service-client auth | External OIDC provider, `client_credentials` grant, **token introspection** (RFC 7662) | Control plane is an OIDC *client*, not an issuer; validates bearer tokens via introspection, not local JWKS verification; trusted client IDs allowlisted via `OIDC_SERVICE_CLIENT_IDS` |
| Dashboard auth | `openid-client` (Authorization Code + PKCE) + `@fastify/secure-session` | Browser login against the same external IdP; encrypted session state stored in the cookie |
| Orchestration | Kubernetes (one Job per sandbox attempt/session) | Pod lifecycle, phase/status reporting, isolation boundary |
| Sandbox isolation | `iptables-init` container + custom TLS-terminating HTTP forward proxy | Forces sandbox egress through the proxy; proxy MITMs allowed HTTPS `CONNECT` traffic and injects route-specific headers (**not** a declarative reverse proxy like Caddy/nginx) |
| Sandbox supervisor | Python | Starts and controls a local `opencode serve` process; forwards prompts; relays events back to the control plane over HTTP (control plane then persists + broadcasts to the dashboard over WebSocket) |
| Coding agent runtime | `opencode serve` (HTTP + SSE) | Model invocation, tool execution, durable local conversation state |
| Model gateway | LiteLLM | `litellm/<model>` routing; credential injection happens at the proxy, not in the sandbox |
| Model listing | Static, hand-curated two-model catalog (config-baked, UI-facing) | Populates the model dropdown only — **server-side validation checks `provider/model` syntax only, not catalog membership** |
| Config layering | `opencode`'s native config-precedence resolution, **plus** supervisor-composed directory trees | Supervisor explicitly assembles platform/team config trees and env vars onto the right paths, and overwrites the project's model selection at runtime — not purely "opencode resolves everything itself" |
| Persistent workspace | Kubernetes PVC, retained via **expiry/reaper management** (not Job ownership/Job TTL) | Must outlive the originating Job for continuation to work — reaper-driven retention, not native K8s garbage collection |
| GitHub integration | GitHub App, `issue_comment` webhook validation, built-in `create-pull-request`/`create-issue-comment` tools | Session triggering via @mention; agent-driven reply posting |
| GitHub host | Configurable via `GITHUB_URL` (code-level, supports both `github.com` and GHES) | Which host is targeted is a **deployment constraint, not a code constraint** |
| Agent/harness abstraction | Design-only seam, not implemented | Current production runtime is OpenCode-specific; any multi-harness adapter exists only as planning material |
| Dashboard | React + Vite + Tailwind | Production-served by the control plane at `/` |

### Reverse-engineered / inferred (not directly confirmed)

| Component | Technology (assumed) | Basis for the assumption |
|---|---|---|
| Kubernetes manifests | Helm chart, Job spec, exact resource limits | Only implied by the doc's mention of "Helm chart" for deployment — no manifest details available |
| `reasoningEffort` wiring | Maps to `opencode`'s own model-"variant" mechanism (`model.variant` on `prompt_async`) | Derived from `opencode`'s public source (Context7), not confirmed against this specific production integration |
| Webhook-spawned session title | `#<issue/PR number>: <issue/PR title>` | Inferred from one dashboard screenshot's session header, not stated in writing anywhere |
| Container log aggregation | OpenSearch | Inferred from the dashboard's "Open full logs in OpenSearch" link label — the underlying log stack was never named explicitly |
| Config-tree composition mechanics | Sparse checkout + SHA-pinned clones per layer | Consistent with the "OpenCode config layering" chapter's described directory conventions, but the supervisor's exact clone/mount implementation was never detailed |
| GHES support completeness | Full `/api/v3`-style path handling for self-hosted GHES | Confirmed only that `GITHUB_URL` toggles the target; whether every GitHub REST call path is GHES-aware end-to-end wasn't verified |
| Token introspection caching | Unknown — possibly per-request, possibly cached | Dev confirmed introspection is used for verification; caching behavior (if any) was never specified |



### My @mention comment didn't trigger a session

- Check the webhook is enabled — `GITHUB_WEBHOOK_SECRET` must be set (a `404` on the webhook URL means it isn't).
- Confirm you used the exact `GITHUB_APP_BOT_USERNAME` value with an `@` in front, e.g. `@digitx-agent-bot`.
- Confirm your GitHub `author_association` on the repo is `OWNER`, `MEMBER`, or `COLLABORATOR`.
- Make sure you commented (not just opened the PR/issue) — only `issue_comment` events are handled.

### My WebSocket closed with code 4001

Your `wsToken` was missing, incorrect, or expired before you sent `subscribe`. Call `GET /api/sessions/:id` to get a fresh token and reconnect.

### My request was rejected with `INVALID_MODEL_REFERENCE`

The `model` field must be `provider/model`, not a bare model ID — e.g. `litellm/eu.anthropic.claude-sonnet-4-6`, not `eu.anthropic.claude-sonnet-4-6`. Fetch `GET /api/models` for exact valid values.

### I sent a prompt and got a different session id back

Your session's workspace had already been continued into a successor — the response's `session_continued` message (WS) or `continuation.successorSessionId` (REST) points at it. Switch to that id. See [Session continuation](#continuation).

### My `teamConfigRepo` override isn't picking up config

If the override points at a repo in a different GitHub org than the target repo, the session's read token needs to cover that org too (via `readOrgRepos` or `additionalRepos`). Otherwise the sparse checkout silently has nothing to fetch and the team layer is skipped.

### My team's `instructions` seem to have disappeared

Arrays don't merge across config layers — they're replaced. If your team's `opencode.json` sets its own `instructions`, it fully overrides the platform's list. Re-include anything from the platform layer you still want.

Generated for the `ai-coding-agents` repo. For architecture, security model, and deployment details, see `README.md` in the repo root.
