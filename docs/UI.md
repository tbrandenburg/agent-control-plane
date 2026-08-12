# Dashboard UI — Screens & Wireframes

This is the **companion spec to [`ARCHITECTURE.md`](./ARCHITECTURE.md)** for the dashboard SPA
described in that document's §5 ("Dashboard") and §11 ("Dashboard login"). It exists so the UI's scope
never silently drifts from what the backend actually implements — every panel below is annotated with
the exact endpoint/section that backs it, and anything not yet built is called out explicitly rather
than implied by the wireframe.

Source material: `docs/Dashboard_Wireframes.png` (design proposal) and
`docs/Dashboard_PR_Review_Session_Deep_Dive.png` (a real production screenshot used to validate several
of these decisions — see `ARCHITECTURE.md` §13/§14's diagnostics and presence corrections).

## Design goals

- Minimal, focused, real-time — everything you need on one screen.
- No functionality implied that the backend doesn't actually provide (see call-outs below).
- Exactly the three routes ARCHITECTURE.md §5 declares — no hidden extra screens.

## Routes

```text
/
└── Session list
      ├── New Session       (or a modal from /, either works)
      └── Open session
            │
            ▼
/sessions/:id
├── Conversation / Events tabs
├── Prompt composer
├── Overview            (session metadata)
├── Participants         ← WS `presence` broadcast (ARCHITECTURE.md §6)
├── Artifacts            ← GET /api/sessions/:id/artifacts (§5)
├── Diagnostics          ← GET /api/sessions/:id/sandbox/diagnostics (§5)
└── Logs                 ← GET /api/sessions/:id/sandbox/logs (§5)
```

No routes beyond these three (`/`, `/sessions/new`, `/sessions/:id`) — matching ARCHITECTURE.md §5's
explicit endpoint table. Everything else is a panel *within* `/sessions/:id`, not a separate route.

---

## 1. Session list — `/`

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Agent Control Plane                                      ● Connected   [JD] │
├──────────────────────────────────────────────────────────────────────────────┤
│ Sessions                                              [+ New Session]        │
│                                                                              │
│ [ Search sessions... ]   [Status ▾]   [Repo ▾]                              │
│                                                                              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Title                     Repository            Model        Status      │ │
│ ├──────────────────────────────────────────────────────────────────────────┤ │
│ │ Fix flaky retry test      eBike/payments        Sonnet 4.6   ● active    │ │
│ │ Add invoice export        eBike/invoicing       Sonnet 4.6   ● running   │ │
│ │ Refactor webhook handler  eBike/webhooks        Sonnet 4.5   ○ stopped   │ │
│ │ Investigate deadlock      eBike/orders          Sonnet 4.6   ✕ failed    │ │
│ │ Update dependencies       eBike/infra           Sonnet 4.5   ○ stopped   │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ● active   ● running   ○ stopped   ✕ failed   ◇ archived                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Backed by `GET /api/sessions` (§5, `limit`/`offset`/`status` query params).

**Status badge is a derived value, not a single column** — `sessions.status` (§4) only ever holds
`active` | `archived` | `pending_bootstrap`. `running`/`stopped`/`failed` come from the live
`docker inspect` phase reported alongside the row (same "session status vs. live sandbox phase" split
already documented in §5/§7). The dashboard combines both into one badge; the backend never stores
`running`/`stopped`/`failed` as session state.

Purpose: find a session, see its state, open it, or create another one.

---

## 2. Create session — `/sessions/new`

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Agent Control Plane                                      ● Connected   [JD] │
├──────────────────────────────────────────────────────────────────────────────┤
│ ← Sessions                                                                  │
│                                                                              │
│ New Session                                                                  │
│ Create a new coding-agent sandbox                                            │
│                                                                              │
│ Title *                                                                      │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Fix flaky retry test                                                     │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ Repository *                                                                 │
│ ┌──────────────────────┐  ┌───────────────────────────────────────────────┐ │
│ │ eBike             ▾  │  │ digitx-payments-service                     │ │
│ └──────────────────────┘  └───────────────────────────────────────────────┘ │
│                                                                              │
│ Model *                                                                      │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Claude Sonnet 4.6                                              ▾   │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ View all models →                                                            │
│                                                                              │
│ Reasoning effort                                                             │
│ [ Low ]   [ Medium ]   [High]   [ Max ]                                     │
│                                                                              │
│ Team config (optional)                                                       │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ owner/repository                                                         │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ Overrides the default team config repository                                 │
│                                                                              │
│                                         [Cancel]   [Create Session]          │
└──────────────────────────────────────────────────────────────────────────────┘
```

Maps 1:1 to `POST /api/sessions`'s fields table (`ai-coding-agent-doc.md`, Quickstart chapter):
`title`, `repoOwner`+`repoName` (split into the two repository fields), `model` (populated from
`GET /api/models`'s static allowlist, §5), `reasoningEffort`, `teamConfigRepo`.

**Deliberately absent:** `additionalRepos`/`readOrgRepos` fields — permanent declared deviation
(ARCHITECTURE.md §13); this design has no org-wide repo-access model, so there's nothing for these
fields to configure.

For a thinner variant, this can be a modal triggered from `[+ New Session]` on `/` instead of a
full route — either is fine, no backend implication either way.

---

## 3. Session detail — `/sessions/:id`

The main application screen — watch progress, send prompts, inspect results, manage the session.

```text
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Sessions   Fix flaky retry test                           ● Connected     [Stop] [Archive] │
│              eBike/payments-service • litellm/claude-sonnet-4-6 • High               [⋮] │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⏱ Available until 8/18/2026, 3:05 PM (in 7d 2h)       Session ID: 7f3e2b3a-1c6d-4f2b-9a2c   │
├──────────────────────────────────────────────────────────────────────────────┬─────────────┤
│                                                                              │ Overview    │
│  [Conversation] [Events]                                                     │─────────────│
│                                                                              │ Status      │
│  2:42:47 PM assistant                                                        │ ● active    │
│  ┌────────────────────────────────────────────────────────────────────────┐  │             │
│  │ bash                                                            ✓       │  │ Updated     │
│  │ Arguments                                                               │  │ 2m ago      │
│  │ cd /workspace/repo && git diff origin/develop..origin/BDU3-...          │  │             │
│  │                                                                          │  │ Created     │
│  │ diff --git a/include/.../MOVD_ModelClass.h                              │  │ 2:42:47 PM  │
│  │ + new file content                                                       │  │             │
│  └────────────────────────────────────────────────────────────────────────┘  │ Model       │
│                                                                              │ Sonnet 4.6  │
│  2:43:45 PM assistant                                                        │             │
│  ┌────────────────────────────────────────────────────────────────────────┐  │ Reasoning   │
│  │ Added transfer module and updated build configuration.                 │  │ High        │
│  └────────────────────────────────────────────────────────────────────────┘  │             │
│                                                                              │ Workspace   │
│  2:44:01 PM tool_call                                                        │ bdu3-...    │
│  ┌────────────────────────────────────────────────────────────────────────┐  │             │
│  │ ○ Run tests                                                             │  │ Sandbox     │
│  │ All tests passed                                                        │  │ sandbox_3f..│
│  └────────────────────────────────────────────────────────────────────────┘  │             │
│                                                                              │ OpenCode    │
│                                                                              │ session     │
│                                                                              │ oc_9c1b7d2e │
├──────────────────────────────────────────────────────────────────────────────┴─────────────┤
│ [Prompt] [System]                                                                          │
│                                                                                            │
│ ┌────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Ask the agent to inspect, change, or explain the code...                               │ │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                            │
│ [Claude Sonnet 4.6 ▾]    Low   Medium   [High]   Max                         [Send ➤]      │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Conversation/Events tabs, message stream** — driven by `GET /api/sessions/:id/events` (cursor
  pagination) + live WS updates (§4, §6). Every SSE frame the bridge relayed is available here,
  matching the confirmed "full event data" design (§4).
- **Continuation banner** (`⏱ Available until...`) — from the `continuation` object on
  `GET /api/sessions/:id` (§7).
- **Prompt composer** — `POST /api/sessions/:id/prompt` or WS `prompt` message, `{content, model?,
  reasoningEffort?}` (§5, §6). Reasoning-effort buttons map directly onto opencode's model-variant
  mechanism, confirmed not mandatory (§8).
- **Stop/Archive buttons** — WS `stop` message / `PATCH /api/sessions/:id {status}` (§5, §9).

### Overview panel

Plain session metadata — `status`, `model`, `reasoning_effort`, `container_name`
("Sandbox"), `opencode_session_id` ("OpenCode session") — all straight off the `sessions` row (§4).
No separate endpoint; this is the same data `GET /api/sessions/:id` already returns.

### Participants panel

```text
┌──────────────────────────────┐
│ Participants                 │
├──────────────────────────────┤
│ 1 active                     │
│                              │
│ ● JD   john@example.com      │
│        You                   │
│                              │
│ No other participants        │
└──────────────────────────────┘
```

Backed by the WS `presence` message (§6) — **confirmed real, broadcast to other subscribers**, not a
no-op (a correction made after the production dashboard screenshot showed this panel actually rendering
live participant state).

### Artifacts panel

```text
┌──────────────────────────────┐
│ Files changed                │
├──────────────────────────────┤
│ 2 files                      │
│                              │
│ MOVD_ModelClass.h      +28 -4│
│ build.cfg               +1 -0│
│                              │
│ View full diff →             │
└──────────────────────────────┘
```

**Simplified from the original wireframe:** shows only file-level diffs, because that's all
`GET /api/sessions/:id/artifacts` actually returns — a thin 1:1 proxy to OpenCode's own
`GET /session/{id}/diff` (§5, `SnapshotFileDiff[]`). The original proposal's separate "Patch" and
"Command output" artifact types aren't real capabilities of this endpoint — tool/command output is
already visible inline in the Conversation transcript above, not a separate downloadable artifact.
Don't build capture/export mechanisms this panel would need to back those extra types unless a real
requirement for them shows up later (YAGNI).

### Diagnostics panel

```text
┌──────────────────────────────┐
│ Diagnostics                  │
├──────────────────────────────┤
│ Phase                        │
│ Succeeded                    │
│                              │
│ Failure reason                │
│ —                            │
│                              │
│ Failure message               │
│ —                            │
│                              │
│ Last spawn                   │
│ 8/11/2026, 2:42:47 PM        │
│                              │
│ Last failure                  │
│ —                            │
│                              │
│ Failure count                 │
│ 0                            │
│                              │
│ [Refresh]                    │
└──────────────────────────────┘
```

Backed by `GET /api/sessions/:id/sandbox/diagnostics` (§5) — **confirmed real, actively-used panel**,
not redundant with `sandbox/logs` (a correction made after the production screenshot; see §13/§14).
`docker inspect` + the structured failure fields listed in §5.

### Logs panel

```text
┌────────────────────────────────────┐
│ Logs                               │
├────────────────────────────────────┤
│ [sandbox] [proxy]                  │
│                                    │
│ 15:05:18 starting bridge...        │
│ 15:05:18 connected to opencode     │
│ 15:05:19 session ready             │
│ 15:05:21 received prompt           │
│ 15:05:31 idle                      │
│                                    │
│ [Refresh]                          │
└────────────────────────────────────┘
```

**Simplified from the original wireframe:**
- **Only `[sandbox]` and `[proxy]` tabs** — `iptables-init` doesn't exist as a container in this
  design; network isolation is structural (`internal: true`, §12/§13), not a separate init-container
  process with its own logs.
- **No "Open full logs in OpenSearch" link** — log aggregation was explicitly declared *not built*
  (§13); this panel only ever shows `docker logs --tail N <container>` (§5). Don't render a link to a
  system that isn't there.

---

## 4. Mobile-ish session detail

If the viewport is narrower, collapse everything into tabs:

```text
┌──────────────────────────────────────┐
│ ← Fix flaky retry test        [⋮]   │
│ ● active                             │
├──────────────────────────────────────┤
│ Available until 8/18/2026            │
├──────────────────────────────────────┤
│ [Chat] [Info] [Logs]                 │
├──────────────────────────────────────┤
│                                      │
│ assistant                            │
│ ┌──────────────────────────────────┐ │
│ │ bash                             │ │
│ │ git diff ...                     │ │
│ │ + change                         │ │
│ └──────────────────────────────────┘ │
│                                      │
│ assistant                            │
│ Updated transfer module...           │
│                                      │
├──────────────────────────────────────┤
│ Ask the agent...                     │
│                                      │
│ Sonnet 4.6 ▾     High        [Send] │
└──────────────────────────────────────┘
```

`[Info]` collapses Overview + Participants + Artifacts + Diagnostics into one scrollable tab; `[Logs]`
stays separate given its own tab structure. No new endpoints — purely a layout change.

---

## Implementation note

The dashboard is a **React + TypeScript SPA** built with Vite, styled with Tailwind v4, using
shadcn/ui (Radix) primitives for the interactive chrome (dialogs, tabs, dropdowns) and TanStack Query
for REST data-fetching/cache invalidation (ARCHITECTURE.md §5 — corrected from an earlier vanilla-JS,
no-framework draft; this now matches production's own stack instead of deliberately deviating from
it, see §13). Each panel above is still a small, independent, `fetch`/WS-driven unit — the wireframes
define *what* to render, not *how* — but is now implemented as a React component rather than a raw DOM
update, which matters specifically for this screen's concurrency: SSE token deltas, WS `presence`
broadcasts, and cursor-paginated history all update independently and concurrently within the same
session-detail view, which is exactly the state-synchronization problem a component/render model
exists to handle cleanly.
