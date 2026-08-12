/**
 * Unit + integration tests for sandbox/bridge.js.
 *
 * Unit: SSE chunk-boundary buffering, splitModel on a multi-slash model id, variant
 * omitted-vs-present in the prompt_async body.
 * Integration: the bridge run against stub opencode + control-plane HTTP servers, asserting every
 * frame is forwarded verbatim and frames for a different sessionID are filtered out.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import {
  buildPromptBody,
  createBridge,
  parseFrame,
  SseFrameBuffer,
  splitModel,
} from './bridge.js';

describe('splitModel', () => {
  it('splits on the first slash only, keeping further slashes in modelID', () => {
    assert.deepEqual(splitModel('litellm/eu.anthropic.claude-sonnet-4-6'), {
      providerID: 'litellm',
      modelID: 'eu.anthropic.claude-sonnet-4-6',
    });
  });
});

describe('buildPromptBody', () => {
  it('omits variant entirely when reasoningEffort is unset', () => {
    const body = buildPromptBody({ model: 'litellm/claude', content: 'hi' });
    assert.equal('variant' in body.model, false);
    assert.deepEqual(body.parts, [{ type: 'text', text: 'hi' }]);
  });

  it('includes variant when reasoningEffort is set', () => {
    const body = buildPromptBody({
      model: 'litellm/claude',
      content: 'hi',
      reasoningEffort: 'high',
    });
    assert.equal(body.model.variant, 'high');
  });
});

describe('SseFrameBuffer', () => {
  it('buffers a frame split across chunk boundaries until the blank-line delimiter arrives', () => {
    const buffer = new SseFrameBuffer();
    assert.deepEqual(buffer.push('data: {"a":1'), []);
    assert.deepEqual(buffer.push('}\n\n'), ['data: {"a":1}']);
  });

  it('yields multiple frames present in a single chunk', () => {
    const buffer = new SseFrameBuffer();
    const frames = buffer.push('data: {"a":1}\n\ndata: {"a":2}\n\n');
    assert.deepEqual(frames, ['data: {"a":1}', 'data: {"a":2}']);
  });
});

describe('parseFrame', () => {
  it('parses a plain data: frame with no event: field', () => {
    assert.deepEqual(parseFrame('data: {"type":"heartbeat"}'), {
      type: 'heartbeat',
    });
  });

  it('returns null for a frame with no data line', () => {
    assert.equal(parseFrame(''), null);
  });
});

/**
 * Minimal stub `opencode serve` — `GET /global/health`, `POST /session`, `GET /event` (a fixed
 * recorded frame sequence including a `message.part.delta`, plus a frame for a different session),
 * and `POST /session/:id/prompt_async`.
 */
function createStubOc() {
  let sessionCounter = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/global/health') {
      res.writeHead(200).end('{"healthy":true}');
      return;
    }
    if (req.method === 'POST' && req.url === '/session') {
      sessionCounter += 1;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ id: `oc-${sessionCounter}` }));
      return;
    }
    if (req.method === 'GET' && req.url === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"server.connected"}\n\n');
      res.write(
        'data: {"type":"message.part.delta","properties":{"sessionID":"oc-1","text":"hel' +
          'lo"}}\n\n',
      );
      res.write('data: {"type":"heartbeat"}\n\n');
      res.write(
        'data: {"type":"message.part.delta","properties":{"sessionID":"oc-other"}}\n\n',
      );
      // Never ends within the test window — the relay reads until the test stops the bridge.
      return;
    }
    if (
      req.method === 'POST' &&
      req.url?.startsWith('/session/') &&
      req.url.endsWith('/prompt_async')
    ) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });
  return server;
}

/** Minimal stub control plane — records every `/internal/sessions/:id/events` body received. */
function createStubControlPlane() {
  const receivedEvents = [];
  let ocSessionReports = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : {};
      if (req.method === 'POST' && req.url?.endsWith('/oc-session')) {
        ocSessionReports += 1;
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: 'set' }));
        return;
      }
      if (req.method === 'POST' && req.url?.endsWith('/events')) {
        receivedEvents.push(body);
        res
          .writeHead(201, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: 'stored' }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  return {
    server,
    receivedEvents,
    get ocSessionReports() {
      return ocSessionReports;
    },
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('createBridge integration', () => {
  /** @type {import('node:http').Server} */
  let ocServer;
  /** @type {ReturnType<typeof createStubControlPlane>} */
  let cp;
  /** @type {ReturnType<typeof createBridge>} */
  let bridge;

  before(async () => {
    ocServer = createStubOc();
    const ocPort = await listen(ocServer);
    cp = createStubControlPlane();
    const cpPort = await listen(cp.server);

    bridge = createBridge({
      ocUrl: `http://127.0.0.1:${ocPort}`,
      controlPlaneUrl: `http://127.0.0.1:${cpPort}`,
      sessionId: 'sess-1',
    });
    await bridge.start(0);

    // Give the relay a moment to read and forward the stub's fixed frame sequence.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  after(async () => {
    await bridge.stop();
    await close(ocServer);
    await close(cp.server);
  });

  it('reports the freshly created opencode session id exactly once', () => {
    assert.equal(cp.ocSessionReports, 1);
  });

  it('forwards every frame for the bridge session verbatim, including message.part.delta', () => {
    const delta = cp.receivedEvents.find(
      (evt) =>
        evt.type === 'message.part.delta' &&
        evt.properties?.sessionID === 'oc-1',
    );
    assert.ok(
      delta,
      'expected the oc-1 message.part.delta frame to be forwarded',
    );
    assert.equal(delta.properties.text, 'hello');
  });

  it('filters out frames for a different sessionID', () => {
    const other = cp.receivedEvents.find(
      (evt) => evt.properties?.sessionID === 'oc-other',
    );
    assert.equal(other, undefined);
  });

  it('never forwards server.connected/heartbeat keepalive frames', () => {
    const keepalive = cp.receivedEvents.find(
      (evt) => evt.type === 'server.connected' || evt.type === 'heartbeat',
    );
    assert.equal(keepalive, undefined);
  });

  it('answers GET /global/health once ready', async () => {
    const address = /** @type {import('node:net').AddressInfo} */ (
      bridge.server.address()
    );
    const res = await fetch(`http://127.0.0.1:${address.port}/global/health`);
    assert.equal(res.status, 200);
  });
});
