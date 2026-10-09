/**
 * F6a-1: telas de administração (Membros, Clientes, Concessões), só leitura, renderizadas pelo app real (AppRoutes)
 * contra a API SIMULADA (mock/), com o fetch ligado direto ao MockApi e relógio fixo. Cobertura contra o mock; a API
 * real fica para a validação posterior.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ORG, MockApi, OTHER_ORG } from '../../mock/contract';
import { stableUuid } from '../../mock/product';
import { AppRoutes } from '../app/AppRoutes';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const base = `/o/${DEV_ORG}`;
const members = `${base}/administracao/membros`;
const clients = `${base}/administracao/clientes`;
const grants = `${base}/administracao/concessoes`;
const client = (k: string, key = 'dev') => stableUuid(`${key}:client:${k}`);

let api: MockApi;
let cookie = '';
let requests: string[] = [];
/** Respostas da API por requisição: status de cada chamada (para conferir 400/403 enviados). */
let statuses: [string, number][] = [];
let intercept: ((path: string) => { delay?: Promise<void>; respond?: { status: number; body: unknown } } | undefined) | undefined;
let location = '';

function Probe() {
  const loc = useLocation();
  location = loc.pathname + loc.search;
  return null;
}

function sessionFor(email: string, org = DEV_ORG) {
  const a = [...api.accounts.values()].find((x) => x.email === email && x.org === org)!;
  cookie = api.openSession(a.userId);
  return a;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
      <Probe />
    </MemoryRouter>,
  );
}

const rows = (name: string) => within(screen.getByRole('region', { name })).getAllByRole('row').slice(1);
const firstCells = (name: string) => rows(name).map((r) => within(r).getAllByRole('cell')[0].textContent);
const adminCalls = () => requests.filter((r) => /\/(members|clients|client-grants)(\?|$)/.test(r));
const nav = () => screen.getByRole('navigation', { name: 'Navegação principal' });

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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname + url.search;
      requests.push(path);
      const hook = intercept?.(path);
      if (hook?.delay) await hook.delay;
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

describe('navegação pela P01', () => {
  it('ORG_ADMIN: grupo Administração com Membros, Clientes e Concessões; item ativo; título do topo', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de membros' });
    const group = await within(nav()).findByRole('link', { name: 'Membros' });
    expect(group).toHaveAttribute('href', members);
    expect(group).toHaveAttribute('aria-current', 'page');
    expect(within(nav()).getByRole('link', { name: 'Clientes' })).toHaveAttribute('href', clients);
    expect(within(nav()).getByRole('link', { name: 'Concessões' })).toHaveAttribute('href', grants);
    expect(within(nav()).getByText('Administração')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Membros' })).toBeInTheDocument();
  });

  it('sem permissão organizacional: sem o grupo; acesso direto às três telas é decidido pela API (403 → estado próprio, sem dados)', async () => {
    sessionFor('gestora@nekkora.dev');
    for (const [path, area] of [
      [members, 'os membros desta organização'],
      [clients, 'os clientes desta organização'],
      [grants, 'as concessões desta organização'],
    ] as const) {
      const view = renderAt(path);
      expect(await screen.findByText(`Você não tem permissão para ver ${area}.`)).toBeInTheDocument();
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.queryByRole('form')).toBeNull();
      await waitFor(() => expect(within(nav()).queryByText('Administração')).toBeNull());
      view.unmount();
    }
    const listCalls = statuses.filter(([p]) => /\/(members|clients|client-grants)\?/.test(p) && !p.includes('limit=100'));
    expect(listCalls.length).toBeGreaterThanOrEqual(3);
    for (const [p, s] of listCalls) expect(s, p).toBe(403);
  });

  it('P01 em erro: o grupo não aparece, mas o endereço direto continua e a API decide (ORG_ADMIN vê os dados)', async () => {
    sessionFor('ana@nekkora.dev');
    intercept = (p) => (p.includes('/me/permissions') && !p.includes('/workspaces') ? { respond: { status: 500, body: { error: 'internal_error' } } } : undefined);
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(screen.getByText('Não foi possível carregar suas permissões.')).toBeInTheDocument();
    expect(within(nav()).queryByText('Administração')).toBeNull();
  });

  it('conta externa: não chega às telas e nenhuma rota administrativa é chamada', async () => {
    sessionFor('portal@nekkora.dev');
    renderAt(members);
    await waitFor(() => expect(requests.some((r) => r.endsWith('/me'))).toBe(true));
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    expect(adminCalls()).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Lista de membros' })).toBeNull();
  });
});

describe('Membros', () => {
  it('ordem do contrato, estados e MFA; "Carregar mais" pelo cursor até o fim, sem duplicar', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(rows('Lista de membros')).toHaveLength(25);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(rows('Lista de membros').length).toBeGreaterThan(25));
    const total = [...api.accounts.values()].filter((a) => a.org === DEV_ORG && a.accountType === 'internal').length;
    expect(rows('Lista de membros')).toHaveLength(total);
    expect(screen.getByText('Fim da lista')).toBeInTheDocument();
    expect(firstCells('Lista de membros')[0]).toContain('Ana Souza');
    const row = (name: string) => rows('Lista de membros').find((r) => r.textContent!.includes(name))!;
    expect(row('Gil Desligado')).toHaveTextContent('Revogado');
    expect(row('Helena Convidada')).toHaveTextContent('E-mail não confirmado');
    expect(row('Íris Encerrada')).toHaveTextContent('Encerrada');
    expect(row('Flávia Suspensa')).toHaveTextContent('Suspensa');
    expect(row('Ana Souza')).toHaveTextContent('Administração da organização');
    expect(row('Pessoa Nova')).toHaveTextContent('Não configurado');
    const pages = requests.filter((r) => r.includes('/members?'));
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain('cursor=');
  });

  it('filtro na URL: abre filtrado, marca/desmarca grava a URL e a consulta; parâmetros inválidos são descartados sem 400', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`${members}?estado=revoked&estado=xyz&estado=revoked`);
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(firstCells('Lista de membros')).toEqual([expect.stringContaining('Gil Desligado')]);
    await waitFor(() => expect(location).toBe(`${members}?estado=revoked`));
    expect(screen.getByRole('checkbox', { name: 'Revogado' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pendente' }));
    await waitFor(() => expect(location).toBe(`${members}?estado=pending&estado=revoked`));
    await waitFor(() => expect(firstCells('Lista de membros').length).toBe(2));
    const last = new URL(requests.filter((r) => r.includes('/members?')).at(-1)!, 'http://x').searchParams;
    expect(last.getAll('status')).toEqual(['pending', 'revoked']);
    expect(statuses.filter(([p]) => p.includes('/members?')).every(([, s]) => s === 200)).toBe(true);
  });

  it('mudança externa do endereço (menu "Membros" sem filtros) reabre os filtros a partir dela', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`${members}?estado=revoked`);
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(rows('Lista de membros')).toHaveLength(1);
    fireEvent.click(await within(nav()).findByRole('link', { name: 'Membros' }));
    await waitFor(() => expect(location).toBe(members));
    await waitFor(() => expect(rows('Lista de membros')).toHaveLength(25));
    expect(screen.getByRole('checkbox', { name: 'Revogado' })).not.toBeChecked();
  });

  it('nenhum resultado com filtro: estado vazio com "Limpar filtros"', async () => {
    sessionFor('ana@nekkora.dev');
    api.accounts.forEach((a) => {
      if (a.membershipStatus === 'revoked') a.membershipStatus = 'active';
    });
    renderAt(`${members}?estado=revoked`);
    expect(await screen.findByText('Nenhum membro com esses estados.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await waitFor(() => expect(location).toBe(members));
    await screen.findByRole('region', { name: 'Lista de membros' });
  });

  it('cursor recusado (rotação da chave): a lista exibida continua e a tela oferece recomeçar, sem repetir sozinha', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de membros' });
    api.product.cursors.rotate();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText(/A lista mudou desde a última página/)).toBeInTheDocument();
    expect(rows('Lista de membros')).toHaveLength(25);
    const before = requests.filter((r) => r.includes('/members?')).length;
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    expect(requests.filter((r) => r.includes('/members?')).length).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Recomeçar a lista' }));
    await waitFor(() => expect(requests.filter((r) => r.includes('/members?')).length).toBe(before + 1));
    expect(requests.filter((r) => r.includes('/members?')).at(-1)).not.toContain('cursor=');
  });

  it('resposta atrasada da consulta anterior não sobrescreve a do filtro novo', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const late = new Promise<void>((r) => (release = r));
    intercept = (p) => (p.includes('/members?') && !p.includes('status=') ? { delay: late } : undefined);
    renderAt(members);
    await waitFor(() => expect(requests.some((r) => r.includes('/members?'))).toBe(true));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Revogado' }));
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(rows('Lista de membros')).toHaveLength(1);
    await act(async () => release());
    await act(() => new Promise<void>((r) => setTimeout(r, 30)));
    expect(rows('Lista de membros')).toHaveLength(1);
    expect(firstCells('Lista de membros')[0]).toContain('Gil Desligado');
  });

  it('sessão expirada (401) numa atualização: volta ao login com o aviso', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de membros' });
    api.revokeSessions(ana.userId);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(location).toBe(`${base}/login`));
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
  });

  it('isolamento: a ORG_ADMIN vizinha vê só os membros da sua organização; a sessão de A não abre a lista de B', async () => {
    sessionFor('vizinha@nekkora.dev', OTHER_ORG);
    const v = renderAt(`/o/${OTHER_ORG}/administracao/membros`);
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(firstCells('Lista de membros')).toEqual([expect.stringContaining('Vera Vizinha')]);
    v.unmount();
    sessionFor('ana@nekkora.dev');
    requests = [];
    renderAt(`/o/${OTHER_ORG}/administracao/membros`);
    await waitFor(() => expect(location).toBe(`/o/${OTHER_ORG}/login`));
    expect(screen.queryByRole('region', { name: 'Lista de membros' })).toBeNull();
    expect(adminCalls().every((r) => !r.includes(OTHER_ORG) || statuses.find(([p]) => p === r)?.[1] !== 200)).toBe(true);
  });
});

describe('Clientes', () => {
  it('ordem por ponto de código, estados, filtro na URL e atalho para as concessões do cliente', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(clients);
    await screen.findByRole('region', { name: 'Lista de clientes' });
    expect(firstCells('Lista de clientes')).toEqual(['ACME Logística', 'Banco Exemplo S.A.', 'Clínica Exemplo', 'Ômega Indústria']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Arquivado' }));
    await waitFor(() => expect(location).toBe(`${clients}?estado=archived`));
    await waitFor(() => expect(firstCells('Lista de clientes')).toEqual(['Ômega Indústria']));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Arquivado' }));
    await waitFor(() => expect(firstCells('Lista de clientes')).toHaveLength(4));
    const link = await screen.findByRole('link', { name: 'Ver concessões de ACME Logística' });
    expect(link).toHaveAttribute('href', `${grants}?cliente=${client('acme')}`);
    fireEvent.click(link);
    await screen.findByRole('region', { name: 'Lista de concessões' });
    expect(rows('Lista de concessões')).toHaveLength(3);
    expect(screen.getByRole('combobox', { name: 'Cliente' })).toHaveValue(client('acme'));
  });
});

describe('Concessões', () => {
  it('lista da mais recente para a mais antiga; estados; filtros de estado e workspace na URL', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(grants);
    await screen.findByRole('region', { name: 'Lista de concessões' });
    expect(rows('Lista de concessões')).toHaveLength(6);
    expect(rows('Lista de concessões')[0]).toHaveTextContent('Pendente');
    expect(rows('Lista de concessões').some((r) => r.textContent!.includes('Revogada'))).toBe(true);
    expect(rows('Lista de concessões').some((r) => r.textContent!.includes('Sem expiração'))).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ativa' }));
    await waitFor(() => expect(location).toBe(`${grants}?estado=active`));
    await waitFor(() => expect(rows('Lista de concessões')).toHaveLength(3));
    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), { target: { value: stableUuid('dev:ws:logistica') } });
    await waitFor(() => expect(location).toBe(`${grants}?estado=active&workspace=${stableUuid('dev:ws:logistica')}`));
    await waitFor(() => expect(rows('Lista de concessões')).toHaveLength(1));
  });

  it('cliente de outra organização no endereço: lista vazia (DC-05), não erro; cliente malformado é descartado', async () => {
    sessionFor('ana@nekkora.dev');
    const v = renderAt(`${grants}?cliente=${client('vizinho', 'vizinha')}`);
    expect(await screen.findByText('Nenhuma concessão com esses filtros.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Cliente' })).toHaveValue(client('vizinho', 'vizinha'));
    v.unmount();
    requests = [];
    renderAt(`${grants}?cliente=nao-e-uuid`);
    await screen.findByRole('region', { name: 'Lista de concessões' });
    await waitFor(() => expect(location).toBe(grants));
    expect(requests.filter((r) => r.includes('/client-grants?')).every((r) => !r.includes('clientId='))).toBe(true);
  });

  it('falha (500) na primeira página: estado de erro com nova tentativa só por ação', async () => {
    sessionFor('ana@nekkora.dev');
    let fail = true;
    intercept = (p) => (fail && p.includes('/client-grants?') ? { respond: { status: 500, body: { error: 'internal_error' } } } : undefined);
    renderAt(grants);
    const retry = await screen.findByRole('button', { name: 'Tentar novamente' });
    const before = requests.filter((r) => r.includes('/client-grants?')).length;
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    expect(requests.filter((r) => r.includes('/client-grants?')).length).toBe(before);
    fail = false;
    fireEvent.click(retry);
    await screen.findByRole('region', { name: 'Lista de concessões' });
  });
});
