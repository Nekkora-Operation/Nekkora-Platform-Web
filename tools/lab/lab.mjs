#!/usr/bin/env node
/**
 * FRONT-V1-001 — acesso ao laboratório descartável criado por tools/lab/subir.sh (só leitura, exceto onde indicado).
 *
 *   node tools/lab/lab.mjs <id> caixa                     lista as mensagens da caixa de homologação (sem tokens)
 *   node tools/lab/lab.mjs <id> token <TIPO> <e-mail>     token da mensagem MAIS RECENTE do tipo para o destinatário
 *   node tools/lab/lab.mjs <id> compose <args...>         docker compose do projeto (ex.: ps, logs platform)
 *   node tools/lab/lab.mjs <id> limites <org> <e-mail>   FIXTURE DECLARADA (só laboratório descartável): grava os limites da
 *                                                         organização (010, recursos 1–5) — a ativação operacional não tem
 *                                                         ferramenta no laboratório (bloqueio B2). O mesmo modelo do
 *                                                         laboratório do Agent (ciclo.py, "fixture declarada 2"). Registrada
 *                                                         em tools/lab/saidas/<id>/fixtures.txt
 *   node tools/lab/lab.mjs <id> limpar-redis              SÓ laboratório descartável: zera o Redis do projeto (limitadores
 *                                                         R9/R9b/R11 etc. e CSRF de pré-autenticação) entre rodadas.
 *                                                         Nunca é chamado pelos testes; cada uso fica registrado na
 *                                                         saída do laboratório (tools/lab/saidas/<id>/redis_limpo.txt)
 *
 * A caixa é o transporte de HOMOLOGAÇÃO da Platform (nenhum envio externo): cada mensagem é um arquivo JSON no volume do
 * projeto. O token só sai no comando `token`, para o teste do navegador seguir o link da mensagem produzida pelo fluxo
 * real; ele nunca é gravado em arquivo, relatório ou evidência.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function env(id) {
  const file = join(homedir(), '.nekkora', 'front-lab', id, 'segredos.env');
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export function compose(id, args, options = {}) {
  const e = env(id);
  const files = ['-f', join(e.LAB_API_REPO, 'api', 'e2e', 'compose.e2e.yml'), '-f', join(here, 'compose.front.yml')];
  return execFileSync('docker', ['compose', ...files, ...args], {
    env: { ...process.env, ...e },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

/** Mensagens da caixa, da mais antiga para a mais nova: { arquivo, tipo, destinatario, token? }. */
export function mailbox(id) {
  // um JSON por linha: cada arquivo publicado da caixa (nomes começam pelo instante UTC: a ordem do nome é a do envio)
  const script = 'find /caixa -type f -name "*.json" ! -path "*/.tmp/*" | sort | while read f; do printf "%s\\t" "$(basename "$f")"; tr -d "\\n" < "$f"; echo; done';
  const raw = compose(id, ['exec', '-T', 'platform', 'sh', '-c', script]);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [arquivo, json] = line.split('\t');
      const m = JSON.parse(json);
      return { arquivo, tipo: m.tipo, destinatario: m.destinatario, token: m.token ?? null };
    });
}

/** Token da mensagem mais recente de `tipo` para `destinatario` (ou null). */
export function latestToken(id, tipo, destinatario) {
  const all = mailbox(id).filter((m) => m.tipo === tipo && m.destinatario?.toLowerCase() === destinatario.toLowerCase());
  return all.length ? all[all.length - 1].token : null;
}

/** Quantas mensagens de `tipo` foram para `destinatario` (para provar reenvio ou ausência de envio). */
export function countMessages(id, tipo, destinatario) {
  return mailbox(id).filter((m) => m.tipo === tipo && m.destinatario?.toLowerCase() === destinatario.toLowerCase()).length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [id, cmd, ...rest] = process.argv.slice(2);
  if (!id || !cmd) {
    console.error('uso: node tools/lab/lab.mjs <id> caixa | token <TIPO> <e-mail> | compose <args...>');
    process.exit(2);
  }
  if (cmd === 'caixa') {
    for (const m of mailbox(id)) console.log(`${m.arquivo}\t${m.tipo}\t${m.destinatario}\t${m.token ? 'com token' : 'sem token'}`);
  } else if (cmd === 'token') {
    const t = latestToken(id, rest[0], rest[1]);
    if (!t) process.exit(1);
    process.stdout.write(t);
  } else if (cmd === 'limites') {
    const e = env(id);
    if (!/^ensaio-frontlab-/.test(e.FRONT_AMBIENTE ?? '')) throw new Error('recusado: só em laboratório descartável ensaio-frontlab-*');
    const [org, email] = rest;
    if (!/^[0-9a-f-]{36}$/.test(org ?? '') || !/^[^\s@']+@[^\s@']+$/.test(email ?? '')) throw new Error('uso: limites <org uuid> <e-mail da identidade administradora>');
    const user = `(SELECT u.user_id FROM users u JOIN identity_users iu ON iu.user_id = u.user_id JOIN identities i ON i.identity_id = iu.identity_id WHERE lower(i.email) = lower('${email}') AND u.organization_id = '${org}')`;
    const rows = [1, 2, 3, 4, 5]
      .map(
        (c) =>
          `INSERT INTO organization_resource_limit_revisions (organization_id, resource_code, revision_number, effective_from, limit_mode, limit_value, provisioned_by_user_id) ` +
          `VALUES ('${org}', ${c}, (SELECT coalesce(max(revision_number), 0) + 1 FROM organization_resource_limit_revisions WHERE organization_id = '${org}' AND resource_code = ${c}), clock_timestamp(), 2, NULL, ${user});`,
      )
      .join('\n');
    const sql = `BEGIN;\nSELECT set_config('nekkora.organization_id', '${org}', true);\n${rows}\nCOMMIT;\n`;
    compose(id, ['exec', '-T', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'nekkora', '-d', 'nekkora'], { input: sql });
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(here, 'saidas', id, 'fixtures.txt'), `${new Date().toISOString()} limites 010 (recursos 1-5, modo 2) org=${org}\n`);
    console.log('limites gravados (fixture declarada; registrada em fixtures.txt)');
  } else if (cmd === 'limpar-redis') {
    const e = env(id);
    if (!/^ensaio-frontlab-/.test(e.FRONT_AMBIENTE ?? '')) throw new Error('recusado: só em laboratório descartável ensaio-frontlab-*');
    compose(id, ['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL']);
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(here, 'saidas', id, 'redis_limpo.txt'), `${new Date().toISOString()} FLUSHALL (entre rodadas de teste)\n`);
    console.log('redis do laboratório zerado (registrado em redis_limpo.txt)');
  } else if (cmd === 'compose') {
    process.stdout.write(compose(id, rest));
  } else {
    console.error(`comando desconhecido: ${cmd}`);
    process.exit(2);
  }
}
