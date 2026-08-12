import { defineConfig } from '@playwright/test';

// Points at the real `docker compose` stack — never a faked `webServer`. `make e2e`
// (Makefile) brings the stack up, waits for `/health`, runs this suite, then tears it down.
// See docs/plan/steps/*/00600-e2e-harness-and-ci-pipeline.md.
export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
});
