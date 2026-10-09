/**
 * F6a-1-R1: 403 na CONTINUAÇÃO da lista (perda de permissão entre a primeira página e "Carregar mais") nas três telas
 * de administração, contra a API simulada (MockApi, relógio fixo). Controles: cursor recusado, falha transitória e 401
 * continuam com o tratamento próprio. Estes testes reprovam nas fontes da F6a-1 (R0).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ORG, MockApi } from '../../mock/contract';
import { stableUuid } from '../../mock/product';
import { AppRoutes } from '../app/AppRoutes';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 86_400_000;
const base = `/o/${DEV_ORG}`;

let api: MockApi;
let cookie = '';
let requests: string[] = [];
let statuses: [string, number][] = [];
let intercept: ((path: string) => { respond?: { status: number; body: unknown } } | undefined) | undefined;
let location = '';

function Probe() {
  const loc = useLocation();
  location = loc.pathname + loc.search;
  return null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  api = new MockApi(() => NOW);
  requests = [];
  statuses = [];
  intercept = undefined;
  location = '';
  csrfStore.clear();
  sessionMemory.reset();
  // mais de uma página também em clientes e concessões
  for (let i = 1; i <= 25; i++) {
    const n = String(i).padStart(2, '0');
    const clientId = stableUuid(`teste:cliente:${n}`);
    api.product.clients.set(clientId, { clientId, org: DEV_ORG, name: `Cliente Extra ${n}`, status: 'active', createdAt: NOW - 100 * DAY, updatedAt: NOW - 10 * DAY });
    const portal = [...api.accounts.values()].find((a) => a.email === 'portal@nekkora.dev')!;
    api.addGrant(DEV_ORG, 'dev', `extra${n}`, portal, 'acme', 'logistica', 'active', 200 + i);
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname + url.search;
      requests.push(path);
      const hook = intercept?.(path);
      if (hook?.respond) {
        statuses.push([path, hook.respond.status]);
        return new Response(JSON.stringify(hook.respond.body), { status: hook.respond.status, headers: { 'Content-Type': 'application/json' } });
      }
      const out = api.handle({
        method: init?.method ?? 'GET',
        path: url.pathname,
        origin: 'http://localhost',
        expectedOrigin: 'http://localhost',
        csrf: (init?.headers as Record<string, string> | undefined)?.['X-CSRF-Token'],
        cookies: { '__Host-nekkora_session': cookie },
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        query: url.searchParams,
      });
      statuses.push([path, out.status]);
      return new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status, headers: out.headers });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function signIn() {
  const ana = [...api.accounts.values()].find((x) => x.email === 'ana@nekkora.dev')!;
  cookie = api.openSession(ana.userId);
  return ana;
}

const SCREENS = [
  { name: 'Membros', path: `${base}/administracao/membros`, region: 'Lista de membros', route: '/members?', area: 'os membros desta organização', filters: 'Filtros de membros' },
  { name: 'Clientes', path: `${base}/administracao/clientes`, region: 'Lista de clientes', route: '/clients?', area: 'os clientes desta organização', filters: 'Filtros de clientes' },
  { name: 'Concessões', path: `${base}/administracao/concessoes`, region: 'Lista de concessões', route: '/client-grants?', area: 'as concessões desta organização', filters: 'Filtros de concessões' },
] as const;

/** Leituras da LISTA da tela (exclui o seletor de clientes das concessões, que pede limit=100). */
const listCalls = (route: string) => requests.filter((r) => r.includes(route) && !r.includes('limit=100'));

async function firstPage(s: (typeof SCREENS)[number]) {
  render(
    <MemoryRouter initialEntries={[s.path]}>
      <AppRoutes />
      <Probe />
    </MemoryRouter>,
  );
  await screen.findByRole('region', { name: s.region });
  expect(screen.getByRole('region', { name: s.region }).querySelectorAll('tbody tr')).toHaveLength(25);
  expect(screen.getByRole('button', { name: 'Carregar mais' })).toBeInTheDocument();
}

describe.each(SCREENS)('$name: 403 na continuação', (s) => {
  it('primeira página → perda de permissão → "Carregar mais" → 403: estado de acesso negado, sem dados, filtros nem paginação', async () => {
    const ana = signIn();
    await firstPage(s);
    api.product.revokeOrganizationRoles(ana.membershipId);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText(`Você não tem permissão para ver ${s.area}.`)).toBeInTheDocument();
    expect(statuses.filter(([p]) => p.includes(s.route) && p.includes('cursor=')).map(([, st]) => st)).toEqual([403]);
    expect(screen.queryByRole('region', { name: s.region })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('form', { name: s.filters })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    expect(screen.queryByText(/A lista exibida continua válida/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Atualizar' })).toBeNull();
  });

  it('os dados anteriores só voltam por uma nova primeira leitura autorizada ("Verificar novamente")', async () => {
    const ana = signIn();
    await firstPage(s);
    api.product.revokeOrganizationRoles(ana.membershipId);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    const again = await screen.findByRole('button', { name: 'Verificar novamente' });
    // ainda sem permissão: a nova leitura é recusada e nada da lista anterior aparece
    const before = listCalls(s.route).length;
    fireEvent.click(again);
    await waitFor(() => expect(listCalls(s.route).length).toBe(before + 1));
    expect(listCalls(s.route).at(-1)).not.toContain('cursor=');
    expect(await screen.findByText(`Você não tem permissão para ver ${s.area}.`)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    // permissão restaurada: só a nova leitura (primeira página, sem cursor) traz os dados
    api.product.memberships.get(ana.membershipId)!.orgRoles = ['ORG_ADMIN'];
    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));
    await screen.findByRole('region', { name: s.region });
    expect(screen.getByRole('region', { name: s.region }).querySelectorAll('tbody tr')).toHaveLength(25);
    expect(listCalls(s.route).at(-1)).not.toContain('cursor=');
  });

  it('controle: falha transitória (500) ao carregar mais mantém os itens e a mensagem da lista, sem acesso negado', async () => {
    signIn();
    await firstPage(s);
    intercept = (p) => (p.includes(s.route) && p.includes('cursor=') ? { respond: { status: 500, body: { error: 'internal_error' } } } : undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText(/A lista exibida continua válida/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: s.region }).querySelectorAll('tbody tr')).toHaveLength(25);
    expect(screen.queryByText(`Você não tem permissão para ver ${s.area}.`)).toBeNull();
  });

  it('controle: cursor recusado (rotação da chave) mantém os itens e oferece recomeçar, sem acesso negado', async () => {
    signIn();
    await firstPage(s);
    api.product.cursors.rotate();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText(/A lista mudou desde a última página/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recomeçar a lista' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: s.region }).querySelectorAll('tbody tr')).toHaveLength(25);
    expect(screen.queryByText(`Você não tem permissão para ver ${s.area}.`)).toBeNull();
  });

  it('controle: 401 ao carregar mais segue o fluxo de sessão expirada', async () => {
    const ana = signIn();
    await firstPage(s);
    api.revokeSessions(ana.userId);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(location).toBe(`${base}/login`));
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
    await act(() => new Promise<void>((r) => setTimeout(r, 20)));
    expect(screen.queryByText(`Você não tem permissão para ver ${s.area}.`)).toBeNull();
  });
});
