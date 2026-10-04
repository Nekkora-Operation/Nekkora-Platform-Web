/**
 * F2: os clientes da API v1 (com validação em execução) contra a API simulada, ponta a ponta no processo:
 * o que o mock responde passa pela validação do cliente, e uma página pode ser percorrida pelo useCursorList.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ORG, MockApi } from '../../mock/contract';
import { stableUuid } from '../../mock/product';
import { useCursorList } from '../hooks/useCursorList';
import { ContractViolation } from './validate';
import { getMyPermissions, listMyWorkspacePermissions } from './permissions';
import { getAutomation, getExecution, getWorkspace, listAutomations, listAutomationVersions, listExecutionEvents, listExecutions, listWorkspaces } from './product';

let api: MockApi;
let sessionCookie = '';
/** Adultera a resposta do mock (controle: resposta fora do contrato chegando ao cliente). */
let tamper: ((path: string, body: any) => any) | undefined;
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

function login(email: string) {
  const a = [...api.accounts.values()].find((x) => x.email === email)!;
  sessionCookie = api.openSession(a.userId);
}

beforeEach(() => {
  api = new MockApi(() => NOW);
  tamper = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const out = api.handle({
        method: 'GET',
        path: url.pathname,
        expectedOrigin: 'http://localhost',
        cookies: { '__Host-nekkora_session': sessionCookie },
        body: undefined,
        query: url.searchParams,
      });
      const body = tamper && out.status === 200 ? tamper(url.pathname + url.search, out.body) : out.body;
      return new Response(body === undefined ? null : JSON.stringify(body), { status: out.status, headers: out.headers });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('clientes contra o mock', () => {
  it('todas as leituras de produto e permissões passam pela validação do cliente', async () => {
    login('gestora@nekkora.dev');
    const me = await getMyPermissions(DEV_ORG);
    expect(me.hasWorkspaceAssignments).toBe(true);
    expect((await listMyWorkspacePermissions(DEV_ORG)).items).toHaveLength(2);
    const workspaces = await listWorkspaces(DEV_ORG);
    for (const w of workspaces.items) {
      await getWorkspace(DEV_ORG, w.workspaceId);
      for (const a of (await listAutomations(DEV_ORG, w.workspaceId)).items) {
        await getAutomation(DEV_ORG, a.automationId);
        await listAutomationVersions(DEV_ORG, a.automationId);
      }
    }
    const executions = await listExecutions(DEV_ORG, { status: ['failed', 'succeeded'], limit: 10 });
    expect(executions.items).toHaveLength(10);
    await getExecution(DEV_ORG, executions.items[0].executionId);
    await listExecutionEvents(DEV_ORG, executions.items[0].executionId);
  });

  it('erros do mock chegam tipados ao cliente (403 conta externa, 404 sem acesso, 400 cursor rotacionado)', async () => {
    login('portal@nekkora.dev');
    await expect(listExecutions(DEV_ORG)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    login('operador@nekkora.dev');
    await expect(getWorkspace(DEV_ORG, stableUuid('dev:ws:financeiro'))).rejects.toMatchObject({ code: 'not_found' });
    const p1 = await listExecutions(DEV_ORG, { limit: 2 });
    api.product.cursors.rotate();
    await expect(listExecutions(DEV_ORG, { limit: 2, cursor: p1.nextCursor! })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('useCursorList percorre a lista do mock até o fim e trata a rotação oferecendo recomeço', async () => {
    login('operador@nekkora.dev');
    const { result } = renderHook(() => useCursorList((cursor) => listExecutions(DEV_ORG, { limit: 50, cursor }), (e) => e.executionId, []));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    while (result.current.hasMore) {
      const before = result.current.items.length;
      act(() => result.current.loadMore());
      await waitFor(() => expect(result.current.items.length).toBeGreaterThan(before));
      await waitFor(() => expect(result.current.status).toBe('ready'));
    }
    const all = result.current.items;
    expect(new Set(all.map((e) => e.executionId)).size).toBe(all.length);

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.items).toHaveLength(50));
    api.product.cursors.rotate();
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.cursorRejected).toBe(true));
    expect(result.current.items).toHaveLength(50);
    expect(result.current.hasMore).toBe(false);
  });

  it('resposta fora do contrato ao carregar mais: erro de contrato, lista anterior intacta, nada anexado, sem cursor recusado e sem repetir', async () => {
    login('operador@nekkora.dev');
    const calls: string[] = [];
    tamper = (path, body) => {
      calls.push(path);
      // segunda página: o 1º item vem válido, o 2º sem campo obrigatório (nada pode ser anexado parcialmente)
      if (path.includes('cursor=')) {
        const { status: _s, ...broken } = body.items[1];
        return { ...body, items: [body.items[0], broken, ...body.items.slice(2)] };
      }
      return body;
    };
    const { result } = renderHook(() => useCursorList((cursor) => listExecutions(DEV_ORG, { limit: 10, cursor }), (e) => e.executionId, []));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const firstPage = result.current.items.map((e) => e.executionId);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error).toBeInstanceOf(ContractViolation);
    expect((result.current.error as ContractViolation).code).toBe('unexpected');
    expect((result.current.error as ContractViolation).violations).toEqual([{ path: '$.items[1]', rule: 'required status' }]);
    expect(result.current.items.map((e) => e.executionId)).toEqual(firstPage);
    expect(result.current.cursorRejected).toBe(false);
    expect(result.current.hasMore).toBe(true); // pode tentar de novo, por ação explícita
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.includes('cursor='))).toHaveLength(1); // nenhuma repetição automática
  });

  it('primeira página fora do contrato: estado de erro (não vira lista vazia)', async () => {
    login('operador@nekkora.dev');
    tamper = (_path, body) => ({ items: body.items }); // sem nextCursor
    const { result } = renderHook(() => useCursorList((cursor) => listExecutions(DEV_ORG, { cursor }), (e) => e.executionId, []));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeInstanceOf(ContractViolation);
    expect(result.current.items).toEqual([]);
  });
});
