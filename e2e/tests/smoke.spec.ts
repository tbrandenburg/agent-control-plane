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
});
