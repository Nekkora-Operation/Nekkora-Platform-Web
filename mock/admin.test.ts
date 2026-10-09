/**
 * F6a-1: a API simulada da leitura administrativa (membros, concessões, clientes) confere com o contrato e com as regras
 * do backend (AdminReadController). TODA resposta é conferida pelos dois validadores (o do cliente, estrito, e o Ajv
 * 2020-12), como na F2. Relógio fixo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { responseViolations, type OperationId } from '../src/api/validate';
import { ajvValidate } from '../src/test/ajvContract';
import { DEV_ORG, MockApi, OTHER_ORG } from './contract';
import { stableUuid } from './product';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
let api: MockApi;
const cookie: Record<string, string> = {};

const OPS: [RegExp, OperationId][] = [
  [/^\/members$/, 'listMembers'],
  [/^\/client-grants$/, 'listClientGrants'],
  [/^\/clients$/, 'listClients'],
];
const opFor = (route: string) => OPS.find(([re]) => re.test(route))![1];

function login(email: string, org = DEV_ORG) {
  const a = [...api.accounts.values()].find((x) => x.email === email && x.org === org)!;
  cookie[email] = api.openSession(a.userId);
}

function get(who: string | null, path: string, org = DEV_ORG) {
  const [p, qs] = path.split('?');
  const res = api.handle({
    method: 'GET',
    path: `/api/v1/o/${org}${p}`,
    expectedOrigin: 'http://localhost',
    cookies: who ? { '__Host-nekkora_session': cookie[who] } : {},
    body: undefined,
    query: new URLSearchParams(qs ?? ''),
  });
  const op = opFor(p);
  expect(responseViolations(op, { status: res.status, contentType: res.headers['Content-Type'], body: res.body }), `${op} ${res.status} ${path}`).toEqual([]);
  expect(ajvValidate(op, res.status, res.body).errors, `${op} ${res.status} ${path} (Ajv)`).toEqual([]);
  return { status: res.status, body: res.body as any };
}

function ok(who: string, path: string, org = DEV_ORG) {
  const r = get(who, path, org);
  expect(r.status, path).toBe(200);
  return r.body;
}

function all(who: string, path: string, limit: number, org = DEV_ORG) {
  const out: any[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const body = ok(who, `${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, org);
    expect(body.items.length).toBeLessThanOrEqual(limit);
    out.push(...body.items);
    cursor = body.nextCursor;
  } while (cursor);
  return out;
}

beforeEach(() => {
  api = new MockApi(() => NOW);
  for (const k of Object.keys(cookie)) delete cookie[k];
  for (const e of ['ana@nekkora.dev', 'gestora@nekkora.dev', 'sematribuicao@nekkora.dev', 'portal@nekkora.dev']) login(e);
  login('vizinha@nekkora.dev', OTHER_ORG);
});

describe('membros (listMembers)', () => {
  it('ORG_ADMIN lista todos os membros internos, em createdAt asc + membershipId asc, em mais de uma página; sem externos', () => {
    const first = ok('ana@nekkora.dev', '/members');
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const items = all('ana@nekkora.dev', '/members', 7);
    const internos = [...api.accounts.values()].filter((a) => a.org === DEV_ORG && a.accountType === 'internal');
    expect(items).toHaveLength(internos.length);
    expect(items.length).toBeGreaterThan(25);
    const keys = items.map((m) => [Date.parse(m.createdAt), m.membershipId] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    expect(keys).toEqual(sorted);
    expect(items.map((m) => m.email)).not.toContain('portal@nekkora.dev');
    expect(new Set(items.map((m) => m.membershipId)).size).toBe(items.length);
  });

  it('estados de conta e de vínculo, MFA e papel organizacional vêm como o contrato define', () => {
    const items = all('ana@nekkora.dev', '/members', 100);
    const by = (e: string) => items.find((m) => m.email === e);
    expect(by('ana@nekkora.dev')).toMatchObject({ organizationRoles: ['ORG_ADMIN'], mfaConfigured: true, accountStatus: 'active', membershipStatus: 'active' });
    expect(by('gestora@nekkora.dev').organizationRoles).toEqual([]);
    expect(by('suspensa@nekkora.dev')).toMatchObject({ accountStatus: 'suspended', membershipStatus: 'active' });
    expect(by('desligado@nekkora.dev')).toMatchObject({ membershipStatus: 'revoked' });
    expect(by('convite@nekkora.dev')).toMatchObject({ accountStatus: 'pending', membershipStatus: 'pending', emailVerified: false });
    expect(by('encerrada@nekkora.dev')).toMatchObject({ accountStatus: 'closed', membershipStatus: 'suspended' });
    expect(by('novo@nekkora.dev').mfaConfigured).toBe(false);
  });

  it('filtro de estado (vários) e cursor vinculado ao filtro', () => {
    const revoked = all('ana@nekkora.dev', '/members?status=revoked', 100);
    expect(revoked.map((m) => m.email)).toEqual(['desligado@nekkora.dev']);
    const two = all('ana@nekkora.dev', '/members?status=pending&status=suspended', 100);
    expect(new Set(two.map((m) => m.membershipStatus))).toEqual(new Set(['pending', 'suspended']));
    const page = ok('ana@nekkora.dev', '/members?limit=2');
    expect(get('ana@nekkora.dev', `/members?status=active&cursor=${encodeURIComponent(page.nextCursor)}`).status).toBe(400);
    for (const bad of ['status=ativo', 'status=active&status=active', 'limit=0', 'limit=101', 'cursor=x.y']) {
      expect(get('ana@nekkora.dev', `/members?${bad}`).status, bad).toBe(400);
    }
  });

  it('rotação da chave invalida o cursor; a primeira página continua', () => {
    const page = ok('ana@nekkora.dev', '/members?limit=5');
    api.product.cursors.rotate();
    expect(get('ana@nekkora.dev', `/members?limit=5&cursor=${encodeURIComponent(page.nextCursor)}`).status).toBe(400);
    expect(get('ana@nekkora.dev', '/members?limit=5').status).toBe(200);
  });

  it('autorização: sem sessão 401; sem org.manage 403; conta externa 403; ordem 401 → 400 → 403', () => {
    expect(get(null, '/members').status).toBe(401);
    expect(get('gestora@nekkora.dev', '/members').status).toBe(403);
    expect(get('sematribuicao@nekkora.dev', '/members').status).toBe(403);
    expect(get('portal@nekkora.dev', '/members').status).toBe(403);
    expect(get('gestora@nekkora.dev', '/members?limit=0').status).toBe(400);
    expect(get(null, '/members?limit=0').status).toBe(401);
  });

  it('isolamento: a sessão de uma organização não lê a outra (401); cada ORG_ADMIN vê só os seus membros', () => {
    expect(get('ana@nekkora.dev', '/members', OTHER_ORG).status).toBe(401);
    const viz = all('vizinha@nekkora.dev', '/members', 100, OTHER_ORG);
    expect(viz.map((m) => m.email)).toEqual(['vizinha@nekkora.dev']);
  });
});

describe('clientes (listClients)', () => {
  it('ordem por ponto de código (Ômega depois dos ASCII), três estados, filtro e paginação', () => {
    const items = all('ana@nekkora.dev', '/clients', 1);
    expect(items.map((c) => c.name)).toEqual(['ACME Logística', 'Banco Exemplo S.A.', 'Clínica Exemplo', 'Ômega Indústria']);
    expect(items.map((c) => c.status)).toEqual(['active', 'active', 'suspended', 'archived']);
    expect(all('ana@nekkora.dev', '/clients?status=archived&status=suspended', 100).map((c) => c.name)).toEqual(['Clínica Exemplo', 'Ômega Indústria']);
    expect(get('ana@nekkora.dev', '/clients?status=revoked').status).toBe(400);
  });

  it('autorização (org.manage OU external_access.manage) e isolamento', () => {
    expect(get('gestora@nekkora.dev', '/clients').status).toBe(403);
    expect(get('portal@nekkora.dev', '/clients').status).toBe(403);
    expect(all('vizinha@nekkora.dev', '/clients', 100, OTHER_ORG).map((c) => c.name)).toEqual(['Cliente Vizinho']);
  });
});

describe('concessões (listClientGrants)', () => {
  const client = (k: string, key = 'dev') => stableUuid(`${key}:client:${k}`);
  const ws = (k: string, key = 'dev') => stableUuid(`${key}:ws:${k}`);

  it('createdAt desc + grantId desc; quatro estados; campos da conta externa', () => {
    const items = all('ana@nekkora.dev', '/client-grants', 2);
    expect(items).toHaveLength(6);
    const times = items.map((g) => Date.parse(g.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(new Set(items.map((g) => g.status))).toEqual(new Set(['pending', 'active', 'suspended', 'revoked']));
    const revoked = items.find((g) => g.status === 'revoked');
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.externalAccount.email).toBe('portal@nekkora.dev');
    const pending = items.find((g) => g.status === 'pending');
    expect(pending.approvedAt).toBeNull();
  });

  it('filtros de cliente, workspace e estado; de outra organização ou inexistente → 200 vazio (DC-05); malformado → 400', () => {
    expect(all('ana@nekkora.dev', `/client-grants?clientId=${client('acme')}`, 100)).toHaveLength(3);
    expect(all('ana@nekkora.dev', `/client-grants?workspaceId=${ws('logistica')}`, 100)).toHaveLength(2);
    expect(all('ana@nekkora.dev', `/client-grants?clientId=${client('banco')}&status=active`, 100)).toHaveLength(2);
    expect(ok('ana@nekkora.dev', `/client-grants?clientId=${client('vizinho', 'vizinha')}`)).toEqual({ items: [], nextCursor: null });
    expect(ok('ana@nekkora.dev', `/client-grants?workspaceId=${stableUuid('nao-existe')}`)).toEqual({ items: [], nextCursor: null });
    expect(get('ana@nekkora.dev', '/client-grants?clientId=nao-e-uuid').status).toBe(400);
    const page = ok('ana@nekkora.dev', '/client-grants?limit=1');
    expect(get('ana@nekkora.dev', `/client-grants?status=active&cursor=${encodeURIComponent(page.nextCursor)}`).status).toBe(400);
  });

  it('autorização (external_access.manage) e isolamento', () => {
    expect(get('gestora@nekkora.dev', '/client-grants').status).toBe(403);
    expect(get('portal@nekkora.dev', '/client-grants').status).toBe(403);
    expect(get(null, '/client-grants').status).toBe(401);
    const viz = all('vizinha@nekkora.dev', '/client-grants', 100, OTHER_ORG);
    expect(viz.map((g) => g.externalAccount.email)).toEqual(['contato@vizinho.dev']);
  });
});

describe('contas da massa', () => {
  it('vínculo revogado ou pendente e conta suspensa ou encerrada não entram (mesma resposta genérica)', () => {
    for (const email of ['desligado@nekkora.dev', 'convite@nekkora.dev', 'suspensa@nekkora.dev', 'encerrada@nekkora.dev']) {
      const pre = api.handle({ method: 'GET', path: '/api/v1/csrf', expectedOrigin: 'http://localhost', cookies: {}, body: undefined });
      const preCookie = /__Host-nekkora_pre=([^;]+)/.exec(pre.cookies[0])![1];
      const res = api.handle({
        method: 'POST',
        path: `/api/v1/o/${DEV_ORG}/auth/login`,
        origin: 'http://localhost',
        expectedOrigin: 'http://localhost',
        csrf: (pre.body as { csrfToken: string }).csrfToken,
        cookies: { '__Host-nekkora_pre': preCookie },
        body: { email, password: 'Nekkora-Dev-2026' },
      });
      expect(res.status, email).toBe(401);
    }
  });
});
