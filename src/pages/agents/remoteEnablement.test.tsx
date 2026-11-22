import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { AGENT_AVAILABLE_DESCRIPTION, CLIENT_CONFIRMATION_REQUIRED, CLIENT_UNAVAILABLE_DESCRIPTION, REMOTE_UNAVAILABLE_TEXT } from './agentDialogs';

/**
 * PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T01a — habilitar uma máquina para execução remota a partir da tela de Workers (o
 * código de pareamento nasce marcado só quando a pessoa pede) e a lista das máquinas habilitadas na página do workspace.
 * Respostas por rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const WS = '0b6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const AG1 = '33333333-3333-4333-8333-333333333333';
const AG2 = '44444444-4444-4444-8444-444444444444';
const ENR = '55555555-5555-4555-8555-555555555555';
const MEMBER = '66666666-6666-4666-8666-666666666666';
const T = '2026-11-10T12:00:00Z';
const CODE = `nkp1.${ENR}.${W1}.${'A'.repeat(43)}`;
const PAIRING = `/api/v1/o/${ORG}/agent-enrollments`;
const MACHINES = `/api/v1/o/${ORG}/workspaces/${WS}/remote-machines`;

let api: RouteApi;

const freeWorker = {
  workerId: W1,
  name: 'Worker financeiro',
  status: 'ACTIVE',
  agentId: null,
  workspaceIds: [],
  agentName: null,
  agentStatus: null,
  agentVersion: null,
  installationId: null,
  lastHeartbeatAt: null,
  connectivity: null,
  credentialExpiresAt: null,
  createdAt: T,
};
const issued = (over: Record<string, unknown> = {}) => ({
  status: 201,
  body: { enrollmentId: ENR, code: CODE, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), workerId: W1, ...over },
});
const machine = (over: Record<string, unknown> = {}) => ({
  workerId: W1,
  workerName: 'Worker financeiro',
  agentId: AG1,
  agentName: 'ESTACAO-01',
  agentVersion: '0.1.0+client',
  state: 'AVAILABLE',
  receiving: 'ENABLED',
  lastHeartbeatAt: T,
  enabledAt: T,
  ...over,
});

function setup(workspacePermissions: string[]) {
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: {
      organizationId: ORG,
      membershipId: MEMBER,
      organization: { roles: ['ORG_ADMIN'], permissions: ['worker.manage', 'agent.manage', 'agent_credential.manage', 'worker_agent.assign', 'worker_workspace.authorize'] },
      allWorkspaces: { permissions: workspacePermissions },
      hasWorkspaceAssignments: false,
    },
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
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', remoteExecutionAvailable: true, stepUpMethod: 'totp' },
  });
  setup(['automation.read', 'automation.execute']);
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/workers`, 'listWorkers', { status: 200, body: { items: [freeWorker] } });
  api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}`, 'getWorkspace', {
    status: 200,
    body: { workspaceId: WS, name: 'Financeiro', description: null, status: 'active', client: null, createdAt: T, updatedAt: T },
  });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workspaces/${WS}/automations`), 'listAutomations', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/local-run-authorizations`, 'listLocalRunAuthorizations', { status: 200, body: { items: [] } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/agents`), 'listAgents', { status: 200, body: { items: [], nextCursor: null } });
});
afterEach(() => vi.unstubAllGlobals());

const dialog = () => screen.getByRole('alertdialog');
const pairingPosts = () => api.sent('POST', PAIRING);

async function openPairing() {
  renderApp(`/o/${ORG}/workers`);
  await screen.findByRole('heading', { name: 'Máquinas', level: 1 });
  fireEvent.click(await screen.findByRole('button', { name: 'Vincular Agent a Worker financeiro' }));
}

async function confirm() {
  const button = within(dialog()).getByRole('button', { name: 'Gerar código' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe('Workers: código para habilitar execução remota (T01a)', () => {
  it('vínculo do Client: sem marcar a confirmação, o código não é gerado; marcando, é', async () => {
    api.on('POST', PAIRING, 'createAgentPairingCode', issued({ remoteExecution: true }));
    await openPairing();
    // o diálogo abre no aplicativo atual (Client), com a confirmação desmarcada e o botão desabilitado
    expect((within(dialog()).getByRole('radio', { name: /^Nekkora Agent Client/ }) as HTMLInputElement).checked).toBe(true);
    const option = within(dialog()).getByLabelText('Habilitar esta máquina para execução remota') as HTMLInputElement;
    expect(option.checked).toBe(false);
    const button = within(dialog()).getByRole('button', { name: 'Gerar código' });
    expect(button).toBeDisabled();
    expect(within(dialog()).getByText(CLIENT_CONFIRMATION_REQUIRED)).toBeInTheDocument();
    fireEvent.click(button);
    expect(pairingPosts()).toEqual([]);
    // marcar habilita o botão; desmarcar o desabilita de novo
    fireEvent.click(option);
    await waitFor(() => expect(button).toBeEnabled());
    expect(within(dialog()).queryByText(CLIENT_CONFIRMATION_REQUIRED)).toBeNull();
    fireEvent.click(option);
    await waitFor(() => expect(button).toBeDisabled());
    expect(pairingPosts()).toEqual([]);
    fireEvent.click(option);
    await confirm();
    expect(await screen.findByLabelText('Código de uso único')).toHaveTextContent(CODE);
    expect(pairingPosts()).toHaveLength(1);
    expect(pairingPosts()[0].body).toEqual({ workerId: W1, agentName: 'Worker financeiro', expiresInMinutes: 15, remoteExecution: true });
  });

  it('Agent anterior: o fluxo de sempre, sem a opção de execução remota e sem a marca no pedido', async () => {
    api.on('POST', PAIRING, 'createAgentPairingCode', issued());
    await openPairing();
    // mesmo com a confirmação marcada antes, trocar para o Agent anterior a descarta
    fireEvent.click(within(dialog()).getByLabelText('Habilitar esta máquina para execução remota'));
    fireEvent.click(within(dialog()).getByRole('radio', { name: /^Nekkora Agent anterior/ }));
    expect(within(dialog()).queryByLabelText('Habilitar esta máquina para execução remota')).toBeNull();
    expect(within(dialog()).queryByText(CLIENT_CONFIRMATION_REQUIRED)).toBeNull();
    await confirm();
    expect(await screen.findByLabelText('Código de uso único')).toHaveTextContent(CODE);
    expect(pairingPosts()).toHaveLength(1);
    expect(pairingPosts()[0].body).toEqual({ workerId: W1, agentName: 'Worker financeiro', expiresInMinutes: 15 });
    expect(screen.getByText('Código de pareamento para Worker financeiro')).toBeInTheDocument();
    expect(screen.getByText(/Parear com a Platform/)).toBeInTheDocument();
    expect(screen.queryByText(/Habilitar este computador/)).toBeNull();
  });

  it('marcada, o código nasce para execução remota e a tela diz onde confirmá-lo na máquina', async () => {
    api.on('POST', PAIRING, 'createAgentPairingCode', issued({ remoteExecution: true }));
    await openPairing();
    expect(within(dialog()).getByText(/só vale depois de confirmada no próprio computador/)).toBeInTheDocument();
    expect(within(dialog()).getByText(/Não autoriza nenhuma automação/)).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByLabelText('Habilitar esta máquina para execução remota'));
    await confirm();
    expect(await screen.findByLabelText('Código de uso único')).toHaveTextContent(CODE);
    expect(pairingPosts()[0].body).toEqual({ workerId: W1, agentName: 'Worker financeiro', expiresInMinutes: 15, remoteExecution: true });
    expect(screen.getByText('Código de habilitação para execução remota de Worker financeiro')).toBeInTheDocument();
    expect(screen.getByText(/Habilitar este computador/)).toBeInTheDocument();
    expect(screen.getByText(/o código sozinho não habilita nada/)).toBeInTheDocument();
    expect(screen.queryByText(/Parear com a Platform/)).toBeNull();
  });

  it('a opção não fica marcada para o próximo máquina', async () => {
    api.on('POST', PAIRING, 'createAgentPairingCode', issued({ remoteExecution: true }));
    await openPairing();
    fireEvent.click(within(dialog()).getByLabelText('Habilitar esta máquina para execução remota'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Vincular Agent a Worker financeiro' }));
    expect((within(dialog()).getByLabelText('Habilitar esta máquina para execução remota') as HTMLInputElement).checked).toBe(false);
    expect(within(dialog()).getByRole('button', { name: 'Gerar código' })).toBeDisabled();
    expect(pairingPosts()).toEqual([]);
  });

  it('recurso desligado na Platform: recusa compreensível e nenhum código na tela', async () => {
    api.on('POST', PAIRING, 'createAgentPairingCode', { status: 409, body: { error: 'conflict', reason: 'remote_execution_unavailable' } });
    await openPairing();
    fireEvent.click(within(dialog()).getByLabelText('Habilitar esta máquina para execução remota'));
    await confirm();
    expect(await within(dialog()).findByText(REMOTE_UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(screen.queryByLabelText('Código de uso único')).toBeNull();
    expect(screen.queryByText(/já tem um Agent vinculado/)).toBeNull();
  });
});

describe('Workspace: máquinas habilitadas para execução remota (T01a)', () => {
  const open = async () => {
    renderApp(`/o/${ORG}/workspaces/${WS}`);
    await screen.findByRole('heading', { name: 'Financeiro', level: 1 });
  };
  const section = () => screen.queryByRole('heading', { name: 'Máquinas habilitadas para execução remota' });

  it('mostra cada máquina com o estado em palavras e diz que o estado não reserva nem autoriza', async () => {
    let items = [
      machine(),
      machine({ workerId: W2, workerName: 'Worker fiscal', agentId: AG2, agentName: 'ESTACAO-02', state: 'INCOMPATIBLE', receiving: 'ENABLED' }),
    ];
    api.on('GET', MACHINES, 'listRemoteMachines', () => ({ status: 200, body: { items } }));
    await open();
    await waitFor(() => expect(section()).toBeInTheDocument());
    const table = screen.getByRole('table', { name: /Máquinas habilitadas para execução remota/ });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]).getByText('Disponível')).toBeInTheDocument();
    expect(within(rows[1]).getByText('ESTACAO-01')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Worker financeiro')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Versão do aplicativo: 0.1.0+client')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Incompatível')).toBeInTheDocument();
    expect(within(rows[2]).getByText(/não executa solicitações da Platform/)).toBeInTheDocument();
    expect(screen.getByText(/não reserva a máquina/)).toBeInTheDocument();
    expect(screen.getByText(/não autoriza\s+nenhuma automação/)).toBeInTheDocument();
    // nesta entrega a tela só mostra: nenhum botão de solicitar execução nesta seção
    expect(within(table).queryByRole('button', { name: /Executar|Solicitar/ })).toBeNull();

    // T01c: as versões de Python são pedidas só no clique, por máquina; só versão e tipo aparecem
    const PY = `/api/v1/o/${ORG}/workspaces/${WS}/remote-machines/${AG1}/python-environments`;
    api.on('GET', PY, 'listRemoteMachinePythonEnvironments', {
      status: 200,
      body: {
        items: [
          { environmentId: 'a'.repeat(43), pythonVersion: '3.13.1', kind: 'VIRTUAL_ENVIRONMENT', observedAt: T, reportedAt: T },
          { environmentId: 'b'.repeat(43), pythonVersion: '3.12.4', kind: 'INSTALLATION', observedAt: T, reportedAt: T },
        ],
      },
    });
    expect(api.sent('GET', /python-environments/)).toEqual([]);
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Ver versões de Python de ESTACAO-01' }));
    const versions = await within(rows[1]).findByRole('list', { name: 'Versões de Python de ESTACAO-01' });
    expect(within(versions).getByText('Python 3.13.1 (ambiente virtual)')).toBeInTheDocument();
    expect(within(versions).getByText('Python 3.12.4 (instalação)')).toBeInTheDocument();
    expect(versions.textContent).not.toContain('a'.repeat(43));
    expect(api.sent('GET', PY)).toHaveLength(1);
    // máquina que ainda não informou nada; e falha de leitura, sem inventar versão
    const PY2 = `/api/v1/o/${ORG}/workspaces/${WS}/remote-machines/${AG2}/python-environments`;
    let fail = true;
    api.on('GET', PY2, 'listRemoteMachinePythonEnvironments', () => (fail ? { status: 503, body: { error: 'service_unavailable' } } : { status: 200, body: { items: [] } }));
    fireEvent.click(within(rows[2]).getByRole('button', { name: 'Ver versões de Python de ESTACAO-02' }));
    expect(await within(rows[2]).findByText('Não foi possível consultar. Tente de novo.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(rows[2]).getByRole('button', { name: 'Ver versões de Python de ESTACAO-02' }));
    expect(await within(rows[2]).findByText(/ainda não informou versões de Python/)).toBeInTheDocument();

    // atualizar relê o servidor
    items = [machine({ state: 'PAUSED', receiving: 'PAUSED' })];
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar estado' }));
    await waitFor(() => expect(screen.getByText('Pausada')).toBeInTheDocument());
    expect(screen.queryByText('ESTACAO-02')).toBeNull();
    expect(api.sent('GET', MACHINES).length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['OFFLINE', 'Offline'],
    ['BUSY', 'Ocupada'],
    ['NO_DISK_SPACE', 'Sem espaço em disco'],
  ])('estado %s aparece como "%s"', async (state, label) => {
    api.on('GET', MACHINES, 'listRemoteMachines', { status: 200, body: { items: [machine({ state, lastHeartbeatAt: state === 'OFFLINE' ? null : T })] } });
    await open();
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('sem máquina habilitada, a seção não aparece', async () => {
    api.on('GET', MACHINES, 'listRemoteMachines', { status: 200, body: { items: [] } });
    await open();
    await waitFor(() => expect(api.sent('GET', MACHINES).length).toBeGreaterThan(0));
    expect(section()).toBeNull();
  });

  it('Platform sem o recurso (404): a seção não aparece e a página segue', async () => {
    api.on('GET', MACHINES, 'listRemoteMachines', { status: 404, body: { error: 'not_found' } });
    await open();
    await waitFor(() => expect(api.sent('GET', MACHINES).length).toBeGreaterThan(0));
    expect(section()).toBeNull();
    expect(screen.getByRole('heading', { name: 'Autorizações de execução local' })).toBeInTheDocument();
  });

  it('sem automation.execute no ambiente de trabalho, a lista nem é pedida', async () => {
    setup(['automation.read']);
    await open();
    await screen.findByRole('heading', { name: 'Autorizações de execução local' });
    expect(api.sent('GET', MACHINES)).toEqual([]);
    expect(section()).toBeNull();
  });

  it('falha de leitura: erro com nova tentativa, sem inventar estado', async () => {
    let fail = true;
    api.on('GET', MACHINES, 'listRemoteMachines', () => (fail ? { status: 503, body: { error: 'service_unavailable' } } : { status: 200, body: { items: [machine()] } }));
    await open();
    await waitFor(() => expect(section()).toBeInTheDocument());
    expect(screen.queryByText('Disponível')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar/ }));
    expect(await screen.findByText('Disponível')).toBeInTheDocument();
  });
});

describe('RELEASE-2.2: Platform sem execução remota e organização aguardando ativação', () => {
  const me = (over: Record<string, unknown> = {}) =>
    api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', { status: 200, body: { ...{ accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' }, ...over } });

  it('Vincular Agent: o Agent disponível vem marcado; o Client fica desabilitado dizendo por quê; o pedido é o de sempre', async () => {
    me();
    api.on('POST', PAIRING, 'createAgentPairingCode', issued());
    await openPairing();
    const agent = within(dialog()).getByRole('radio', { name: /^Nekkora Agent anterior/ }) as HTMLInputElement;
    const client = within(dialog()).getByRole('radio', { name: /^Nekkora Agent Client/ }) as HTMLInputElement;
    expect(agent.checked).toBe(true);
    expect(client.checked).toBe(false);
    expect(client).toBeDisabled();
    expect(within(dialog()).getByText(CLIENT_UNAVAILABLE_DESCRIPTION)).toBeInTheDocument();
    expect(within(dialog()).getByText(AGENT_AVAILABLE_DESCRIPTION)).toBeInTheDocument();
    expect(within(dialog()).queryByLabelText('Habilitar esta máquina para execução remota')).toBeNull();
    await confirm();
    await waitFor(() => expect(pairingPosts()).toHaveLength(1));
    expect(pairingPosts()[0].body).not.toHaveProperty('remoteExecution');
  });

  it('Máquinas: aguardando ativação (modelo anterior), o aviso aparece antes de qualquer tentativa', async () => {
    me({ organizationActivationState: 'AGUARDANDO_ATIVACAO', organizationLicenseModel: 'legacy' });
    renderApp(`/o/${ORG}/workers`);
    await screen.findByRole('heading', { name: 'Máquinas', level: 1 });
    expect(await screen.findByText('Organização aguardando ativação')).toBeInTheDocument();
    expect(screen.getByText(/nenhuma máquina pode ser registrada/)).toBeInTheDocument();
    expect(screen.getByText(/A ativação é feita pela operação da Nekkora/)).toBeInTheDocument();
  });

  it('Máquinas: ativada, ou no modelo por licença, não há aviso de ativação', async () => {
    me({ organizationActivationState: 'ATIVADA', organizationLicenseModel: 'legacy' });
    renderApp(`/o/${ORG}/workers`);
    await screen.findByRole('heading', { name: 'Máquinas', level: 1 });
    await screen.findByRole('button', { name: 'Vincular Agent a Worker financeiro' });
    expect(screen.queryByText('Organização aguardando ativação')).toBeNull();
  });
});
