/**
 * F6a-4: redefinir o MFA de um membro, com step-up TOTP imediatamente antes, pelo app real (AppRoutes) contra a API
 * simulada (MockApi, relógio controlado: os códigos TOTP são reais e de uso único).
 *
 * Duas origens de falha, separadas de propósito (como na F6a-2/F6a-3):
 * - CONTRATO: respostas documentadas vêm do próprio mock (401, 403, 404…), provocadas pelo estado da massa;
 * - TRANSPORTE: injetadas no fetch deste arquivo (`transport`), no step-up ou na redefinição, separadamente.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ORG, DEV_TOTP_SECRET, MockApi } from '../../mock/contract';
import { currentStep, totp } from '../../mock/totp';
import { AppRoutes } from '../app/AppRoutes';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';
import { PreviouslyUncertain, resetWriteStore, writeEntry } from '../admin/writeStore';

const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const members = `/o/${DEV_ORG}/administracao/membros`;

type Transport =
  | { kind: 'delay'; until: Promise<void>; then?: Transport }
  | { kind: 'network-before' }
  | { kind: 'network-after' }
  | { kind: 'gateway'; status: 502 | 503 | 504 }
  | { kind: 'off-contract' }
  | { kind: 'status'; status: number; body: unknown }
  | { kind: 'rewrite'; fn: (body: unknown) => unknown }
  /** 204 entregue à requisição ANTIGA, sem consultar o mock (o estado dele pode já ser outro) */
  | { kind: 'no-content' };

let now = T0;
let api: MockApi;
let cookie = '';
let requests: { method: string; path: string; body?: unknown }[] = [];
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
  return out;
}

const asResponse = (out: { status: number; body?: unknown; headers: Record<string, string> }) =>
  new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status, headers: out.headers });

async function apply(t: Transport, method: string, url: URL, init?: RequestInit): Promise<Response> {
  switch (t.kind) {
    case 'delay':
      await t.until;
      return t.then ? apply(t.then, method, url, init) : asResponse(await toMock(method, url, init));
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
    case 'no-content':
      return new Response(null, { status: 204 });
    case 'rewrite': {
      const out = await toMock(method, url, init);
      return asResponse({ ...out, body: t.fn(out.body) });
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  now = T0;
  api = new MockApi(() => now);
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
      requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const t = transport?.(method, path);
      return t ? apply(t, method, url, init) : asResponse(await toMock(method, url, init));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Código TOTP válido AGORA para as contas da massa (mesma chave fixa); `fresh` avança o relógio para um passo novo. */
const code = () => totp(DEV_TOTP_SECRET, currentStep(now));
const fresh = () => {
  now += 30_000;
  return code();
};
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
const posts = () => requests.filter((r) => r.method === 'POST' && /\/auth\/mfa\/step-up$|\/mfa\/reset$|\/(suspend|reactivate)$/.test(r.path));
const kinds = () => posts().map((r) => (r.path.endsWith('/step-up') ? 'step-up' : r.path.endsWith('/mfa/reset') ? 'reset' : 'outra'));
const isStepUp = (m: string, p: string) => m === 'POST' && p.endsWith('/auth/mfa/step-up');
const isReset = (m: string, p: string) => m === 'POST' && p.endsWith('/mfa/reset');
const row = (name: string) => within(screen.getByRole('region', { name: 'Lista de membros' })).getAllByRole('row').find((r) => r.textContent!.includes(name))!;
const panel = () => screen.queryByRole('region', { name: 'Ações sem resultado confirmado' });
const announced = () => screen.getByRole('status', { name: 'Resultado das ações' });
const CAIO = 'Caio Mendes';

async function openMembers() {
  const view = renderAt(members);
  await screen.findByRole('region', { name: 'Lista de membros' });
  await screen.findByRole('button', { name: `Redefinir MFA de ${CAIO}` });
  return view;
}

/** Abre o diálogo, escolhe o motivo, digita o código e confirma. */
async function confirmReset(name = CAIO, { reason = 'Dispositivo perdido', totpCode = code(), retry = false } = {}) {
  if (!retry) {
    const btn = screen.getByRole('button', { name: `Redefinir MFA de ${name}` });
    btn.focus();
    fireEvent.click(btn);
  }
  const dialog = await screen.findByRole('alertdialog', { name: retry ? `Tentar de novo: redefinir o MFA de ${name}?` : `Redefinir o MFA de ${name}?` });
  fireEvent.click(within(dialog).getByRole('radio', { name: reason }));
  fireEvent.change(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/), { target: { value: totpCode } });
  fireEvent.click(within(dialog).getByRole('button', { name: retry ? 'Redefinir de novo' : 'Redefinir MFA' }));
  return dialog;
}

async function uncertainReset(t: Transport = { kind: 'network-before' }) {
  transport = (m, p) => (isReset(m, p) ? t : null);
  const dialog = await confirmReset();
  await within(dialog).findByText(/Não foi possível confirmar o resultado/);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  transport = null;
}

describe('redefinir MFA: sucesso', () => {
  it('confirmação identifica a conta e os efeitos; step-up e redefinição, nessa ordem e uma vez; anúncio; MFA não configurado; foco na outra ação da linha', async () => {
    sessionFor('ana@nekkora.dev');
    const caio = acc('operador@nekkora.dev');
    await openMembers();
    const btn = screen.getByRole('button', { name: `Redefinir MFA de ${CAIO}` });
    btn.focus();
    fireEvent.click(btn);
    const dialog = await screen.findByRole('alertdialog', { name: `Redefinir o MFA de ${CAIO}?` });
    expect(dialog).toHaveTextContent('Caio Mendes (operador@nekkora.dev)');
    expect(dialog).toHaveTextContent('O autenticador e os códigos de recuperação desta conta deixam de valer, e as sessões abertas dela são encerradas agora.');
    expect(dialog).toHaveTextContent('No próximo acesso, será preciso cadastrar o autenticador de novo.');
    expect(dialog).toHaveTextContent('A conta recebe um aviso por e-mail. Se ela administra a organização, as demais pessoas que administram a organização também são avisadas.');
    expect(dialog).toHaveTextContent('Códigos de recuperação não são aceitos aqui.');
    const confirm = within(dialog).getByRole('button', { name: 'Redefinir MFA' });
    expect(confirm).toBeDisabled(); // sem motivo e sem código
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Suspeita de comprometimento' }));
    expect(confirm).toBeDisabled(); // falta o código
    const typed = code();
    fireEvent.change(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/), { target: { value: typed } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(kinds()).toEqual(['step-up', 'reset']);
    expect(posts()[0].body).toEqual({ code: typed });
    expect(posts()[1].body).toEqual({ reason: 'SUSPEITA_COMPROMETIMENTO' });
    expect(posts()[1].path).toContain(`/users/${caio.userId}/mfa/reset`);
    expect(caio.totpSecret).toBeUndefined();
    expect(api.adminWrites).toEqual([expect.objectContaining({ action: 'mfa-reset', target: caio.userId, reason: 'SUSPEITA_COMPROMETIMENTO' })]);
    expect(announced()).toHaveTextContent('MFA de Caio Mendes redefinido.');
    expect(row(CAIO)).toHaveTextContent('Não configurado');
    expect(screen.queryByRole('button', { name: `Redefinir MFA de ${CAIO}` })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: `Suspender ${CAIO}` })).toHaveFocus());
    // o código não fica no registro de escritas
    expect(JSON.stringify(writeEntry(DEV_ORG, caio.userId, 'mfa'))).not.toContain(typed);
  });

  it('ações conforme permissão, identidade e estado: própria conta sem ação; sem MFA sem botão; sem identity.mfa.reset sem botão (P01)', async () => {
    sessionFor('ana@nekkora.dev');
    const v = await openMembers();
    expect(row('Ana Souza')).toHaveTextContent('Sua conta');
    expect(within(row('Ana Souza')).queryByRole('button')).toBeNull();
    expect(within(row('Pessoa Nova')).queryByRole('button', { name: /Redefinir MFA/ })).toBeNull(); // sem MFA
    v.unmount();
    // P01 sem identity.mfa.reset (o resto igual): Suspender continua, Redefinir MFA não aparece
    transport = (m, p) =>
      m === 'GET' && p.endsWith('/me/permissions')
        ? {
            kind: 'rewrite',
            fn: (b) => {
              const body = b as { organization: { permissions: string[] } };
              return { ...body, organization: { ...body.organization, permissions: body.organization.permissions.filter((x) => x !== 'identity.mfa.reset') } };
            },
          }
        : null;
    renderAt(members);
    await screen.findByRole('button', { name: `Suspender ${CAIO}` });
    expect(screen.queryByRole('button', { name: /^Redefinir MFA/ })).toBeNull();
  });
});

describe('cancelamento e duplicidade', () => {
  it('Cancelar ou Esc: nenhum POST; foco volta ao botão; motivo e código recomeçam vazios', async () => {
    sessionFor('ana@nekkora.dev');
    await openMembers();
    const btn = screen.getByRole('button', { name: `Redefinir MFA de ${CAIO}` });
    btn.focus();
    fireEvent.click(btn);
    let dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Outro motivo' }));
    fireEvent.change(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/), { target: { value: code() } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(btn).toHaveFocus());
    fireEvent.click(btn);
    dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('radio', { name: 'Outro motivo' })).not.toBeChecked();
    expect(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/)).toHaveValue('');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(btn).toHaveFocus());
    expect(posts()).toEqual([]);
  });

  it('clique e Enter repetidos: UM step-up e UMA redefinição; durante o envio Cancelar, Esc e fundo não fecham', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (isStepUp(m, p) ? { kind: 'delay', until } : null);
    await openMembers();
    const dialog = await confirmReset();
    const confirm = within(dialog).getByRole('button', { name: 'Redefinir MFA' });
    fireEvent.click(confirm);
    fireEvent.keyDown(confirm, { key: 'Enter' });
    fireEvent.click(confirm);
    await waitFor(() => expect(kinds()).toEqual(['step-up']));
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(document.querySelector('.nk-dialog__backdrop')!);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(row(CAIO)).toHaveTextContent('Enviando…');
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(kinds()).toEqual(['step-up', 'reset']);
    expect(api.adminWrites).toHaveLength(1);
  });
});

describe('confirmação de identidade (step-up) recusada ou sem resposta: nada enviado ao alvo', () => {
  it('403 (código já usado): mensagem NEUTRA, sem atribuir ao código; redefinição não enviada; campo limpo; novo código conclui', async () => {
    sessionFor('ana@nekkora.dev');
    await openMembers();
    const used = code();
    acc('ana@nekkora.dev').lastStep = currentStep(now); // o código deste passo já foi usado
    const dialog = await confirmReset(CAIO, { totpCode: used });
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível confirmar sua identidade. Nada foi alterado na conta de Caio Mendes.');
    expect(alert.textContent).not.toMatch(/código|incorret|inválid/i);
    expect(kinds()).toEqual(['step-up']);
    expect(acc('operador@nekkora.dev').totpSecret).toBe(DEV_TOTP_SECRET);
    expect(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/)).toHaveValue('');
    expect(panel()).toBeNull();
    // nova tentativa no mesmo diálogo, com código novo
    fireEvent.change(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/), { target: { value: fresh() } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Redefinir MFA' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(kinds()).toEqual(['step-up', 'step-up', 'reset']);
    expect(announced()).toHaveTextContent('MFA de Caio Mendes redefinido.');
  });

  it.each([
    ['rede caída ANTES do step-up', { kind: 'network-before' } as Transport],
    ['rede caída DEPOIS do step-up', { kind: 'network-after' } as Transport],
    ['502 de gateway', { kind: 'gateway', status: 502 } as Transport],
    ['step-up fora do contrato (200 com corpo)', { kind: 'off-contract' } as Transport],
  ])('%s: recusa (não incerteza): redefinição não enviada; sem aviso de incerteza', async (_n, t) => {
    sessionFor('ana@nekkora.dev');
    transport = (m, p) => (isStepUp(m, p) ? t : null);
    await openMembers();
    const dialog = await confirmReset();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Não foi possível confirmar sua identidade agora. Nada foi alterado na conta de Caio Mendes.');
    await settle();
    expect(kinds()).toEqual(['step-up']);
    expect(api.adminWrites).toEqual([]);
    expect(writeEntry(DEV_ORG, acc('operador@nekkora.dev').userId, 'mfa')?.phase).toBe('refused');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(panel()).toBeNull();
  });

  it('429 no step-up: aguarde; nada alterado', async () => {
    sessionFor('ana@nekkora.dev');
    transport = (m, p) => (isStepUp(m, p) ? { kind: 'status', status: 429, body: { error: 'rate_limited' } } : null);
    await openMembers();
    const dialog = await confirmReset();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Muitas tentativas em pouco tempo. Aguarde um pouco e tente de novo. Nada foi alterado na conta de Caio Mendes.');
    expect(kinds()).toEqual(['step-up']);
  });

  it('401 no step-up: fluxo de sessão expirada (login com aviso), sem redefinição', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openMembers();
    api.revokeSessions(ana.userId);
    await confirmReset();
    await waitFor(() => expect(location).toBe(`/o/${DEV_ORG}/login`));
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
    // a sessão revogada já é recusada ao obter o CSRF de sessão: nem o step-up nem a redefinição saem
    expect(kinds()).toEqual([]);
    expect(requests.some((r) => r.path.endsWith('/auth/csrf'))).toBe(true);
    expect(api.adminWrites).toEqual([]);
  });
});

describe('redefinição recusada (respostas do contrato)', () => {
  it('perda de permissão depois de abrir: step-up aceito, redefinição 403 com mensagem neutra; nada alterado; sem repetição', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openMembers();
    api.product.revokeOrganizationRoles(ana.membershipId);
    const dialog = await confirmReset();
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('A redefinição não foi permitida. Suas permissões podem ter mudado. Nada foi alterado na conta de Caio Mendes.');
    expect(alert.textContent).not.toMatch(/código/i);
    expect(kinds()).toEqual(['step-up', 'reset']);
    expect(api.adminWrites).toEqual([]);
    await settle();
    expect(kinds()).toEqual(['step-up', 'reset']);
    expect(panel()).toBeNull();
  });

  it('alvo inexistente → 404', async () => {
    sessionFor('ana@nekkora.dev');
    await openMembers();
    api.accounts.delete(acc('operador@nekkora.dev').userId);
    const dialog = await confirmReset();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Este membro não foi encontrado nesta organização.');
    expect(panel()).toBeNull();
  });

  it('401 na redefinição (depois do step-up): fluxo de sessão expirada, tratado à parte', async () => {
    sessionFor('ana@nekkora.dev');
    transport = (m, p) => (isReset(m, p) ? { kind: 'status', status: 401, body: { error: 'unauthenticated' } } : null);
    await openMembers();
    await confirmReset();
    await waitFor(() => expect(location).toBe(`/o/${DEV_ORG}/login`));
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
  });
});

describe('resultado incerto da redefinição (falhas de TRANSPORTE depois do step-up)', () => {
  it.each([
    ['rede caída ANTES de aplicar', { kind: 'network-before' } as Transport, 0],
    ['rede caída DEPOIS de aplicar', { kind: 'network-after' } as Transport, 1],
    ['502 de gateway', { kind: 'gateway', status: 502 } as Transport, 0],
    ['503 de gateway', { kind: 'gateway', status: 503 } as Transport, 0],
    ['resposta fora do contrato (200 com corpo)', { kind: 'off-contract' } as Transport, 1],
  ])('%s: nem sucesso nem recusa; confirmar bloqueado; aviso persistente; foco no aviso; sem repetição', async (_n, t, applied) => {
    sessionFor('ana@nekkora.dev');
    transport = (m, p) => (isReset(m, p) ? t : null);
    await openMembers();
    const dialog = await confirmReset();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Não foi possível confirmar o resultado. A redefinição pode ter sido aplicada ou não.');
    expect(within(dialog).getByRole('button', { name: 'Redefinir MFA' })).toBeDisabled();
    // mesmo com motivo e um código NOVO digitados neste diálogo, confirmar continua bloqueado (só "Tentar de novo")
    fireEvent.change(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/), { target: { value: fresh() } });
    expect(within(dialog).getByRole('button', { name: 'Redefinir MFA' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Redefinir MFA' }));
    expect(api.adminWrites).toHaveLength(applied);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(panel()).toHaveTextContent('Redefinição de MFA de Caio Mendes: resultado não confirmado.');
    expect(row(CAIO)).toHaveTextContent('Resultado não confirmado');
    expect(within(row(CAIO)).queryByRole('button')).toBeNull(); // nenhuma outra ação sobre a conta
    await waitFor(() => expect(panel()).toHaveFocus());
    await settle();
    expect(kinds()).toEqual(['step-up', 'reset']);
  });

  it('conferir: lê o membro pelo id SEM filtros; informa o estado do MFA sem provar o resultado; o aviso continua', async () => {
    sessionFor('ana@nekkora.dev');
    await openMembers();
    await uncertainReset({ kind: 'network-after' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Revogado' }));
    await waitFor(() => expect(location).toContain('estado=revoked'));
    requests = [];
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    expect(await within(panel()!).findByText(/Estado atual lido às .*: MFA não configurado\. Isto informa como a conta está agora; não confirma o resultado do pedido\./)).toBeInTheDocument();
    const reads = requests.filter((r) => r.path.includes('/members?') && r.path.includes('limit=100'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => !r.path.includes('status='))).toBe(true);
    expect(panel()).toHaveTextContent('resultado não confirmado');
    expect(posts()).toHaveLength(0); // conferir só lê: nenhuma escrita
  });

  it('nova tentativa só por confirmação explícita, com aviso de eventos, avisos e encerramentos adicionais; exige novo motivo e novo código', async () => {
    sessionFor('ana@nekkora.dev');
    await openMembers();
    await uncertainReset();
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Tentar de novo/ }));
    let retry = await screen.findByRole('alertdialog', { name: `Tentar de novo: redefinir o MFA de ${CAIO}?` });
    expect(retry).toHaveTextContent('se a anterior foi aplicada, a redefinição acontece de novo, com novo registro na auditoria, novos avisos por e-mail e novo encerramento das sessões');
    expect(within(retry).getByRole('button', { name: 'Redefinir de novo' })).toBeDisabled();
    fireEvent.click(within(retry).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts()).toHaveLength(2);
    expect(panel()).not.toBeNull();
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Tentar de novo/ }));
    retry = await confirmReset(CAIO, { retry: true, totpCode: fresh() });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(kinds()).toEqual(['step-up', 'reset', 'step-up', 'reset']);
    expect(panel()).toBeNull();
    expect(announced()).toHaveTextContent('MFA de Caio Mendes redefinido.');
  });

  it('nova tentativa com step-up recusado (403) NÃO apaga a incerteza anterior', async () => {
    sessionFor('ana@nekkora.dev');
    await openMembers();
    await uncertainReset();
    acc('ana@nekkora.dev').lastStep = currentStep(now) + 5; // qualquer código atual é recusado
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Tentar de novo/ }));
    const retry = await confirmReset(CAIO, { retry: true });
    expect(await within(retry).findByRole('alert')).toHaveTextContent(
      'Não foi possível confirmar sua identidade. Nada foi alterado na conta de Caio Mendes. A tentativa anterior continua sem resultado confirmado.',
    );
    fireEvent.click(within(retry).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(panel()).toHaveTextContent('Redefinição de MFA de Caio Mendes: resultado não confirmado.');
    expect(panel()).toHaveTextContent('Nova tentativa recusada: Não foi possível confirmar sua identidade.');
    expect(kinds()).toEqual(['step-up', 'reset', 'step-up']);
  });

  it('403 na releitura da lista com a incerteza visível: aviso, nomes e ações somem; só "Verificar novamente" autorizado os devolve', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openMembers();
    await uncertainReset();
    api.product.revokeOrganizationRoles(ana.membershipId);
    fireEvent.click(screen.getByRole('button', { name: /Atualizar/ }));
    expect(await screen.findByText('Você não tem permissão para ver os membros desta organização.')).toBeInTheDocument();
    expect(panel()).toBeNull();
    expect(screen.queryByText(/Caio Mendes/)).toBeNull();
    api.product.memberships.get(ana.membershipId)!.orgRoles = ['ORG_ADMIN'];
    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(panel()).toHaveTextContent('Redefinição de MFA de Caio Mendes: resultado não confirmado.');
  });
});

describe('sessão, abas e respostas pendentes', () => {
  it('redefinição pendente que conclui DEPOIS da troca de sessão não altera a sessão nova; a incerteza volta só pelo registro persistente', async () => {
    sessionFor('ana@nekkora.dev');
    const view = await openMembers();
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (isReset(m, p) ? { kind: 'delay', until, then: { kind: 'network-before' } } : null);
    await confirmReset();
    await waitFor(() => expect(kinds()).toEqual(['step-up', 'reset']));
    view.unmount();
    act(() => csrfStore.clear());
    sessionFor('ana@nekkora.dev');
    const again = await openMembers();
    await act(async () => release());
    await settle();
    // a conclusão atrasada da sessão anterior não cria nem altera registro da sessão nova
    const id = acc('operador@nekkora.dev').userId;
    const late = writeEntry(DEV_ORG, id, 'mfa');
    expect(late === undefined || late.error instanceof PreviouslyUncertain).toBe(true);
    // FRONT-V1-002: a MESMA pessoa, ao reler a lista, vê a incerteza vinda do registro persistente — sem reenvio
    again.unmount();
    renderAt(members);
    await screen.findByRole('region', { name: 'Lista de membros' });
    await waitFor(() => expect(writeEntry(DEV_ORG, id, 'mfa')?.error).toBeInstanceOf(PreviouslyUncertain));
    expect(kinds()).toEqual(['step-up', 'reset']);
  });

  it('aviso de outra aba durante o step-up: sai da área; o 204 atrasado do step-up NÃO leva à redefinição', async () => {
    sessionFor('ana@nekkora.dev');
    await openMembers();
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    // R1: libera com 204 (aceito) — com 401 a sequência pararia por si só e o teste não provaria a guarda
    transport = (m, p) => (isStepUp(m, p) ? { kind: 'delay', until, then: { kind: 'no-content' } } : null);
    await confirmReset();
    await waitFor(() => expect(kinds()).toEqual(['step-up']));
    const otherTab = new BroadcastChannel('nekkora-sessao');
    otherTab.postMessage({ tipo: 'sessao-alterada' });
    await waitFor(() => expect(location).toBe(`/o/${DEV_ORG}/login`));
    expect(await screen.findByText('Sua sessão foi encerrada ou alterada em outra aba. Entre novamente para continuar.')).toBeInTheDocument();
    await act(async () => release());
    await settle();
    expect(kinds()).toEqual(['step-up']);
    expect(writeEntry(DEV_ORG, acc('operador@nekkora.dev').userId, 'mfa')).toBeUndefined();
    otherTab.close();
  });
});

describe('R1: a sequência step-up → redefinição pertence à sessão em que começou', () => {
  it('step-up iniciado na sessão A; troca para B (nova sessão VÁLIDA na mesma aba); 204 atrasado: nenhuma redefinição, nenhum registro antigo', async () => {
    sessionFor('ana@nekkora.dev');
    const view = await openMembers();
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (isStepUp(m, p) ? { kind: 'delay', until, then: { kind: 'no-content' } } : null);
    await confirmReset();
    await waitFor(() => expect(kinds()).toEqual(['step-up']));
    // fim da sessão A e entrada em B (mesma pessoa, cookie novo, CSRF novo disponível para quem pedir)
    view.unmount();
    act(() => csrfStore.clear());
    sessionFor('ana@nekkora.dev');
    await openMembers(); // B carregada e operante
    await act(async () => release()); // o step-up de A responde 204
    await settle();
    expect(kinds()).toEqual(['step-up']); // nenhuma redefinição, em sessão nenhuma
    expect(acc('operador@nekkora.dev').totpSecret).toBe(DEV_TOTP_SECRET);
    expect(api.adminWrites).toEqual([]);
    expect(writeEntry(DEV_ORG, acc('operador@nekkora.dev').userId, 'mfa')).toBeUndefined();
    expect(panel()).toBeNull();
    expect(screen.queryByText(/MFA de Caio Mendes redefinido/)).toBeNull();
  });

  it('a sessão muda enquanto o CSRF do step-up está sendo obtido: nenhum POST sai (nem step-up nem redefinição)', async () => {
    sessionFor('ana@nekkora.dev');
    const view = await openMembers();
    act(() => csrfStore.clear()); // sem CSRF em cache: o step-up precisa obter um antes do POST
    // (clear também é fronteira de sessão: abre-se a sessão que vai iniciar a ação DEPOIS dela)
    sessionFor('ana@nekkora.dev');
    view.unmount();
    await openMembers();
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (m === 'GET' && p.endsWith('/auth/csrf') ? { kind: 'delay', until } : null);
    requests = [];
    await confirmReset();
    await waitFor(() => expect(requests.some((r) => r.path.endsWith('/auth/csrf'))).toBe(true));
    // troca de sessão durante a espera: B entra; o CSRF pendente volta válido (lido com o cookie de B)
    act(() => csrfStore.clear());
    sessionFor('ana@nekkora.dev');
    await act(async () => release());
    await settle();
    expect(kinds()).toEqual([]);
    expect(api.adminWrites).toEqual([]);
    expect(writeEntry(DEV_ORG, acc('operador@nekkora.dev').userId, 'mfa')).toBeUndefined();
  });

  it('controle: na MESMA sessão, com o step-up atrasado, um step-up e uma redefinição', async () => {
    sessionFor('ana@nekkora.dev');
    await openMembers();
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (isStepUp(m, p) ? { kind: 'delay', until } : null);
    await confirmReset();
    await waitFor(() => expect(kinds()).toEqual(['step-up']));
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(kinds()).toEqual(['step-up', 'reset']);
    expect(api.adminWrites).toHaveLength(1);
    expect(announced()).toHaveTextContent('MFA de Caio Mendes redefinido.');
  });
});

describe('suspensão e redefinição de MFA não colidem', () => {
  it('suspensão incerta de uma conta e redefinição de outra: cada registro no seu tipo; a linha incerta não oferece outra ação', async () => {
    sessionFor('ana@nekkora.dev');
    await openMembers();
    transport = (m, p) => (m === 'POST' && p.endsWith('/suspend') ? { kind: 'network-before' } : null);
    fireEvent.click(screen.getByRole('button', { name: `Suspender ${CAIO}` }));
    const s = await screen.findByRole('alertdialog', { name: `Suspender ${CAIO}?` });
    fireEvent.click(within(s).getByRole('button', { name: 'Suspender' }));
    await within(s).findByRole('alert');
    fireEvent.click(within(s).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    transport = null;
    // Caio: suspensão incerta → nenhuma ação na linha (nem Redefinir MFA)
    expect(within(row(CAIO)).queryByRole('button')).toBeNull();
    // Dani: redefinição concluída, sem tocar o registro de Caio
    await confirmReset('Dani Rocha');
    await waitFor(() => expect(announced()).toHaveTextContent('MFA de Dani Rocha redefinido.'));
    const caio = acc('operador@nekkora.dev').userId;
    expect(writeEntry(DEV_ORG, caio, 'member')?.phase).toBe('uncertain');
    expect(writeEntry(DEV_ORG, caio, 'mfa')).toBeUndefined();
    expect(panel()).toHaveTextContent('Suspensão de Caio Mendes: resultado não confirmado.');
    expect(panel()).not.toHaveTextContent('Redefinição de MFA');
  });
});
