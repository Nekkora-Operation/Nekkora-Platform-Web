/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nekkoraMockApi } from './mock/plugin.ts';

// O navegador fala só com o Vite (origem única, sem CORS — contrato 8.7 §5.1). Por padrão, /api é atendido pela
// API simulada em memória (mock/, painel em /__mock/). Com NEKKORA_API_URL definido, /api é repassado a uma API
// real (fase de integração). Nenhum dos dois entra no build de produção.
const api = process.env.NEKKORA_API_URL;
const proxy = api ? { '/api': { target: api, secure: false } } : undefined;

export default defineConfig({
  plugins: [react(), ...(api ? [] : [nekkoraMockApi()])],
  resolve: {
    // A nekkora-lib vem de ../Nekkora-lib (link local): garante uma única cópia do React.
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
    css: false,
    include: ['src/**/*.test.{ts,tsx}', 'mock/**/*.test.ts'],
  },
});
