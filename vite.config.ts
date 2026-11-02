/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nekkoraMockApi } from './mock/plugin.ts';

// O navegador fala só com o Vite (origem única, sem CORS — contrato 8.7 §5.1). Por padrão, /api é atendido pela
// API simulada em memória (mock/, painel em /__mock/). Com NEKKORA_API_URL definido, /api é repassado a uma API
// real (fase de integração). Nenhum dos dois entra no build de produção.
// Com NEKKORA_API_CA (certificado do laboratório, usado por tools/lab/local.sh), o repasse CONFERE o TLS da API
// (cadeia e nome localhost); sem ele, mantém o comportamento anterior dos ensaios (certificado não conferido).
const api = process.env.NEKKORA_API_URL;
const ca = process.env.NEKKORA_API_CA ? readFileSync(process.env.NEKKORA_API_CA, 'utf8') : undefined;
const proxy = api ? { '/api': ca ? { target: api, secure: true, ca } : { target: api, secure: false } } : undefined;

// Versão em execução (PLATFORM-LOCAL-002): commit e branch do Web lidos do git no início do Vite/build, a Nekkora-lib
// fixada (lib.lock.json) e o commit da API informado pelo runner local (NEKKORA_API_COMMIT). Só identificação para a
// pessoa saber o que está testando; nada disso decide acesso. Sem git (pacote copiado): "desconhecida".
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}
function libVersion(): string | null {
  try {
    const l = JSON.parse(readFileSync('lib.lock.json', 'utf8')) as { version?: string; commit?: string };
    return l.version ? `${l.version} (${(l.commit ?? '').slice(0, 7)})` : null;
  } catch {
    return null;
  }
}
const buildInfo = {
  webCommit: process.env.NEKKORA_WEB_COMMIT ?? git(['rev-parse', '--short=7', 'HEAD']),
  webBranch: process.env.NEKKORA_WEB_BRANCH ?? git(['rev-parse', '--abbrev-ref', 'HEAD']),
  webDirty: process.env.NEKKORA_WEB_COMMIT ? false : (git(['status', '--porcelain', '--untracked-files=no']) ?? '') !== '',
  apiCommit: process.env.NEKKORA_API_COMMIT ? process.env.NEKKORA_API_COMMIT.slice(0, 7) : null,
  lib: libVersion(),
};

export default defineConfig({
  define: { __NEKKORA_BUILD__: JSON.stringify(buildInfo) },
  plugins: [react(), ...(api ? [] : [nekkoraMockApi()])],
  resolve: {
    // Uma única cópia do React (a nekkora-lib declara react/react-dom como peer).
    dedupe: ['react', 'react-dom', 'react-router'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy,
  },
  build: {
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 15_000,
    css: false,
    include: ['src/**/*.test.{ts,tsx}', 'mock/**/*.test.ts'],
  },
});
