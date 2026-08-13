import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODEL_ALLOWLIST } from '../config.js';
import { buildServer } from '../server.js';

/** @type {string} */
let dataDir;
/** @type {string|undefined} */
let previousDataDir;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cp-models-test-'));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/models', () => {
  it('returns the static allowlist from config.js', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/models' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ models: MODEL_ALLOWLIST });
    await app.close();
  });

  it('defaults to opencode/big-pickle first and never returns a litellm/* entry', async () => {
    const app = buildServer();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/models' });
    const { models } = response.json();

    expect(models[0].id).toBe('opencode/big-pickle');
    expect(models.some((model) => model.id.startsWith('litellm/'))).toBe(false);
    await app.close();
  });
});
