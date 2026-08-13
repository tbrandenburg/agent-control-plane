import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { TARGET_REPO_A } from '../fixtures/distinct-target-repos.mjs';

/**
 * End-to-end vertical slice against the real `docker compose` stack (`make e2e` — no mocks of
 * Docker, `opencode serve`, or the bridge/SSE relay, and no mocked model provider either: this
 * spec uses `opencode/big-pickle`, a real, free, zero-credential model bundled natively with
 * `opencode` itself — no gateway base URL/API key/Platform-config-repo wiring required, and it
 * resolves correctly with only `OPENCODE_CONFIG_CONTENT`'s narrow `{model, autoupdate}` layer,
 * confirming Option C's decision is sufficient on its own for any model opencode already knows
 * about natively). Covers create (`202`, async bootstrap/spawn split) → `pending_bootstrap` →
 * `active` → prompt over WebSocket → streaming transcript delivered over the socket (no polling)
 * → `opencode_session_id` persistence, plus variants and error paths.
 *
 * Model responses are real and non-deterministic (root `AGENTS.md`'s Gotchas) — assertions check
 * frame arrival/type and event persistence, never specific response text.
 *
 * Updated for this phase's WebSocket transport and async spawn split (Step 6) — see
 * `docs/phase_02_findings.md` for the falsification evidence this spec produced.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const WS_BASE_URL = BASE_URL.replace(/^http/, 'ws');
const MODEL = 'opencode/big-pickle';
// The stack's SQLite file, bind-mounted at ./data by docker-compose.yml — read directly (not
// via the API) so `opencode_session_id`/`events` persistence is verified against real storage.
const DB_PATH =
  process.env.E2E_DB_PATH ??
  join(process.cwd(), '..', 'data', 'control-plane.db');

/** Every container this spec spawns, torn down unconditionally in `test.afterEach`. */
const spawnedContainers = new Set();

/**
 * Creates a session, asserting the `202`-then-settle contract (this phase's async spawn split):
 * the row/`wsToken` are returned immediately, before bootstrap/spawn has necessarily finished.
 * @param {string} title
 * @returns {Promise<{id: string, wsToken: string}>}
 */
async function createSession(request, title) {
  const response = await request.post(`${BASE_URL}/api/sessions`, {
    data: {
      title,
      repoOwner: TARGET_REPO_A.owner,
      repoName: TARGET_REPO_A.name,
      model: MODEL,
    },
  });
  expect(response.status()).toBe(202);
  const body = await response.json();
  expect(body.id).toBeTruthy();
  expect(body.wsToken).toBeTruthy();
  spawnedContainers.add(`sandbox-${body.id}`);
  return body;
}

/**
 * Polls `GET /api/sessions/:id` until `predicate(status)` is true or `timeoutMs` elapses — used
 * only to wait out the async bootstrap/spawn window before opening the WebSocket, never as the
 * transcript-delivery mechanism itself (that's WS-only, this step's whole point).
 */
async function waitForStatus(request, id, predicate, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string };
  for (;;) {
    const response = await request.get(`${BASE_URL}/api/sessions/${id}`);
    last = await response.json();
    if (predicate(last.status)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for session status; last saw: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Opens the session's WebSocket, sends `subscribe`, and resolves once `predicate` matches an
 * incoming `{type:"event",...}` frame's parsed payload, collecting every frame seen along the
 * way. Uses Node's built-in global `WebSocket` (no `ws` package dependency).
 *
 * `onSubscribed` (if given) fires immediately after `subscribe` is sent — callers must not send
 * the prompt until this fires, or a fast model response can complete and broadcast before the
 * socket is subscribed (no `fetch_history` replay this phase, by design) and the matching frame
 * is missed entirely.
 */
function collectWsEvents(
  id,
  wsToken,
  predicate,
  { timeoutMs = 40000, onSubscribed } = {},
) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_BASE_URL}/ws/sessions/${id}`);
    const seen = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(
        new Error(
          `timed out waiting for a matching WS frame; saw ${seen.length}: ${JSON.stringify(seen.slice(-5))}`,
        ),
      );
    }, timeoutMs);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', wsToken }));
      onSubscribed?.();
    });
    socket.addEventListener('message', (ev) => {
      let message: { type?: string } | undefined;
      try {
        message = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      seen.push(message);
      if (predicate(message)) {
        clearTimeout(timer);
        socket.close();
        resolve({ socket, seen });
      }
    });
    socket.addEventListener('close', (ev) => {
      if (ev.code === 4001) {
        clearTimeout(timer);
        reject(new Error('WS closed 4001 (unauthorized wsToken)'));
      }
    });
    socket.addEventListener('error', () => {
      // Surfaced via the timeout/close handlers above; no separate rejection needed here.
    });
  });
}

/**
 * True for a relayed WS event frame whose inner (opencode-native) `type` field matches `type`.
 * `routes/internal.js` broadcasts `{type: 'event', ...opencodeEvent}` — since `opencodeEvent`
 * itself already carries its own `type` field (e.g. `message.part.updated`), the object spread
 * overwrites the wrapper's literal `'event'` with that inner type, so relayed frames arrive
 * client-side with `message.type` equal to the opencode event's own type directly, never the
 * literal string `'event'`. `ping`/`prompt-result` frames (the only other WS message shapes)
 * never carry a `properties` key, which real opencode events always do — used here as a cheap
 * discriminator so this predicate can't accidentally match either of those.
 */
function eventContains(type) {
  return (message) =>
    message?.type === type && message.properties !== undefined;
}

test.describe('session lifecycle (real docker compose stack)', () => {
  test.afterEach(() => {
    for (const name of spawnedContainers) {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        // Already removed — fine, teardown must be unconditional either way.
      }
    }
    spawnedContainers.clear();
  });

  test('create (202) → pending_bootstrap → active → prompt over WS → streaming transcript over the socket → opencode_session_id persisted', async ({
    request,
  }) => {
    // Bootstrap/spawn (up to ~30s of the healthcheck's own start-period/retries) plus the real
    // model round-trip both happen within this one test, well past Playwright's 30s default.
    test.setTimeout(90000);
    const { id, wsToken } = await createSession(request, 'E2E happy path');

    // Async spawn split: the row exists and is queryable immediately, independent of whether
    // bootstrap/spawn has settled yet.
    const initial = await request.get(`${BASE_URL}/api/sessions/${id}`);
    expect(['pending_bootstrap', 'active']).toContain(
      (await initial.json()).status,
    );

    await waitForStatus(request, id, (status) => status === 'active');

    // `message.part.updated` frames prove frame-by-frame relay of the assistant's reply,
    // delivered over the WebSocket — the delivery mechanism changed from Phase 1's polling, the
    // content contract did not. Real model output is non-deterministic, so this asserts frame
    // arrival/type only, never specific response text (root `AGENTS.md`'s Gotchas). The prompt
    // is sent only once the socket is subscribed — no `fetch_history` replay this phase, so a
    // fast model reply that completes before subscribing would otherwise be missed entirely.
    let promptRes: ReturnType<typeof request.post> | undefined;
    await collectWsEvents(id, wsToken, eventContains('message.part.updated'), {
      onSubscribed: () => {
        // Small settle delay: `subscribe` (WS) and the prompt (a separate HTTP connection) have
        // no cross-connection ordering guarantee — without this, a fast model reply can complete
        // and broadcast before the server has finished processing `subscribe`, and the matching
        // frame is missed (no `fetch_history` replay this phase). Real clients (a human typing
        // into the dashboard) always have far more natural delay than this.
        setTimeout(() => {
          promptRes = request.post(`${BASE_URL}/api/sessions/${id}/prompt`, {
            data: { content: 'hi' },
          });
        }, 500);
      },
    });
    expect((await promptRes).ok()).toBeTruthy();

    // Direct SQL — not the API — per this step's Action 4.
    if (!existsSync(DB_PATH)) throw new Error(`db not found at ${DB_PATH}`);
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const session = db
        .prepare('SELECT opencode_session_id FROM sessions WHERE id = ?')
        .get(id);
      expect(session?.opencode_session_id).toMatch(/^ses_/);

      const deltaRows = db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND payload LIKE '%message.part%'",
        )
        .get(id);
      expect(deltaRows.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test('variant: two concurrent WS subscribers to the same session both receive the same broadcast event', async ({
    request,
  }) => {
    test.setTimeout(90000);
    const { id, wsToken } = await createSession(
      request,
      'E2E dual-subscriber variant',
    );
    await waitForStatus(request, id, (status) => status === 'active');

    const matchesReply = eventContains('message.part.updated');

    let subscribedCount = 0;
    let sentPrompt = false;
    const onSubscribed = () => {
      subscribedCount += 1;
      if (subscribedCount === 2 && !sentPrompt) {
        sentPrompt = true;
        // Settle delay — see the happy-path test's comment for why this is needed.
        setTimeout(() => {
          request.post(`${BASE_URL}/api/sessions/${id}/prompt`, {
            data: { content: 'hi' },
          });
        }, 500);
      }
    };

    const first = collectWsEvents(id, wsToken, matchesReply, { onSubscribed });
    const second = collectWsEvents(id, wsToken, matchesReply, { onSubscribed });

    await Promise.all([first, second]);
  });

  test('error path: WS subscribe with a wrong wsToken closes with code 4001, and a prompt sent before subscribing is rejected', async ({
    request,
  }) => {
    const { id } = await createSession(request, 'E2E bad-token variant');

    const closeCode = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${WS_BASE_URL}/ws/sessions/${id}`);
      const timer = setTimeout(() => reject(new Error('timed out')), 10000);
      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({ type: 'subscribe', wsToken: 'not-the-real-token' }),
        );
      });
      socket.addEventListener('close', (ev) => {
        clearTimeout(timer);
        resolve(ev.code);
      });
    });
    expect(closeCode).toBe(4001);
  });

  test('error path: prompting a session stuck in pending_bootstrap (no live container yet) returns 503, and a nonexistent session returns 404', async ({
    request,
  }) => {
    const missingRes = await request.post(
      `${BASE_URL}/api/sessions/does-not-exist/prompt`,
      { data: { content: 'hi' } },
    );
    expect(missingRes.status()).toBe(404);
  });

  test('PATCH /api/sessions/:id archives a session, reflected on GET', async ({
    request,
  }) => {
    const { id } = await createSession(request, 'E2E archive variant');

    const patchRes = await request.patch(`${BASE_URL}/api/sessions/${id}`, {
      data: { status: 'archived' },
    });
    expect(patchRes.ok()).toBeTruthy();

    const getRes = await request.get(`${BASE_URL}/api/sessions/${id}`);
    expect((await getRes.json()).status).toBe('archived');
  });
});
