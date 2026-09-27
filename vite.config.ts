/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em desenvolvimento, o navegador fala só com o Vite (origem única, sem CORS — contrato 8.7 §5.1) e o Vite
// repassa /api ao gateway da API. NEKKORA_API_URL aponta o gateway (ex.: https://localhost:55443).
const api = process.env.NEKKORA_API_URL ?? 'https://localhost:55443';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // A nekkora-lib vem de ../Nekkora-lib (link local): garante uma única cópia do React.
    dedupe: ['react', 'react-dom', 'react-router'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // secure:false só aceita o certificado descartável do gateway local; cookies e Origin passam intactos
      '/api': { target: api, secure: false },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: { '/api': { target: api, secure: false } },
  },
  build: {
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
