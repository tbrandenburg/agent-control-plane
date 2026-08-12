#!/usr/bin/env node
/**
 * Stub OpenAI-Chat-Completions-compatible server — stands in for LiteLLM/a real model provider
 * in `make e2e` so the suite is deterministic, free, and requires no external credentials
 * (root AGENTS.md's evidence-first principle still holds: everything about Docker, `opencode
 * serve`, and the bridge/SSE relay in `e2e/tests/session-lifecycle.spec.ts` is the real thing —
 * only the third-party model backend behind `@ai-sdk/openai-compatible` is substituted, the same
 * pattern as a test payment gateway).
 *
 * Implements the two endpoints `@ai-sdk/openai-compatible` needs: `GET /v1/models` and
 * `POST /v1/chat/completions` (streaming and non-streaming), replying with a short, fixed
 * assistant message so nothing here is a source of non-determinism.
 */

import http from 'node:http';

const PORT = Number.parseInt(process.env.PORT ?? '4141', 10);
const REPLY = 'ack';

function readBody(req) {
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

function chunk(id, model, delta, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function handleModels(res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      object: 'list',
      data: [{ id: 'stub-model', object: 'model' }],
    }),
  );
}

async function handleChatCompletions(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const model = typeof body.model === 'string' ? body.model : 'stub-model';
  const id = `chatcmpl-stub-${Date.now()}`;

  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: REPLY },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(
    `data: ${JSON.stringify(chunk(id, model, { role: 'assistant', content: '' }, null))}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify(chunk(id, model, { content: REPLY }, null))}\n\n`,
  );
  res.write(`data: ${JSON.stringify(chunk(id, model, {}, 'stop'))}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  if (
    req.method === 'GET' &&
    (req.url === '/v1/models' || req.url === '/models')
  ) {
    handleModels(res);
    return;
  }
  if (
    req.method === 'POST' &&
    (req.url === '/v1/chat/completions' || req.url === '/chat/completions')
  ) {
    handleChatCompletions(req, res).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'NOT_FOUND' }));
});

server.listen(PORT, () => {
  console.log(`[stub-model] listening on ${PORT}`);
});
