/**
 * F4: área interna e tela de execuções renderizadas pelo app real (AppRoutes) contra a API SIMULADA da F2 (mock/), com
 * o fetch ligado direto ao MockApi e relógio fixo. Cobertura contra o mock; a API real continua pendente (F1.5/F8).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ORG, MockApi, OTHER_ORG } from '../../mock/contract';
import { stableUuid } from '../../mock/product';
import { AppRoutes } from '../app/AppRoutes';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 86_400_000;
const ws = (k: string) => stableUuid(`dev:ws:${k}`);

let api: MockApi;
let cookie = '';
let requests: string[] = [];
/** Hooks por requisição: atrasar, adulterar a resposta ou derrubar a conexão. */
let intercept: ((path: string) => { delay?: Promise<void>; tamper?: (body: any) => any; network?: boolean } | undefined) | undefined;

function sessionFor(email: string, org = DEV_ORG) {
  const a = [...api.accounts.values()].find((x) => x.email === email && x.org === org)!;
  cookie = api.openSession(a.userId);
  return a;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

const exec = (org = DEV_ORG) => `/o/${org}/execucoes`;
const rows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);
const execRequests = () => requests.filter((r) => r.includes('/executions'));
const param = (url: string, name: string) => new URL(url, 'http://x').searchParams.getAll(name);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  api = new MockApi(() => NOW);
  requests = [];
  intercept = undefined;
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
      if (hook?.network) throw new TypeError('Failed to fetch');
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
      const body = hook?.tamper && out.status === 200 ? hook.tamper(out.body) : out.body;
      return new Response(body === undefined ? null : JSON.stringify(body), { status: out.status, headers: out.headers });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Insere no mock uma execução nova (dados alterados), visível a quem vê o workspace de `like`. */
function addExecution(label: string, createdAt: number) {
  const src = [...api.product.executions.values()].find((e) => e.workspaceId === ws('operacoes') && e.status === 'succeeded')!;
  const id = stableUuid(`teste:${label}`);
  api.product.executions.set(id, {
    ...src,
    executionId: id,
    createdAt,
    startedAt: createdAt + 1_000,
    finishedAt: createdAt + 3_000,
    cancelRequestedAt: null,
    retryOf: null,
  });
  api.product.events.set(id, []);
  return id;
}

/** Workspaces extras na organização de desenvolvimento ("Zz extra NNN" ficam depois dos 9 originais na ordem por nome). */
function addWorkspaces(n: number) {
  for (let i = 1; i <= n; i++) {
    const id = stableUuid(`teste:ws-extra:${i}`);
    api.product.workspaces.set(id, {
      workspaceId: id, org: DEV_ORG, name: `Zz extra ${String(i).padStart(3, '0')}`, description: null, status: 'active',
      clientId: null, createdAt: NOW - 100 * DAY, updatedAt: NOW - 100 * DAY,
    });
  }
}

async function ready() {
  await screen.findByRole('table');
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
}

describe('área interna', () => {
  it('ORG_ADMIN: P01 orienta o resumo, workspaces vêm de listWorkspaces (paginada) e a P02 nunca é chamada', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`/o/${DEV_ORG}`);
    expect(await screen.findByRole('heading', { name: 'Olá, Ana Souza' })).toBeInTheDocument();
    expect(await screen.findByText('Administração da organização (todos os workspaces)')).toBeInTheDocument();
    expect(await screen.findByText('9 workspaces visíveis')).toBeInTheDocument();
    expect(requests.filter((r) => r.startsWith(`/api/v1/o/${DEV_ORG}/me/permissions`) && !r.includes('/workspaces'))).toHaveLength(1);
    expect(requests.some((r) => r.includes('/me/permissions/workspaces'))).toBe(false);
    expect(requests.filter((r) => r.includes('/workspaces?') && r.includes('limit=100')).length).toBeGreaterThan(0);
  });

  it('menu só com telas implementadas (Início e Execuções), item ativo e conta/sair visíveis', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(exec());
    const nav = await screen.findByRole('navigation', { name: 'Navegação principal' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Início', 'Workspaces', 'Execuções']);
    expect(within(nav).getByRole('link', { name: 'Execuções' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByText('Ana Souza').length).toBeGreaterThan(0);
    expect(screen.getByText('ana@nekkora.dev')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sair' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /executar|cancelar|reagendar/i })).toBeNull();
  });

  it('conta externa: fica no início próprio; rota interna volta a ele; nada de P01/P02/leituras internas', async () => {
    sessionFor('portal@nekkora.dev');
    renderAt(exec());
    expect(await screen.findByRole('heading', { name: 'Olá, Pessoa do Portal' })).toBeInTheDocument();
    expect(screen.getByText('Externa')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(requests.filter((r) => /\/me\/permissions|\/workspaces|\/executions/.test(r))).toEqual([]);
    expect(screen.queryByRole('navigation', { name: 'Navegação principal' })).toBeNull();
  });

  it('isolamento: sessão de outra organização não abre a área (volta ao login); na própria, só os workspaces dela', async () => {
    sessionFor('vizinha@nekkora.dev', OTHER_ORG);
    const { unmount } = renderAt(exec(DEV_ORG));
    expect(await screen.findByRole('heading', { name: 'Bem-vinda de volta' })).toBeInTheDocument();
    unmount();
    renderAt(exec(OTHER_ORG));
    await ready();
    const select = screen.getByLabelText('Workspace') as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.text)).toEqual(['Todos os workspaces visíveis', 'Workspace da organização vizinha']));
  });
});

describe('execuções por perfil', () => {
  it('ORG_ADMIN: lista com campos do contrato, período padrão de 30 dias indicado e enviado em UTC', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(exec());
    await ready();
    expect(rows()).toHaveLength(25);
    expect(screen.getByText(/Período: Últimos 30 dias \(padrão\)\./)).toBeInTheDocument();
    const first = execRequests()[0];
    expect(param(first, 'from')).toEqual([new Date(NOW - 30 * DAY).toISOString()]);
    expect(param(first, 'to')).toEqual([]);
    expect(param(first, 'limit')).toEqual(['25']);
    const header = within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(header).toEqual(['Automação', 'Workspace', 'Estado', 'Origem', 'Criada em', 'Início', 'Término', 'Duração']);
    expect(screen.getByRole('table')).toHaveTextContent(/Horários no fuso deste navegador/);
    const select = screen.getByLabelText('Workspace') as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(10));
  });

  it('acesso limitado (operador): só os workspaces dele no filtro e nas linhas', async () => {
    sessionFor('operador@nekkora.dev');
    renderAt(exec());
    await ready();
    const select = screen.getByLabelText('Workspace') as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.text).slice(1).sort()).toEqual(['Logística', 'Operações']));
    for (const r of rows()) expect(r.textContent).toMatch(/Logística|Operações/);
  });

  it('sem workspaces: estado vazio próprio', async () => {
    sessionFor('sematribuicao@nekkora.dev');
    renderAt(exec());
    expect(await screen.findByText('Você ainda não tem acesso a nenhum workspace.')).toBeInTheDocument();
  });
});

describe('filtros e paginação', () => {
  it('estado e workspace viram parâmetros da API; período personalizado inválido não envia nada', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(exec());
    await ready();
    fireEvent.click(screen.getByLabelText('Falhou'));
    await waitFor(() => expect(param(execRequests().at(-1)!, 'status')).toEqual(['failed']));
    await waitFor(() => expect(rows().every((r) => r.textContent!.includes('Falhou'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: ws('logistica') } }); // valor do workspace
    await waitFor(() => expect(param(execRequests().at(-1)!, 'workspaceId')).toEqual([ws('logistica')]));
    const before = execRequests().length;
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: 'custom' } });
    // o início vem preenchido com o mesmo instante do período atual: mesma consulta, nada é reenviado
    expect((screen.getByLabelText('Início (inclusivo)') as HTMLInputElement).value).not.toBe('');
    await new Promise((r) => setTimeout(r, 30));
    expect(execRequests()).toHaveLength(before);
    const count = execRequests().length;
    fireEvent.change(screen.getByLabelText('Fim (exclusivo)'), { target: { value: '2020-01-01T00:00' } });
    expect(await screen.findByText('Período inválido')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(execRequests()).toHaveLength(count);
  });

  it('carregar mais acrescenta páginas até o fim, sem total nem número de página', async () => {
    sessionFor('leitora@nekkora.dev');
    renderAt(exec());
    await ready();
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: 'all' } });
    await waitFor(() => expect(param(execRequests().at(-1)!, 'from')).toEqual([]));
    await ready();
    while (screen.queryByRole('button', { name: 'Carregar mais' })) {
      const n = rows().length;
      fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
      await waitFor(() => expect(rows().length).toBeGreaterThan(n));
    }
    expect(screen.getByText('Fim da lista')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '' }).textContent ?? '').not.toMatch(/ de \d/);
    const ids = execRequests().map((r) => param(r, 'cursor')[0]).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length); // cada cursor usado uma vez
  });

  it('troca de filtro limpa a lista e descarta a resposta atrasada do filtro anterior', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    intercept = (path) => (path.includes('/executions') && param(path, 'status').includes('cancelled') ? { delay: slow } : undefined);
    renderAt(exec());
    await ready();
    fireEvent.click(screen.getByLabelText('Cancelada')); // fica pendente
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull()); // lista limpa na hora
    fireEvent.click(screen.getByLabelText('Cancelada')); // desmarca: volta a todos
    await ready();
    const shown = rows().map((r) => r.textContent);
    await act(async () => release());
    await new Promise((r) => setTimeout(r, 30));
    expect(rows().map((r) => r.textContent)).toEqual(shown); // a resposta antiga não entrou
  });
});

describe('falhas e sessão', () => {
  it('revogação entre páginas: a página seguinte não traz o workspace perdido', async () => {
    const op = sessionFor('operador@nekkora.dev');
    renderAt(exec());
    await ready();
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: 'all' } });
    await waitFor(() => expect(param(execRequests().at(-1)!, 'from')).toEqual([]));
    await ready();
    api.product.revokeWorkspaceRole(op.membershipId, ws('logistica'));
    const n = rows().length;
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(rows().length).toBeGreaterThan(n));
    expect(rows().slice(n).some((r) => r.textContent!.includes('Logística'))).toBe(false);
  });

  it('vários 401 concorrentes (P01 e workspaces em andamento): o aviso de sessão expirada não é apagado', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    intercept = (path) => (/\/me\/permissions$|\/workspaces\?/.test(path.split('&')[0]) ? { delay: hold } : undefined);
    renderAt(`/o/${DEV_ORG}`);
    expect(await screen.findByRole('heading', { name: 'Olá, Ana Souza' })).toBeInTheDocument();
    api.revokeSessions(ana.userId);
    await act(async () => release());
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
  });

  it('sessão expirada ao carregar mais: volta ao login com o aviso', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    renderAt(exec());
    await ready();
    api.revokeSessions(ana.userId);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
  });

  it('cursor recusado (chave rotacionada): itens mantidos, oferece recomeçar, sem repetir sozinho', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(exec());
    await ready();
    api.product.cursors.rotate();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('A lista mudou desde a última página (ou a continuação expirou).')).toBeInTheDocument();
    expect(rows()).toHaveLength(25);
    const count = execRequests().length;
    await new Promise((r) => setTimeout(r, 30));
    expect(execRequests()).toHaveLength(count);
    fireEvent.click(screen.getByRole('button', { name: 'Recomeçar a lista' }));
    await waitFor(() => expect(execRequests()).toHaveLength(count + 1));
    await ready();
    expect(screen.queryByText(/A lista mudou/)).toBeNull();
    expect(param(execRequests().at(-1)!, 'cursor')).toEqual([]);
  });

  it('resposta fora do contrato ao carregar mais: nada é acrescentado, erro exposto, sem repetição automática', async () => {
    sessionFor('ana@nekkora.dev');
    intercept = (path) =>
      path.includes('/executions') && path.includes('cursor=') ? { tamper: (b) => ({ ...b, items: b.items.map((e: any, i: number) => (i === 3 ? { ...e, status: 'finished' } : e)) }) } : undefined;
    renderAt(exec());
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText(/A resposta do servidor veio fora do formato esperado\. A lista exibida continua válida\./)).toBeInTheDocument();
    expect(rows()).toHaveLength(25);
    const count = execRequests().length;
    await new Promise((r) => setTimeout(r, 30));
    expect(execRequests()).toHaveLength(count);
  });

  it('falha de rede ao carregar mais: mantém a lista e só tenta de novo por ação', async () => {
    sessionFor('ana@nekkora.dev');
    let fail = true;
    intercept = (path) => (path.includes('/executions') && path.includes('cursor=') && fail ? { network: true } : undefined);
    renderAt(exec());
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText(/Não foi possível conectar\. A lista exibida continua válida\./)).toBeInTheDocument();
    expect(rows()).toHaveLength(25);
    const count = execRequests().length;
    await new Promise((r) => setTimeout(r, 30));
    expect(execRequests()).toHaveLength(count);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(rows()).toHaveLength(50));
  });

  it('primeira página fora do contrato: estado de erro, não lista vazia', async () => {
    sessionFor('ana@nekkora.dev');
    intercept = (path) => (path.includes('/executions') ? { tamper: (b) => ({ items: b.items }) } : undefined);
    renderAt(exec());
    expect(await screen.findByText('A resposta do servidor veio fora do formato esperado.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Nenhuma execução encontrada.')).toBeNull();
  });
});

describe('F4-R1: Atualizar', () => {
  const firstPageRequests = () => execRequests().filter((r) => param(r, 'cursor').length === 0);

  it('em "Todo o histórico": busca a primeira página de novo e mostra o dado alterado no mock', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(exec());
    await ready();
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: 'all' } });
    await waitFor(() => expect(param(execRequests().at(-1)!, 'from')).toEqual([]));
    await ready();
    const before = firstPageRequests().length;
    const id = addExecution('nova-historico', NOW - 60_000);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(firstPageRequests()).toHaveLength(before + 1));
    await waitFor(() => expect(rows()[0].textContent).toContain('03/10/2026'));
    expect(screen.getByRole('table').querySelector(`time[datetime="${new Date(NOW - 60_000).toISOString()}"]`)).not.toBeNull();
    expect(id).toBeTruthy();
  });

  it('em "Personalizado": busca de novo com os mesmos limites', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(exec());
    await ready();
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: 'custom' } });
    await new Promise((r) => setTimeout(r, 30));
    const before = firstPageRequests().length;
    const limits = [param(execRequests().at(-1)!, 'from'), param(execRequests().at(-1)!, 'to')];
    addExecution('nova-personalizado', NOW - 120_000);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(firstPageRequests()).toHaveLength(before + 1));
    expect([param(execRequests().at(-1)!, 'from'), param(execRequests().at(-1)!, 'to')]).toEqual(limits);
    await waitFor(() => expect(screen.getByRole('table').querySelector(`time[datetime="${new Date(NOW - 120_000).toISOString()}"]`)).not.toBeNull());
  });

  it('nos períodos relativos: uma única requisição por clique, com o início recalculado', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(exec());
    await ready();
    const before = execRequests().length;
    vi.setSystemTime(NOW + 60_000);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(execRequests()).toHaveLength(before + 1));
    await new Promise((r) => setTimeout(r, 30));
    expect(execRequests()).toHaveLength(before + 1);
    expect(param(execRequests().at(-1)!, 'from')).toEqual([new Date(NOW + 60_000 - 30 * DAY).toISOString()]);
  });

  it('descarta a resposta antiga pendente (carregar mais em andamento)', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    intercept = (path) => (path.includes('/executions') && path.includes('cursor=') ? { delay: hold } : undefined);
    renderAt(exec());
    await ready();
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: 'all' } });
    await waitFor(() => expect(param(execRequests().at(-1)!, 'from')).toEqual([]));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' })); // fica pendente
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(rows()).toHaveLength(25));
    await act(async () => release());
    await new Promise((r) => setTimeout(r, 30));
    expect(rows()).toHaveLength(25); // a página antiga não foi anexada
  });
});

describe('F4-R1: data aceita pelo contrato que o Date não representa', () => {
  it('segundo bissexto (23:59:60Z) passa pela validação e a tela continua utilizável, mostrando o valor como recebido', async () => {
    sessionFor('ana@nekkora.dev');
    intercept = (path) =>
      path.includes('/executions') && !path.includes('cursor=')
        ? { tamper: (b) => ({ ...b, items: b.items.map((e: any, i: number) => (i === 0 ? { ...e, status: 'succeeded', statusReason: 'process_completed', startedAt: '2016-12-31T23:59:00Z', finishedAt: '2016-12-31T23:59:60Z', durationMs: 60000 } : e)) }) }
        : undefined;
    renderAt(exec());
    await ready();
    expect(rows()).toHaveLength(25);
    const cell = screen.getByRole('table').querySelector('time[datetime="2016-12-31T23:59:60Z"]')!;
    expect(cell).not.toBeNull();
    expect(cell.textContent).toContain('31/12/2016, 23:59:60');
    expect(cell.textContent).toContain('UTC+00:00');
    expect(cell.getAttribute('title')).toMatch(/como recebido/);
    expect(screen.queryByText(/Algo deu errado/)).toBeNull();
  });
});

describe('F4-R1: workspaces além da primeira página', () => {
  it('carrega só a primeira página ao entrar, oferece continuação e permite filtrar por um workspace da página seguinte', async () => {
    addWorkspaces(130);
    sessionFor('ana@nekkora.dev');
    renderAt(`/o/${DEV_ORG}`);
    expect(await screen.findByText('Pelo menos 100 workspaces visíveis (lista parcial)')).toBeInTheDocument();
    expect(screen.queryByText(/139/)).toBeNull();
    const wsRequests = () => requests.filter((r) => r.includes('/workspaces?'));
    expect(wsRequests()).toHaveLength(1); // nada de carregar tudo automaticamente
    fireEvent.click(screen.getByRole('link', { name: 'Ver execuções' }));
    await ready();
    const select = screen.getByLabelText('Workspace') as HTMLSelectElement;
    expect(select.options).toHaveLength(101);
    expect(screen.getByText(/Lista parcial: 100 workspaces carregados/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais workspaces' }));
    await waitFor(() => expect(select.options).toHaveLength(140));
    expect(wsRequests()).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Carregar mais workspaces' })).toBeNull();
    const last = stableUuid('teste:ws-extra:130');
    fireEvent.change(select, { target: { value: last } });
    await waitFor(() => expect(param(execRequests().at(-1)!, 'workspaceId')).toEqual([last]));
  });
});

describe('F4-R2: continuação recusada da lista de workspaces', () => {
  const wsRequests = () => requests.filter((r) => r.includes('/workspaces?'));

  async function openWithExtras() {
    addWorkspaces(130);
    sessionFor('ana@nekkora.dev');
    renderAt(exec());
    await ready();
    const select = screen.getByLabelText('Workspace') as HTMLSelectElement;
    expect(select.options).toHaveLength(101);
    return select;
  }

  it('cursor recusado: mantém o carregado, identifica a recusa, não repete nem reenvia o cursor; recomeço só por ação, sem cursor', async () => {
    const select = await openWithExtras();
    api.product.cursors.rotate(); // a continuação emitida deixa de valer (DC-15)
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais workspaces' }));
    expect(await screen.findByText(/A continuação da lista de workspaces deixou de valer/)).toBeInTheDocument();
    expect(select.options).toHaveLength(101); // o carregado continua
    expect(screen.queryByRole('button', { name: 'Carregar mais workspaces' })).toBeNull(); // nada de reenviar o cursor recusado
    const afterRejection = wsRequests().length;
    await new Promise((r) => setTimeout(r, 40));
    expect(wsRequests()).toHaveLength(afterRejection); // sem repetição automática
    fireEvent.click(screen.getByRole('button', { name: 'Recomeçar lista de workspaces' }));
    await waitFor(() => expect(wsRequests()).toHaveLength(afterRejection + 1));
    expect(param(wsRequests().at(-1)!, 'cursor')).toEqual([]); // nova primeira página, sem cursor
    await waitFor(() => expect(screen.queryByText(/deixou de valer/)).toBeNull());
    expect(select.options).toHaveLength(101);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais workspaces' }));
    await waitFor(() => expect(select.options).toHaveLength(140)); // a continuação nova funciona
  });

  it('controle: falha transitória (rede) mantém o carregado e a nova tentativa reutiliza o mesmo cursor', async () => {
    let fail = true;
    intercept = (path) => (path.includes('/workspaces?') && path.includes('cursor=') && fail ? { network: true } : undefined);
    const select = await openWithExtras();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais workspaces' }));
    expect(await screen.findByText(/Não foi possível carregar a próxima parte/)).toBeInTheDocument();
    expect(select.options).toHaveLength(101);
    expect(screen.queryByRole('button', { name: 'Recomeçar lista de workspaces' })).toBeNull();
    const failed = wsRequests().at(-1)!;
    await new Promise((r) => setTimeout(r, 40));
    expect(wsRequests().at(-1)).toBe(failed); // sem repetição automática
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais workspaces' }));
    await waitFor(() => expect(select.options).toHaveLength(140));
    const retried = wsRequests().filter((r) => param(r, 'cursor').length > 0);
    expect(retried).toHaveLength(2);
    expect(param(retried[1], 'cursor')).toEqual(param(retried[0], 'cursor')); // mesmo cursor na nova tentativa
  });
});
