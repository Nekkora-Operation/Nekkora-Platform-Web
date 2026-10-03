#!/usr/bin/env node
/**
 * Contrato da API v1 no frontend.
 *
 * A fonte é o OpenAPI definitivo do backend (Nekkora-Platform-API: api/openapi/nekkora-api-v1.yaml). O frontend
 * guarda uma CÓPIA versionada em contract/ e gera os tipos TypeScript em src/api/generated/ com o openapi-typescript,
 * que roda numa ferramenta ISOLADA (tools/contract/, com TypeScript 5): o gerador não funciona com o TypeScript 7 do
 * app. O arquivo gerado é só de tipos (nenhum código em runtime).
 *
 *   node scripts/contract.mjs gen     regenera os tipos a partir da cópia
 *   node scripts/contract.mjs check   falha se os tipos commitados não forem os gerados da cópia, ou se a cópia
 *                                     divergir do OpenAPI do backend (quando o repositório irmão existir)
 *   node scripts/contract.mjs sync    copia o OpenAPI do repositório irmão para contract/ (depois rode gen)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = join(root, 'tools', 'contract');
const copy = join(root, 'contract', 'nekkora-api-v1.yaml');
const generated = join(root, 'src', 'api', 'generated', 'nekkora-api-v1.ts');
const sibling = resolve(root, '..', 'nekkora-platform', 'api', 'openapi', 'nekkora-api-v1.yaml');

const lf = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function ensureTools() {
  if (!existsSync(join(tools, 'node_modules', 'openapi-typescript'))) {
    console.log('[contract] instalando a ferramenta isolada (tools/contract, npm ci)...');
    execFileSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: tools, stdio: 'inherit', shell: process.platform === 'win32' });
  }
}

function generate(target) {
  ensureTools();
  const cli = join(tools, 'node_modules', 'openapi-typescript', 'bin', 'cli.js');
  execFileSync(process.execPath, [cli, copy, '-o', target], { cwd: tools, stdio: ['ignore', 'ignore', 'inherit'] });
}

const mode = process.argv[2];
if (mode === 'gen') {
  generate(generated);
  console.log(`[contract] tipos gerados: src/api/generated/nekkora-api-v1.ts (OpenAPI sha256 ${sha(lf(copy)).slice(0, 12)})`);
} else if (mode === 'check') {
  const dir = mkdtempSync(join(tmpdir(), 'nk-contract-'));
  try {
    const fresh = join(dir, 'gen.ts');
    generate(fresh);
    if (!existsSync(generated) || lf(fresh) !== lf(generated)) {
      console.error('[contract] FALHA: src/api/generated/nekkora-api-v1.ts não corresponde a contract/nekkora-api-v1.yaml. Rode: npm run contract:gen');
      process.exit(1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (existsSync(sibling)) {
    if (sha(lf(sibling)) !== sha(lf(copy))) {
      console.error('[contract] FALHA: contract/nekkora-api-v1.yaml diverge do OpenAPI do backend (../nekkora-platform). Rode: npm run contract:sync && npm run contract:gen');
      process.exit(1);
    }
    console.log('[contract] OK: tipos atualizados e cópia igual ao OpenAPI do backend');
  } else {
    console.log('[contract] OK: tipos atualizados (repositório do backend ausente: comparação da cópia não executada)');
  }
} else if (mode === 'sync') {
  if (!existsSync(sibling)) {
    console.error(`[contract] repositório do backend não encontrado em ${sibling}`);
    process.exit(1);
  }
  copyFileSync(sibling, copy);
  console.log(`[contract] contract/nekkora-api-v1.yaml atualizado (sha256 ${sha(lf(copy)).slice(0, 12)}); rode npm run contract:gen`);
} else {
  console.error('uso: node scripts/contract.mjs gen|check|sync');
  process.exit(2);
}
