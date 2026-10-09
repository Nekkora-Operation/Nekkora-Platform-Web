/**
 * F6a-2: suspender e reativar membros pelo app real (AppRoutes) contra a API simulada (MockApi, relógio fixo).
 *
 * Duas origens de falha, separadas de propósito:
 * - CONTRATO: respostas documentadas no OpenAPI vêm do próprio mock (401, 403, 404…), provocadas pelo estado da massa;
 * - TRANSPORTE: injetadas no fetch deste arquivo (`transport`): rede caída antes ou DEPOIS de o mock aplicar, 502/503 de
 *   gateway sem corpo JSON e resposta fora do contrato. O seletor de falhas do mock NÃO é usado para isso.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ORG, MockApi, OTHER_ORG } from '../../mock/contract';
import { AppRoutes } from '../app/AppRoutes';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';
import { resetWriteStore } from '../admin/writeStore';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const members = `/o/${DEV_ORG}/administracao/membros`;

type Transport =
  | { kind: 'delay'; until: Promise<void>; then?: Transport }
  | { kind: 'network-before' }
  | { kind: 'network-after' }
  | { kind: 'gateway'; status: 502 | 503 | 504 }
  | { kind: 'off-contract' }
  | { kind: 'status'; status: number; body: unknown };

let api: MockApi;
let cookie = '';
let requests: { method: string; path: string }[] = [];
/** Falha de TRANSPORTE por requisição (null = segue para o mock). */
let transport: ((method: string, path: string) => Transport | null) | null = null;
let location = '';

function Probe() {
  const loc = useLocation();
  location = loc.pathname + loc.search;
  return null;
}

const acc = (email: string, org = DEV_ORG) => [...api.accounts.values()].find((a) => a.email === email && a.org === org)!;

function sessionFor(email: string, org = DEV_ORG) {
  const a = acc(email, org);
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
  switch (t.kind) {
    case 'delay':
      await t.until;
      return t.then ? apply(t.then, method, url, init) : toMock(method, url, init);
    case 'network-before':
      throw new TypeError('Failed to fetch');
    case 'network-after':
      await toMock(method, url, init); // o servidor aplicou; a resposta se perdeu no caminho
      throw new TypeError('Failed to fetch');
    case 'gateway':
      return new Response('<html><body>Bad Gateway</body></html>', { status: t.status, headers: { 'Content-Type': 'text/html' } });
    case 'off-contract':
      await toMock(method, url, init);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    case 'status':
      return new Response(JSON.stringify(t.body), { status: t.status, headers: { 'Content-Type': 'application/json' } });
  }
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
      const path = url.pathname + url.search;
      requests.push({ method, path });
      const t = transport?.(method, path);
      return t ? apply(t, method, url, init) : toMock(method, url, init);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const posts = (action?: 'suspend' | 'reactivate') => requests.filter((r) => r.method === 'POST' && /\/users\/[^/]+\/(suspend|reactivate)$/.test(r.path) && (!action || r.path.endsWith(action)));
const row = (name: string) => within(screen.getByRole('region', { name: 'Lista de membros' })).getAllByRole('row').find((r) => r.textContent!.includes(name))!;
const panel = () => screen.queryByRole('region', { name: 'Ações sem resultado confirmado' });
const isSuspendPost = (m: string, p: string) => m === 'POST' && p.endsWith('/suspend');

async function openMembers() {
  renderAt(members);
  await screen.findByRole('region', { name: 'Lista de membros' });
  // as ações dependem da P01
  await screen.findByRole('button', { name: 'Suspender Caio Mendes' });
}

async function confirmSuspend(name = 'Caio Mendes') {
  const btn = screen.getByRole('button', { name: `Suspender ${name}` });
  btn.focus();
  fireEvent.click(btn);
  const dialog = await screen.findByRole('alertdialog', { name: `Suspender ${name}?` });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Suspender' }));
  return dialog;
}

describe('suspender e reativar: sucesso', () => {
  it('suspende: confirmação explica o efeito; um POST; diálogo fecha; anúncio; linha atualizada; foco no botão novo (Reativar)', async () => {
    sessionFor('ana@nekkora.dev');
    const caio = acc('operador@nekkora.dev');
    await openMembers();
    const btn = screen.getByRole('button', { name: 'Suspender Caio Mendes' });
    btn.focus();
    fireEvent.click(btn);
    const dialog = await screen.findByRole('alertdialog', { name: 'Suspender Caio Mendes?' });
    expect(dialog).toHaveTextContent('as sessões abertas dela são encerradas agora');
    expect(dialog).toHaveTextContent('não restaura as sessões encerradas');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspender' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts()).toHaveLength(1);
    expect(caio.active).toBe(false);
    expect(screen.getByRole('status', { name: 'Resultado das ações' })).toHaveTextContent('Conta de Caio Mendes suspensa.');
    expect(row('Caio Mendes')).toHaveTextContent('Suspensa');
    const reativar = screen.getByRole('button', { name: 'Reativar Caio Mendes' });
    await waitFor(() => expect(reativar).toHaveFocus());
  });

  it('reativa: confirmação diz que não restaura sessões nem concessões; conta ativa', async () => {
    sessionFor('ana@nekkora.dev');
    const flavia = acc('suspensa@nekkora.dev');
    await openMembers();
    fireEvent.click(screen.getByRole('button', { name: 'Reativar Flávia Suspensa' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reativar Flávia Suspensa?' });
    expect(dialog).toHaveTextContent('não restaura sessões encerradas nem concessões revogadas');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reativar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(flavia.active).toBe(true);
    expect(posts('reactivate')).toHaveLength(1);
    expect(screen.getByRole('status', { name: 'Resultado das ações' })).toHaveTextContent('Conta de Flávia Suspensa reativada.');
    expect(screen.getByRole('button', { name: 'Suspender Flávia Suspensa' })).toBeInTheDocument();
  });

  it('ações conforme identidade e estado: a própria conta sem ação; pendente e encerrada sem ação; P01 em erro → sem coluna de ações', async () => {
    sessionFor('ana@nekkora.dev');
    const v = renderAt(members);
    await screen.findByRole('button', { name: 'Suspender Caio Mendes' });
    expect(row('Ana Souza')).toHaveTextContent('Sua conta');
    expect(within(row('Ana Souza')).queryByRole('button')).toBeNull();
    expect(within(row('Helena Convidada')).queryByRole('button')).toBeNull();
    expect(within(row('Íris Encerrada')).queryByRole('button')).toBeNull();
    v.unmount();
    transport = (m, p) => (m === 'GET' && p.endsWith('/me/permissions') ? { kind: 'status', status: 500, body: { error: 'internal_error' } } : null);
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(screen.queryByRole('columnheader', { name: 'Ações' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Suspender / })).toBeNull();
  });
});

describe('cancelamento e duplicidade', () => {
  it('cancelar ou Esc antes de confirmar: nenhum POST', async () => {
    sessionFor('ana@nekkora.dev');
    await openMembers();
    fireEvent.click(screen.getByRole('button', { name: 'Suspender Caio Mendes' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Suspender Caio Mendes' }));
    await screen.findByRole('alertdialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts()).toEqual([]);
    expect(acc('operador@nekkora.dev').active).toBe(true);
  });

  it('clique e Enter repetidos: UM POST; durante o envio Cancelar, Esc e fundo não fecham', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (isSuspendPost(m, p) ? { kind: 'delay', until } : null);
    await openMembers();
    fireEvent.click(screen.getByRole('button', { name: 'Suspender Caio Mendes' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Suspender' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.keyDown(confirm, { key: 'Enter' });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(document.querySelector('.nk-dialog__backdrop')!);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts()).toHaveLength(1);
    expect(api.adminWrites).toHaveLength(1);
  });
});

describe('recusas comprovadas (respostas do contrato, vindas do mock)', () => {
  it('perda de permissão antes de confirmar → 403: mensagem genérica, nada aplicado, nenhuma repetição', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openMembers();
    api.product.revokeOrganizationRoles(ana.membershipId);
    const dialog = await confirmSuspend();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A ação não foi permitida.');
    expect(api.adminWrites).toEqual([]);
    expect(posts()).toHaveLength(1);
    await act(() => new Promise<void>((r) => setTimeout(r, 30)));
    expect(posts()).toHaveLength(1);
    expect(panel()).toBeNull();
  });

  it('alvo inexistente → 404: "não foi encontrado nesta organização"', async () => {
    sessionFor('ana@nekkora.dev');
    await openMembers();
    api.accounts.delete(acc('operador@nekkora.dev').userId);
    const dialog = await confirmSuspend();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Este membro não foi encontrado nesta organização.');
    expect(panel()).toBeNull();
  });

  it('sessão expirada → 401: volta ao login com o aviso; nada aplicado', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openMembers();
    api.revokeSessions(ana.userId);
    await confirmSuspend();
    await waitFor(() => expect(location).toBe(`/o/${DEV_ORG}/login`));
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
    expect(api.adminWrites).toEqual([]);
  });
});

describe('resultado incerto (falhas de TRANSPORTE injetadas)', () => {
  it.each([
    ['rede caída ANTES de aplicar', { kind: 'network-before' } as Transport, 0],
    ['rede caída DEPOIS de aplicar', { kind: 'network-after' } as Transport, 1],
    ['502 de gateway sem corpo JSON', { kind: 'gateway', status: 502 } as Transport, 0],
    ['503 de gateway sem corpo JSON', { kind: 'gateway', status: 503 } as Transport, 0],
    ['resposta fora do contrato (200 com corpo)', { kind: 'off-contract' } as Transport, 1],
  ])('%s: nem sucesso nem recusa; confirmar bloqueado; aviso persistente; foco no aviso ao fechar', async (_n, t, applied) => {
    sessionFor('ana@nekkora.dev');
    transport = (m, p) => (isSuspendPost(m, p) ? t : null);
    await openMembers();
    const dialog = await confirmSuspend();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Não foi possível confirmar o resultado.');
    expect(within(dialog).getByRole('button', { name: 'Suspender' })).toBeDisabled();
    expect(screen.queryByText('Conta de Caio Mendes suspensa.')).toBeNull();
    expect(api.adminWrites).toHaveLength(applied);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(panel()).toHaveTextContent('Suspensão de Caio Mendes: resultado não confirmado.');
    expect(row('Caio Mendes')).toHaveTextContent('Resultado não confirmado');
    expect(within(row('Caio Mendes')).queryByRole('button')).toBeNull();
    await waitFor(() => expect(panel()).toHaveFocus());
    await act(() => new Promise<void>((r) => setTimeout(r, 30)));
    expect(posts()).toHaveLength(1);
  });

  it('conferir estado atual: procura pelo id SEM os filtros da tela, percorrendo páginas; informa o estado sem provar o resultado; o aviso continua', async () => {
    sessionFor('ana@nekkora.dev');
    transport = (m, p) => (isSuspendPost(m, p) ? { kind: 'network-after' } : null);
    await openMembers();
    const dialog = await confirmSuspend();
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    // filtro na tela que NÃO inclui o alvo depois da suspensão… a conferência ignora o filtro
    fireEvent.click(screen.getByRole('checkbox', { name: 'Revogado' }));
    await waitFor(() => expect(location).toContain('estado=revoked'));
    requests = [];
    // muitos membros: o alvo fica além da primeira página de 100
    for (let i = 0; i < 120; i++) api.createAccount({ org: DEV_ORG, displayName: `Extra ${i}`, createdAt: NOW - 500 * 86_400_000 });
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    expect(await within(panel()!).findByText(/Estado atual lido às .*: conta suspensa\. .*não confirma o resultado do pedido\./)).toBeInTheDocument();
    const checks = requests.filter((r) => r.path.includes('/members?') && r.path.includes('limit=100'));
    expect(checks.length).toBe(2);
    expect(checks.every((r) => !r.path.includes('status='))).toBe(true);
    expect(checks[1].path).toContain('cursor=');
    expect(panel()).toHaveTextContent('resultado não confirmado');
  });

  it('conferência: alvo ausente, leitura incompleta (cursor recusado), recusada (403) e interrompida — nenhuma conclui o resultado', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    transport = (m, p) => (isSuspendPost(m, p) ? { kind: 'network-before' } : null);
    await openMembers();
    const dialog = await confirmSuspend();
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    const conferir = () => fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));

    const caio = acc('operador@nekkora.dev');
    api.accounts.delete(caio.userId);
    conferir();
    expect(await within(panel()!).findByText(/não foi encontrado na lista atual\. Isso não indica sucesso nem falha/)).toBeInTheDocument();
    api.accounts.set(caio.userId, caio);

    for (let i = 0; i < 120; i++) api.createAccount({ org: DEV_ORG, displayName: `Extra ${i}`, createdAt: NOW - 500 * 86_400_000 });
    transport = (m, p) => (m === 'GET' && p.includes('/members?') && p.includes('cursor=') ? { kind: 'status', status: 400, body: { error: 'invalid_request' } } : null);
    conferir();
    expect(await within(panel()!).findByText(/a lista não pôde ser percorrida até o fim/)).toBeInTheDocument();

    transport = null;
    api.product.revokeOrganizationRoles(ana.membershipId);
    conferir();
    // R1: conferência recusada (403) = acesso perdido: a tela passa a acesso negado, sem aviso, nomes nem ações
    expect(await screen.findByText('Você não tem permissão para ver os membros desta organização.')).toBeInTheDocument();
    expect(panel()).toBeNull();
    expect(screen.queryByText(/Caio Mendes/)).toBeNull();
    api.product.memberships.get(ana.membershipId)!.orgRoles = ['ORG_ADMIN'];
    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));
    await screen.findByRole('region', { name: 'Lista de membros' });
    // só a nova leitura autorizada devolve o aviso — a incerteza continua registrada
    expect(panel()).toHaveTextContent('Suspensão de Caio Mendes: resultado não confirmado.');

    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (m === 'GET' && p.includes('/members?') && p.includes('limit=100') ? { kind: 'delay', until } : null);
    conferir();
    fireEvent.click(await within(panel()!).findByRole('button', { name: /^Interromper a conferência/ }));
    await act(async () => release());
    expect(await within(panel()!).findByText('Conferência interrompida. Nada foi alterado.')).toBeInTheDocument();
    expect(panel()).toHaveTextContent('resultado não confirmado');
    expect(posts()).toHaveLength(1);
  });

  it('nova tentativa só por confirmação explícita, com aviso; cancelar mantém a incerteza; confirmar com sucesso a encerra', async () => {
    sessionFor('ana@nekkora.dev');
    transport = (m, p) => (isSuspendPost(m, p) ? { kind: 'network-before' } : null);
    await openMembers();
    const dialog = await confirmSuspend();
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    transport = null;
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Tentar de novo/ }));
    let retry = await screen.findByRole('alertdialog', { name: 'Tentar de novo: suspender Caio Mendes?' });
    expect(retry).toHaveTextContent('O resultado anterior não foi confirmado.');
    fireEvent.click(within(retry).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts()).toHaveLength(1);
    expect(panel()).not.toBeNull();
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Tentar de novo/ }));
    retry = await screen.findByRole('alertdialog', { name: 'Tentar de novo: suspender Caio Mendes?' });
    fireEvent.click(within(retry).getByRole('button', { name: 'Suspender de novo' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts()).toHaveLength(2);
    expect(panel()).toBeNull();
    expect(screen.getByRole('status', { name: 'Resultado das ações' })).toHaveTextContent('Conta de Caio Mendes suspensa.');
  });

  it('navegar para outra tela e voltar não apaga a incerteza; sair durante o envio não cancela: o resultado incerto aparece ao voltar', async () => {
    sessionFor('ana@nekkora.dev');
    transport = (m, p) => (isSuspendPost(m, p) ? { kind: 'network-before' } : null);
    let view = renderAt(members);
    await screen.findByRole('button', { name: 'Suspender Caio Mendes' });
    const dialog = await confirmSuspend();
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    view.unmount();
    view = renderAt(`/o/${DEV_ORG}/administracao/clientes`);
    await screen.findByRole('region', { name: 'Lista de clientes' });
    view.unmount();
    view = renderAt(members);
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(panel()).toHaveTextContent('Suspensão de Caio Mendes: resultado não confirmado.');

    // sai durante o envio de outra ação
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (m === 'POST' && p.endsWith('/reactivate') ? { kind: 'delay', until, then: { kind: 'network-before' } } : null);
    fireEvent.click(await screen.findByRole('button', { name: 'Reativar Flávia Suspensa' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reativar' }));
    await waitFor(() => expect(posts('reactivate')).toHaveLength(1));
    view.unmount();
    await act(async () => release());
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(panel()).toHaveTextContent('Reativação de Flávia Suspensa: resultado não confirmado.');
    expect(panel()).toHaveTextContent('Suspensão de Caio Mendes: resultado não confirmado.');
  });

  it('respostas de alvos diferentes não se misturam: a incerteza de um não altera o sucesso do outro', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    const caio = acc('operador@nekkora.dev').userId;
    transport = (m, p) => (m === 'POST' && p.includes(caio) ? { kind: 'delay', until, then: { kind: 'network-before' } } : null);
    await openMembers();
    await confirmSuspend('Caio Mendes');
    await waitFor(() => expect(posts()).toHaveLength(1));
    // o diálogo de Caio está em envio; Dani é suspensa por outro caminho só depois — aqui, garantimos a chave por alvo:
    await act(async () => release());
    await waitFor(() => expect(panel()).not.toBeNull());
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }));
    await confirmSuspend('Dani Rocha');
    await waitFor(() => expect(screen.getByRole('status', { name: 'Resultado das ações' })).toHaveTextContent('Conta de Dani Rocha suspensa.'));
    expect(row('Dani Rocha')).toHaveTextContent('Suspensa');
    expect(row('Caio Mendes')).toHaveTextContent('Resultado não confirmado');
    expect(panel()).toHaveTextContent('Suspensão de Caio Mendes');
    expect(panel()).not.toHaveTextContent('Dani Rocha');
  });
});

describe('isolamento entre organizações no registro de escritas', () => {
  it('incerteza em uma organização não aparece na outra', async () => {
    sessionFor('ana@nekkora.dev');
    transport = (m, p) => (isSuspendPost(m, p) ? { kind: 'network-before' } : null);
    const v = renderAt(members);
    await screen.findByRole('button', { name: 'Suspender Caio Mendes' });
    const dialog = await confirmSuspend();
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(panel()).not.toBeNull();
    v.unmount();
    sessionFor('vizinha@nekkora.dev', OTHER_ORG);
    renderAt(`/o/${OTHER_ORG}/administracao/membros`);
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(panel()).toBeNull();
  });
});
