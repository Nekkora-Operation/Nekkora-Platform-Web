/**
 * F5: telas de leitura do produto (detalhe e eventos da execução, workspaces, automações e versões) renderizadas pelo
 * app real (AppRoutes) contra a API SIMULADA (mock/), com o fetch ligado direto ao MockApi e relógio fixo. Cobertura
 * contra o mock; a API real continua pendente.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ORG, MockApi, OTHER_ORG } from '../../mock/contract';
import { stableUuid } from '../../mock/product';
import { AppRoutes } from '../app/AppRoutes';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 86_400_000;
const ws = (k: string) => stableUuid(`dev:ws:${k}`);
const auto = (k: string) => stableUuid(`dev:auto:${k}`);
/** Execução agendada fixa do mock (Backup, Operações, sem solicitante, 2 eventos). */
const SCHEDULED = stableUuid('dev:exec:empate:0');

let api: MockApi;
let cookie = '';
let requests: string[] = [];
/** Hooks por requisição: atrasar, adulterar, derrubar a conexão ou responder com um status fixo (ex.: 500, 401). */
let intercept: ((path: string) => { delay?: Promise<void>; tamper?: (body: any) => any; network?: boolean; respond?: { status: number; body: unknown } } | undefined) | undefined;
let location = '';
/** Endereços por onde o app passou (uma entrada por navegação), para contar idas ao login. */
let visited: string[] = [];
let navigate: (to: string) => void = () => {};

function Probe() {
  const loc = useLocation();
  const nav = useNavigate();
  location = loc.pathname + loc.search;
  if (visited.at(-1) !== `${loc.key}|${location}`) visited.push(`${loc.key}|${location}`);
  navigate = (to) => void nav(to);
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

const base = `/o/${DEV_ORG}`;
const execPath = (id: string, org = DEV_ORG) => `/o/${org}/execucoes/${id}`;
const tableRows = (name: string) => within(screen.getByRole('region', { name })).getAllByRole('row').slice(1);
const count = (re: RegExp) => requests.filter((r) => re.test(r)).length;
const pause = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  api = new MockApi(() => NOW);
  requests = [];
  intercept = undefined;
  location = '';
  visited = [];
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
      if (hook?.respond) return new Response(JSON.stringify(hook.respond.body), { status: hook.respond.status, headers: { 'Content-Type': 'application/json' } });
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

/** Execução controlada no mock, copiada de uma existente da automação `k`. */
function putExecution(label: string, k: string, over: Record<string, unknown> = {}) {
  const src = [...api.product.executions.values()].find((e) => e.automationId === auto(k))!;
  const id = stableUuid(`teste:${label}`);
  api.product.executions.set(id, { ...src, executionId: id, retryOf: null, ...over } as typeof src);
  api.product.events.set(id, []);
  return id;
}

function setEvents(id: string, n: number) {
  const at = NOW - DAY;
  api.product.events.set(
    id,
    Array.from({ length: n }, (_, i) => ({ sequence: i + 1, type: i === 0 ? 'process_started' : 'process_succeeded', occurredAt: at + i * 1000, receivedAt: at + i * 1000 + 200 }) as never),
  );
}

const detailHeading = (name: string) => screen.findByRole('heading', { level: 1, name: `Execução de ${name}` });

describe('detalhe da execução', () => {
  it('lista → detalhe (link real, foco no conteúdo) → eventos → voltar mantém os filtros aplicados', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`${base}/execucoes`);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Concluída' }));
    await waitFor(() => expect(location).toContain('estado=succeeded'));
    const listUrl = location;
    const link = (await screen.findAllByRole('link', { name: /^Execução de .*, criada em / }))[0];
    const href = link.getAttribute('href')!;
    expect(href).toMatch(new RegExp(`^${base}/execucoes/[0-9a-f-]{36}$`));
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: /^Execução de / })).toBeInTheDocument();
    expect(location).toBe(href);
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('conteudo')));
    expect(screen.getByText('Concluída')).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Eventos da execução' });
    const back = screen.getByRole('link', { name: 'Voltar para execuções' });
    expect(back).toHaveAttribute('href', listUrl);
    fireEvent.click(back);
    await screen.findByRole('table');
    expect(location).toBe(listUrl);
    expect(screen.getByRole('checkbox', { name: 'Concluída' })).toBeChecked();
    expect(new URL(requests.filter((r) => r.includes('/executions?')).at(-1)!, 'http://x').searchParams.getAll('status')).toEqual(['succeeded']);
  });

  it('acesso direto: agendada sem solicitante não é erro; campos e eventos só do contrato, em ordem de sequência', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(execPath(SCHEDULED));
    expect(await detailHeading('Backup dos arquivos de operação')).toBeInTheDocument();
    expect(screen.getByText('Nenhum (execução agendada)')).toBeInTheDocument();
    expect(screen.getByText('Agendada')).toBeInTheDocument();
    expect(screen.getByText('Não solicitado')).toBeInTheDocument();
    expect(screen.getByText('Não é reexecução')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Operações' })).toHaveAttribute('href', `${base}/workspaces/${ws('operacoes')}`);
    expect(screen.getByRole('link', { name: 'Backup dos arquivos de operação' })).toHaveAttribute('href', `${base}/automacoes/${auto('backup')}`);
    await screen.findByRole('region', { name: 'Eventos da execução' });
    expect(tableRows('Eventos da execução').map((r) => within(r).getAllByRole('cell')[1].textContent)).toEqual(['Processo iniciado', 'Processo concluído']);
    expect(screen.getAllByRole('term').map((t) => t.textContent)).toEqual([
      'Estado', 'Origem', 'Automação', 'Versão', 'Workspace', 'Solicitante', 'Criada em', 'Início', 'Término', 'Duração',
      'Cancelamento solicitado em', 'Reexecução de',
    ]);
    // menu: Execuções ativo no detalhe
    const nav = screen.getByRole('navigation', { name: 'Navegação principal' });
    expect(within(nav).getByRole('link', { name: 'Execuções' })).toHaveAttribute('aria-current', 'page');
  });

  it('manual sem solicitante, em andamento e campos nulos: estados próprios, sem erro', async () => {
    sessionFor('ana@nekkora.dev');
    const id = putExecution('em-andamento', 'limpeza', {
      origin: 'manual', requestedBy: null, status: 'running', statusReason: null, startedAt: NOW - 60_000, finishedAt: null, cancelRequestedAt: null,
    });
    renderAt(execPath(id));
    expect(await detailHeading('Limpeza de temporários')).toBeInTheDocument();
    expect(screen.getByText('Não informado')).toBeInTheDocument();
    expect(screen.getByText('Em andamento')).toBeInTheDocument();
    expect(await screen.findByText('Nenhum evento registrado.')).toBeInTheDocument();
  });

  it('inexistente, malformado e de outra organização: o mesmo estado de não encontrado', async () => {
    sessionFor('ana@nekkora.dev');
    const vizinha = [...api.product.executions.values()].find((e) => e.org === OTHER_ORG)!.executionId;
    for (const id of [stableUuid('nao-existe'), 'nao-e-um-uuid', vizinha]) {
      const { unmount } = renderAt(execPath(id));
      expect(await screen.findByRole('heading', { name: 'Execução não encontrada.' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Eventos da execução' })).toBeNull();
      unmount();
    }
  });

  it('acesso limitado: operador vê a execução do próprio workspace; a de outro dá o mesmo não encontrado', async () => {
    sessionFor('operador@nekkora.dev');
    const own = putExecution('do-operador', 'backup');
    const other = putExecution('do-financeiro', 'conciliacao');
    const { unmount } = renderAt(execPath(own));
    expect(await detailHeading('Backup dos arquivos de operação')).toBeInTheDocument();
    unmount();
    renderAt(execPath(other));
    expect(await screen.findByRole('heading', { name: 'Execução não encontrada.' })).toBeInTheDocument();
    expect(screen.queryByText('Conciliação bancária diária')).toBeNull();
  });

  it('revogação + Atualizar: mesmo não encontrado, sem os dados carregados antes', async () => {
    const gestora = sessionFor('gestora@nekkora.dev');
    const id = putExecution('revogada', 'conciliacao');
    renderAt(execPath(id));
    expect(await detailHeading('Conciliação bancária diária')).toBeInTheDocument();
    api.product.revokeWorkspaceRole(gestora.membershipId, ws('financeiro'));
    const before = count(new RegExp(`/executions/${id}$`));
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(await screen.findByRole('heading', { name: 'Execução não encontrada.' })).toBeInTheDocument();
    expect(count(new RegExp(`/executions/${id}$`))).toBe(before + 1);
    expect(screen.queryByText(/Conciliação bancária diária/)).toBeNull();
    expect(screen.queryByText(id)).toBeNull();
  });

  it('Atualizar com os mesmos parâmetros consulta de novo (detalhe e eventos), mantendo o conteúdo até a resposta', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(execPath(SCHEDULED));
    await detailHeading('Backup dos arquivos de operação');
    await screen.findByRole('region', { name: 'Eventos da execução' });
    const d = count(new RegExp(`/executions/${SCHEDULED}$`));
    const ev = count(/\/events/);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    intercept = (p) => (p.endsWith(`/executions/${SCHEDULED}`) ? { delay: hold } : undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Execução de Backup dos arquivos de operação' })).toBeInTheDocument();
    await act(async () => release());
    await waitFor(() => expect(count(new RegExp(`/executions/${SCHEDULED}$`))).toBe(d + 1));
    await waitFor(() => expect(count(/\/events/)).toBe(ev + 1));
    // sem atualização periódica
    await pause();
    expect(count(new RegExp(`/executions/${SCHEDULED}$`))).toBe(d + 1);
  });

  it('eventos paginados por cursor: 25 + 5, sem total inventado, ordem de sequência', async () => {
    sessionFor('ana@nekkora.dev');
    const id = putExecution('muitos-eventos', 'backup');
    setEvents(id, 30);
    renderAt(execPath(id));
    await screen.findByRole('region', { name: 'Eventos da execução' });
    expect(tableRows('Eventos da execução')).toHaveLength(25);
    expect(screen.queryByText(/de 30/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(tableRows('Eventos da execução')).toHaveLength(30));
    expect(tableRows('Eventos da execução').map((r) => Number(within(r).getAllByRole('cell')[0].textContent))).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  });

  it('eventos: cursor recusado mantém o conteúdo e oferece recomeçar; falha transitória só repete por ação', async () => {
    sessionFor('ana@nekkora.dev');
    const id = putExecution('cursor-eventos', 'backup');
    setEvents(id, 30);
    renderAt(execPath(id));
    await screen.findByRole('region', { name: 'Eventos da execução' });
    api.product.cursors.rotate();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('A lista de eventos mudou desde a última página (ou a continuação expirou).')).toBeInTheDocument();
    expect(tableRows('Eventos da execução')).toHaveLength(25);
    const n = count(/\/events/);
    await pause();
    expect(count(/\/events/)).toBe(n);
    fireEvent.click(screen.getByRole('button', { name: 'Recomeçar a lista' }));
    await waitFor(() => expect(count(/\/events/)).toBe(n + 1));
    expect(requests.filter((r) => r.includes('/events')).at(-1)).not.toContain('cursor=');

    let fail = true;
    intercept = (p) => (p.includes('/events') && p.includes('cursor=') && fail ? { network: true } : undefined);
    fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText(/Não foi possível conectar\. A lista exibida continua válida\./)).toBeInTheDocument();
    expect(tableRows('Eventos da execução')).toHaveLength(25);
    const m = count(/\/events/);
    await pause();
    expect(count(/\/events/)).toBe(m);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(tableRows('Eventos da execução')).toHaveLength(30));
  });

  it('falha transitória no detalhe: estado de erro com nova tentativa manual, sem repetição automática', async () => {
    sessionFor('ana@nekkora.dev');
    let fail = true;
    intercept = (p) => (p.endsWith(`/executions/${SCHEDULED}`) && fail ? { network: true } : undefined);
    renderAt(execPath(SCHEDULED));
    expect(await screen.findByText('Não foi possível conectar.')).toBeInTheDocument();
    const n = count(new RegExp(`/executions/${SCHEDULED}$`));
    await pause();
    expect(count(new RegExp(`/executions/${SCHEDULED}$`))).toBe(n);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await detailHeading('Backup dos arquivos de operação')).toBeInTheDocument();
  });

  it('resposta fora do contrato: nada é exibido a partir dela', async () => {
    sessionFor('ana@nekkora.dev');
    intercept = (p) => (p.endsWith(`/executions/${SCHEDULED}`) ? { tamper: (b) => ({ ...b, status: 'finished' }) } : undefined);
    renderAt(execPath(SCHEDULED));
    expect(await screen.findByText('A resposta do servidor veio fora do formato esperado.')).toBeInTheDocument();
    expect(screen.queryByText(/Backup dos arquivos de operação/)).toBeNull();
  });

  it('datas especiais: segundo bissexto aceito pelo contrato aparece como recebido, sem quebrar a tela', async () => {
    sessionFor('ana@nekkora.dev');
    intercept = (p) =>
      p.includes(`/executions/${SCHEDULED}/events`)
        ? { tamper: (b) => ({ ...b, items: b.items.map((e: any, i: number) => (i === 0 ? { ...e, occurredAt: '2016-12-31T23:59:60Z' } : e)) }) }
        : undefined;
    renderAt(execPath(SCHEDULED));
    await screen.findByRole('region', { name: 'Eventos da execução' });
    const t = screen.getByTitle('2016-12-31T23:59:60Z (horário como recebido, sem conversão de fuso)');
    expect(t).toHaveAttribute('dateTime', '2016-12-31T23:59:60Z');
  });

  it('troca rápida de execução com respostas fora de ordem: só a atual aparece', async () => {
    sessionFor('ana@nekkora.dev');
    const a = putExecution('lenta', 'conciliacao');
    const b = putExecution('rapida', 'rastreio');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    intercept = (p) => (p.includes(`/executions/${a}`) ? { delay: hold } : undefined);
    renderAt(execPath(a));
    await screen.findByText('Carregando execução…');
    act(() => navigate(execPath(b)));
    expect(await detailHeading('Atualização de rastreio de entregas')).toBeInTheDocument();
    await act(async () => release());
    await pause();
    expect(screen.queryByText(/Conciliação bancária diária/)).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Execução de Atualização de rastreio de entregas' })).toBeInTheDocument();
  });

  it('o botão Atualizar fica indisponível enquanto a atualização anterior não volta (sem pedidos sobrepostos)', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(execPath(SCHEDULED));
    await detailHeading('Backup dos arquivos de operação');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    intercept = (p) => (p.endsWith(`/executions/${SCHEDULED}`) ? { delay: hold } : undefined);
    const n = count(new RegExp(`/executions/${SCHEDULED}$`));
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(count(new RegExp(`/executions/${SCHEDULED}$`))).toBe(n + 1);
    await act(async () => release());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Atualizar' })).toBeEnabled());
  });

  it('troca de organização: o conteúdo da anterior some e respostas atrasadas dela são descartadas', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    intercept = (p) => (p.includes('/events') ? { delay: hold } : undefined);
    renderAt(execPath(SCHEDULED));
    await detailHeading('Backup dos arquivos de operação');
    const vizinha = [...api.product.executions.values()].find((e) => e.org === OTHER_ORG)!.executionId;
    act(() => navigate(execPath(vizinha, OTHER_ORG)));
    await act(async () => release());
    await pause();
    expect(screen.queryByText(/Backup dos arquivos de operação/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Eventos da execução' })).toBeNull();
  });

  it('sessão expirada ao atualizar: volta ao login com o aviso', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    renderAt(execPath(SCHEDULED));
    await detailHeading('Backup dos arquivos de operação');
    api.revokeSessions(ana.userId);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
    expect(screen.queryByText(/Backup dos arquivos de operação/)).toBeNull();
  });

  it('conta externa: nenhuma tela de leitura monta e nenhuma leitura interna é feita', async () => {
    sessionFor('portal@nekkora.dev');
    for (const path of [execPath(SCHEDULED), `${base}/workspaces`, `${base}/workspaces/${ws('operacoes')}`, `${base}/automacoes/${auto('backup')}`]) {
      const { unmount } = renderAt(path);
      expect(await screen.findByRole('heading', { name: 'Olá, Pessoa do Portal' })).toBeInTheDocument();
      await pause();
      unmount();
    }
    expect(requests.filter((r) => /\/me\/permissions|\/workspaces|\/executions|\/automations/.test(r))).toEqual([]);
  });
});

describe('workspaces, automações e versões', () => {
  it('workspace → automações → detail → versões → execuções filtradas por automação', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(base);
    const nav = await screen.findByRole('navigation', { name: 'Navegação principal' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Workspaces' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Workspaces' })).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Lista de workspaces' });
    expect(within(nav).getByRole('link', { name: 'Workspaces' })).toHaveAttribute('aria-current', 'page');
    expect(tableRows('Lista de workspaces')).toHaveLength(9);
    expect(screen.getByText('Arquivado')).toBeInTheDocument();
    expect(screen.getByText('Suspenso')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Operações' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Operações' })).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Automações do workspace' });
    expect(screen.getByText('Sem cliente')).toBeInTheDocument();
    expect(tableRows('Automações do workspace').map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      'Backup dos arquivos de operação',
      'Limpeza de temporários',
      'Relatório de capacidade',
    ]);
    expect(screen.getByRole('link', { name: 'Ver execuções deste workspace' })).toHaveAttribute('href', `${base}/execucoes?workspace=${ws('operacoes')}`);

    fireEvent.click(screen.getByRole('link', { name: 'Backup dos arquivos de operação' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Backup dos arquivos de operação' })).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Versões da automação' });
    expect(tableRows('Versões da automação').map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['versão 3', 'versão 2', 'versão 1']);
    expect(screen.getByRole('link', { name: 'Voltar para Operações' })).toHaveAttribute('href', `${base}/workspaces/${ws('operacoes')}`);

    fireEvent.click(screen.getByRole('link', { name: 'Ver execuções desta automação' }));
    expect(await screen.findByText('Somente a automação Backup dos arquivos de operação.')).toBeInTheDocument();
    await waitFor(() => expect(requests.some((r) => r.includes('/executions?') && r.includes(`automationId=${auto('backup')}`))).toBe(true));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Remover filtro de automação' }));
    await waitFor(() => expect(location).not.toContain('automacao='));
    expect(requests.filter((r) => r.includes('/executions?')).at(-1)).not.toContain('automationId=');
  });

  it('rascunho sem publicação e automação sem versões publicadas aparecem como tal', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`${base}/automacoes/${auto('rascunho')}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Exportação para auditoria (rascunho)' })).toBeInTheDocument();
    expect(screen.getByText('Nenhuma versão publicada')).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Versões da automação' });
    expect(screen.getByText('Rascunho')).toBeInTheDocument();
    expect(screen.getByText('Não publicada')).toBeInTheDocument();
  });

  it('automações e versões paginadas por cursor', async () => {
    sessionFor('ana@nekkora.dev');
    for (let i = 1; i <= 30; i++) {
      const id = stableUuid(`teste:auto:${i}`);
      api.product.automations.set(id, {
        automationId: id, org: DEV_ORG, workspaceId: ws('vazio'), name: `Rotina ${String(i).padStart(2, '0')}`, description: null,
        status: 'active', createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY,
      });
      api.product.versions.set(id, []);
    }
    const many = stableUuid('teste:auto:1');
    api.product.versions.set(
      many,
      Array.from({ length: 30 }, (_, i) => ({
        automationVersionId: stableUuid(`teste:ver:${i + 1}`), automationId: many, versionNumber: i + 1, status: 'published' as const,
        publishedAt: NOW - (40 - i) * DAY, createdAt: NOW - (41 - i) * DAY,
      })),
    );
    const { unmount } = renderAt(`${base}/workspaces/${ws('vazio')}`);
    await screen.findByRole('region', { name: 'Automações do workspace' });
    expect(tableRows('Automações do workspace')).toHaveLength(25);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(tableRows('Automações do workspace')).toHaveLength(30));
    unmount();

    renderAt(`${base}/automacoes/${many}`);
    await screen.findByRole('region', { name: 'Versões da automação' });
    expect(tableRows('Versões da automação')).toHaveLength(25);
    expect(within(tableRows('Versões da automação')[0]).getAllByRole('cell')[0].textContent).toBe('versão 30');
    api.product.cursors.rotate();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('A lista mudou desde a última página (ou a continuação expirou).')).toBeInTheDocument();
    expect(tableRows('Versões da automação')).toHaveLength(25);
    fireEvent.click(screen.getByRole('button', { name: 'Recomeçar a lista' }));
    await waitFor(() => expect(screen.queryByText(/A lista mudou/)).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(tableRows('Versões da automação')).toHaveLength(30));
  });

  it('acesso limitado: leitora vê só os workspaces atribuídos; outro workspace dá não encontrado', async () => {
    sessionFor('leitora@nekkora.dev');
    const { unmount } = renderAt(`${base}/workspaces`);
    await screen.findByRole('region', { name: 'Lista de workspaces' });
    expect(tableRows('Lista de workspaces').map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['Atendimento', 'Integrações legadas']);
    unmount();
    renderAt(`${base}/workspaces/${ws('financeiro')}`);
    expect(await screen.findByRole('heading', { name: 'Workspace não encontrado.' })).toBeInTheDocument();
    expect(screen.queryByText('Financeiro — Conciliação')).toBeNull();
  });

  it('sem atribuições: lista vazia explicada; automação de qualquer workspace dá não encontrado', async () => {
    sessionFor('sematribuicao@nekkora.dev');
    const { unmount } = renderAt(`${base}/workspaces`);
    expect(await screen.findByText('Você ainda não tem acesso a nenhum workspace.')).toBeInTheDocument();
    unmount();
    renderAt(`${base}/automacoes/${auto('backup')}`);
    expect(await screen.findByRole('heading', { name: 'Automação não encontrada.' })).toBeInTheDocument();
  });

  it('isolamento: workspace de outra organização dá o mesmo não encontrado', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`${base}/workspaces/${stableUuid('vizinha:ws:vizinho')}`);
    expect(await screen.findByRole('heading', { name: 'Workspace não encontrado.' })).toBeInTheDocument();
    expect(screen.queryByText('Workspace da organização vizinha')).toBeNull();
  });

  it('troca rápida de workspace com respostas fora de ordem: só o atual aparece, inclusive nas automações', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    intercept = (p) => (p.includes(`/workspaces/${ws('financeiro')}`) ? { delay: hold } : undefined);
    renderAt(`${base}/workspaces/${ws('financeiro')}`);
    await screen.findByText('Carregando workspace…');
    act(() => navigate(`${base}/workspaces/${ws('logistica')}`));
    expect(await screen.findByRole('heading', { level: 1, name: 'Logística' })).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Automações do workspace' });
    await act(async () => release());
    await pause();
    expect(screen.queryByText('Conciliação bancária diária')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Financeiro — Conciliação' })).toBeNull();
  });

  it('revogação + Atualizar no workspace: não encontrado sem os dados anteriores', async () => {
    const gestora = sessionFor('gestora@nekkora.dev');
    renderAt(`${base}/workspaces/${ws('financeiro')}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Financeiro — Conciliação' })).toBeInTheDocument();
    api.product.revokeWorkspaceRole(gestora.membershipId, ws('financeiro'));
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(await screen.findByRole('heading', { name: 'Workspace não encontrado.' })).toBeInTheDocument();
    expect(screen.queryByText(/Conciliação bancária/)).toBeNull();
  });
});

describe('filtros da lista de execuções no endereço', () => {
  it('troca do filtro de automação com respostas fora de ordem: o aviso mostra só a automação atual', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    intercept = (p) => (p.endsWith(`/automations/${auto('backup')}`) ? { delay: hold } : undefined);
    renderAt(`${base}/execucoes?automacao=${auto('backup')}`);
    await screen.findByText('Filtro por automação.');
    act(() => navigate(`${base}/execucoes?automacao=${auto('limpeza')}`));
    expect(await screen.findByText('Somente a automação Limpeza de temporários.')).toBeInTheDocument();
    await act(async () => release());
    await pause();
    expect(screen.queryByText(/Backup dos arquivos de operação\./)).toBeNull();
    expect(screen.getByText('Somente a automação Limpeza de temporários.')).toBeInTheDocument();
  });

  it('recarga com o mesmo endereço repete exatamente os mesmos limites do período', async () => {
    sessionFor('ana@nekkora.dev');
    const { unmount } = renderAt(`${base}/execucoes`);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: '7d' } });
    await waitFor(() => expect(location).toContain('periodo=7d'));
    const url = location;
    const from1 = new URL(requests.filter((r) => r.includes('/executions?')).at(-1)!, 'http://x').searchParams.get('from');
    unmount();
    vi.setSystemTime(NOW + 3 * 3_600_000); // "recarga" horas depois
    requests = [];
    renderAt(url);
    await screen.findByRole('table');
    const from2 = new URL(requests.filter((r) => r.includes('/executions?')).at(-1)!, 'http://x').searchParams.get('from');
    expect(from2).toBe(from1);
    expect(location).toBe(url);
  });

  it('período personalizado e workspace fora da parte carregada vêm do endereço', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`${base}/execucoes?workspace=${ws('logistica')}&periodo=custom&de=2026-09-01T03:00:00.000Z&ate=2026-09-10T03:00:00.000Z`);
    await screen.findByRole('table');
    const q = new URL(requests.filter((r) => r.includes('/executions?')).at(-1)!, 'http://x').searchParams;
    expect(q.get('workspaceId')).toBe(ws('logistica'));
    expect(q.get('from')).toBe('2026-09-01T03:00:00.000Z');
    expect(q.get('to')).toBe('2026-09-10T03:00:00.000Z');
  });

  it('endereço com valores desconhecidos cai no padrão de 30 dias, sem erro', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`${base}/execucoes?periodo=nunca&estado=quebrado&desde=ontem`);
    await screen.findByRole('table');
    const q = new URL(requests.filter((r) => r.includes('/executions?')).at(-1)!, 'http://x').searchParams;
    expect(q.getAll('status')).toEqual([]);
    expect(q.get('from')).toBe(new Date(NOW - 30 * DAY).toISOString());
  });

  it('link do workspace na linha da lista leva ao detalhe do workspace', async () => {
    sessionFor('ana@nekkora.dev');
    renderAt(`${base}/execucoes?workspace=${ws('operacoes')}`);
    await screen.findByRole('table');
    const link = within(screen.getByRole('table')).getAllByRole('link', { name: 'Operações' })[0];
    expect(link).toHaveAttribute('href', `${base}/workspaces/${ws('operacoes')}`);
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Operações' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Voltar para workspaces' })).toHaveAttribute('href', `${base}/execucoes?workspace=${ws('operacoes')}&periodo=30d&desde=${encodeURIComponent(new Date(NOW - 30 * DAY).toISOString())}`);
  });
});

/* ------------------------------------------------------------------------------------------------ F5-R1 */

const loginVisits = () => visited.filter((v) => v.split('|')[1].startsWith(`${base}/login`)).length;
const EXPIRED = 'Sua sessão expirou. Entre novamente para continuar.';
const fail = (status: number, error: string) => ({ respond: { status, body: { error } } });

describe('F5-R1: perda de acesso na consulta subordinada invalida a página inteira', () => {
  it('execução: revogação antes de "Carregar mais" dos eventos → não encontrada, sem os dados anteriores', async () => {
    const gestora = sessionFor('gestora@nekkora.dev');
    const id = putExecution('r1-eventos', 'conciliacao');
    setEvents(id, 30);
    renderAt(execPath(id));
    expect(await detailHeading('Conciliação bancária diária')).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Eventos da execução' });
    api.product.revokeWorkspaceRole(gestora.membershipId, ws('financeiro'));
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByRole('heading', { name: 'Execução não encontrada.' })).toBeInTheDocument();
    expect(screen.queryByText(/Conciliação bancária diária/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Eventos da execução' })).toBeNull();
    expect(screen.queryByText(/continua válida/)).toBeNull();
    expect(screen.queryByText(id)).toBeNull();
  });

  it('workspace: revogação antes de "Carregar mais" das automações → não encontrado, sem os dados anteriores', async () => {
    const gestora = sessionFor('gestora@nekkora.dev');
    for (let i = 1; i <= 30; i++) {
      const aid = stableUuid(`teste:r1:auto:${i}`);
      api.product.automations.set(aid, {
        automationId: aid, org: DEV_ORG, workspaceId: ws('financeiro'), name: `Rotina R1 ${String(i).padStart(2, '0')}`, description: null,
        status: 'active', createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY,
      });
      api.product.versions.set(aid, []);
    }
    renderAt(`${base}/workspaces/${ws('financeiro')}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Financeiro — Conciliação' })).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Automações do workspace' });
    api.product.revokeWorkspaceRole(gestora.membershipId, ws('financeiro'));
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByRole('heading', { name: 'Workspace não encontrado.' })).toBeInTheDocument();
    expect(screen.queryByText(/Financeiro — Conciliação|Rotina R1|Conciliação bancária/)).toBeNull();
    expect(screen.queryByText(/continua válida/)).toBeNull();
  });

  it('automação: revogação antes de "Carregar mais" das versões → não encontrada, sem os dados anteriores', async () => {
    const gestora = sessionFor('gestora@nekkora.dev');
    const aid = auto('conciliacao');
    api.product.versions.set(
      aid,
      Array.from({ length: 30 }, (_, i) => ({
        automationVersionId: stableUuid(`teste:r1:ver:${i + 1}`), automationId: aid, versionNumber: i + 1, status: 'published' as const,
        publishedAt: NOW - (40 - i) * DAY, createdAt: NOW - (41 - i) * DAY,
      })),
    );
    renderAt(`${base}/automacoes/${aid}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Conciliação bancária diária' })).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Versões da automação' });
    api.product.revokeWorkspaceRole(gestora.membershipId, ws('financeiro'));
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByRole('heading', { name: 'Automação não encontrada.' })).toBeInTheDocument();
    expect(screen.queryByText(/Conciliação bancária diária|versão 30/)).toBeNull();
    expect(screen.queryByText(/continua válida/)).toBeNull();
  });

  it('Atualizar após revogação: o 404 do detalhe basta, mesmo com a consulta subordinada ainda pendente', async () => {
    const gestora = sessionFor('gestora@nekkora.dev');
    const id = putExecution('r1-so-detalhe', 'conciliacao');
    renderAt(execPath(id));
    expect(await detailHeading('Conciliação bancária diária')).toBeInTheDocument();
    await screen.findByText('Nenhum evento registrado.');
    api.product.revokeWorkspaceRole(gestora.membershipId, ws('financeiro'));
    const never = new Promise<void>(() => {});
    intercept = (p) => (p.includes('/events') ? { delay: never } : undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(await screen.findByRole('heading', { name: 'Execução não encontrada.' })).toBeInTheDocument();
    expect(screen.queryByText(/Conciliação bancária diária/)).toBeNull();
  });

  it('primeira página subordinada 404 com o detalhe já exibido: a página inteira vira não encontrada', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    intercept = (p) => (p.includes(`/executions/${SCHEDULED}/events`) ? { delay: hold, ...fail(404, 'not_found') } : undefined);
    renderAt(execPath(SCHEDULED));
    expect(await detailHeading('Backup dos arquivos de operação')).toBeInTheDocument();
    await act(async () => release());
    expect(await screen.findByRole('heading', { name: 'Execução não encontrada.' })).toBeInTheDocument();
    expect(screen.queryByText(/Backup dos arquivos de operação/)).toBeNull();
  });

  it('distinção mantida: cursor recusado e falha transitória na subordinada NÃO derrubam o detalhe', async () => {
    sessionFor('ana@nekkora.dev');
    const id = putExecution('r1-distincao', 'backup');
    setEvents(id, 30);
    renderAt(execPath(id));
    await screen.findByRole('region', { name: 'Eventos da execução' });
    api.product.cursors.rotate();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText(/A lista de eventos mudou/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Execução de Backup dos arquivos de operação' })).toBeInTheDocument();
    expect(tableRows('Eventos da execução')).toHaveLength(25);
    fireEvent.click(screen.getByRole('button', { name: 'Recomeçar a lista' }));
    await waitFor(() => expect(screen.queryByText(/A lista de eventos mudou/)).toBeNull());
    intercept = (p) => (p.includes('/events') && p.includes('cursor=') ? { network: true } : undefined);
    fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText(/Não foi possível conectar\. A lista exibida continua válida\./)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Execução de Backup dos arquivos de operação' })).toBeInTheDocument();
    expect(tableRows('Eventos da execução')).toHaveLength(25);
  });
});

describe('F5-R1: 401 de qualquer requisição encerra a sessão, uma única vez', () => {
  type Case = { name: string; path: string; detail: RegExp; sub: RegExp };
  const cases: Case[] = [
    { name: 'execução', path: execPath(SCHEDULED), detail: new RegExp(`/executions/${SCHEDULED}$`), sub: /\/events/ },
    { name: 'workspace', path: `${base}/workspaces/${ws('operacoes')}`, detail: new RegExp(`/workspaces/${ws('operacoes')}$`), sub: /\/automations\?/ },
    { name: 'automação', path: `${base}/automacoes/${auto('backup')}`, detail: new RegExp(`/automations/${auto('backup')}$`), sub: /\/versions/ },
  ];

  for (const c of cases) {
    for (const order of ['detalhe 500 antes, lista 401 depois', 'lista 401 antes, detalhe 500 depois'] as const) {
      it(`${c.name}: ${order}`, async () => {
        sessionFor('ana@nekkora.dev');
        let releaseFirst!: () => void;
        let releaseSecond!: () => void;
        const first = new Promise<void>((r) => (releaseFirst = r));
        const second = new Promise<void>((r) => (releaseSecond = r));
        const detailFirst = order.startsWith('detalhe');
        intercept = (p) => {
          if (c.detail.test(p.split('?')[0])) return { delay: detailFirst ? first : second, ...fail(500, 'internal_error') };
          if (c.sub.test(p)) return { delay: detailFirst ? second : first, ...fail(401, 'unauthenticated') };
          return undefined;
        };
        renderAt(c.path);
        await waitFor(() => expect(requests.some((r) => c.sub.test(r))).toBe(true));
        await act(async () => releaseFirst());
        await pause();
        await act(async () => releaseSecond());
        expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
        await pause();
        expect(location).toBe(`${base}/login`);
        expect(loginVisits()).toBe(1);
      });
    }
  }

  it('detalhe e lista com 401 juntos: o fluxo de sessão expirada acontece uma única vez', async () => {
    sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    intercept = (p) => (p.includes(`/executions/${SCHEDULED}`) ? { delay: hold, ...fail(401, 'unauthenticated') } : undefined);
    renderAt(execPath(SCHEDULED));
    await waitFor(() => expect(requests.filter((r) => r.includes(`/executions/${SCHEDULED}`))).toHaveLength(2));
    await act(async () => release());
    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    await pause();
    expect(loginVisits()).toBe(1);
  });

  it('sessão revogada com leituras do shell e da página em andamento: todos os 401 levam a um único fluxo', async () => {
    const ana = sessionFor('ana@nekkora.dev');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    intercept = (p) => (/\/me\/permissions|\/workspaces\?|\/executions\//.test(p) ? { delay: hold } : undefined);
    renderAt(execPath(SCHEDULED));
    await waitFor(() => expect(requests.some((r) => r.includes('/events'))).toBe(true));
    await waitFor(() => expect(requests.some((r) => r.includes('/me/permissions'))).toBe(true));
    api.revokeSessions(ana.userId);
    await act(async () => release());
    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    await pause();
    expect(loginVisits()).toBe(1);
  });

  it('lista de execuções: 401 só na leitura auxiliar da automação também encerra a sessão', async () => {
    sessionFor('ana@nekkora.dev');
    intercept = (p) => (p.endsWith(`/automations/${auto('backup')}`) ? fail(401, 'unauthenticated') : undefined);
    renderAt(`${base}/execucoes?automacao=${auto('backup')}`);
    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    await pause();
    expect(location).toBe(`${base}/login`);
    expect(loginVisits()).toBe(1);
  });
});
