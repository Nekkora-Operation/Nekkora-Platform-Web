/**
 * F6a-2: suspensão e reativação na API simulada conferem com o contrato e com o AdminService. Toda resposta passa
 * pelos dois validadores (cliente estrito e Ajv). Relógio fixo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { responseViolations, type OperationId } from '../src/api/validate';
import { ajvValidate } from '../src/test/ajvContract';
import { DEV_ORG, MockApi, OTHER_ORG } from './contract';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
let api: MockApi;

const acc = (email: string, org = DEV_ORG) => [...api.accounts.values()].find((a) => a.email === email && a.org === org)!;

function session(email: string, org = DEV_ORG) {
  const cookie = api.openSession(acc(email, org).userId);
  const r = api.handle({ method: 'GET', path: `/api/v1/o/${org}/auth/csrf`, expectedOrigin: 'http://localhost', cookies: { '__Host-nekkora_session': cookie }, body: undefined });
  return { cookie, csrf: (r.body as { csrfToken: string }).csrfToken };
}

function post(s: { cookie: string; csrf: string } | null, action: 'suspend' | 'reactivate', target: string, { org = DEV_ORG, origin = 'http://localhost', csrf }: { org?: string; origin?: string; csrf?: string } = {}) {
  const res = api.handle({
    method: 'POST',
    path: `/api/v1/o/${org}/users/${target}/${action}`,
    origin,
    expectedOrigin: 'http://localhost',
    csrf: csrf ?? s?.csrf,
    cookies: s ? { '__Host-nekkora_session': s.cookie } : {},
    body: undefined,
  });
  const op: OperationId = action === 'suspend' ? 'suspendUser' : 'reactivateUser';
  expect(responseViolations(op, { status: res.status, contentType: res.headers['Content-Type'], body: res.body }), `${op} ${res.status}`).toEqual([]);
  // 204 não tem corpo nem esquema (o validador do cliente já confere a ausência de corpo); o Ajv vale para os erros
  if (res.status === 204) expect(res.body).toBeUndefined();
  else expect(ajvValidate(op, res.status, res.body).errors, `${op} ${res.status} (Ajv)`).toEqual([]);
  return res.status;
}

beforeEach(() => {
  api = new MockApi(() => NOW);
});

describe('suspender e reativar (AdminService)', () => {
  it('suspende: conta suspensa, sessões do alvo encerradas; reativa: conta ativa SEM restaurar sessões; idempotentes', () => {
    const ana = session('ana@nekkora.dev');
    const target = acc('operador@nekkora.dev');
    api.openSession(target.userId);
    expect(api.activeSessions(target.userId)).toBe(1);
    expect(post(ana, 'suspend', target.userId)).toBe(204);
    expect(target.active).toBe(false);
    expect(api.activeSessions(target.userId)).toBe(0);
    expect(post(ana, 'suspend', target.userId)).toBe(204);
    expect(post(ana, 'reactivate', target.userId)).toBe(204);
    expect(target.active).toBe(true);
    expect(api.activeSessions(target.userId)).toBe(0);
    expect(api.adminWrites.map((w) => w.action)).toEqual(['suspend', 'suspend', 'reactivate']);
  });

  it('ordem e recusas: sem sessão 401; Origin ou CSRF errados 403; UUID malformado 400; sem org.manage 403; externa 403; alvo = ator 403; fora da organização 404', () => {
    const ana = session('ana@nekkora.dev');
    const target = acc('operador@nekkora.dev').userId;
    expect(post(null, 'suspend', target)).toBe(401);
    expect(post(ana, 'suspend', target, { origin: 'http://outro.exemplo' })).toBe(403);
    expect(post(ana, 'suspend', target, { csrf: 'errado' })).toBe(403);
    expect(post(ana, 'suspend', 'nao-e-uuid')).toBe(400);
    expect(post(session('gestora@nekkora.dev'), 'suspend', target)).toBe(403);
    expect(post(session('portal@nekkora.dev'), 'suspend', target)).toBe(403);
    expect(post(ana, 'suspend', acc('ana@nekkora.dev').userId)).toBe(403);
    expect(post(ana, 'suspend', acc('vizinha@nekkora.dev', OTHER_ORG).userId)).toBe(404);
    expect(post(ana, 'reactivate', '00000000-0000-4000-8000-000000000000')).toBe(404);
    expect(post(ana, 'suspend', target, { org: OTHER_ORG })).toBe(401);
    expect(api.adminWrites).toEqual([]);
    expect(acc('operador@nekkora.dev').active).toBe(true);
  });

  it('conta suspensa não entra; reativada volta a entrar', () => {
    const ana = session('ana@nekkora.dev');
    const target = acc('leitora@nekkora.dev');
    expect(post(ana, 'suspend', target.userId)).toBe(204);
    const login = () => {
      const pre = api.handle({ method: 'GET', path: '/api/v1/csrf', expectedOrigin: 'http://localhost', cookies: {}, body: undefined });
      return api.handle({
        method: 'POST',
        path: `/api/v1/o/${DEV_ORG}/auth/login`,
        origin: 'http://localhost',
        expectedOrigin: 'http://localhost',
        csrf: (pre.body as { csrfToken: string }).csrfToken,
        cookies: { '__Host-nekkora_pre': /__Host-nekkora_pre=([^;]+)/.exec(pre.cookies[0])![1] },
        body: { email: target.email, password: target.password },
      }).status;
    };
    expect(login()).toBe(401);
    expect(post(ana, 'reactivate', target.userId)).toBe(204);
    expect(login()).toBe(200);
  });
});
