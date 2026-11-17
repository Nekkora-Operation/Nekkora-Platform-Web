import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';

/**
 * A execução remota nas telas Execuções e Supervisão e no detalhe próprio. As duas telas liam só os modelos anteriores; a
 * solicitação e as tentativas vêm do registro da execução remota (a mesma rota, sem cópia). Respostas conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const WS = '0b6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const AG1 = '33333333-3333-4333-8333-333333333333';
const AG2 = '44444444-4444-4444-8444-444444444444';
const AUT = '55555555-5555-4555-8555-555555555555';
const VERSION = '66666666-6666-4666-8666-666666666666';
const X1 = '88888888-8888-4888-8888-888888888888';
const A1 = '77777777-7777-4777-8777-777777777777';
const A2 = '99999999-9999-4999-8999-999999999999';
const T = '2026-11-10T10:00:00Z';
const ALL = `/api/v1/o/${ORG}/remote-executions`;
type Row = Record<string, unknown>;

let api: RouteApi;

const attempt = (over: Row = {}): Row => ({
  attemptId: A1,
  attemptNumber: 1,
  agentId: AG1,
  agentName: 'ESTACAO-01',
  workerId: W1,
  workerName: 'Worker financeiro',
  state: 'SUCCEEDED',
  refusalReason: null,
  communication: 'NONE',
  exitCode: 0,
  createdAt: T,
  offerValidUntil: '2026-11-10T10:15:00Z',
  offeredAt: '2026-11-10T10:00:05Z',
  receivedAt: '2026-11-10T10:00:06Z',
  startedAt: '2026-11-10T10:00:10Z',
  endedAt: '2026-11-10T10:01:10Z',
  closureCause: null,
  lateReport: null,
  reconciliations: [],
  machineStillRunningAt: null,
  processes: null,
  processesAt: null,
  ...over,
});
const execution = (attempts: Row[], over: Row = {}): Row => ({
  remoteExecutionId: X1,
  workspaceId: WS,
  automationId: AUT,
  automationVersionId: VERSION,
  versionNumber: 3,
  state: attempts[attempts.length - 1].state,
  requirementsRevision: 1,
  dependencies: [],
  requestedAt: T,
  cancelRequestedAt: null,
  workspaceName: 'Financeiro',
  automationName: 'Conciliação',
  attempts,
  ...over,
});
/** Uma solicitação com duas tentativas: a primeira recusada numa máquina, a segunda concluída em outra. */
const twoAttempts = () =>
  execution([
    attempt({ state: 'REFUSED', refusalReason: 'BUSY', exitCode: null, startedAt: null, endedAt: '2026-11-10T10:00:08Z' }),
    attempt({ attemptId: A2, attemptNumber: 2, agentId: AG2, agentName: 'ESTACAO-02', workerId: W2, workerName: 'Worker fiscal' }),
  ]);

function permissions(workspace: string[]) {
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: { organizationId: ORG, membershipId: VERSION, organization: { roles: ['ORG_ADMIN'], permissions: [] }, allWorkspaces: { permissions: workspace }, hasWorkspaceAssignments: false },
  });
}

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  csrfStore.clear();
  sessionMemory.reset();
  vi.unstubAllGlobals();
  localStorage.clear();
  const locks = fakeLocks();
  setOperationRegistryForTest(createOperationRegistry({ storage: () => localStorage, locks: () => locks, now: () => Date.now() }));
  api = new RouteApi().install();
  csrfStore.setSession(ORG, 'ses');
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' },
  });
  permissions(['automation.read', 'logs.read']);
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/executions`, 'listExecutions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/agent-runs`, 'listAgentRuns', { status: 200, body: { items: [], nextCursor: null } });
});
afterEach(() => vi.unstubAllGlobals());

/** A lista do modelo anterior, vazia (o texto depende de haver workspaces carregados). */
const EMPTY_OLD_MODEL = /Nenhuma execução encontrada\.|Você ainda não tem acesso a nenhum workspace\./;
const region = (name: string) => screen.findByRole('region', { name });

describe('Execuções: a execução remota aparece pela solicitação', () => {
  it('uma linha por solicitação, com automação, versão, workspace, máquina, origem, horários e resultado; continua lá ao recarregar', async () => {
    api.on('GET', ALL, 'listVisibleRemoteExecutions', { status: 200, body: { items: [twoAttempts()] } });
    renderApp(`/o/${ORG}/execucoes`);
    // a tela continua sem execuções do modelo anterior: são listas distintas, uma não inventa item para a outra
    expect(await screen.findByText(EMPTY_OLD_MODEL)).toBeInTheDocument();
    // a página ainda se redesenha enquanto carrega (workspaces, permissões): as linhas são relidas a cada conferência
    await waitFor(() => {
      const rows = within(screen.getByRole('region', { name: 'Lista de execuções remotas' })).getAllByRole('row');
      expect(rows, 'cabeçalho + UMA linha: a solicitação, não as duas tentativas').toHaveLength(2);
      const row = within(rows[1]);
      expect(row.getByRole('link', { name: /Execução remota de Conciliação/ })).toHaveAttribute('href', `/o/${ORG}/execucoes-remotas/${X1}`);
      expect(row.getByText('versão 3')).toBeInTheDocument();
      expect(row.getByRole('link', { name: 'Financeiro' })).toBeInTheDocument();
      expect(row.getByText('Concluída')).toBeInTheDocument();
      expect(row.getByText('código de saída 0')).toBeInTheDocument();
      expect(row.getByText('Execução remota · solicitada pela Platform')).toBeInTheDocument();
      expect(row.getByText('ESTACAO-02 · Worker fiscal')).toBeInTheDocument();
      expect(rows[1].querySelectorAll('time').length, 'solicitada em, início e término').toBeGreaterThanOrEqual(3);
      expect(row.getByText('2')).toBeInTheDocument();
    });
    expect(api.sent('POST', /.*/)).toEqual([]);

    // recarregar a página: a solicitação continua lá (vem do servidor, não da memória da tela)
    cleanup();
    renderApp(`/o/${ORG}/execucoes`);
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Lista de execuções remotas' })).getByRole('link', { name: /Execução remota de Conciliação/ })).toBeInTheDocument());
  });

  it('o filtro de workspace e o período da tela vão na consulta', async () => {
    api.on('GET', ALL, 'listVisibleRemoteExecutions', { status: 200, body: { items: [] } });
    // o registro de chamadas do teste guarda só o caminho: os parâmetros são lidos do endereço pedido
    const inner = globalThis.fetch;
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      return inner(url, init);
    });
    renderApp(`/o/${ORG}/execucoes?workspace=${WS}&periodo=30d`);
    expect(await screen.findByText('Nenhuma execução remota com esses filtros.')).toBeInTheDocument();
    const sent = urls.filter((u) => u.split('?')[0] === ALL);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[sent.length - 1]).toContain(`workspaceId=${WS}`);
    expect(sent[sent.length - 1]).toMatch(/from=\d{4}-/);
  });

  it('Platform sem a rota (404): a seção diz que não está disponível e a tela segue', async () => {
    api.on('GET', ALL, 'listVisibleRemoteExecutions', { status: 404, body: { error: 'not_found' } });
    renderApp(`/o/${ORG}/execucoes`);
    expect(await screen.findByText('Execuções remotas não estão disponíveis para você aqui.')).toBeInTheDocument();
    expect(await screen.findByText(EMPTY_OLD_MODEL)).toBeInTheDocument();
  });
});

describe('Supervisão: a execução remota aparece pelas tentativas', () => {
  it('uma linha por tentativa, cada uma com a sua máquina, o seu Worker e o seu desfecho', async () => {
    api.on('GET', ALL, 'listVisibleRemoteExecutions', { status: 200, body: { items: [twoAttempts()] } });
    renderApp(`/o/${ORG}/supervisao`);
    const r = within(await region('Tentativas de execução remota'));
    const rows = r.getAllByRole('row');
    expect(rows, 'cabeçalho + duas tentativas da mesma solicitação').toHaveLength(3);
    const second = within(rows[1]);
    expect(second.getByText('ESTACAO-02')).toBeInTheDocument();
    expect(second.getByText('Worker fiscal')).toBeInTheDocument();
    expect(second.getByText('Concluída')).toBeInTheDocument();
    expect(second.getByText('2 de 2')).toBeInTheDocument();
    expect(second.getByText('Conciliação · versão 3')).toBeInTheDocument();
    expect(second.getByRole('link')).toHaveAttribute('href', `/o/${ORG}/execucoes-remotas/${X1}`);
    const first = within(rows[2]);
    expect(first.getByText('ESTACAO-01')).toBeInTheDocument();
    expect(first.getByText('Não iniciada')).toBeInTheDocument();
    expect(first.getByText('1 de 2')).toBeInTheDocument();
  });
});

describe('Detalhe da execução remota', () => {
  it('mostra a solicitação e cada tentativa, com acesso aos registros e aos arquivos da que iniciou e terminou', async () => {
    api.on('GET', `${ALL}/${X1}`, 'getRemoteExecution', { status: 200, body: twoAttempts() });
    api.on('GET', new RegExp(`${ALL}/${X1}/attempts/${A2}/logs`), 'listRemoteAttemptLogs', {
      status: 200,
      body: {
        attemptId: A2,
        items: [{ sequence: 1, capturedAt: T, channel: 'STDOUT', level: 'UNKNOWN', truncated: false, message: 'linha da automação', textRemoved: false }],
        total: 1,
        automationLines: 1,
        systemLines: 0,
        nextAfter: null,
        closure: null,
        retentionLoss: null,
        expiration: null,
      },
    });
    renderApp(`/o/${ORG}/execucoes-remotas/${X1}`);
    const request = within(await screen.findByRole('region', { name: 'Solicitação' }).catch(() => screen.findByLabelText('Solicitação')));
    expect(request.getByRole('link', { name: 'Conciliação' })).toHaveAttribute('href', `/o/${ORG}/automacoes/${AUT}`);
    expect(request.getByRole('link', { name: 'versão 3' })).toHaveAttribute('href', `/o/${ORG}/versoes/${VERSION}`);
    expect(request.getByRole('link', { name: 'Financeiro' })).toBeInTheDocument();
    expect(request.getByText('Execução remota · solicitada pela Platform')).toBeInTheDocument();

    const second = within(screen.getByLabelText('Tentativa 2'));
    expect(second.getByText('ESTACAO-02')).toBeInTheDocument();
    expect(second.getByText('Worker fiscal')).toBeInTheDocument();
    expect(second.getByText('Concluída')).toBeInTheDocument();
    const first = within(screen.getByLabelText('Tentativa 1'));
    expect(first.getByText(/Motivo informado pela máquina/)).toBeInTheDocument();
    // a tentativa que não iniciou não tem registros nem arquivos a oferecer
    expect(first.queryByRole('button', { name: /registros/ })).toBeNull();

    fireEvent.click(await second.findByRole('button', { name: 'Ver registros da tentativa 2' }));
    expect(await second.findByText('linha da automação')).toBeInTheDocument();
    await waitFor(() => expect(second.getByRole('button', { name: /arquivos|resultados/i })).toBeInTheDocument());
    expect(api.sent('POST', /.*/)).toEqual([]);
  });

  it('sem logs.read: a solicitação e as tentativas aparecem, sem registros nem arquivos', async () => {
    permissions(['automation.read']);
    api.on('GET', `${ALL}/${X1}`, 'getRemoteExecution', { status: 200, body: twoAttempts() });
    renderApp(`/o/${ORG}/execucoes-remotas/${X1}`);
    const second = within(await screen.findByLabelText('Tentativa 2'));
    expect(await second.findByText(/não tem permissão para ver os registros/)).toBeInTheDocument();
    expect(second.queryByRole('button', { name: /registros/ })).toBeNull();
  });

  it('solicitação de ambiente sem acesso (404): não encontrada', async () => {
    api.on('GET', `${ALL}/${X1}`, 'getRemoteExecution', { status: 404, body: { error: 'not_found' } });
    renderApp(`/o/${ORG}/execucoes-remotas/${X1}`);
    expect(await screen.findByText('Execução remota não encontrada')).toBeInTheDocument();
  });
});
