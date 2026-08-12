import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

describe('SPA static serving', () => {
  it('returns index.html for /sessions/new, not a 404', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/sessions/new' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<div id="root">');
  });
});
