/**
 * F1: clientes por domínio da API v1 (caminhos, query no formato do contrato, CSRF só nas escritas).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revokeClientGrant, listClientGrants, listMembers, resetUserMfa, suspendUser, reactivateUser, listClients } from './admin';
import { stepUp } from './auth';
import { csrfStore } from './csrf';
import { ApiError } from './http';
import { effectiveInWorkspace, getMyPermissions, listMyWorkspacePermissions } from './permissions';
import { portalGetExecution, portalListExecutionEvents, portalListExecutions, portalListWorkspaces } from './portal';
import { getAutomation, getExecution, getWorkspace, listAutomations, listAutomationVersions, listExecutionEvents, listExecutions, listWorkspaces } from './product';
import { queryString } from './query';
import type { MyPermissions } from './v1';
import * as fx from '../test/contractFixtures';

const ORG = '3f2a1c9e-5b7d-4e21-9c61-2e4d8f7a91c0';
const W = 'e9b0c7a2-1111-4a22-8b33-0c44d55e66f7';

interface Call {
  url: string;
  method: string;
  csrf?: string;
  body?: unknown;
}

let calls: Call[];
let responder: (url: string) => { status: number; body?: unknown };

beforeEach(() => {
  csrfStore.clear();
  calls = [];
  responder = (url) => ({ status: 200, body: conforming(url) });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', csrf: headers['X-CSRF-Token'], body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = responder(url);
      return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** Resposta conforme ao contrato para o caminho (o cliente valida as respostas desde a F2). */
function conforming(url: string): unknown {
  const path = url.split('?')[0];
  if (/\/portal\/api\/v1\/o\/[^/]+\/executions\/[^/]+$/.test(path)) return fx.portalExecution;
  if (path.startsWith('/portal/') && /\/(workspaces|events)$/.test(path)) return { items: [] };
  if (/\/workspaces\/[^/]+$/.test(path)) return fx.workspace;
  if (/\/automations\/[^/]+$/.test(path)) return fx.automation;
  if (/\/executions\/[^/]+$/.test(path)) return fx.executionDetail;
  if (/\/me\/permissions$/.test(path)) return fx.myPermissions;
  return fx.emptyPage;
}

describe('queryString', () => {
  it('repete listas, omite vazios e serializa datas em ISO com fuso', () => {
    expect(queryString({ status: ['pending', 'failed'], workspaceId: undefined, cursor: '', limit: 25 })).toBe('?status=pending&status=failed&limit=25');
    expect(queryString({ from: new Date('2026-10-01T03:00:00Z') })).toBe('?from=2026-10-01T03%3A00%3A00.000Z');
    expect(queryString({})).toBe('');
  });
});

describe('leituras (GET, sem CSRF)', () => {
  it('produto: caminhos e filtros do contrato', async () => {
    await listWorkspaces(ORG, { status: ['active', 'archived'], limit: 10 });
    await getWorkspace(ORG, W);
    await listAutomations(ORG, W, { cursor: 'abc.def' });
    await getAutomation(ORG, 'a1');
    await listAutomationVersions(ORG, 'a1', { limit: 5 });
    await listExecutions(ORG, { workspaceId: W, status: ['failed'], from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00-03:00' });
    await getExecution(ORG, 'x1');
    await listExecutionEvents(ORG, 'x1');
    const base = `/api/v1/o/${ORG}`;
    expect(calls.map((c) => c.url)).toEqual([
      `${base}/workspaces?status=active&status=archived&limit=10`,
      `${base}/workspaces/${W}`,
      `${base}/workspaces/${W}/automations?cursor=abc.def`,
      `${base}/automations/a1`,
      `${base}/automations/a1/versions?limit=5`,
      `${base}/executions?workspaceId=${W}&status=failed&from=2026-10-01T00%3A00%3A00Z&to=2026-10-02T00%3A00%3A00-03%3A00`,
      `${base}/executions/x1`,
      `${base}/executions/x1/events`,
    ]);
    expect(calls.every((c) => c.method === 'GET' && c.csrf === undefined)).toBe(true);
  });

  it('permissões e administração', async () => {
    await getMyPermissions(ORG);
    await listMyWorkspacePermissions(ORG, { limit: 50 });
    await listMembers(ORG, { status: ['active'] });
    await listClientGrants(ORG, { clientId: 'c1', status: ['revoked'] });
    await listClients(ORG);
    const base = `/api/v1/o/${ORG}`;
    expect(calls.map((c) => c.url)).toEqual([
      `${base}/me/permissions`,
      `${base}/me/permissions/workspaces?limit=50`,
      `${base}/members?status=active`,
      `${base}/client-grants?clientId=c1&status=revoked`,
      `${base}/clients`,
    ]);
  });

  it('portal externo usa /portal/api/v1 e devolve as listas sem paginação', async () => {
    responder = (url) => ({
      status: 200,
      body: url.endsWith('/workspaces')
        ? { items: [fx.portalWorkspace] }
        : url.endsWith('/events')
          ? { items: [fx.portalEvent] }
          : url.endsWith('/x1')
            ? fx.portalExecution
            : { items: [fx.portalExecution], nextCursor: null },
    });
    expect(await portalListWorkspaces(ORG)).toEqual([fx.portalWorkspace]);
    await portalListExecutions(ORG, { limit: 10 });
    await portalGetExecution(ORG, 'x1');
    expect(await portalListExecutionEvents(ORG, 'x2')).toEqual([fx.portalEvent]);
    expect(calls.map((c) => c.url)).toEqual([
      `/portal/api/v1/o/${ORG}/workspaces`,
      `/portal/api/v1/o/${ORG}/executions?limit=10`,
      `/portal/api/v1/o/${ORG}/executions/x1`,
      `/portal/api/v1/o/${ORG}/executions/x2/events`,
    ]);
  });

  it('erros do contrato chegam tipados (404 sem distinguir inexistente de sem acesso)', async () => {
    responder = () => ({ status: 404, body: { error: 'not_found' } });
    await expect(getExecution(ORG, 'x9')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    responder = () => ({ status: 403, body: { error: 'forbidden' } });
    await expect(listMembers(ORG)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('escritas (sessão + CSRF de sessão)', () => {
  it('usam o CSRF da sessão em memória ou o recuperam de GET …/auth/csrf', async () => {
    responder = (url) => (url.endsWith('/auth/csrf') ? { status: 200, body: { csrfToken: 'csrf-sessao' } } : { status: 204 });
    await revokeClientGrant(ORG, 'g1');
    await suspendUser(ORG, 'u1');
    await reactivateUser(ORG, 'u1');
    await stepUp(ORG, '123456');
    await resetUserMfa(ORG, 'u1', 'DISPOSITIVO_PERDIDO');
    const base = `/api/v1/o/${ORG}`;
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${base}/auth/csrf`,
      `POST ${base}/client-grants/g1/revoke`,
      `POST ${base}/users/u1/suspend`,
      `POST ${base}/users/u1/reactivate`,
      `POST ${base}/auth/mfa/step-up`,
      `POST ${base}/users/u1/mfa/reset`,
    ]);
    expect(calls.filter((c) => c.method === 'POST').every((c) => c.csrf === 'csrf-sessao')).toBe(true);
    expect(calls.find((c) => c.url.endsWith('/step-up'))?.body).toEqual({ code: '123456' });
    expect(calls.find((c) => c.url.endsWith('/mfa/reset'))?.body).toEqual({ reason: 'DISPOSITIVO_PERDIDO' });
  });
});

describe('effectiveInWorkspace', () => {
  it('une allWorkspaces e as permissões explícitas do workspace', () => {
    const me = { allWorkspaces: { permissions: ['automation.read'] } } as unknown as MyPermissions;
    const eff = effectiveInWorkspace(me, { workspaceId: W, roles: ['OPERATOR'], permissions: ['automation.execute', 'automation.read'] });
    expect([...eff].sort()).toEqual(['automation.execute', 'automation.read']);
    expect([...effectiveInWorkspace(me, undefined)]).toEqual(['automation.read']);
  });
});
