/**
 * F6a-4: step-up e reset administrativo de MFA na API simulada conferem com o contrato e com o backend
 * (AuthService.stepUp, AccountController.resetMfa, AdminService.resetMfa). Toda resposta passa pelos dois validadores
 * (cliente estrito e Ajv). Relógio controlado (TOTP real, com anti-replay).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { responseViolations, type OperationId } from '../src/api/validate';
import { ajvValidate } from '../src/test/ajvContract';
import { DEV_ORG, DEV_TOTP_SECRET, MockApi, OTHER_ORG } from './contract';
import { stableUuid } from './product';
import { currentStep, totp } from './totp';

const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
let now = T0;
let api: MockApi;

const acc = (email: string, org = DEV_ORG) => [...api.accounts.values()].find((a) => a.email === email && a.org === org)!;
const code = (offset = 0) => totp(DEV_TOTP_SECRET, currentStep(now) + offset);
/** Avisos da redefinição (a caixa da massa já tem outras mensagens, como a confirmação de e-mail da conta pendente). */
const notices = () => api.inbox.filter((m) => m.kind.startsWith('mfa-reset')).map((m) => [m.to, m.kind]);

function session(email: string, org = DEV_ORG) {
  const cookie = api.openSession(acc(email, org).userId);
  const r = api.handle({ method: 'GET', path: `/api/v1/o/${org}/auth/csrf`, expectedOrigin: 'http://localhost', cookies: { '__Host-nekkora_session': cookie }, body: undefined });
  return { cookie, csrf: (r.body as { csrfToken: string }).csrfToken };
}

type S = { cookie: string; csrf: string } | null;

function call(op: OperationId, s: S, path: string, body: unknown, { org = DEV_ORG, origin = 'http://localhost', csrf }: { org?: string; origin?: string; csrf?: string } = {}) {
  const res = api.handle({
    method: 'POST',
    path: `/api/v1/o/${org}${path}`,
    origin,
    expectedOrigin: 'http://localhost',
    csrf: csrf ?? s?.csrf,
    cookies: s ? { '__Host-nekkora_session': s.cookie } : {},
    body,
  });
  expect(responseViolations(op, { status: res.status, contentType: res.headers['Content-Type'], body: res.body }), `${op} ${res.status}`).toEqual([]);
  if (res.status === 204) expect(res.body).toBeUndefined();
  else expect(ajvValidate(op, res.status, res.body).errors, `${op} ${res.status} (Ajv)`).toEqual([]);
  return res.status;
}

const stepUp = (s: S, body: unknown = { code: code() }, opts = {}) => call('mfaStepUp', s, '/auth/mfa/step-up', body, opts);
const reset = (s: S, target: string, reason: unknown = 'DISPOSITIVO_PERDIDO', opts = {}) =>
  call('resetUserMfa', s, `/users/${target}/mfa/reset`, reason === null ? {} : { reason }, opts); // null = sem motivo

beforeEach(() => {
  now = T0;
  api = new MockApi(() => now);
});

describe('step-up (AuthService.stepUp)', () => {
  it('código válido → 204 e registrado NA sessão; código já usado, errado ou de conta sem fator → 403 sem detalhe; ausente → 400', () => {
    const ana = session('ana@nekkora.dev');
    expect(stepUp(ana)).toBe(204);
    expect(stepUp(ana)).toBe(403); // mesmo passo: anti-replay
    expect(stepUp(ana, { code: '000000' })).toBe(403);
    expect(stepUp(ana, { code: 'abc' })).toBe(403);
    expect(stepUp(ana, {})).toBe(400);
    expect(stepUp(ana, { recoveryCode: 'X' })).toBe(400); // código de recuperação não é alternativa
    const semFator = session('novo@nekkora.dev');
    expect(stepUp(semFator)).toBe(403);
  });

  it('sem sessão 401; Origin ou CSRF errados 403', () => {
    const ana = session('ana@nekkora.dev');
    expect(stepUp(null)).toBe(401);
    expect(stepUp(ana, { code: code() }, { origin: 'http://evil.example' })).toBe(403);
    expect(stepUp(ana, { code: code() }, { csrf: 'x'.repeat(43) })).toBe(403);
  });
});

describe('reset administrativo de MFA (AdminService.resetMfa)', () => {
  it('com step-up recente: 204; fator, códigos, desafios e sessões do alvo encerrados; evento com motivo; aviso ao titular', () => {
    const ana = session('ana@nekkora.dev');
    const caio = acc('operador@nekkora.dev');
    api.openSession(caio.userId);
    expect(api.activeSessions(caio.userId)).toBe(1);
    expect(stepUp(ana)).toBe(204);
    expect(reset(ana, caio.userId, 'SUSPEITA_COMPROMETIMENTO')).toBe(204);
    expect(caio.totpSecret).toBeUndefined();
    expect(caio.recoveryCodes).toEqual([]);
    expect(api.activeSessions(caio.userId)).toBe(0);
    expect(api.adminWrites).toEqual([{ org: DEV_ORG, action: 'mfa-reset', target: caio.userId, at: now, reason: 'SUSPEITA_COMPROMETIMENTO' }]);
    expect(notices()).toEqual([['operador@nekkora.dev', 'mfa-reset-notice']]);
  });

  it('alvo ORG_ADMIN efetivo: avisa também as demais ORG_ADMIN', () => {
    const viz = session('vizinha@nekkora.dev', OTHER_ORG);
    const outra = api.createAccount({ org: OTHER_ORG, email: 'outra@vizinho.dev', displayName: 'Outra Admin', orgRoles: ['ORG_ADMIN'] });
    outra.totpSecret = DEV_TOTP_SECRET;
    const terceira = api.createAccount({ org: OTHER_ORG, email: 'terceira@vizinho.dev', displayName: 'Terceira Admin', orgRoles: ['ORG_ADMIN'] });
    expect(stepUp(viz, { code: code() }, { org: OTHER_ORG })).toBe(204);
    expect(reset(viz, outra.userId, 'OUTRO', { org: OTHER_ORG })).toBe(204);
    expect(notices().sort()).toEqual(
      [['outra@vizinho.dev', 'mfa-reset-notice'], ['terceira@vizinho.dev', 'mfa-reset-admin-notice'], ['vizinha@nekkora.dev', 'mfa-reset-admin-notice']].sort(),
    );
    expect(terceira.totpSecret).toBeUndefined(); // não tinha fator; nada muda para ela
  });

  it('NÃO é idempotente: repetir (com novo step-up) gera novo evento e novo aviso, e encerra as sessões abertas desde então', () => {
    const ana = session('ana@nekkora.dev');
    const caio = acc('operador@nekkora.dev');
    expect(stepUp(ana)).toBe(204);
    expect(reset(ana, caio.userId)).toBe(204);
    api.openSession(caio.userId);
    expect(reset(ana, caio.userId)).toBe(204); // ainda dentro da janela de 5 min
    expect(api.activeSessions(caio.userId)).toBe(0);
    expect(api.adminWrites).toHaveLength(2);
    expect(notices().filter(([, k]) => k === 'mfa-reset-notice')).toHaveLength(2);
  });

  it('janela do step-up: 5 min NA MESMA sessão; outra sessão da mesma pessoa não aproveita', () => {
    const ana = session('ana@nekkora.dev');
    const caio = acc('operador@nekkora.dev').userId;
    expect(reset(ana, caio)).toBe(403); // sem step-up
    expect(stepUp(ana)).toBe(204);
    const outraSessao = session('ana@nekkora.dev');
    expect(reset(outraSessao, caio)).toBe(403);
    now = T0 + 5 * 60_000;
    expect(reset(ana, caio)).toBe(403); // venceu
    expect(stepUp(ana)).toBe(204); // passo novo do relógio
    expect(reset(ana, caio)).toBe(204);
  });

  it('ordem e recusas: 401 → CSRF 403 → UUID/motivo 400 → permissão 403 → própria conta 403 → alvo 404 → step-up 403', () => {
    const ana = session('ana@nekkora.dev');
    const caio = acc('operador@nekkora.dev').userId;
    expect(reset(null, caio)).toBe(401);
    expect(reset(ana, caio, 'OUTRO', { csrf: 'x'.repeat(43) })).toBe(403);
    expect(reset(ana, 'nao-e-uuid')).toBe(400);
    expect(reset(ana, caio, null)).toBe(400);
    expect(reset(ana, caio, 'PERDI')).toBe(400);
    const bruna = session('gestora@nekkora.dev');
    expect(stepUp(bruna)).toBe(204);
    expect(reset(bruna, caio)).toBe(403); // sem identity.mfa.reset, mesmo com step-up
    expect(reset(bruna, stableUuid('nao-existe'))).toBe(403); // a permissão vem antes do alvo
    expect(reset(ana, acc('ana@nekkora.dev').userId)).toBe(403); // própria conta
    expect(reset(ana, stableUuid('nao-existe'))).toBe(404); // alvo antes do step-up
    expect(reset(ana, acc('vizinha@nekkora.dev', OTHER_ORG).userId)).toBe(404);
    expect(reset(ana, caio)).toBe(403); // sem step-up
    expect(api.adminWrites).toEqual([]);
    expect(acc('operador@nekkora.dev').totpSecret).toBe(DEV_TOTP_SECRET);
  });

  it('depois do reset, o próximo login do alvo pede cadastro do autenticador (mfa_enrollment_required)', () => {
    const ana = session('ana@nekkora.dev');
    const caio = acc('operador@nekkora.dev');
    expect(stepUp(ana)).toBe(204);
    expect(reset(ana, caio.userId)).toBe(204);
    const pre = api.handle({ method: 'GET', path: '/api/v1/csrf', expectedOrigin: 'http://localhost', cookies: {}, body: undefined });
    const preCookie = /__Host-nekkora_pre=([^;]+)/.exec(pre.cookies[0])![1];
    const res = api.handle({
      method: 'POST',
      path: `/api/v1/o/${DEV_ORG}/auth/login`,
      origin: 'http://localhost',
      expectedOrigin: 'http://localhost',
      csrf: (pre.body as { csrfToken: string }).csrfToken,
      cookies: { '__Host-nekkora_pre': preCookie },
      body: { email: caio.email, password: caio.password },
    });
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('mfa_enrollment_required');
  });
});
