import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E contra a API REAL (e2e/stack/up.sh com WEB_ORIGEM=http://localhost:4173). O build de produção é servido
 * pelo `vite preview`, que repassa /api ao gateway TLS da stack — mesma origem, cookies __Host- e CSRF reais.
 */
const chromium = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOptions = existsSync(chromium) ? { executablePath: chromium } : {};

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'pt-BR',
    trace: 'retain-on-failure',
    launchOptions,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions } },
    {
      name: 'tablet',
      testMatch: /responsive\.spec\.ts/,
      use: { ...devices['iPad Mini'], browserName: 'chromium', launchOptions },
    },
    {
      name: 'mobile',
      testMatch: /responsive\.spec\.ts/,
      use: { ...devices['Pixel 7'], launchOptions },
    },
  ],
  webServer: {
    command: 'npm run build && npx vite preview',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
