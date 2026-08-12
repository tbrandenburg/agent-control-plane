import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';

/**
 * End-to-end vertical slice against the real `docker compose` stack (`make e2e` — no mocks of
 * Docker, `opencode serve`, or the bridge/SSE relay; only the third-party model backend is a
 * local stub, see `e2e/fixtures/stub-model-server.mjs`). Covers create → spawn → prompt →
 * streaming transcript → `opencode_session_id` persistence, plus one variant and one error path.
 *
 * See docs/plan/steps/*-implement-missing-e2e-vertical-slice-and-findings.md and
 * docs/phase_01_findings.md for the assumption-falsification evidence gathered from this spec.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const MODEL = 'litellm/stub-model';
// The stack's SQLite file, bind-mounted at ./data by docker-compose.yml — read directly (not
// via the API) so `opencode_session_id`/`events` persistence is verified against real storage.
const DB_PATH = join(process.cwd(), '..', 'data', 'control-plane.db');

/** Every container this spec spawns, torn down unconditionally in `test.afterEach`. */
const spawnedContainers = new Set();

/**
 * @param {string} title
 * @returns {Promise<{id: string}>}
 */
async function createSession(request, title) {
  const response = await request.post(`${BASE_URL}/api/sessions`, {
    data: {
      title,
      repoOwner: 'acme',
      repoName: 'widgets',
      model: MODEL,
    },
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  spawnedContainers.add(`sandbox-${body.id}`);
  return body;
}

/**
 * Polls `GET /api/sessions/:id/events` until `predicate` matches one of the returned events, or
 * `timeoutMs` elapses.
 */
async function waitForEvent(request, id, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastEvents = [];
  for (;;) {
    const response = await request.get(
      `${BASE_URL}/api/sessions/${id}/events?limit=100`,
    );
    const body = await response.json();
    lastEvents = body.events ?? [];
    if (lastEvents.some(predicate)) return lastEvents;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for a matching event; last saw ${lastEvents.length} events: ` +
          JSON.stringify(lastEvents.slice(-5)),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** True for any relayed frame whose parsed payload has the given `type`. */
function frameTypeIs(type) {
  return (event) => {
    try {
      return JSON.parse(event.payload).type === type;
    } catch {
      return false;
    }
  };
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

  test('create → spawn → prompt → streaming transcript → opencode_session_id persisted', async ({
    request,
  }) => {
    const { id } = await createSession(request, 'E2E happy path');

    const promptRes = await request.post(
      `${BASE_URL}/api/sessions/${id}/prompt`,
      { data: { content: 'hi' } },
    );
    expect(promptRes.ok()).toBeTruthy();

    // `message.part.delta`/`message.part.updated` frames prove frame-by-frame relay of the
    // assistant's reply (not just the user message echoed back).
    await waitForEvent(
      request,
      id,
      (e) =>
        frameTypeIs('message.part.updated')(e) &&
        JSON.parse(e.payload).properties?.part?.text?.includes('ack'),
    );

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

  test('variant: a second prompt on the same session reuses the same opencode_session_id', async ({
    request,
  }) => {
    const { id } = await createSession(request, 'E2E continuation variant');

    await request.post(`${BASE_URL}/api/sessions/${id}/prompt`, {
      data: { content: 'first' },
    });
    await waitForEvent(request, id, frameTypeIs('session.idle'));

    const before = await request.get(`${BASE_URL}/api/sessions/${id}`);
    const firstOcId = (await before.json()).opencodeSessionId;
    expect(firstOcId).toBeTruthy();

    const secondPromptRes = await request.post(
      `${BASE_URL}/api/sessions/${id}/prompt`,
      { data: { content: 'second' } },
    );
    expect(secondPromptRes.ok()).toBeTruthy();

    const after = await request.get(`${BASE_URL}/api/sessions/${id}`);
    expect((await after.json()).opencodeSessionId).toBe(firstOcId);
  });

  test('error path: prompting before the sandbox exists returns 404, and prompting a session whose sandbox crashed returns 503', async ({
    request,
  }) => {
    test.setTimeout(60000);
    const missingRes = await request.post(
      `${BASE_URL}/api/sessions/does-not-exist/prompt`,
      { data: { content: 'hi' } },
    );
    expect(missingRes.status()).toBe(404);

    const { id } = await createSession(request, 'E2E sandbox-crash variant');
    // Kill the sandbox mid-flight to simulate a crash before the next prompt is sent.
    execFileSync('docker', ['rm', '-f', `sandbox-${id}`], { stdio: 'ignore' });

    const crashedRes = await request.post(
      `${BASE_URL}/api/sessions/${id}/prompt`,
      { data: { content: 'hi' } },
    );
    expect(crashedRes.status()).toBe(503);
  });
});
