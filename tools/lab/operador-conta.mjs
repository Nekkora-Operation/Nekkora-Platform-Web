#!/usr/bin/env node
/**
 * PLATFORM-LOCAL-002 — conta da Platform CONTROLADA PELO OPERADOR do laboratório (a "conta responsável" da 022).
 *
 * A ativação (022) registra, além do operador e do certificado, uma conta da Platform que o operador controla e que fica
 * como autora das revisões de capacidade. Essa conta é do OPERADOR: nunca a conta pessoal de quem explora a Platform.
 * Ela nasce pelo fluxo REAL da API (cadastro → mensagem da caixa local → confirmação → entrada → primeiro fator →
 * organização própria "Operação do laboratório"), sem SQL e sem fixture, e o código de vínculo é emitido na sessão
 * dela, como o titular de uma conta faria (POST /o/{org}/me/operational-link-code).
 *
 *   node tools/lab/operador-conta.mjs <id> criar     cria a conta do operador (uma vez) e a organização dela
 *   node tools/lab/operador-conta.mjs <id> codigo    entra na conta e emite o código de vínculo (uso único, poucos minutos)
 *                                                    gravado SÓ em ~/.nekkora/front-lab/<id>/operador/codigo_vinculo (0600)
 *
 * Estado (e-mail, senha e chave do autenticador da conta do operador) SÓ em ~/.nekkora/front-lab/<id>/operador/conta.json
 * (0600), fora do Git. Nada disso vai para a saída: ela leva só o resultado de cada passo.
 * TLS: o nginx do laboratório é conferido pelo certificado do próprio laboratório (NODE_EXTRA_CA_CERTS, definido por
 * tools/lab/operador.sh). O cabeçalho Origin é a origem pública da Platform (a mesma do navegador).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestToken } from './lab.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [id, cmd] = process.argv.slice(2);
if (!/^frontlab-[0-9a-z-]+$/.test(id ?? '') || !['criar', 'codigo'].includes(cmd)) {
  console.error('uso: node tools/lab/operador-conta.mjs <id frontlab-*> criar|codigo');
  process.exit(64);
}
const OP = join(homedir(), '.nekkora', 'front-lab', id, 'operador');
const ESTADO = join(OP, 'conta.json');
const info = readFileSync(join(here, 'saidas', id, 'laboratorio.txt'), 'utf8');
const API = /^api=(.+)$/m.exec(info)[1].trim();
const ORIGEM = /^origem_publica=(.+)$/m.exec(info)[1].trim();

// ------------------------------------------------------------------ TOTP (RFC 6238: SHA-1, 6 dígitos, 30 s)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32(s) {
  let bits = '';
  for (const ch of s.replace(/[\s=-]/g, '').toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, step) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', b32(secret)).update(c).digest();
  const o = h[h.length - 1] & 0x0f;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}
/**
 * Código de um passo AINDA NÃO usado (a API recusa o mesmo passo duas vezes no mesmo fator, também entre execuções
 * deste script): espera o próximo se preciso. O último passo usado fica no estado da conta.
 */
async function codigo(conta) {
  for (;;) {
    const passo = Math.floor(Date.now() / 30_000);
    if (passo > (conta.ultimoPasso ?? 0) && Date.now() % 30_000 < 27_000) {
      conta.ultimoPasso = passo;
      if (existsSync(ESTADO)) salvar(conta);
      return totp(conta.chave, passo);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ------------------------------------------------------------------ HTTP com cookies e CSRF
const jar = new Map();
async function http(method, path, { body, csrf } = {}) {
  const headers = { Accept: 'application/json', Origin: ORIGEM };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    const v = kv.slice(i + 1);
    if (v === '' || /max-age=0/i.test(c)) jar.delete(kv.slice(0, i));
    else jar.set(kv.slice(0, i), v);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}
function exigir(passo, r, ...esperados) {
  if (!esperados.includes(r.status)) {
    console.error(`${passo}: status ${r.status}${r.data?.code ? ` (${r.data.code})` : ''}`);
    process.exit(3);
  }
  console.log(`${passo}: ${r.status}`);
  return r.data;
}
const pre = async () => exigir('csrf de pré-autenticação', await http('GET', '/api/v1/csrf'), 200).csrfToken;

async function entrar(conta) {
  const login = exigir('entrada (senha)', await http('POST', '/api/v1/auth/login', { body: { email: conta.email, password: conta.senha }, csrf: await pre() }), 200);
  if (login.status !== 'mfa_required') {
    console.error(`entrada: passo seguinte inesperado (${login.status}); a conta do operador tem autenticador`);
    process.exit(3);
  }
  const s = exigir('entrada (autenticador)', await http('POST', '/api/v1/auth/mfa/verify', { body: { code: await codigo(conta) }, csrf: login.csrfToken }), 200);
  return s.csrfToken;
}

const salvar = (c) => writeFileSync(ESTADO, JSON.stringify(c), { mode: 0o600 });

if (cmd === 'criar') {
  if (existsSync(ESTADO)) {
    console.log('conta do operador já existe (nada feito)');
    process.exit(0);
  }
  mkdirSync(OP, { recursive: true, mode: 0o700 });
  const tag = randomBytes(4).toString('hex');
  const conta = {
    email: `operador-${tag}@operacao.frontlab.test`,
    senha: `Operador-${randomBytes(18).toString('base64url')}`,
    nome: 'Operação do laboratório',
    organizacao: `Operação do laboratório ${tag}`,
  };
  exigir('cadastro', await http('POST', '/api/v1/signup', { body: { email: conta.email }, csrf: await pre() }), 202);
  let token = null;
  for (let i = 0; i < 60 && !token; i++) {
    token = latestToken(id, 'IDENTITY_SIGNUP_CONFIRMATION', conta.email);
    if (!token) await new Promise((r) => setTimeout(r, 500));
  }
  if (!token) {
    console.error('a mensagem de confirmação não chegou à caixa local');
    process.exit(3);
  }
  exigir('confirmação (link da caixa local)', await http('POST', '/api/v1/signup/confirm', { body: { token, password: conta.senha, displayName: conta.nome }, csrf: await pre() }), 204);
  const login = exigir('entrada (senha)', await http('POST', '/api/v1/auth/login', { body: { email: conta.email, password: conta.senha }, csrf: await pre() }), 200);
  // a conta do operador SEMPRE tem autenticador. API ate a 028: o primeiro login exige o cadastro (desafio). API 029+
  // (segundo fator opcional): o login ja abre a sessao e o autenticador e ATIVADO pela sessao, com a senha reconfirmada
  let conf;
  if (login.status === 'authenticated') {
    exigir('senha reconfirmada (ativação)', await http('POST', '/api/v1/auth/password-confirm', { body: { password: conta.senha }, csrf: login.csrfToken }), 204);
    const uri = exigir('autenticador (início da ativação)', await http('POST', '/api/v1/auth/mfa/activate/start', { csrf: login.csrfToken }), 200).otpauthUri;
    conta.chave = new URL(uri).searchParams.get('secret');
    salvar(conta); // a chave é gravada ANTES da confirmação: sem ela a conta ficaria inacessível
    conf = exigir('autenticador (ativação)', await http('POST', '/api/v1/auth/mfa/activate/confirm', { body: { code: await codigo(conta) }, csrf: login.csrfToken }), 200);
  } else if (login.status === 'mfa_enrollment_required') {
    const uri = exigir('autenticador (início)', await http('POST', '/api/v1/auth/mfa/enroll/start', { csrf: login.csrfToken }), 200).otpauthUri;
    conta.chave = new URL(uri).searchParams.get('secret');
    salvar(conta); // a chave é gravada ANTES da confirmação: sem ela a conta ficaria inacessível
    conf = exigir('autenticador (confirmação)', await http('POST', '/api/v1/auth/mfa/enroll/confirm', { body: { code: await codigo(conta) }, csrf: login.csrfToken }), 200);
  } else {
    console.error(`entrada: passo seguinte inesperado (${login.status})`);
    process.exit(3);
  }
  conta.recuperacao = conf.recoveryCodes;
  salvar(conta);
  exigir('confirmação de segurança (step-up)', await http('POST', '/api/v1/auth/step-up', { body: { code: await codigo(conta) }, csrf: conf.csrfToken }), 204);
  const org = exigir('organização do operador', await http('POST', '/api/v1/organizations', { body: { name: conta.organizacao }, csrf: conf.csrfToken }), 201);
  conta.organizationId = org.organizationId;
  salvar(conta);
  console.log(`conta do operador criada; organização própria ${conta.organizationId} (estado em ${ESTADO})`);
} else {
  if (!existsSync(ESTADO)) {
    console.error('conta do operador ausente (rode antes: criar)');
    process.exit(64);
  }
  const conta = JSON.parse(readFileSync(ESTADO, 'utf8'));
  const csrf = await entrar(conta);
  const troca = exigir('entrada na organização do operador', await http('POST', '/api/v1/sessions/organization', { body: { organizationId: conta.organizationId }, csrf }), 200);
  if (troca.status === 'sem_acesso' || !troca.csrfToken) {
    console.error('entrada na organização do operador recusada');
    process.exit(3);
  }
  const c = exigir('código de vínculo (sessão da conta)', await http('POST', `/api/v1/o/${conta.organizationId}/me/operational-link-code`, { csrf: troca.csrfToken }), 200);
  writeFileSync(join(OP, 'codigo_vinculo'), c.code, { mode: 0o600 });
  console.log(`código de vínculo emitido (válido até ${c.expiresAt}); gravado fora do Git`);
}
