#!/usr/bin/env node
/**
 * Sandbox bridge — a small inbound HTTP server (not a poller, ARCHITECTURE.md §8/§9) that runs
 * alongside `opencode serve` inside each sandbox container. Exposes `POST /prompt` and
 * `GET /global/health`, relays `opencode serve`'s single global SSE stream verbatim into the
 * control plane, and reports the freshly created `opencode` conversation id exactly once.
 *
 * Zero runtime dependencies — `node:http` + the built-in `fetch`/`ReadableStream` only, keeping
 * this near the ~50-70 LOC estimate from ARCHITECTURE.md §14.
 *
 * The `OPENCODE_SESSION_ID` env-hint reattach branch (continuation) is deliberately not
 * implemented this phase — no caller sets it yet (see the step file's Implementation notes).
 */

import http from 'node:http';

/** `opencode serve`'s fixed local address inside the sandbox (ARCHITECTURE.md §8). */
export const DEFAULT_OC_URL = 'http://127.0.0.1:4096';

/**
 * Splits a `provider/model` string on the FIRST `/` only — model ids can legitimately contain
 * further slashes (this step's Gotchas).
 * @param {string} model - e.g. `opencode/big-pickle`.
 * @returns {{providerID: string, modelID: string}} The split provider/model pair.
 */
export function splitModel(model) {
  const i = model.indexOf('/');
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/**
 * Builds the `prompt_async` request body. `variant` is omitted entirely (not `undefined`) when
 * `reasoningEffort` is unset, so opencode's own per-provider default applies — no control-plane
 * fallback value invented.
 * @param {{model: string, content: string, reasoningEffort?: string|null}} args
 * @returns {object} The `prompt_async` request body.
 */
export function buildPromptBody({ model, content, reasoningEffort }) {
  const modelField = splitModel(model);
  if (reasoningEffort) modelField.variant = reasoningEffort;
  return { model: modelField, parts: [{ type: 'text', text: content }] };
}

/** Incrementally splits an SSE byte stream into `data:`-only frames across chunk boundaries. */
export class SseFrameBuffer {
  constructor() {
    this.buffer = '';
  }

  /**
   * @param {string} chunk - Newly decoded text from the stream.
   * @returns {string[]} Any complete (blank-line-delimited) frames now available.
   */
  push(chunk) {
    this.buffer += chunk;
    const frames = [];
    let idx = this.buffer.indexOf('\n\n');
    while (idx !== -1) {
      frames.push(this.buffer.slice(0, idx));
      this.buffer = this.buffer.slice(idx + 2);
      idx = this.buffer.indexOf('\n\n');
    }
    return frames;
  }
}

/**
 * Parses a raw SSE frame into its JSON payload. Only plain `data:` lines exist on this stream —
 * there is no `event:` field (this step's Gotchas).
 * @param {string} frame - One blank-line-delimited SSE frame.
 * @returns {object|null} The parsed event, or `null` if the frame carries no usable data.
 */
export function parseFrame(frame) {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function log(message) {
  console.log(`[bridge] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postJSON(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Creates a bridge instance wired to injectable opencode/control-plane base URLs — real values at
 * runtime, stub HTTP servers in tests.
 * @param {{ocUrl?: string, controlPlaneUrl: string, sessionId: string}} config
 * @returns {{server: import('node:http').Server, start: (port: number) => Promise<void>, stop: () => Promise<void>}}
 */
export function createBridge({
  ocUrl = DEFAULT_OC_URL,
  controlPlaneUrl,
  sessionId,
}) {
  let ocSessionId = null;
  let ready = false;
  let generation = 0;
  let relayAbort = null;

  async function waitForOpencode(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const controller = new AbortController();
      const attemptTimeout = setTimeout(() => controller.abort(), 2000);
      try {
        const res = await fetch(`${ocUrl}/global/health`, {
          signal: controller.signal,
        });
        if (res.ok) return;
      } catch {
        // opencode not accepting connections yet (or this attempt timed out) — retried below.
      } finally {
        clearTimeout(attemptTimeout);
      }
      if (Date.now() >= deadline)
        throw new Error('opencode did not become healthy in time');
      await sleep(300);
    }
  }

  async function getOrCreateOcSession() {
    if (ocSessionId) return ocSessionId;
    const created = await postJSON(`${ocUrl}/session`, {});
    if (!created.ok)
      throw new Error(`opencode POST /session failed: ${created.status}`);
    const { id } = /** @type {{id: string}} */ (await created.json());
    ocSessionId = id;
    const reported = await postJSON(
      `${controlPlaneUrl}/internal/sessions/${sessionId}/oc-session`,
      { ocSessionId: id },
    );
    if (!reported.ok && reported.status !== 409) {
      throw new Error(`oc-session report failed: ${reported.status}`);
    }
    log('session ready');
    return ocSessionId;
  }

  async function forwardEvent(evt) {
    const url = `${controlPlaneUrl}/internal/sessions/${sessionId}/events`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await postJSON(url, evt);
        if (res.ok) return;
      } catch {
        // network error against the control plane — retried below with backoff.
      }
      await sleep(2 ** attempt * 200);
    }
    // Best-effort mirror (ARCHITECTURE.md §4) — dropped after bounded retries, not queued.
    log(`dropped event after retries: ${evt?.type ?? 'unknown'}`);
  }

  async function handleFrame(frame) {
    const evt = parseFrame(frame);
    if (!evt) return;
    if (evt.type === 'server.connected' || evt.type === 'heartbeat') return;
    if (evt.properties?.sessionID !== ocSessionId) return;
    await forwardEvent(evt);
  }

  async function relayOnce(myGeneration) {
    relayAbort = new AbortController();
    const res = await fetch(`${ocUrl}/event`, { signal: relayAbort.signal });
    if (!res.ok || !res.body)
      throw new Error(`opencode GET /event failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const frameBuffer = new SseFrameBuffer();
    for (;;) {
      const { value, done } = await reader.read();
      if (done || myGeneration !== generation) return;
      const frames = frameBuffer.push(decoder.decode(value, { stream: true }));
      for (const frame of frames) await handleFrame(frame);
    }
  }

  async function relayLoop(myGeneration) {
    for (;;) {
      if (myGeneration !== generation) return;
      try {
        await relayOnce(myGeneration);
      } catch (err) {
        log(
          `SSE relay error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (myGeneration !== generation) return;
      await sleep(1000);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/global/health') {
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'starting' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/prompt') {
      readRequestBody(req)
        .then(async ({ content, model, reasoningEffort }) => {
          log('received prompt');
          const id = await getOrCreateOcSession();
          const promptRes = await postJSON(
            `${ocUrl}/session/${id}/prompt_async`,
            buildPromptBody({ model, content, reasoningEffort }),
          );
          const payload = await promptRes.json().catch(() => ({}));
          res.writeHead(promptRes.status, {
            'content-type': 'application/json',
          });
          res.end(JSON.stringify(payload));
        })
        .catch((err) => {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
      return;
    }

    if (req.method === 'POST' && req.url === '/stop') {
      (async () => {
        try {
          if (!ocSessionId) {
            // Nothing to abort yet (never prompted) — a clean no-op, not an error.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'no-op' }));
            return;
          }
          log('received stop');
          const abortRes = await postJSON(
            `${ocUrl}/session/${ocSessionId}/abort`,
            {},
          );
          const payload = await abortRes.json().catch(() => ({}));
          res.writeHead(abortRes.status, {
            'content-type': 'application/json',
          });
          res.end(JSON.stringify(payload));
        } catch (err) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      })();
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });

  /**
   * Retries `getOrCreateOcSession()` with bounded exponential backoff instead of letting a
   * transiently-unreachable control plane crash the whole bridge process at startup (docs/
   * phase_01_findings.md's "Bridge startup resilience" decision) — a control-plane restart or
   * network blip during sandbox boot should be retried, not treated as fatal on the first
   * attempt.
   * @param {number} [attempts] - Max attempts before giving up and rethrowing.
   */
  async function getOrCreateOcSessionWithRetry(attempts = 5) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await getOrCreateOcSession();
      } catch (err) {
        if (attempt >= attempts - 1) throw err;
        const backoffMs = 2 ** attempt * 500;
        log(
          `oc-session setup failed (attempt ${attempt + 1}/${attempts}), retrying in ` +
            `${backoffMs}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await sleep(backoffMs);
      }
    }
  }

  async function start(port) {
    log('starting bridge');
    await waitForOpencode();
    log('connected to opencode');
    await getOrCreateOcSessionWithRetry();
    ready = true;
    generation += 1;
    relayLoop(generation);
    await new Promise((resolve) => server.listen(port, resolve));
  }

  function stop() {
    generation += 1;
    relayAbort?.abort();
    return new Promise((resolve) => server.close(() => resolve(undefined)));
  }

  return { server, start, stop };
}

const isEntrypoint = process.argv[1] === new URL(import.meta.url).pathname;

if (isEntrypoint) {
  const bridge = createBridge({
    controlPlaneUrl: process.env.CONTROL_PLANE_URL ?? '',
    sessionId: process.env.SESSION_ID ?? '',
  });
  bridge
    .start(Number.parseInt(process.env.BRIDGE_PORT ?? '8080', 10))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
