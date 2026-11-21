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
/** PLATFORM-FLUXO-002: Membros e Convites viraram "Pessoas e acessos"; o endereço antigo redireciona para cá. */
const people = `${base}/administracao/pessoas`;
// PLATFORM-FLUXO-002 (070): Clientes e Concessões ficam dentro de "Pessoas e acessos" (os endereços antigos redirecionam)
const clients = `${base}/administracao/pessoas/clientes`;
const grants = `${base}/administracao/pessoas/acessos/ambientes`;
const legacyClients = `${base}/administracao/clientes`;
const legacyGrants = `${base}/administracao/concessoes`;
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
const adminCalls = () => requests.filter((r) => /\/(people|members|clients|client-grants)(\?|$)/.test(r));
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
  it('ORG_ADMIN: grupo Administração com Pessoas e acessos (Clientes, Concessões e Auditoria saíram do menu); item ativo; título do topo', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de pessoas e convites' });
    const group = await within(nav()).findByRole('link', { name: 'Pessoas e acessos' });
    expect(group).toHaveAttribute('href', people);
    expect(group).toHaveAttribute('aria-current', 'page');
    // Membros e Convites saíram do menu
    expect(within(nav()).queryByRole('link', { name: 'Membros' })).toBeNull();
    expect(within(nav()).queryByRole('link', { name: 'Convites' })).toBeNull();
    expect(within(nav()).queryByRole('link', { name: 'Clientes' })).toBeNull();
    expect(within(nav()).queryByRole('link', { name: 'Concessões' })).toBeNull();
    expect(within(nav()).queryByRole('link', { name: 'Auditoria de acessos' })).toBeNull();
    // os atalhos ficam na própria página
    expect(screen.getByRole('link', { name: /Gerenciar clientes/ })).toHaveAttribute('href', clients);
    expect(screen.getByRole('link', { name: /Acessos e histórico/ })).toHaveAttribute('href', `${base}/administracao/pessoas/acessos`);
    expect(within(nav()).getByText('Administração')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Pessoas e acessos' })).toBeInTheDocument();
  });

  it('sem permissão organizacional: sem o grupo; acesso direto às três telas é decidido pela API (403 → estado próprio, sem dados)', async () => {
    sessionFor('gestora@nekkora.dev');
    for (const [path, area] of [
      [members, 'as pessoas e os convites desta organização'],
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
    const listCalls = statuses.filter(([p]) => /\/(people|clients|client-grants)\?/.test(p) && !p.includes('limit=100'));
    expect(listCalls.length).toBeGreaterThanOrEqual(3);
    for (const [p, s] of listCalls) expect(s, p).toBe(403);
  });

  it('P01 em erro: o grupo não aparece, mas o endereço direto continua e a API decide (ORG_ADMIN vê os dados)', async () => {
    sessionFor('ana@nekkora.dev');
    intercept = (p) => (p.includes('/me/permissions') && !p.includes('/workspaces') ? { respond: { status: 500, body: { error: 'internal_error' } } } : undefined);
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de pessoas e convites' });
    expect(screen.getByText('Não foi possível carregar suas permissões.')).toBeInTheDocument();
    expect(within(nav()).queryByText('Administração')).toBeNull();
  });

  it('conta externa: não chega às telas e nenhuma rota administrativa é chamada', async () => {
    sessionFor('portal@nekkora.dev');
    renderAt(members);
    await waitFor(() => expect(requests.some((r) => r.endsWith('/me'))).toBe(true));
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    expect(adminCalls()).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Lista de pessoas e convites' })).toBeNull();
  });
});

describe('Membros', () => {
  it('ordem do contrato (membros da entrada mais recente), situação e MFA; "Carregar mais" pelo cursor até o fim, sem duplicar', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de pessoas e convites' });
    expect(rows('Lista de pessoas e convites')).toHaveLength(25);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(rows('Lista de pessoas e convites').length).toBeGreaterThan(25));
    const total = [...api.accounts.values()].filter((a) => a.org === DEV_ORG && a.accountType === 'internal').length;
    expect(rows('Lista de pessoas e convites')).toHaveLength(total);
    expect(screen.getByText('Fim da lista')).toBeInTheDocument();
    expect(firstCells('Lista de pessoas e convites')[0]).toContain('Pessoa da Equipe 24');
    expect(firstCells('Lista de pessoas e convites').at(-1)).toContain('Ana Souza');
    const row = (name: string) => rows('Lista de pessoas e convites').find((r) => r.textContent!.includes(name))!;
    expect(row('Gil Desligado')).toHaveTextContent('Retirado');
    expect(row('Helena Convidada')).toHaveTextContent('E-mail não confirmado');
    expect(row('Íris Encerrada')).toHaveTextContent('Encerrada');
    expect(row('Flávia Suspensa')).toHaveTextContent('Suspensa');
    expect(row('Ana Souza')).toHaveTextContent('Administração da organização');
    expect(row('Pessoa Nova')).toHaveTextContent('Não configurado');
    const pages = requests.filter((r) => r.includes('/people?'));
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain('cursor=');
  });

  it('filtro na URL: abre filtrado, marca/desmarca grava a URL e a consulta; parâmetros inválidos são descartados sem 400', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`${people}?estado=member_revoked&estado=xyz&estado=member_revoked`);
    await screen.findByRole('region', { name: 'Lista de pessoas e convites' });
    expect(firstCells('Lista de pessoas e convites')).toEqual([expect.stringContaining('Gil Desligado')]);
    await waitFor(() => expect(location).toBe(`${people}?estado=member_revoked`));
    expect(screen.getByRole('checkbox', { name: 'Retirado da organização' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Membro com vínculo pendente' }));
    await waitFor(() => expect(location).toBe(`${people}?estado=member_pending&estado=member_revoked`));
    await waitFor(() => expect(firstCells('Lista de pessoas e convites').length).toBe(2));
    const last = new URL(requests.filter((r) => r.includes('/people?')).at(-1)!, 'http://x').searchParams;
    expect(last.getAll('situation')).toEqual(['member_pending', 'member_revoked']);
    expect(statuses.filter(([p]) => p.includes('/people?')).every(([, s]) => s === 200)).toBe(true);
  });

  it('mudança externa do endereço (menu "Pessoas e acessos" sem filtros) reabre os filtros a partir dela', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`${members}?estado=revoked`); // endereço antigo com o filtro antigo: vira a situação equivalente
    await screen.findByRole('region', { name: 'Lista de pessoas e convites' });
    await waitFor(() => expect(location).toBe(`${people}?estado=member_revoked`));
    expect(rows('Lista de pessoas e convites')).toHaveLength(1);
    fireEvent.click(await within(nav()).findByRole('link', { name: 'Pessoas e acessos' }));
    await waitFor(() => expect(location).toBe(people));
    await waitFor(() => expect(rows('Lista de pessoas e convites')).toHaveLength(25));
    expect(screen.getByRole('checkbox', { name: 'Retirado da organização' })).not.toBeChecked();
  });

  it('nenhum resultado com filtro: estado vazio com "Limpar filtros"', async () => {
    sessionFor('ana@nekkora.dev');
    api.accounts.forEach((a) => {
      if (a.membershipStatus === 'revoked') a.membershipStatus = 'active';
    });
    renderAt(`${people}?estado=member_revoked`);
    expect(await screen.findByText('Ninguém encontrado com essa busca ou situação.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar busca e filtros' }));
    await waitFor(() => expect(location).toBe(people));
    await screen.findByRole('region', { name: 'Lista de pessoas e convites' });
  });

  it('cursor recusado (rotação da chave): a lista exibida continua e a tela oferece recomeçar, sem repetir sozinha', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de pessoas e convites' });
    api.product.cursors.rotate();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText(/A lista mudou desde a última página/)).toBeInTheDocument();
    expect(rows('Lista de pessoas e convites')).toHaveLength(25);
    const before = requests.filter((r) => r.includes('/people?')).length;
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    expect(requests.filter((r) => r.includes('/people?')).length).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Recomeçar a lista' }));
    await waitFor(() => expect(requests.filter((r) => r.includes('/people?')).length).toBe(before + 1));
    expect(requests.filter((r) => r.includes('/people?')).at(-1)).not.toContain('cursor=');
  });

  it('resposta atrasada da consulta anterior não sobrescreve a do filtro novo', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const late = new Promise<void>((r) => (release = r));
    intercept = (p) => (p.includes('/people?') && !p.includes('situation=') ? { delay: late } : undefined);
    renderAt(people);
    await waitFor(() => expect(requests.some((r) => r.includes('/people?'))).toBe(true));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Retirado da organização' }));
    await screen.findByRole('region', { name: 'Lista de pessoas e convites' });
    expect(rows('Lista de pessoas e convites')).toHaveLength(1);
    await act(async () => release());
    await act(() => new Promise<void>((r) => setTimeout(r, 30)));
    expect(rows('Lista de pessoas e convites')).toHaveLength(1);
    expect(firstCells('Lista de pessoas e convites')[0]).toContain('Gil Desligado');
  });

  it('sessão expirada (401) numa atualização: volta ao login com o aviso', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de pessoas e convites' });
    api.revokeSessions(ana.userId);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(location).toBe(`${base}/login`));
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
  });

  it('isolamento: a ORG_ADMIN vizinha vê só os membros da sua organização; a sessão de A não abre a lista de B', async () => {
    sessionFor('vizinha@nekkora.dev', OTHER_ORG);
    const v = renderAt(`/o/${OTHER_ORG}/administracao/membros`);
    await screen.findByRole('region', { name: 'Lista de pessoas e convites' });
    expect(firstCells('Lista de pessoas e convites')).toEqual([expect.stringContaining('Vera Vizinha')]);
    v.unmount();
    sessionFor('ana@nekkora.dev');
    requests = [];
    renderAt(`/o/${OTHER_ORG}/administracao/membros`);
    await waitFor(() => expect(location).toBe(`/o/${OTHER_ORG}/login`));
    expect(screen.queryByRole('region', { name: 'Lista de pessoas e convites' })).toBeNull();
    expect(adminCalls().every((r) => !r.includes(OTHER_ORG) || statuses.find(([p]) => p === r)?.[1] !== 200)).toBe(true);
  });
});

describe('Clientes', () => {
  it('ordem por ponto de código, estados, filtro na URL, detalhes do cliente e atalho para as concessões dele; o endereço antigo redireciona', async () => {
    sessionFor('ana@nekkora.dev');
    const legacy = renderAt(`${legacyClients}?estado=active`);
    await waitFor(() => expect(location).toBe(`${clients}?estado=active`));
    await screen.findByRole('region', { name: 'Lista de clientes' });
    legacy.unmount();
    const view = renderAt(clients);
    await screen.findByRole('region', { name: 'Lista de clientes' });
    expect(firstCells('Lista de clientes')).toEqual(['ACME Logística', 'Banco Exemplo S.A.', 'Clínica Exemplo', 'Ômega Indústria']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Arquivado' }));
    await waitFor(() => expect(location).toBe(`${clients}?estado=archived`));
    await waitFor(() => expect(firstCells('Lista de clientes')).toEqual(['Ômega Indústria']));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Arquivado' }));
    await waitFor(() => expect(firstCells('Lista de clientes')).toHaveLength(4));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalhes de ACME Logística' }));
    await waitFor(() => expect(location).toBe(`${clients}?cliente=${client('acme')}`));
    expect(await screen.findByRole('heading', { level: 2, name: 'ACME Logística' })).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /Ver concessões e histórico deste cliente/ });
    expect(link).toHaveAttribute('href', `${base}/administracao/pessoas/acessos?cliente=${client('acme')}`);
    // o endereço antigo de Concessões leva às concessões unificadas, com os filtros
    view.unmount();
    renderAt(`${legacyGrants}?cliente=${client('acme')}&estado=active`);
    await waitFor(() => expect(location).toBe(`${base}/administracao/pessoas/acessos?estado=active&cliente=${client('acme')}`));
    await screen.findByRole('region', { name: 'Lista de concessões de clientes' });
  });
});

describe('Concessões', () => {
  it('lista da mais recente para a mais antiga; estados; filtros de estado e ambiente de trabalho na URL', async () => {
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Ambiente de trabalho' }), { target: { value: stableUuid('dev:ws:logistica') } });
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
