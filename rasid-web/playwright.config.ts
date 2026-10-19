import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests (npm run e2e), in two projects:
 * - "api": the production build (useApi: true) with the Rasid API faked inside
 *   the test (e2e/fake-api.ts), so the app takes its live paths (PRAL reference
 *   data, server posting) without a backend, a database or FBR.
 * - "offline": the development build that `npm start` serves (localStorage and
 *   the in-browser FBR simulator), so the offline demo keeps working.
 */
const API_PORT = 4310;
const OFFLINE_PORT = 4311;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'api', testMatch: '*.api.e2e.ts', use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${API_PORT}` } },
    { name: 'offline', testMatch: '*.offline.e2e.ts', use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${OFFLINE_PORT}` } },
  ],
  webServer: [
    {
      command: `npx ng serve --configuration production --port ${API_PORT}`,
      url: `http://localhost:${API_PORT}`,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
    },
    {
      command: `npx ng serve --configuration development --port ${OFFLINE_PORT}`,
      url: `http://localhost:${OFFLINE_PORT}`,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
    },
  ],
});
