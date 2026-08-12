import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

describe('SPA static serving', () => {
  it.each([
    '/sessions/new',
    '/sessions',
    '/sessions/',
    '/nonexistent-route',
    '/sessions/new/extra',
  ])('returns the app shell for %s, not a raw 404', async (url) => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<div id="root">');
  });

  it('returns a JSON 404 for unmatched /api routes', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/api/nonexistent',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      message: 'Route GET:/api/nonexistent not found',
      error: 'Not Found',
      statusCode: 404,
    });
  });

  it('returns a JSON 404 for unmatched /internal routes', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/internal/nonexistent',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().statusCode).toBe(404);
  });
});
