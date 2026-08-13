/**
 * Prompt delivery — extracted from `routes/sessions.js` (step `00605`) to keep that route file
 * under the LOC budget. Synchronous bridge-proxy shared by `POST /api/sessions/:id/prompt` and
 * the WS `prompt` message (`routes/ws.js`) — the single place that validates and forwards a
 * prompt to the sandbox bridge, so neither entry point duplicates this logic.
 */

import { isValidModelReference } from './model.js';

/** Port the bridge listens on inside the sandbox (matches `sandbox/bridge.js`'s own default). */
const DEFAULT_BRIDGE_PORT = 8080;

/**
 * @typedef {object} PromptResult
 * @property {number} status - HTTP-style status code to mirror in the caller's response.
 * @property {object} body - Response payload (bridge's JSON, or a local error shape).
 */

/**
 * @param {import('node:sqlite').DatabaseSync} db - Open database handle.
 * @param {typeof fetch} fetchImpl - `fetch` implementation, swappable in tests.
 * @param {string} id - Session id.
 * @param {Record<string, unknown>} body - Prompt request body (`content`, `model?`,
 *   `reasoningEffort?`).
 * @returns {Promise<PromptResult>} The status/body to relay to the caller.
 */
export async function promptSession(db, fetchImpl, id, body) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) {
    return { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
  }

  const content = body.content;
  if (typeof content !== 'string' || !content) {
    return { status: 400, body: { error: 'INVALID_PROMPT_BODY' } };
  }

  const model = body.model ?? row.model;
  if (!isValidModelReference(model)) {
    return { status: 400, body: { error: 'INVALID_MODEL_REFERENCE' } };
  }
  const reasoningEffort = body.reasoningEffort ?? row.reasoning_effort;

  if (!row.container_name) {
    return { status: 503, body: { error: 'SANDBOX_UNAVAILABLE' } };
  }

  const bridgeUrl = `http://${row.container_name}:${DEFAULT_BRIDGE_PORT}/prompt`;
  let bridgeRes;
  try {
    bridgeRes = await fetchImpl(bridgeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, model, reasoningEffort }),
    });
  } catch {
    return { status: 503, body: { error: 'SANDBOX_UNAVAILABLE' } };
  }

  const payload = await bridgeRes.json().catch(() => ({}));
  const bodyPayload =
    payload && typeof payload === 'object' ? payload : { data: payload };
  return { status: bridgeRes.status, body: bodyPayload };
}
