/**
 * F6a-2-R2: (1) depois do 403 da conferência nenhuma leitura acontece sozinha — só "Verificar novamente", concluída
 * com autorização, devolve a apresentação; (2) fronteira de sessão vinda de OUTRA aba (BroadcastChannel da mesma
 * origem): a aba antiga invalida registro, conferências e contexto autenticado antes de qualquer nova ação.
 * "Outra aba" é simulada por um segundo BroadcastChannel no mesmo processo (o canal não entrega ao próprio emissor).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ORG, MockApi } from '../../mock/contract';
import { AppRoutes } from '../app/AppRoutes';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';
import { resetWriteStore, writeEntry } from '../admin/writeStore';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const members = `/o/${DEV_ORG}/administracao/membros`;
type Transport = { kind: 'delay'; until: Promise<void> } | { kind: 'network-before' } | { kind: 'status'; status: number; body: unknown };

let api: MockApi;
let cookie = '';
let requests: { method: string; path: string }[] = [];
let transport: ((method: string, path: string) => Transport | null) | null = null;
let location = '';

function Probe() {
  const loc = useLocation();
  location = loc.pathname;
  return null;
}

const acc = (email: string) => [...api.accounts.values()].find((a) => a.email === email && a.org === DEV_ORG)!;
function sessionFor(email: string) {
  const a = acc(email);
  cookie = api.openSession(a.userId);
  return a;
}

async function toMock(method: string, url: URL, init?: RequestInit) {
  const out = api.handle({
    method,
    path: url.pathname,
    origin: 'http://localhost',
    expectedOrigin: 'http://localhost',
    csrf: (init?.headers as Record<string, string> | undefined)?.['X-CSRF-Token'],
    cookies: { '__Host-nekkora_session': cookie },
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    query: url.searchParams,
  });
  return new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status, headers: out.headers });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  api = new MockApi(() => NOW);
  requests = [];
  transport = null;
  location = '';
  csrfStore.clear();
  sessionMemory.reset();
  resetWriteStore();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      requests.push({ method, path: url.pathname + url.search });
      const t = transport?.(method, url.pathname + url.search);
      if (t?.kind === 'network-before') throw new TypeError('Failed to fetch');
      if (t?.kind === 'status') return new Response(JSON.stringify(t.body), { status: t.status, headers: { 'Content-Type': 'application/json' } });
      if (t?.kind === 'delay') await t.until;
      return toMock(method, url, init);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const panel = () => screen.queryByRole('region', { name: 'Ações sem resultado confirmado' });
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 80)));
const FORBIDDEN = 'Você não tem permissão para ver os membros desta organização.';

async function openWithUncertainty() {
  render(
    <MemoryRouter initialEntries={[members]}>
      <AppRoutes />
      <Probe />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Suspender Caio Mendes' });
  transport = (m, p) => (m === 'POST' && p.endsWith('/suspend') ? { kind: 'network-before' } : null);
  fireEvent.click(screen.getByRole('button', { name: 'Suspender Caio Mendes' }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Suspender' }));
  await within(dialog).findByRole('alert');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  await waitFor(() => expect(panel()).not.toBeNull());
  transport = null;
}

describe('R2.1: 403 da conferência sem leitura automática', () => {
  it('nenhuma requisição acontece sozinha depois do 403; permissão devolvida não reabre nada; só "Verificar novamente" (concluída com 200) reabre', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openWithUncertainty();
    api.product.revokeOrganizationRoles(ana.membershipId);
    const beforeCheck = requests.length;
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    expect(await screen.findByText(FORBIDDEN)).toBeInTheDocument();
    await settle();
    // desde o clique, SÓ a leitura da própria conferência (limit=100): nenhuma releitura da lista foi feita sozinha
    expect(requests.slice(beforeCheck).map((r) => r.path.replace(/\?.*/, ''))).toEqual([`/api/v1/o/${DEV_ORG}/members`]);
    expect(requests.slice(beforeCheck)[0].path).toContain('limit=100');
    const after403 = requests.length;
    // permissão devolvida no servidor: a tela continua negada e nada é lido sem decisão da pessoa
    api.product.memberships.get(ana.membershipId)!.orgRoles = ['ORG_ADMIN'];
    await settle();
    expect(requests.slice(after403)).toEqual([]);
    expect(screen.getByText(FORBIDDEN)).toBeInTheDocument();
    expect(panel()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));
    await screen.findByRole('region', { name: 'Lista de membros' });
    const reads = requests.slice(after403).filter((r) => r.path.includes('/members?'));
    expect(reads).toHaveLength(1);
    expect(reads[0].path).not.toContain('cursor=');
    expect(panel()).toHaveTextContent('Suspensão de Caio Mendes: resultado não confirmado.');
  });

  it('"Verificar novamente" ainda sem permissão: continua negado, e nenhuma outra leitura acontece sozinha', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openWithUncertainty();
    api.product.revokeOrganizationRoles(ana.membershipId);
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    await screen.findByText(FORBIDDEN);
    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));
    await waitFor(() => expect(requests.filter((r) => r.path.includes('/members?') && !r.path.includes('limit=100')).length).toBeGreaterThan(1));
    const mark = requests.length;
    await settle();
    expect(requests.slice(mark)).toEqual([]);
    expect(screen.getByText(FORBIDDEN)).toBeInTheDocument();
    expect(panel()).toBeNull();
  });
});

describe('R2.1b: 403 só na conferência, com a lista ainda autorizada', () => {
  it('a apresentação NÃO volta sozinha (sem leitura automática que daria 200); só "Verificar novamente"', async () => {
    sessionFor('ana@nekkora.dev');
    await openWithUncertainty();
    transport = (m, p) => (m === 'GET' && p.includes('/members?') && p.includes('limit=100') ? { kind: 'status', status: 403, body: { error: 'forbidden' } } : null);
    const beforeCheck = requests.length;
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    expect(await screen.findByText(FORBIDDEN)).toBeInTheDocument();
    transport = null;
    await settle();
    expect(screen.getByText(FORBIDDEN)).toBeInTheDocument();
    expect(panel()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Lista de membros' })).toBeNull();
    expect(requests.slice(beforeCheck).filter((r) => r.path.includes('/members?') && !r.path.includes('limit=100'))).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(panel()).not.toBeNull();
  });
});

describe('R2.1c: leitura já em curso que conclui DEPOIS do 403 da conferência', () => {
  it('"Carregar mais" pendente que conclui com 200 depois do 403 não devolve a apresentação (não foi pedido no estado negado)', async () => {
    sessionFor('ana@nekkora.dev');
    await openWithUncertainty();
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => {
      if (m === 'GET' && p.includes('/members?') && p.includes('cursor=') && !p.includes('limit=100')) return { kind: 'delay', until };
      if (m === 'GET' && p.includes('/members?') && p.includes('limit=100')) return { kind: 'status', status: 403, body: { error: 'forbidden' } };
      return null;
    };
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(requests.some((r) => r.path.includes('/members?') && r.path.includes('cursor='))).toBe(true));
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    expect(await screen.findByText(FORBIDDEN)).toBeInTheDocument();
    await act(async () => release());
    await settle();
    expect(screen.getByText(FORBIDDEN)).toBeInTheDocument();
    expect(panel()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Lista de membros' })).toBeNull();
  });
});

describe('R2.2: troca de sessão em OUTRA aba', () => {
  it('o aviso entre abas não carrega credencial: só { tipo: "sessao-alterada" }', async () => {
    const other = new BroadcastChannel('nekkora-sessao');
    const got: unknown[] = [];
    other.onmessage = (e) => got.push(e.data);
    csrfStore.setSession(DEV_ORG, 'token-que-nao-pode-vazar');
    csrfStore.clear();
    csrfStore.beginSession(DEV_ORG, 'outro-token-que-nao-pode-vazar');
    await waitFor(() => expect(got).toHaveLength(2));
    expect(got).toEqual([{ tipo: 'sessao-alterada' }, { tipo: 'sessao-alterada' }]);
    expect(JSON.stringify(got)).not.toContain('token');
    other.close();
  });

  it('a aba antiga sai da área (aviso no login), esquece tokens e registro, e a conferência pendente para de ler', async () => {
    sessionFor('ana@nekkora.dev');
    await openWithUncertainty();
    for (let i = 0; i < 120; i++) api.createAccount({ org: DEV_ORG, displayName: `Extra ${i}`, createdAt: NOW - 500 * 86_400_000 });
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (m === 'GET' && p.includes('/members?') && p.includes('limit=100') ? { kind: 'delay', until } : null);
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    await waitFor(() => expect(requests.filter((r) => r.path.includes('/members?') && r.path.includes('limit=100'))).toHaveLength(1));
    const caio = acc('operador@nekkora.dev').userId;
    expect(writeEntry(DEV_ORG, caio)?.phase).toBe('uncertain');

    // outra aba entra com outra conta (ou sai): avisa pelo canal
    const otherTab = new BroadcastChannel('nekkora-sessao');
    otherTab.postMessage({ tipo: 'sessao-alterada' });
    await waitFor(() => expect(location).toBe(`/o/${DEV_ORG}/login`));
    expect(await screen.findByText('Sua sessão foi encerrada ou alterada em outra aba. Entre novamente para continuar.')).toBeInTheDocument();
    expect(writeEntry(DEV_ORG, caio)).toBeUndefined();
    expect(csrfStore.session(DEV_ORG)).toBeUndefined();
    expect(screen.queryByRole('region', { name: 'Lista de membros' })).toBeNull();
    expect(panel()).toBeNull();
    await act(async () => release());
    await settle();
    expect(requests.filter((r) => r.path.includes('/members?') && r.path.includes('limit=100'))).toHaveLength(1);
    expect(writeEntry(DEV_ORG, caio)).toBeUndefined();
    otherTab.close();
  });

  it('escrita pendente na aba antiga que conclui depois do aviso de outra aba não volta a aparecer', async () => {
    sessionFor('ana@nekkora.dev');
    render(
      <MemoryRouter initialEntries={[members]}>
        <AppRoutes />
        <Probe />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: 'Suspender Caio Mendes' });
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (m === 'POST' && p.endsWith('/suspend') ? { kind: 'delay', until } : null);
    fireEvent.click(screen.getByRole('button', { name: 'Suspender Caio Mendes' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Suspender' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
    const otherTab = new BroadcastChannel('nekkora-sessao');
    otherTab.postMessage({ tipo: 'sessao-alterada' });
    await waitFor(() => expect(location).toBe(`/o/${DEV_ORG}/login`));
    await act(async () => release());
    await settle();
    expect(writeEntry(DEV_ORG, acc('operador@nekkora.dev').userId)).toBeUndefined();
    otherTab.close();
  });

  it('mensagem de outro tipo no canal é ignorada', async () => {
    sessionFor('ana@nekkora.dev');
    await openWithUncertainty();
    const otherTab = new BroadcastChannel('nekkora-sessao');
    otherTab.postMessage({ tipo: 'outra-coisa' });
    await settle();
    expect(location).toBe(members);
    expect(panel()).not.toBeNull();
    otherTab.close();
  });
});
