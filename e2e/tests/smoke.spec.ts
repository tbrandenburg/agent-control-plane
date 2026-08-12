import { expect, test } from '@playwright/test';

// Regression baseline every later phase inherits — see docs/plan/steps/*/00600-*.md.
test.describe('smoke', () => {
  test('dashboard shell renders at /', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#root')).not.toBeEmpty();
  });

  test('GET /health returns 200 ok', async ({ request }) => {
    const response = await request.get('/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('/sessions/new serves the SPA rather than 404', async ({ page }) => {
    const response = await page.goto('/sessions/new');
    expect(response?.status()).toBe(200);
    await expect(page.locator('#root')).not.toBeEmpty();
  });

  // Regression coverage for #5 — SPA fallback previously only worked for exact routes
  // (/, /sessions/new, /sessions/:id), returning raw backend JSON 404s for other shapes.
  for (const path of ['/sessions', '/sessions/', '/nonexistent-route', '/sessions/new/extra']) {
    test(`${path} serves the SPA shell rather than a raw JSON 404`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(response?.headers()['content-type']).toContain('text/html');
      await expect(page.locator('#root')).not.toBeEmpty();
    });
  }

  test('unmatched /api route still returns a JSON 404, not the SPA shell', async ({ request }) => {
    const response = await request.get('/api/nonexistent');
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.statusCode).toBe(404);
  });
});
