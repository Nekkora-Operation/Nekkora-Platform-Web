/**
 * F6a-3: revogação de concessão na API simulada confere com o contrato e com o AdminService.revokeGrant. Toda resposta
 * passa pelos dois validadores (cliente estrito e Ajv). Relógio fixo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { responseViolations } from '../src/api/validate';
import { ajvValidate } from '../src/test/ajvContract';
import { DEV_ORG, MockApi, OTHER_ORG } from './contract';
import { stableUuid } from './product';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
let api: MockApi;

const acc = (email: string, org = DEV_ORG) => [...api.accounts.values()].find((a) => a.email === email && a.org === org)!;
const grant = (k: string, key = 'dev') => stableUuid(`${key}:grant:${k}`);

function session(email: string, org = DEV_ORG) {
  const cookie = api.openSession(acc(email, org).userId);
  const r = api.handle({ method: 'GET', path: `/api/v1/o/${org}/auth/csrf`, expectedOrigin: 'http://localhost', cookies: { '__Host-nekkora_session': cookie }, body: undefined });
  return { cookie, csrf: (r.body as { csrfToken: string }).csrfToken };
}

function revoke(s: { cookie: string; csrf: string } | null, target: string, { org = DEV_ORG, origin = 'http://localhost', csrf }: { org?: string; origin?: string; csrf?: string } = {}) {
  const res = api.handle({
    method: 'POST',
    path: `/api/v1/o/${org}/client-grants/${target}/revoke`,
    origin,
    expectedOrigin: 'http://localhost',
    csrf: csrf ?? s?.csrf,
    cookies: s ? { '__Host-nekkora_session': s.cookie } : {},
    body: undefined,
  });
  expect(responseViolations('revokeClientGrant', { status: res.status, contentType: res.headers['Content-Type'], body: res.body }), `revoke ${res.status}`).toEqual([]);
  // 204 não tem corpo nem esquema; o Ajv vale para os erros
  if (res.status === 204) expect(res.body).toBeUndefined();
  else expect(ajvValidate('revokeClientGrant', res.status, res.body).errors, `revoke ${res.status} (Ajv)`).toEqual([]);
  return res.status;
}

beforeEach(() => {
  api = new MockApi(() => NOW);
});

describe('revogar concessão (AdminService.revokeGrant)', () => {
  it('ativa, suspensa e pendente passam a revogada (status e revokedAt); o resto não muda', () => {
    const ana = session('ana@nekkora.dev');
    for (const k of ['g1', 'g2', 'g5']) {
      const before = { ...api.admin.grants.get(grant(k))! };
      expect(revoke(ana, grant(k)), k).toBe(204);
      const after = api.admin.grants.get(grant(k))!;
      expect(after.status, k).toBe('revoked');
      expect(after.revokedAt, k).toBe(NOW);
      expect({ ...after, status: before.status, revokedAt: before.revokedAt }, k).toEqual(before);
    }
    expect(api.adminWrites.map((w) => [w.action, w.target])).toEqual([['revoke', grant('g1')], ['revoke', grant('g2')], ['revoke', grant('g5')]]);
  });

  it('já revogada: 204 sem alterar nada (idempotente), inclusive repetida', () => {
    const ana = session('ana@nekkora.dev');
    const before = { ...api.admin.grants.get(grant('g3'))! };
    expect(revoke(ana, grant('g3'))).toBe(204);
    expect(revoke(ana, grant('g3'))).toBe(204);
    expect(api.admin.grants.get(grant('g3'))).toEqual(before);
    expect(revoke(ana, grant('g1'))).toBe(204);
    const once = api.admin.grants.get(grant('g1'))!.revokedAt;
    expect(revoke(ana, grant('g1'))).toBe(204);
    expect(api.admin.grants.get(grant('g1'))!.revokedAt).toBe(once);
  });

  it('ordem e recusas: sem sessão 401; Origin ou CSRF errados 403; UUID malformado 400; sem permissão 403; externa 403; inexistente ou de outra organização 404', () => {
    const ana = session('ana@nekkora.dev');
    expect(revoke(null, grant('g1'))).toBe(401);
    expect(revoke(ana, grant('g1'), { origin: 'http://evil.example' })).toBe(403);
    expect(revoke(ana, grant('g1'), { csrf: 'x'.repeat(43) })).toBe(403);
    expect(revoke(ana, 'nao-e-uuid')).toBe(400);
    expect(revoke(session('gestora@nekkora.dev'), grant('g1'))).toBe(403);
    expect(revoke(session('portal@nekkora.dev'), grant('g1'))).toBe(403);
    expect(revoke(ana, stableUuid('nao-existe'))).toBe(404);
    expect(revoke(ana, grant('g1', 'vizinha'))).toBe(404);
    // sem permissão, nem a existência é revelada: 403 antes do 404
    expect(revoke(session('gestora@nekkora.dev'), stableUuid('nao-existe'))).toBe(403);
    expect(api.admin.grants.get(grant('g1'))!.status).toBe('active');
    expect(api.admin.grants.get(grant('g1', 'vizinha'))!.status).toBe('active');
    expect(api.adminWrites).toEqual([]);
  });

  it('isolamento: a vizinha revoga só a sua', () => {
    const viz = session('vizinha@nekkora.dev', OTHER_ORG);
    expect(revoke(viz, grant('g1'), { org: OTHER_ORG })).toBe(404);
    expect(revoke(viz, grant('g1', 'vizinha'), { org: OTHER_ORG })).toBe(204);
    expect(api.admin.grants.get(grant('g1'))!.status).toBe('active');
  });

  it('a leitura seguinte mostra a concessão revogada (contrato da listagem)', () => {
    const ana = session('ana@nekkora.dev');
    expect(revoke(ana, grant('g4'))).toBe(204);
    const res = api.handle({
      method: 'GET',
      path: `/api/v1/o/${DEV_ORG}/client-grants`,
      expectedOrigin: 'http://localhost',
      cookies: { '__Host-nekkora_session': ana.cookie },
      body: undefined,
      query: new URLSearchParams('status=revoked&limit=100'),
    });
    expect(responseViolations('listClientGrants', { status: res.status, contentType: res.headers['Content-Type'], body: res.body })).toEqual([]);
    const ids = (res.body as { items: { grantId: string }[] }).items.map((g) => g.grantId);
    expect(ids).toContain(grant('g4'));
  });
});
