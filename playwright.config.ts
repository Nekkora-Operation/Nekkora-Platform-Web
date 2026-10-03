import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E do build de produção servido pelo `vite preview`, com /api atendido pela API simulada do contrato 8.7
 * (mock/: mesma origem, cookies __Host- HttpOnly, CSRF, TOTP real). Não precisa de backend nem de Docker.
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
    env: { NEKKORA_MOCK_DELAY: '60' }, // latência curta da API simulada (o padrão de 350 ms é para uso manual)
    timeout: 120_000,
  },
});
