/**
 * F6a-2-R1: registro de escritas isolado por sessão; acesso negado esconde aviso e diálogo; nova tentativa recusada não
 * resolve a incerteza anterior. App real (AppRoutes) contra a API simulada; falhas de TRANSPORTE injetadas no fetch.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ORG, MockApi } from '../../mock/contract';
import { AppRoutes } from '../app/AppRoutes';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';
import { resetWriteStore } from '../admin/writeStore';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const members = `/o/${DEV_ORG}/administracao/membros`;

type Transport = { kind: 'delay'; until: Promise<void>; then?: Transport } | { kind: 'network-before' } | { kind: 'status'; status: number; body: unknown };

let api: MockApi;
let cookie = '';
let requests: { method: string; path: string }[] = [];
let transport: ((method: string, path: string) => Transport | null) | null = null;

const acc = (email: string) => [...api.accounts.values()].find((a) => a.email === email && a.org === DEV_ORG)!;

function sessionFor(email: string) {
  const a = acc(email);
  cookie = api.openSession(a.userId);
  return a;
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );

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

async function apply(t: Transport, method: string, url: URL, init?: RequestInit): Promise<Response> {
  if (t.kind === 'delay') {
    await t.until;
    return t.then ? apply(t.then, method, url, init) : toMock(method, url, init);
  }
  if (t.kind === 'network-before') throw new TypeError('Failed to fetch');
  return new Response(JSON.stringify(t.body), { status: t.status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  api = new MockApi(() => NOW);
  // segunda administradora da mesma organização (outra conta na mesma aba)
  const bia = api.createAccount({ org: DEV_ORG, email: 'bia@nekkora.dev', displayName: 'Bia Admin', orgRoles: ['ORG_ADMIN'] });
  bia.totpSecret = 'NEKKORADEVTOTPSECRETJBSWY3DPEHPK';
  requests = [];
  transport = null;
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
      return t ? apply(t, method, url, init) : toMock(method, url, init);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const panel = () => screen.queryByRole('region', { name: 'Ações sem resultado confirmado' });
const row = (name: string) => within(screen.getByRole('region', { name: 'Lista de membros' })).getAllByRole('row').find((r) => r.textContent!.includes(name))!;
const isSuspend = (m: string, p: string) => m === 'POST' && p.endsWith('/suspend');
const membersGets = () => requests.filter((r) => r.method === 'GET' && r.path.includes('/members?') && r.path.includes('limit=100'));

/** `actions`: espera a coluna de ações (P01) pelo botão de Caio, quando ele está na primeira página e sem incerteza. */
async function openMembers({ actions = true } = {}) {
  const view = renderAt(members);
  await screen.findByRole('region', { name: 'Lista de membros' });
  if (actions) await screen.findByRole('button', { name: 'Suspender Caio Mendes' });
  else await screen.findByRole('columnheader', { name: 'Ações' });
  return view;
}

async function uncertainSuspend(name = 'Caio Mendes') {
  transport = (m, p) => (isSuspend(m, p) ? { kind: 'network-before' } : null);
  fireEvent.click(screen.getByRole('button', { name: `Suspender ${name}` }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Suspender' }));
  await within(dialog).findByRole('alert');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  await waitFor(() => expect(panel()).toHaveTextContent(`Suspensão de ${name}: resultado não confirmado.`));
  transport = null;
}

describe('isolamento por sessão', () => {
  it('logout e entrada de OUTRA conta na mesma organização e aba: nada do registro anterior aparece', async () => {
    sessionFor('ana@nekkora.dev');
    const view = await openMembers();
    await uncertainSuspend();
    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    await screen.findByText('Você saiu da sua conta.');
    view.unmount();
    sessionFor('bia@nekkora.dev');
    await openMembers();
    expect(panel()).toBeNull();
    expect(row('Caio Mendes')).not.toHaveTextContent('Resultado não confirmado');
    expect(screen.getByRole('button', { name: 'Suspender Caio Mendes' })).toBeInTheDocument();
  });

  it('logout e nova entrada da MESMA pessoa: a incerteza volta (registro persistente, FRONT-V1-002), sem reenviar', async () => {
    // Regra nova (FRONT-V1-002, substitui a da F6a-2-R1 só para a MESMA pessoa na MESMA organização): o resultado
    // desconhecido continua depois de sair e entrar de novo; outra pessoa segue sem ver nada (teste acima).
    sessionFor('ana@nekkora.dev');
    const view = await openMembers();
    await uncertainSuspend();
    const sent = requests.filter((r) => isSuspend(r.method, r.path)).length;
    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    await screen.findByText('Você saiu da sua conta.');
    view.unmount();
    sessionFor('ana@nekkora.dev');
    csrfStore.beginSession(DEV_ORG, 'sessao-nova'); // o login emite sessão nova (MfaPage → verifyMfa)
    await openMembers();
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(requests.filter((r) => isSuspend(r.method, r.path)).length).toBe(sent);
  });

  it('escrita pendente que conclui DEPOIS da troca de sessão não aparece na sessão nova', async () => {
    sessionFor('ana@nekkora.dev');
    const view = await openMembers();
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (isSuspend(m, p) ? { kind: 'delay', until, then: { kind: 'network-before' } } : null);
    fireEvent.click(screen.getByRole('button', { name: 'Suspender Caio Mendes' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Suspender' }));
    await waitFor(() => expect(requests.some((r) => isSuspend(r.method, r.path))).toBe(true));
    view.unmount();
    act(() => csrfStore.clear()); // fim da sessão (logout ou expiração) com o envio pendente
    sessionFor('bia@nekkora.dev');
    await openMembers();
    await act(async () => release());
    await act(() => new Promise<void>((r) => setTimeout(r, 30)));
    expect(panel()).toBeNull();
    expect(row('Caio Mendes')).not.toHaveTextContent('Resultado não confirmado');
  });

  it('conferência em andamento na troca de sessão: para de ler (sem páginas com o cookie novo) e o resultado é descartado', async () => {
    sessionFor('ana@nekkora.dev');
    const view = await openMembers();
    await uncertainSuspend();
    for (let i = 0; i < 120; i++) api.createAccount({ org: DEV_ORG, displayName: `Extra ${i}`, createdAt: NOW - 500 * 86_400_000 });
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (m === 'GET' && p.includes('/members?') && p.includes('limit=100') ? { kind: 'delay', until } : null);
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    await waitFor(() => expect(membersGets()).toHaveLength(1));
    view.unmount();
    act(() => csrfStore.clear());
    sessionFor('bia@nekkora.dev');
    transport = null;
    await act(async () => release());
    await act(() => new Promise<void>((r) => setTimeout(r, 30)));
    expect(membersGets()).toHaveLength(1);
    // as 120 contas extras (mais antigas) ocupam a primeira página: espera só a coluna de ações
    await openMembers({ actions: false });
    expect(panel()).toBeNull();
  });

  it('navegação dentro da MESMA sessão preserva a incerteza', async () => {
    sessionFor('ana@nekkora.dev');
    let view = await openMembers();
    await uncertainSuspend();
    view.unmount();
    view = renderAt(`/o/${DEV_ORG}/administracao/concessoes`);
    await screen.findByRole('region', { name: 'Lista de concessões' });
    view.unmount();
    await openMembers({ actions: false });
    expect(panel()).toHaveTextContent('Suspensão de Caio Mendes: resultado não confirmado.');
  });
});

describe('acesso negado esconde aviso e diálogo', () => {
  it('403 na lista com o aviso de incerteza visível: aviso, nomes e ações somem; só nova leitura autorizada os devolve', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openMembers();
    await uncertainSuspend();
    api.product.revokeOrganizationRoles(ana.membershipId);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(await screen.findByText('Você não tem permissão para ver os membros desta organização.')).toBeInTheDocument();
    expect(panel()).toBeNull();
    expect(screen.queryByText(/Caio Mendes/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Conferir estado atual|Tentar de novo|Dispensar aviso/ })).toBeNull();
    // nova leitura ainda sem permissão: continua negado
    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));
    expect(await screen.findByText('Você não tem permissão para ver os membros desta organização.')).toBeInTheDocument();
    expect(panel()).toBeNull();
    api.product.memberships.get(ana.membershipId)!.orgRoles = ['ORG_ADMIN'];
    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(panel()).toHaveTextContent('Suspensão de Caio Mendes: resultado não confirmado.');
  });

  it('403 na continuação com o diálogo aberto: o diálogo fecha e nada do alvo fica visível', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openMembers();
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (m === 'GET' && p.includes('/members?') && p.includes('cursor=') ? { kind: 'delay', until } : null);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    fireEvent.click(screen.getByRole('button', { name: 'Suspender Dani Rocha' }));
    expect(await screen.findByRole('alertdialog', { name: 'Suspender Dani Rocha?' })).toBeInTheDocument();
    api.product.revokeOrganizationRoles(ana.membershipId);
    await act(async () => release());
    expect(await screen.findByText('Você não tem permissão para ver os membros desta organização.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByText(/Dani Rocha/)).toBeNull();
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});

describe('nova tentativa recusada depois de resultado incerto', () => {
  it('incerto → nova tentativa 404: o diálogo mostra a recusa E que a anterior continua incerta; o aviso continua, inclusive depois de sair e voltar', async () => {
    sessionFor('ana@nekkora.dev');
    let view = await openMembers();
    await uncertainSuspend();
    api.accounts.delete(acc('operador@nekkora.dev').userId);
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Tentar de novo/ }));
    const retry = await screen.findByRole('alertdialog', { name: 'Tentar de novo: suspender Caio Mendes?' });
    fireEvent.click(within(retry).getByRole('button', { name: 'Suspender de novo' }));
    const alert = await within(retry).findByRole('alert');
    expect(alert).toHaveTextContent('Este membro não foi encontrado nesta organização.');
    expect(alert).toHaveTextContent('A tentativa anterior continua sem resultado confirmado.');
    expect(within(retry).getByRole('button', { name: 'Suspender de novo' })).toBeDisabled();
    fireEvent.click(within(retry).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(panel()).toHaveTextContent('Suspensão de Caio Mendes: resultado não confirmado.');
    expect(panel()).toHaveTextContent('Nova tentativa recusada: Este membro não foi encontrado nesta organização.');
    view.unmount();
    view = renderAt(members);
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(panel()).toHaveTextContent('Suspensão de Caio Mendes: resultado não confirmado.');
    expect(requests.filter((r) => isSuspend(r.method, r.path))).toHaveLength(2);
  });
});
