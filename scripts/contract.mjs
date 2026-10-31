#!/usr/bin/env node
/**
 * Contrato da API v1 no frontend.
 *
 * A fonte é o OpenAPI definitivo do backend (Nekkora-Platform-API: api/openapi/nekkora-api-v1.yaml). O frontend
 * guarda uma CÓPIA versionada em contract/ e gera os tipos TypeScript em src/api/generated/ com o openapi-typescript,
 * que roda numa ferramenta ISOLADA (tools/contract/, com TypeScript 5): o gerador não funciona com o TypeScript 7 do
 * app. O arquivo gerado é só de tipos (nenhum código em runtime).
 *
 * Também gera src/api/generated/nekkora-api-v1.schemas.json: os esquemas de components.schemas (sem textos
 * descritivos nem extensões x-*) e, por operationId (todos os métodos), TODAS as respostas documentadas (status, tipo de
 * conteúdo e esquema, com as $ref de components/responses resolvidas). É a fonte da validação
 * em execução das respostas (src/api/validate.ts) e da conferência do mock contra o contrato nos testes.
 *
 *   node scripts/contract.mjs gen     regenera os tipos e os esquemas a partir da cópia
 *   node scripts/contract.mjs check   falha se os tipos ou esquemas commitados não forem os gerados da cópia, se a cópia não
 *                                     tiver o sha256 registrado em contract/SOURCE.json ou (com o repositório da API presente)
 *                                     se divergir do arquivo no commit fixado; avisa quando a main da API andou
 *   node scripts/contract.mjs sync <commit>
 *                                     copia o OpenAPI do commit indicado da API (git show, independente do branch em que o
 *                                     checkout da API estiver) para contract/ e fixa o commit em contract/SOURCE.json
 *
 * Repositório da API: NEKKORA_API_REPO ou, por padrão, ../Nekkora-Platform-API.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = join(root, 'tools', 'contract');
const copy = join(root, 'contract', 'nekkora-api-v1.yaml');
const generated = join(root, 'src', 'api', 'generated', 'nekkora-api-v1.ts');
const schemasOut = join(root, 'src', 'api', 'generated', 'nekkora-api-v1.schemas.json');
const sourceFile = join(root, 'contract', 'SOURCE.json');
const apiRepo = resolve(process.env.NEKKORA_API_REPO ?? join(root, '..', 'Nekkora-Platform-API'));
const API_PATH = 'api/openapi/nekkora-api-v1.yaml';

const lf = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Conteúdo de um arquivo num commit da API (só leitura: nunca muda o checkout da API). */
function apiFile(commit, path = API_PATH) {
  return execFileSync('git', ['-C', apiRepo, 'show', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n');
}

function apiCommit(ref) {
  return execFileSync('git', ['-C', apiRepo, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
}

const readSource = () => JSON.parse(readFileSync(sourceFile, 'utf8'));

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

/**
 * Remove o que não valida (textos, exemplos, extensões x-*), preservando a ordem das chaves do YAML. Dentro de
 * `properties` as chaves são NOMES de campos (ex.: o campo `description` de Workspace) e nunca são removidas.
 */
function strip(node) {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('x-') || k === 'description' || k === 'summary' || k === 'example' || k === 'examples' || k === 'title') continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([name, s]) => [name, strip(s)])) : strip(v);
  }
  return out;
}

function schemasJson() {
  ensureTools();
  const yaml = createRequire(join(tools, 'package.json'))('js-yaml');
  const doc = yaml.load(lf(copy));
  const resolveResponse = (r) => {
    const name = typeof r?.$ref === 'string' ? /^#\/components\/responses\/(.+)$/.exec(r.$ref)?.[1] : undefined;
    if (r?.$ref && !doc.components.responses?.[name]) throw new Error(`resposta desconhecida: ${r.$ref}`);
    return name ? doc.components.responses[name] : r;
  };
  // por operação (todos os métodos): cada status documentado, com o tipo de conteúdo e o esquema (null = sem corpo)
  const operations = {};
  for (const [path, item] of Object.entries(doc.paths)) for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const op = item[method];
    if (!op?.operationId) continue;
    const responses = {};
    for (const [status, raw] of Object.entries(op.responses ?? {})) {
      const r = resolveResponse(raw);
      const types = Object.keys(r.content ?? {});
      if (types.length > 1) throw new Error(`${op.operationId} ${status}: mais de um tipo de conteúdo (não suportado)`);
      responses[status] = types.length ? { contentType: types[0], schema: strip(r.content[types[0]].schema) } : { contentType: null, schema: null };
    }
    operations[op.operationId] = { method: method.toUpperCase(), path, responses };
  }
  const out = { openapiSha256: sha(lf(copy)), schemas: strip(doc.components.schemas), operations };
  return JSON.stringify(out, null, 2) + '\n';
}

const mode = process.argv[2];
if (mode === 'gen') {
  generate(generated);
  writeFileSync(schemasOut, schemasJson());
  console.log(`[contract] tipos e esquemas gerados em src/api/generated/ (OpenAPI sha256 ${sha(lf(copy)).slice(0, 12)})`);
} else if (mode === 'check') {
  const dir = mkdtempSync(join(tmpdir(), 'nk-contract-'));
  try {
    const fresh = join(dir, 'gen.ts');
    generate(fresh);
    if (!existsSync(generated) || lf(fresh) !== lf(generated)) {
      console.error('[contract] FALHA: src/api/generated/nekkora-api-v1.ts não corresponde a contract/nekkora-api-v1.yaml. Rode: npm run contract:gen');
      process.exit(1);
    }
    if (!existsSync(schemasOut) || lf(schemasOut) !== schemasJson()) {
      console.error('[contract] FALHA: src/api/generated/nekkora-api-v1.schemas.json não corresponde a contract/nekkora-api-v1.yaml. Rode: npm run contract:gen');
      process.exit(1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const source = readSource();
  if (sha(lf(copy)) !== source.sha256) {
    console.error('[contract] FALHA: contract/nekkora-api-v1.yaml não tem o sha256 registrado em contract/SOURCE.json. Rode: npm run contract:sync -- <commit>');
    process.exit(1);
  }
  if (!existsSync(join(apiRepo, '.git'))) {
    console.log(`[contract] OK: tipos atualizados; cópia = API ${source.commit.slice(0, 12)} pelo sha256 (repositório da API ausente: comparação com o git não executada)`);
  } else {
    if (sha(apiFile(source.commit)) !== source.sha256) {
      console.error(`[contract] FALHA: a cópia diverge do OpenAPI da API no commit fixado ${source.commit}`);
      process.exit(1);
    }
    console.log(`[contract] OK: tipos atualizados e cópia igual ao OpenAPI da API em ${source.commit.slice(0, 12)}`);
    try {
      const main = apiCommit('origin/main');
      if (main !== source.commit && sha(apiFile(main)) !== source.sha256) {
        console.warn(`[contract] AVISO: o OpenAPI de origin/main da API (${main.slice(0, 12)}) difere do commit fixado; compare os contratos antes de atualizar a base`);
      }
    } catch {
      // sem origin/main local: nada a comparar
    }
  }
} else if (mode === 'sync') {
  const ref = process.argv[3];
  if (!ref) {
    console.error('uso: node scripts/contract.mjs sync <commit da API>');
    process.exit(2);
  }
  const commit = apiCommit(ref);
  const text = apiFile(commit);
  writeFileSync(copy, text);
  const source = { repository: 'Nekkora-Operation/Nekkora-Platform-API', commit, path: API_PATH, sha256: sha(text) };
  writeFileSync(sourceFile, JSON.stringify(source, null, 2) + '\n');
  console.log(`[contract] contract/nekkora-api-v1.yaml = API ${commit.slice(0, 12)} (sha256 ${source.sha256.slice(0, 12)}); rode npm run contract:gen`);
} else {
  console.error('uso: node scripts/contract.mjs gen|check|sync <commit>');
  process.exit(2);
}
