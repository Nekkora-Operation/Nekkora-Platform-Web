/**
 * F6a-3: revogar concessões pelo app real (AppRoutes) contra a API simulada (MockApi, relógio fixo).
 *
 * Duas origens de falha, separadas de propósito (como na F6a-2):
 * - CONTRATO: respostas documentadas no OpenAPI vêm do próprio mock (401, 403, 404…), provocadas pelo estado da massa;
 * - TRANSPORTE: injetadas no fetch deste arquivo (`transport`): rede caída antes ou DEPOIS de o mock aplicar, 502/503 de
 *   gateway sem corpo JSON e resposta fora do contrato.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ORG, MockApi } from '../../mock/contract';
import { stableUuid } from '../../mock/product';
import { AppRoutes } from '../app/AppRoutes';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';
import { revokeClientGrant } from '../api/admin';
import { PreviouslyUncertain, resetWriteStore, startWrite, writeEntry } from '../admin/writeStore';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const grants = `/o/${DEV_ORG}/administracao/concessoes`;
const members = `/o/${DEV_ORG}/administracao/membros`;
const G = (k: string) => stableUuid(`dev:grant:${k}`);
const G1 = 'Pessoa do Portal (cliente ACME Logística, workspace Logística)';
const G4 = 'Financeiro do Banco (cliente Banco Exemplo S.A., workspace Financeiro — Conciliação)';
const G5 = 'Financeiro do Banco (cliente Banco Exemplo S.A., workspace Relatórios regulatórios consolidados do semestre — Sul)';

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
      await toMock(method, url, init);
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

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
const revokes = () => requests.filter((r) => r.method === 'POST' && /\/client-grants\/[^/]+\/revoke$/.test(r.path));
const isRevoke = (m: string, p: string) => m === 'POST' && p.endsWith('/revoke');
const grantReads = () => requests.filter((r) => r.method === 'GET' && r.path.includes('/client-grants?'));
const checkReads = () => grantReads().filter((r) => r.path.includes('limit=100'));
const row = (id: string) => document.querySelector(`[data-concessao-linha="${id}"]`)?.closest('tr') ?? null;
const panel = () => screen.queryByRole('region', { name: 'Ações sem resultado confirmado' });
const announced = () => screen.getByRole('status', { name: 'Resultado das ações' });

async function openGrants(path = grants, actionOf = G1) {
  const view = renderAt(path);
  await screen.findByRole('region', { name: 'Lista de concessões' });
  // as ações dependem da P01 (espera o botão de uma concessão que tenha ação nesta tela)
  await screen.findByRole('button', { name: `Revogar a concessão de ${actionOf}` });
  return view;
}

async function confirmRevoke(label = G1) {
  const btn = screen.getByRole('button', { name: `Revogar a concessão de ${label}` });
  btn.focus();
  fireEvent.click(btn);
  const dialog = await screen.findByRole('alertdialog', { name: /^Revogar a concessão de / });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revogar' }));
  return dialog;
}

async function uncertainRevoke(t: Transport = { kind: 'network-before' }) {
  transport = (m, p) => (isRevoke(m, p) ? t : null);
  const dialog = await confirmRevoke();
  await within(dialog).findByRole('alert');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  transport = null;
}

describe('revogar: sucesso', () => {
  it('a confirmação identifica cliente e workspace e explica o efeito; um POST; anúncio; linha revogada; foco na linha', async () => {
    sessionFor('ana@nekkora.dev');
    await openGrants();
    const btn = screen.getByRole('button', { name: `Revogar a concessão de ${G1}` });
    btn.focus();
    fireEvent.click(btn);
    const dialog = await screen.findByRole('alertdialog', { name: 'Revogar a concessão de Pessoa do Portal?' });
    expect(dialog).toHaveTextContent('portal@nekkora.dev');
    expect(dialog).toHaveTextContent('ClienteACME Logística');
    expect(dialog).toHaveTextContent('WorkspaceLogística');
    expect(dialog).toHaveTextContent('deixa de dar à conta Pessoa do Portal acesso ao workspace Logística do cliente ACME Logística');
    expect(dialog).toHaveTextContent('Só esta concessão muda: outras concessões da mesma conta e a própria conta continuam como estão.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(revokes()).toHaveLength(1);
    expect(revokes()[0].path).toContain(`/client-grants/${G('g1')}/revoke`);
    expect(api.admin.grants.get(G('g1'))!.status).toBe('revoked');
    expect(api.admin.grants.get(G('g2'))!.status).toBe('suspended'); // outra concessão da mesma conta
    expect(announced()).toHaveTextContent(`Concessão de ${G1} revogada.`);
    expect(row(G('g1'))).toHaveTextContent('Revogada');
    expect(within(row(G('g1'))!).queryByRole('button')).toBeNull();
    await waitFor(() => expect(document.querySelector(`[data-concessao-linha="${G('g1')}"]`)).toHaveFocus());
  });

  it('ações conforme estado: pendente, ativa e suspensa têm "Revogar"; revogada não; P01 em erro → sem coluna de ações', async () => {
    sessionFor('ana@nekkora.dev');
    const v = await openGrants();
    for (const k of ['g1', 'g2', 'g4', 'g5', 'g6']) expect(within(row(G(k))!).getByRole('button', { name: /^Revogar a concessão de / }), k).toBeInTheDocument();
    // revogada: sem "Revogar"; M2 (024) acrescenta só "Pedir de novo" (pedido novo, outra pessoa aprova)
    expect(within(row(G('g3'))!).queryByRole('button', { name: /^Revogar/ })).toBeNull();
    expect(within(row(G('g3'))!).getAllByRole('button').map((b) => b.textContent)).toEqual(['Pedir de novo']);
    v.unmount();
    transport = (m, p) => (m === 'GET' && p.endsWith('/me/permissions') ? { kind: 'status', status: 500, body: { error: 'internal_error' } } : null);
    renderAt(grants);
    await screen.findByRole('region', { name: 'Lista de concessões' });
    expect(screen.queryByRole('columnheader', { name: 'Ações' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Revogar/ })).toBeNull();
    expect(screen.getByText(/Somente consulta\./)).toBeInTheDocument();
  });

  it('FRONT-V1-002: "Pedir renovação" e "Pedir de novo" abrem sem quebrar com a data vazia; renovação avisa que a aprovação está indisponível; nenhum "Aprovar renovação"', async () => {
    sessionFor('ana@nekkora.dev');
    await openGrants();
    expect(screen.queryByRole('button', { name: /^Aprovar renovação/ })).toBeNull();
    const sent: unknown[] = [];
    transport = (m, p) => {
      if (m === 'POST' && p.endsWith('/renew')) {
        sent.push(p);
        return {
          kind: 'status',
          status: 202,
          body: {
            grantId: G('g1'),
            clientMembershipId: stableUuid('cm-renovacao'),
            workspaceId: stableUuid('ws-renovacao'),
            status: 'ATIVA',
            startsAt: '2026-10-01T00:00:00Z',
            expiresAt: null,
            nextReviewAt: '2026-11-15T23:59:59Z',
            renewal: { requestedByMembershipId: stableUuid('m-ana'), requestedAt: '2026-10-30T10:00:00Z', nextReviewAt: '2026-12-31T23:59:59Z', expiresAt: null, justification: 'x' },
          },
        };
      }
      return null;
    };
    fireEvent.click(within(row(G('g1'))!).getByRole('button', { name: /^Pedir renovação/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Aprovar a renovação ainda não está disponível nesta tela/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Enviar pedido' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^Próxima revisão/), { target: { value: '2099-12-31' } });
    fireEvent.change(within(dialog).getByLabelText(/^Justificativa/), { target: { value: 'Contrato renovado' } });
    // o envio só é liberado depois de o registro persistente da operação estar pronto (resumo assíncrono)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Enviar pedido' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));
    expect(await screen.findByText(/Pedido de renovação registrado\. O acesso não muda/)).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    // revogada: "Pedir de novo" também abre com a data vazia
    fireEvent.click(within(row(G('g3'))!).getByRole('button', { name: /^Pedir de novo/ }));
    const again = await screen.findByRole('alertdialog');
    expect(within(again).getByRole('button', { name: 'Enviar pedido' })).toBeDisabled();
  });

  it('decisão com resultado desconhecido (504 do proxy): a linha não oferece decidir de novo até a pessoa usar "Atualizar"', async () => {
    sessionFor('ana@nekkora.dev');
    await openGrants();
    let renews = 0;
    transport = (m, p) => (m === 'POST' && p.endsWith('/renew') && ++renews ? { kind: 'gateway', status: 504 } : null);
    fireEvent.click(within(row(G('g1'))!).getByRole('button', { name: /^Pedir renovação/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText(/^Próxima revisão/), { target: { value: '2099-12-31' } });
    fireEvent.change(within(dialog).getByLabelText(/^Justificativa/), { target: { value: 'Contrato renovado' } });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Enviar pedido' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));
    expect(await screen.findByText(/O resultado da última decisão não foi confirmado/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(row(G('g1'))).toHaveTextContent('Decisão não confirmada'));
    expect(within(row(G('g1'))!).queryByRole('button', { name: /^Pedir renovação/ })).toBeNull();
    expect(renews).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(within(row(G('g1'))!).getByRole('button', { name: /^Pedir renovação/ })).toBeInTheDocument());
  });

  it('concessão já revogada por outra pessoa depois da leitura: 204 = sucesso (idempotente), sem nova alteração', async () => {
    sessionFor('ana@nekkora.dev');
    await openGrants();
    const g = api.admin.grants.get(G('g1'))!;
    g.status = 'revoked';
    g.revokedAt = NOW - 60_000;
    await confirmRevoke();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(announced()).toHaveTextContent(`Concessão de ${G1} revogada.`);
    expect(api.admin.grants.get(G('g1'))!.revokedAt).toBe(NOW - 60_000);
    expect(row(G('g1'))).toHaveTextContent('Revogada');
    expect(panel()).toBeNull();
  });

  it('filtro sem "Revogada": a linha revogada sai da vista e o foco vai à lista', async () => {
    sessionFor('ana@nekkora.dev');
    await openGrants(`${grants}?estado=active`);
    await confirmRevoke();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(row(G('g1'))).toBeNull();
    expect(row(G('g4'))).not.toBeNull();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Lista de concessões' })).toHaveFocus());
    expect(announced()).toHaveTextContent(`Concessão de ${G1} revogada.`);
  });

  it('filtro com uma única concessão: a lista fica vazia e o foco vai ao conteúdo principal', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`${grants}?estado=pending`);
    const btn = await screen.findByRole('button', { name: `Revogar a concessão de ${G5}` });
    btn.focus();
    fireEvent.click(btn);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByText('Nenhuma concessão com esses filtros.')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('main')).toHaveFocus());
    expect(announced()).toHaveTextContent(`Concessão de ${G5} revogada.`);
    // controle (R1): lista ENCERRADA, sem cursor — vazio verdadeiro, sem continuação
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    expect(screen.queryByText(/entre as carregadas/)).toBeNull();
  });

  it('R1: revogar TODAS as carregadas com próxima página: vazio só entre as carregadas, continuação disponível sem busca automática, foco válido; o cursor encontra outra concessão', async () => {
    sessionFor('ana@nekkora.dev');
    // ativas: g1, g4, g6 + 25 antigas + 1 da segunda página = 29 → páginas de 25 e 4; a mais antiga é de outra conta
    const portal = acc('portal@nekkora.dev');
    for (let i = 0; i < 25; i++) api.addGrant(DEV_ORG, 'dev', `old${i}`, portal, 'banco', 'financeiro', 'active', 400 + i);
    const ultima = api.createAccount({ org: DEV_ORG, displayName: 'Conta da Segunda Página', accountType: 'external' });
    api.addGrant(DEV_ORG, 'dev', 'segunda', ultima, 'acme', 'logistica', 'active', 999);
    const SEGUNDA = 'Conta da Segunda Página (cliente ACME Logística, workspace Logística)';
    renderAt(`${grants}?estado=active`);
    await screen.findByRole('button', { name: `Revogar a concessão de ${G1}` });
    expect(screen.getAllByRole('button', { name: /^Revogar a concessão de / })).toHaveLength(25);
    expect(screen.getByRole('button', { name: 'Carregar mais' })).toBeInTheDocument();
    const readsBefore = grantReads().length;

    for (let i = 0; i < 25; i++) {
      const btn = screen.getAllByRole('button', { name: /^Revogar a concessão de / })[0];
      btn.focus();
      fireEvent.click(btn);
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revogar' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    }
    expect(revokes()).toHaveLength(25);

    // nada visível ENTRE AS CARREGADAS, mas a lista continua
    const region = screen.getByRole('region', { name: 'Lista de concessões' });
    expect(region).toHaveTextContent('Nenhuma concessão com esses filtros entre as carregadas até agora.');
    expect(screen.queryByText('Nenhuma concessão com esses filtros.')).toBeNull();
    await waitFor(() => expect(region).toHaveFocus());
    expect(screen.getByText(/Exibindo 0 concessões/)).toBeInTheDocument();
    const more = screen.getByRole('button', { name: 'Carregar mais' });
    // sem busca automática; filtros preservados
    await settle();
    expect(grantReads()).toHaveLength(readsBefore);
    expect(location).toBe(`${grants}?estado=active`);

    fireEvent.click(more);
    expect(await screen.findByRole('button', { name: `Revogar a concessão de ${SEGUNDA}` })).toBeInTheDocument();
    const next = grantReads().slice(readsBefore);
    expect(next).toHaveLength(1);
    expect(next[0].path).toContain('cursor=');
    expect(next[0].path).toContain('status=active');
    expect(screen.getAllByRole('button', { name: /^Revogar a concessão de / })).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    expect(screen.getByText(/Exibindo 4 concessões · lista completa/)).toBeInTheDocument();
    // Limite próprio de 30 s (o global continua 5 s): o teste faz 25 fluxos completos de revogação, cada um com diálogo,
    // envio e fechamento, porque a página tem 25 itens. Isolado levou ~4,3 s; na suíte completa (arquivos em paralelo)
    // passou de 5 s (5,17 s, check da R1 preservado em check_r1.txt) sem nenhuma verificação reprovada. O limite é
    // compatível com essa carga; a causa exata da lentidão não foi demonstrada. Sem retry e sem afrouxar verificações.
  }, 30_000);
});

describe('R2: continuação RECUSADA com zero linhas visíveis', () => {
  it('zerar as visíveis → cursor recusado: aviso e recomeço continuam (não é "lista encerrada"); nada é lido sozinho nem o cursor reenviado; recomeçar lê a primeira página SEM cursor e com os filtros', async () => {
    sessionFor('ana@nekkora.dev');
    // mesma massa do teste R1: 29 ativas → páginas de 25 e 4; a mais antiga é de outra conta
    const portal = acc('portal@nekkora.dev');
    for (let i = 0; i < 25; i++) api.addGrant(DEV_ORG, 'dev', `old${i}`, portal, 'banco', 'financeiro', 'active', 400 + i);
    const ultima = api.createAccount({ org: DEV_ORG, displayName: 'Conta da Segunda Página', accountType: 'external' });
    api.addGrant(DEV_ORG, 'dev', 'segunda', ultima, 'acme', 'logistica', 'active', 999);
    const SEGUNDA = 'Conta da Segunda Página (cliente ACME Logística, workspace Logística)';
    renderAt(`${grants}?estado=active`);
    await screen.findByRole('button', { name: `Revogar a concessão de ${G1}` });
    const ids = [...document.querySelectorAll<HTMLElement>('[data-concessao-acao]')].map((b) => b.dataset.concessaoAcao!);
    expect(ids).toHaveLength(25);

    // 24 revogações pela MESMA infraestrutura de escrita do diálogo (startWrite + revokeClientGrant, contra o mock), sem
    // abrir 24 diálogos (o fluxo com diálogo de todas as 25 já é coberto pelo teste R1); a última, pelo diálogo
    await act(async () => {
      for (const id of ids.slice(0, 24)) {
        const target = { kind: 'grant' as const, grantId: id, displayName: 'x', email: 'x@x.dev', clientName: 'x', workspaceName: 'x' };
        startWrite(DEV_ORG, 'revoke', target, () => revokeClientGrant(DEV_ORG, id));
      }
    });
    await waitFor(() => expect(ids.slice(0, 24).every((id) => writeEntry(DEV_ORG, id, 'grant')?.phase === 'done')).toBe(true));
    const last = screen.getByRole('button', { name: /^Revogar a concessão de / });
    last.focus();
    fireEvent.click(last);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(revokes()).toHaveLength(25);
    expect(screen.getByRole('region', { name: 'Lista de concessões' })).toHaveTextContent('A lista continua');

    // a continuação é RECUSADA (cursor inválido ou expirado: 400 do contrato)
    transport = (m, p) =>
      m === 'GET' && p.includes('/client-grants?') && p.includes('cursor=') ? { kind: 'status', status: 400, body: { error: 'invalid_request' } } : null;
    const readsBefore = grantReads().length;
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('A lista mudou desde a última página (ou a continuação expirou).')).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Lista de concessões' });
    expect(region).toHaveTextContent('Nenhuma concessão com esses filtros entre as carregadas até agora.');
    expect(region).toHaveTextContent('Não foi possível continuar a lista. Recomece para ver as demais.');
    expect(screen.queryByText('Nenhuma concessão com esses filtros.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    const restart = screen.getByRole('button', { name: 'Recomeçar a lista' });
    // só a continuação pedida; nada é lido sozinho e o cursor recusado não é reenviado
    await settle();
    const afterReject = grantReads().slice(readsBefore);
    expect(afterReject).toHaveLength(1);
    expect(afterReject[0].path).toContain('cursor=');
    expect(location).toBe(`${grants}?estado=active`);

    // recomeço MANUAL: nova primeira página, sem cursor, com o mesmo filtro
    transport = null;
    fireEvent.click(restart);
    expect(await screen.findByRole('button', { name: `Revogar a concessão de ${SEGUNDA}` })).toBeInTheDocument();
    const afterRestart = grantReads().slice(readsBefore + 1);
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0].path).not.toContain('cursor=');
    expect(afterRestart[0].path).toContain('status=active');
    expect(location).toBe(`${grants}?estado=active`);
    // as 25 revogadas não voltam (a API já as lê revogadas e o filtro as exclui): sobram as 4 ativas
    expect(screen.getAllByRole('button', { name: /^Revogar a concessão de / })).toHaveLength(4);
    expect(screen.getByText('Exibindo 4 concessões · lista completa')).toBeInTheDocument();
    expect(screen.queryByText(/A lista mudou desde a última página/)).toBeNull();
  });
});

describe('R1: "Exibindo N" do AdminLoadMore nas telas administrativas (compatibilidade do padrão)', () => {
  it('Membros e Clientes contam os itens carregados (padrão); Concessões sem linhas escondidas conta o mesmo número', async () => {
    sessionFor('ana@nekkora.dev');
    // linhas da tabela (sem o cabeçalho) = itens exibidos; no padrão, = itens carregados
    const rows = (region: string) => within(screen.getByRole('region', { name: region })).getAllByRole('row').length - 1;
    let view = renderAt(members);
    await screen.findByRole('region', { name: 'Lista de membros' });
    expect(await screen.findByText('Exibindo 25 membros')).toBeInTheDocument();
    expect(rows('Lista de membros')).toBe(25);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull());
    const n = rows('Lista de membros');
    expect(n).toBeGreaterThan(25);
    expect(screen.getByText(`Exibindo ${n} membros · lista completa`)).toBeInTheDocument();
    view.unmount();

    view = renderAt(`/o/${DEV_ORG}/administracao/clientes`);
    await screen.findByRole('region', { name: 'Lista de clientes' });
    expect(await screen.findByText(`Exibindo ${rows('Lista de clientes')} clientes · lista completa`)).toBeInTheDocument();
    view.unmount();

    await openGrants();
    expect(rows('Lista de concessões')).toBe(6);
    expect(screen.getByText('Exibindo 6 concessões · lista completa')).toBeInTheDocument();
  });
});

describe('cancelamento e duplicidade', () => {
  it('Cancelar ou Esc: nenhum POST; o foco volta ao botão da linha', async () => {
    sessionFor('ana@nekkora.dev');
    await openGrants();
    const btn = screen.getByRole('button', { name: `Revogar a concessão de ${G1}` });
    btn.focus();
    fireEvent.click(btn);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(btn).toHaveFocus());
    fireEvent.click(btn);
    await screen.findByRole('alertdialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(btn).toHaveFocus());
    expect(revokes()).toEqual([]);
    expect(api.admin.grants.get(G('g1'))!.status).toBe('active');
  });

  it('clique e Enter repetidos: UM POST; durante o envio Cancelar, Esc e fundo não fecham', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (isRevoke(m, p) ? { kind: 'delay', until } : null);
    await openGrants();
    fireEvent.click(screen.getByRole('button', { name: `Revogar a concessão de ${G1}` }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Revogar' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.keyDown(confirm, { key: 'Enter' });
    fireEvent.click(confirm);
    await waitFor(() => expect(revokes()).toHaveLength(1));
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(document.querySelector('.nk-dialog__backdrop')!);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(row(G('g1'))).toHaveTextContent('Enviando…');
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(revokes()).toHaveLength(1);
    expect(api.adminWrites).toHaveLength(1);
  });
});

describe('recusas comprovadas (respostas do contrato, vindas do mock)', () => {
  it('perda de permissão antes de confirmar → 403: mensagem genérica, nada aplicado, nenhuma repetição, sem aviso de incerteza', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openGrants();
    api.product.revokeOrganizationRoles(ana.membershipId);
    const dialog = await confirmRevoke();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A ação não foi permitida. Suas permissões podem ter mudado.');
    expect(api.adminWrites).toEqual([]);
    await settle();
    expect(revokes()).toHaveLength(1);
    expect(panel()).toBeNull();
  });

  it('alvo inexistente → 404: "não foi encontrada nesta organização"', async () => {
    sessionFor('ana@nekkora.dev');
    await openGrants();
    api.admin.grants.delete(G('g1'));
    const dialog = await confirmRevoke();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Esta concessão não foi encontrada nesta organização.');
    expect(panel()).toBeNull();
  });

  it('sessão expirada → 401: volta ao login com o aviso; nada aplicado', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openGrants();
    api.revokeSessions(ana.userId);
    await confirmRevoke();
    await waitFor(() => expect(location).toBe(`/o/${DEV_ORG}/login`));
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
    expect(api.adminWrites).toEqual([]);
    expect(writeEntry(DEV_ORG, G('g1'), 'grant')).toBeUndefined();
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
    transport = (m, p) => (isRevoke(m, p) ? t : null);
    await openGrants();
    const dialog = await confirmRevoke();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Não foi possível confirmar o resultado.');
    expect(within(dialog).getByRole('button', { name: 'Revogar' })).toBeDisabled();
    expect(screen.queryByText(`Concessão de ${G1} revogada.`)).toBeNull();
    expect(api.adminWrites).toHaveLength(applied);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(panel()).toHaveTextContent(`Revogação da concessão de ${G1}: resultado não confirmado.`);
    expect(row(G('g1'))).toHaveTextContent('Resultado não confirmado');
    expect(row(G('g1'))).toHaveTextContent('Ativa'); // a tela não presume o resultado
    expect(within(row(G('g1'))!).queryByRole('button')).toBeNull();
    await waitFor(() => expect(panel()).toHaveFocus());
    await settle();
    expect(revokes()).toHaveLength(1);
  });

  it('conferir: busca pelo id SEM os filtros da tela, percorrendo páginas; informa o estado sem provar o resultado; o aviso continua', async () => {
    sessionFor('ana@nekkora.dev');
    await openGrants(`${grants}?estado=active&cliente=${stableUuid('dev:client:acme')}`);
    await uncertainRevoke({ kind: 'network-after' });
    // muitas concessões mais novas: o alvo fica além da primeira página de 100
    const portal = acc('portal@nekkora.dev');
    for (let i = 0; i < 120; i++) api.addGrant(DEV_ORG, 'dev', `x${i}`, portal, 'banco', 'financeiro', 'active', 1);
    requests = [];
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    expect(await within(panel()!).findByText(/Estado atual lido às .*: concessão revogada\. Isto informa como a concessão está agora; não confirma o resultado do pedido\./)).toBeInTheDocument();
    expect(checkReads()).toHaveLength(2);
    expect(checkReads().every((r) => !r.path.includes('status=') && !r.path.includes('clientId=') && !r.path.includes('workspaceId='))).toBe(true);
    expect(checkReads()[1].path).toContain('cursor=');
    expect(panel()).toHaveTextContent('resultado não confirmado');
    expect(revokes()).toHaveLength(0);
  });

  it('conferência: ausente, incompleta (cursor recusado), interrompida e recusada (403) — nenhuma conclui o resultado', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openGrants();
    await uncertainRevoke();
    const conferir = () => fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));

    const g1 = api.admin.grants.get(G('g1'))!;
    api.admin.grants.delete(G('g1'));
    conferir();
    expect(await within(panel()!).findByText(/esta concessão não foi encontrada na lista atual\. Isso não indica sucesso nem falha/)).toBeInTheDocument();
    api.admin.grants.set(G('g1'), g1);

    const portal = acc('portal@nekkora.dev');
    for (let i = 0; i < 120; i++) api.addGrant(DEV_ORG, 'dev', `x${i}`, portal, 'banco', 'financeiro', 'active', 1);
    transport = (m, p) => (m === 'GET' && p.includes('/client-grants?') && p.includes('cursor=') ? { kind: 'status', status: 400, body: { error: 'invalid_request' } } : null);
    conferir();
    expect(await within(panel()!).findByText(/a lista não pôde ser percorrida até o fim/)).toBeInTheDocument();

    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (m === 'GET' && p.includes('/client-grants?') && p.includes('limit=100') ? { kind: 'delay', until } : null);
    conferir();
    fireEvent.click(await within(panel()!).findByRole('button', { name: /^Interromper a conferência/ }));
    await act(async () => release());
    expect(await within(panel()!).findByText('Conferência interrompida. Nada foi alterado.')).toBeInTheDocument();

    transport = null;
    api.product.revokeOrganizationRoles(ana.membershipId);
    requests = [];
    conferir();
    // conferência recusada: acesso negado, sem aviso, nomes nem ações; nenhuma leitura sozinha
    expect(await screen.findByText('Você não tem permissão para ver as concessões desta organização.')).toBeInTheDocument();
    expect(panel()).toBeNull();
    expect(screen.queryByText(/Pessoa do Portal/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Revogar/ })).toBeNull();
    api.product.memberships.get(ana.membershipId)!.orgRoles = ['ORG_ADMIN'];
    await settle();
    expect(grantReads()).toHaveLength(1);
    expect(panel()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));
    await screen.findByRole('region', { name: 'Lista de concessões' });
    expect(panel()).toHaveTextContent(`Revogação da concessão de ${G1}: resultado não confirmado.`);
    expect(revokes()).toHaveLength(0);
  });

  it('nova tentativa só por confirmação explícita; recusa posterior (404) não apaga a incerteza; sucesso posterior a encerra', async () => {
    sessionFor('ana@nekkora.dev');
    await openGrants();
    await uncertainRevoke();
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Tentar de novo/ }));
    let retry = await screen.findByRole('alertdialog', { name: 'Tentar de novo: revogar a concessão de Pessoa do Portal?' });
    expect(retry).toHaveTextContent('O resultado anterior não foi confirmado.');
    expect(retry).toHaveTextContent('ACME Logística');
    fireEvent.click(within(retry).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(revokes()).toHaveLength(1);

    transport = (m, p) => (isRevoke(m, p) ? { kind: 'status', status: 404, body: { error: 'not_found' } } : null);
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Tentar de novo/ }));
    retry = await screen.findByRole('alertdialog', { name: /^Tentar de novo/ });
    fireEvent.click(within(retry).getByRole('button', { name: 'Revogar de novo' }));
    expect(await within(retry).findByRole('alert')).toHaveTextContent(
      'Esta concessão não foi encontrada nesta organização. A lista pode estar desatualizada. A tentativa anterior continua sem resultado confirmado.',
    );
    fireEvent.click(within(retry).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(panel()).toHaveTextContent('Nova tentativa recusada: Esta concessão não foi encontrada');
    expect(panel()).toHaveTextContent('A tentativa anterior continua sem resultado confirmado.');
    expect(revokes()).toHaveLength(2);

    transport = null;
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Tentar de novo/ }));
    retry = await screen.findByRole('alertdialog', { name: /^Tentar de novo/ });
    fireEvent.click(within(retry).getByRole('button', { name: 'Revogar de novo' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(revokes()).toHaveLength(3);
    expect(panel()).toBeNull();
    expect(announced()).toHaveTextContent(`Concessão de ${G1} revogada.`);
  });

  it('403 na releitura da lista com o aviso visível: aviso, nomes e ações somem; só "Verificar novamente" autorizado os devolve', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    await openGrants();
    await uncertainRevoke();
    api.product.revokeOrganizationRoles(ana.membershipId);
    fireEvent.click(screen.getByRole('button', { name: /Atualizar/ }));
    expect(await screen.findByText('Você não tem permissão para ver as concessões desta organização.')).toBeInTheDocument();
    expect(panel()).toBeNull();
    expect(screen.queryByText(/Pessoa do Portal/)).toBeNull();
    api.product.memberships.get(ana.membershipId)!.orgRoles = ['ORG_ADMIN'];
    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));
    await screen.findByRole('region', { name: 'Lista de concessões' });
    expect(panel()).toHaveTextContent(`Revogação da concessão de ${G1}: resultado não confirmado.`);
  });

  it('"Carregar mais" pendente que conclui com 200 depois do 403 da conferência não devolve a apresentação', async () => {
    sessionFor('ana@nekkora.dev');
    // concessões mais antigas que as da massa: a primeira página (25) continua com G1 e aparece "Carregar mais"
    const portal = acc('portal@nekkora.dev');
    for (let i = 0; i < 30; i++) api.addGrant(DEV_ORG, 'dev', `old${i}`, portal, 'banco', 'financeiro', 'active', 400 + i);
    await openGrants();
    await uncertainRevoke();
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => {
      if (m === 'GET' && p.includes('/client-grants?') && p.includes('cursor=') && !p.includes('limit=100')) return { kind: 'delay', until };
      if (m === 'GET' && p.includes('/client-grants?') && p.includes('limit=100')) return { kind: 'status', status: 403, body: { error: 'forbidden' } };
      return null;
    };
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(grantReads().some((r) => r.path.includes('cursor='))).toBe(true));
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    const FORBIDDEN = 'Você não tem permissão para ver as concessões desta organização.';
    expect(await screen.findByText(FORBIDDEN)).toBeInTheDocument();
    await act(async () => release());
    await settle();
    expect(screen.getByText(FORBIDDEN)).toBeInTheDocument();
    expect(panel()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Lista de concessões' })).toBeNull();
  });
});

describe('sessão e respostas pendentes', () => {
  it('revogação pendente que conclui DEPOIS da troca de sessão não altera a sessão nova; a incerteza volta só pelo registro persistente', async () => {
    sessionFor('ana@nekkora.dev');
    const view = await openGrants();
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (isRevoke(m, p) ? { kind: 'delay', until, then: { kind: 'network-before' } } : null);
    await confirmRevoke();
    await waitFor(() => expect(revokes()).toHaveLength(1));
    view.unmount();
    act(() => csrfStore.clear());
    sessionFor('ana@nekkora.dev');
    const again = await openGrants();
    await act(async () => release());
    await settle();
    // a conclusão atrasada da sessão anterior não cria nem altera registro da sessão nova
    const late = writeEntry(DEV_ORG, G('g1'), 'grant');
    expect(late === undefined || late.error instanceof PreviouslyUncertain).toBe(true);
    // FRONT-V1-002: a MESMA pessoa, ao reler a lista, vê a incerteza vinda do registro persistente — sem reenvio
    again.unmount();
    renderAt(grants);
    await screen.findByRole('region', { name: 'Lista de concessões' });
    await waitFor(() => expect(writeEntry(DEV_ORG, G('g1'), 'grant')?.error).toBeInstanceOf(PreviouslyUncertain));
    expect(revokes()).toHaveLength(1);
  });

  it('aviso de outra aba: sai da área, esquece o registro, e a conferência pendente para de ler', async () => {
    sessionFor('ana@nekkora.dev');
    await openGrants();
    await uncertainRevoke();
    const portal = acc('portal@nekkora.dev');
    for (let i = 0; i < 120; i++) api.addGrant(DEV_ORG, 'dev', `x${i}`, portal, 'banco', 'financeiro', 'active', 1);
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    transport = (m, p) => (m === 'GET' && p.includes('/client-grants?') && p.includes('limit=100') ? { kind: 'delay', until } : null);
    requests = [];
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    await waitFor(() => expect(checkReads()).toHaveLength(1));
    const otherTab = new BroadcastChannel('nekkora-sessao');
    otherTab.postMessage({ tipo: 'sessao-alterada' });
    await waitFor(() => expect(location).toBe(`/o/${DEV_ORG}/login`));
    expect(await screen.findByText('Sua sessão foi encerrada ou alterada em outra aba. Entre novamente para continuar.')).toBeInTheDocument();
    expect(writeEntry(DEV_ORG, G('g1'), 'grant')).toBeUndefined();
    expect(panel()).toBeNull();
    await act(async () => release());
    await settle();
    expect(checkReads()).toHaveLength(1);
    expect(writeEntry(DEV_ORG, G('g1'), 'grant')).toBeUndefined();
    otherTab.close();
  });
});

describe('membros e concessões não colidem', () => {
  it('incerteza de concessão não aparece em Membros, e a de membro não aparece em Concessões; cada tela confere o seu', async () => {
    sessionFor('ana@nekkora.dev');
    let view = await openGrants();
    await uncertainRevoke();
    view.unmount();

    view = renderAt(members);
    await screen.findByRole('button', { name: 'Suspender Caio Mendes' });
    expect(panel()).toBeNull();
    transport = (m, p) => (m === 'POST' && p.endsWith('/suspend') ? { kind: 'network-before' } : null);
    fireEvent.click(screen.getByRole('button', { name: 'Suspender Caio Mendes' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Suspender Caio Mendes?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspender' }));
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    transport = null;
    await waitFor(() => expect(panel()).toHaveTextContent('Suspensão de Caio Mendes: resultado não confirmado.'));
    expect(panel()).not.toHaveTextContent('Revogação');
    view.unmount();

    await openGrants(grants, G4); // G1 está incerta: sem botão
    expect(panel()).toHaveTextContent(`Revogação da concessão de ${G1}: resultado não confirmado.`);
    expect(panel()).not.toHaveTextContent('Caio Mendes');
    // conferir a concessão lê concessões, não membros
    requests = [];
    fireEvent.click(within(panel()!).getByRole('button', { name: /^Conferir estado atual/ }));
    expect(await within(panel()!).findByText(/concessão ativa\./)).toBeInTheDocument();
    expect(requests.some((r) => r.path.includes('/members'))).toBe(false);
    // revogar outra concessão com sucesso não mexe na incerteza do membro
    await confirmRevoke(G4);
    await waitFor(() => expect(announced()).toHaveTextContent(`Concessão de ${G4} revogada.`));
    expect(writeEntry(DEV_ORG, acc('operador@nekkora.dev').userId, 'member')?.phase).toBe('uncertain');
  });
});
