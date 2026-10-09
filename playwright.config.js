// @ts-check
import { defineConfig, devices } from '@playwright/test';

// The app is served under /CHARLIE/ locally to mirror GitHub Pages (https://<user>.github.io/CHARLIE/).
export const BASE_PATH = '/CHARLIE/';
export const BASE_URL = `http://127.0.0.1:4173${BASE_PATH}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node tests/serve.mjs 4173 --base ${BASE_PATH}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } },
    { name: 'iphone', use: { ...devices['iPhone 14'] } },
  ],
});
