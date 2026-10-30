import { existsSync, readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E contra a API REAL do laboratório descartável (tools/lab/subir.sh): o navegador fala com o Vite (origem
 * http://localhost:5173), que repassa /api ao nginx do laboratório. Nenhuma simulação: os e-mails vêm da caixa de
 * homologação da própria Platform (tools/lab/lab.mjs).
 *
 * Privacidade: trace, screenshot e vídeo DESLIGADOS — as telas de MFA mostram QR, chave e códigos de recuperação, e os
 * links trazem tokens. Evidências visuais são capturadas à parte, só de telas sem segredo.
 *
 *   FRONT_LAB_ID=frontlab-001 npx playwright test -c playwright.real.config.ts
 */
const lab = process.env.FRONT_LAB_ID ?? 'frontlab-001';
const info = `tools/lab/saidas/${lab}/laboratorio.txt`;
const api = process.env.NEKKORA_API_URL ?? (existsSync(info) ? /^api=(.+)$/m.exec(readFileSync(info, 'utf8'))?.[1]?.trim() : undefined);
if (!api) throw new Error(`laboratório ${lab} sem ${info}: suba com tools/lab/subir.sh ou defina NEKKORA_API_URL`);
process.env.FRONT_LAB_ID = lab;

const chromium = process.env.PW_CHROMIUM;
const launchOptions = chromium && existsSync(chromium) ? { executablePath: chromium } : {};

export default defineConfig({
  testDir: './e2e-real',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    locale: 'pt-BR',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions,
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 }, launchOptions } }],
  webServer: {
    command: 'npx vite --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    env: { NEKKORA_API_URL: api },
    timeout: 120_000,
  },
});
