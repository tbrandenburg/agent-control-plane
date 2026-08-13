import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /version', () => {
  it('returns the GIT_SHA env var when set', async () => {
    const original = process.env.GIT_SHA;
    process.env.GIT_SHA = 'abc1234';
    try {
      const app = buildServer();
      const response = await app.inject({ method: 'GET', url: '/version' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ gitSha: 'abc1234' });
    } finally {
      if (original === undefined) delete process.env.GIT_SHA;
      else process.env.GIT_SHA = original;
    }
  });

  it("falls back to 'unknown' when GIT_SHA is not set", async () => {
    const original = process.env.GIT_SHA;
    delete process.env.GIT_SHA;
    try {
      const app = buildServer();
      const response = await app.inject({ method: 'GET', url: '/version' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ gitSha: 'unknown' });
    } finally {
      if (original !== undefined) process.env.GIT_SHA = original;
    }
  });
});
