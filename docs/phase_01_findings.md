# Phase 1 findings — assumption falsification

Evidence gathered by running `e2e/tests/session-lifecycle.spec.ts` against the real
`docker compose` stack (`make e2e`), and by manually driving the same API/SSE path with `curl`
and direct SQL against `data/control-plane.db`. Per root `AGENTS.md`'s evidence-first principle,
this document — not a green test run alone — is Phase 1's exit artifact.

> **Environment note:** no real LiteLLM deployment/credentials were available in this run's
> environment (no `LITELLM_BASE_URL`/`LITELLM_API_KEY`, no `.env`, nothing in CI secrets either).
> `e2e/fixtures/stub-model-server.mjs` — a small OpenAI-Chat-Completions-compatible HTTP server —
> now stands in as the model backend by default in `docker-compose.yml` (overridable). Everything
> about Docker, `opencode serve`, and the bridge/SSE relay below is the real thing; only the
> third-party model provider behind `@ai-sdk/openai-compatible` is substituted — the same pattern
> as a test payment gateway, not a mock of the system under test. This also makes the answers
> below fully deterministic and free to reproduce.

## 1. Is the SSE stream relayable frame-by-frame?

**Yes.** A single trivial turn (`content: "hi"`, stub reply `"ack"`) produced this observed
frame-type histogram (24 frames, one turn, `GET /api/sessions/:id/events?limit=100`):

| Frame type              | Count |
|--------------------------|------:|
| `message.updated`        |     6 |
| `session.updated`        |     5 |
| `message.part.updated`   |     5 |
| `session.status`         |     4 |
| `session.diff`           |     2 |
| `message.part.delta`     |     1 |
| `session.idle`           |     1 |

Every frame arrived as its own `data:`-delimited SSE event and was relayed and stored verbatim,
one `events` row per frame, in arrival order — confirmed by the bridge's `SseFrameBuffer`
splitting the byte stream on blank-line boundaries and `sandbox/bridge.js`'s per-frame
`forwardEvent` call. `message.part.delta` in particular carries only an incremental patch, not the
full accumulated text:

```json
{
  "type": "message.part.delta",
  "properties": {
    "sessionID": "ses_...", "messageID": "msg_...", "partID": "prt_...",
    "field": "text", "delta": "ack"
  }
}
```

This is genuinely incremental (§8's claim), not opencode re-sending a growing string per token.

## 2. Is `/prompt` + relay the right seam?

**Mostly yes, with one contract leak found.** The seam itself — `POST /prompt` on the bridge
synchronously proxied via `POST /api/sessions/:id/prompt`, with all *state* arriving asynchronously
over the relayed SSE stream — worked cleanly end to end with no changes needed to `sandbox/bridge.js`
or `control-plane/src/routes/sessions.js`.

Two real leaks were found and fixed as part of building this E2E spec (both in code this step
owns/depends on, not in the seam's own contract):

- **Custom `provider.litellm` config was missing its own `models` map.** `@ai-sdk/openai-compatible`
  (and every custom, `npm`-based opencode provider) only exposes models explicitly declared under
  `provider.<id>.models` — omitting it fails every prompt with `Model not found: litellm/<model>`,
  even though `baseURL`/`apiKey` were correct. Fixed in `control-plane/src/sandbox.js`'s
  `buildOpencodeConfig` — the session's own model id is now always registered.
- **`WORKSPACE_HOST_PATH`'s documented default (`./workspace`) is not a valid Docker bind-mount
  source** when `docker run` executes from inside the control-plane container against the host
  daemon (via the bind-mounted `docker.sock`) — Docker CLI resolves relative host paths against
  its own client's cwd, which is the *container's* `/app`, not the real host directory, and fails
  with `invalid characters for a local volume name`. Fixed in `docker-compose.yml` by defaulting
  to `${PWD}/workspace` (an absolute host path) instead.
- **The control-plane image shipped without a `docker` CLI at all**, and ran as a non-root `node`
  user with no access to the bind-mounted `docker.sock` — `sandbox.run()`'s `spawn('docker', ...)`
  would fail with `ENOENT`/`EACCES` in a real container, never exercised until this step's E2E ran
  against the actual image. Fixed in `control-plane/Dockerfile` by installing `docker.io` and
  running as root — deliberately insecure, same "one line to flip" pattern as every other
  PHASE-4 item.

One genuine **contract leak in the dashboard remains, found but not fixed here** (out of this
step's declared scope — E2E spec + findings only): `control-plane/dashboard/src/components/
Transcript.tsx` only renders text from `message.part.updated` frames (`properties.part.text`,
the full accumulated string) — it does not understand `message.part.delta`'s actual shape
(`properties.delta`, an incremental string, no `part` object at all). In practice this still
produces a correct transcript today because `message.part.updated` frames also arrive with the
full text each time, but it means the dashboard is not actually consuming the frame-by-frame
`delta` events §8 promised — a real seam-contract mismatch to fix explicitly, not silently rely on
`.updated` frames for.

## 3. Transcript or firehose?

**Transcript, not a firehose, at Phase 1's scale.** The one-turn trivial exchange above produced:

- **24 events / turn**
- **8,396 bytes / turn** (verbatim JSON payloads, `events.payload` column)

This is small and clearly bounded for a short exchange — nowhere near firehose territory yet. It
will not stay that way: 6 `message.updated` and 5 `session.updated` frames for a *single* one-word
reply already shows real per-token/per-field duplication (each delta is followed by a re-sent
`.updated` snapshot), and a real multi-turn conversation with tool calls will multiply this. This
is squarely the kind of signal ARCHITECTURE.md §15 flags for its Phase-6 `events` retention
decision (pruning/compaction/rollup policy) — **explicitly escalating that question now**,
per this step's Action 2: Phase 2's real bootstrap and streaming work should not treat "store every
frame verbatim forever" as a closed decision. It has not caused problems yet only because Phase 1's
volume is tiny by construction (one pre-cloned repo, one trivial prompt, no continuation).

## Bridge startup resilience decision (step 00603)

`sandbox/bridge.js`'s `start()` used to call `getOrCreateOcSession()` once, unretried, before
marking the bridge ready — a transiently-unreachable control plane at sandbox boot (restart,
network blip, or a slow-to-come-up fixture in tests) crashed the whole bridge process outright,
failing that sandbox's startup permanently instead of retrying. **Decision: retry with bounded
exponential backoff (5 attempts, 500ms/1s/2s/4s, ~7.5s total) before giving up and exiting**, same
pattern already used for `forwardEvent`'s per-event retries. This is a deliberate, small,
bounded window — not unlimited retry — so a genuinely-down control plane still fails the sandbox
rather than hanging forever. Also fixes `control-plane/src/sandbox.test.js`'s "real Docker
integration" test's fixture-fragility (see this step): the fixture now runs in a container on a
dedicated user-defined network, addressed by container-name DNS, instead of depending on
`docker0` gateway routing from the sandbox container to a host-bound `http.createServer` — a
pattern that timed out (`UND_ERR_CONNECT_TIMEOUT`, not refused) in this environment.

## Exit criterion

`e2e/tests/session-lifecycle.spec.ts`'s happy path demonstrates, against the real stack: create
session → sandbox spawns and becomes healthy → prompt delivered → SSE frames relayed and persisted
→ `opencode_session_id` set exactly once (verified by direct SQL, not the API). Phase 1's roadmap
exit criterion — "you click New Session in a browser, type a prompt, and watch tokens appear" — is
met at the API/bridge layer with real evidence; the dashboard's own consumption of `message.part.delta`
is the one open item noted above.
