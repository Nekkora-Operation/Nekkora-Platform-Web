import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';

/**
 * "Executar" nas autorizações de execução local (pedido de execução, 030) quando a máquina do Worker é um Nekkora Agent
 * Client. O Client declara outras capacidades (execução remota) e nunca lê este pedido: a tela diz isso e aponta o fluxo
 * certo, em vez de "Nenhum Agent ativo neste Worker". Respostas por rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const WS = '0b6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const W1 = '11111111-1111-4111-8111-111111111111';
const AG1 = '33333333-3333-4333-8333-333333333333';
const AUT = '55555555-5555-4555-8555-555555555555';
const AUTO = '77777777-7777-4777-8777-777777777777';
const VER = '88888888-8888-4888-8888-888888888888';
const MEMBER = '66666666-6666-4666-8666-666666666666';
const T = '2026-11-10T12:00:00Z';
const AGENTS = new RegExp(`/api/v1/o/${ORG}/agents$`);

let api: RouteApi;

const agent = (over: Record<string, unknown> = {}) => ({
  agentId: AG1,
  name: 'ESTACAO-01',
  installationId: AG1,
  agentVersion: '0.1.0+client',
  status: 'ACTIVE',
  workerId: W1,
  registeredAt: T,
  lastHeartbeatAt: T,
  connectivity: 'CONNECTED',
  contractVersion: '1.0',
  capabilities: ['PY_INVENTORY_1_0', 'REMOTE_RUN_1_0', 'REMOTE_LOGS_1_0', 'REMOTE_RESULTS_1_0'],
  credentialExpiresAt: T,
  endedBy: null,
  ...over,
});

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
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: {
      organizationId: ORG,
      membershipId: MEMBER,
      organization: { roles: ['ORG_ADMIN'], permissions: ['worker.manage', 'agent.manage', 'worker_workspace.authorize'] },
      allWorkspaces: { permissions: ['automation.read', 'automation.execute'] },
      hasWorkspaceAssignments: false,
    },
  });
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/workers`, 'listWorkers', {
    status: 200,
    body: {
      items: [
        {
          workerId: W1,
          name: 'Worker financeiro',
          status: 'ACTIVE',
          agentId: AG1,
          workspaceIds: [WS],
          agentName: 'ESTACAO-01',
          agentStatus: 'ACTIVE',
          agentVersion: '0.1.0+client',
          installationId: AG1,
          lastHeartbeatAt: T,
          connectivity: 'CONNECTED',
          credentialExpiresAt: T,
          createdAt: T,
        },
      ],
    },
  });
  api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}`, 'getWorkspace', {
    status: 200,
    body: { workspaceId: WS, name: 'Financeiro', description: null, status: 'active', client: null, createdAt: T, updatedAt: T },
  });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workspaces/${WS}/automations`), 'listAutomations', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/remote-machines`, 'listRemoteMachines', { status: 200, body: { items: [] } });
  api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/local-run-authorizations`, 'listLocalRunAuthorizations', {
    status: 200,
    body: {
      items: [
        {
          authorizationId: AUT,
          workspaceId: WS,
          workerId: W1,
          automationId: AUTO,
          automationVersionId: VER,
          packageFingerprint: 'a'.repeat(64),
          grantedAt: T,
          validUntil: new Date(Date.now() + 86_400_000).toISOString(),
          revokedAt: null,
          sourceKind: 'EXTERNAL_PACKAGE',
          packageFingerprintRule: 'nekkora-agent/external-python-fingerprint/1',
        },
      ],
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const dialog = () => screen.getByRole('alertdialog');

async function openExecutar() {
  renderApp(`/o/${ORG}/workspaces/${WS}`);
  await screen.findByRole('heading', { name: 'Financeiro', level: 1 });
  await waitFor(() => expect(api.sent('GET', AGENTS).length).toBeGreaterThan(0));
  fireEvent.click(await screen.findByRole('button', { name: 'Executar na máquina do Worker Worker financeiro' }));
  await screen.findByRole('alertdialog');
}

describe('"Executar" com a máquina do Worker sendo um Nekkora Agent Client', () => {
  it('a lista com as capacidades do Client é aceita e o diálogo diz o impedimento real, apontando a execução remota', async () => {
    api.on('GET', AGENTS, 'listAgents', { status: 200, body: { items: [agent()] } });
    await openExecutar();
    const d = within(dialog());
    expect(d.getByText(/ESTACAO-01\) está ativa, mas usa o Nekkora Agent Client, que não recebe este tipo de pedido/)).toBeInTheDocument();
    expect(d.getByText(/o vínculo e as autorizações continuam valendo/)).toBeInTheDocument();
    expect(d.getByRole('link', { name: 'na página da versão' })).toHaveAttribute('href', expect.stringContaining(VER));
    expect(d.queryByText('Nenhum Agent ativo neste Worker')).toBeNull();
    expect(d.getByRole('button', { name: 'Pedir execução' })).toBeDisabled();
    expect(api.sent('POST', /run-requests/)).toEqual([]);
  });

  it('máquina que declara o pedido de execução (Agent anterior) continua sendo oferecida', async () => {
    api.on('GET', AGENTS, 'listAgents', {
      status: 200,
      body: { items: [agent({ agentVersion: '0.1.0', capabilities: ['RUN_LOCAL', 'OBS_1_0', 'SUPERVISOR_REPORT_1_0', 'EXTERNAL_PYTHON_1_0', 'RUN_REQUEST_1_0'] })] },
    });
    await openExecutar();
    const d = within(dialog());
    expect(d.queryByText(/não recebe este tipo de pedido/)).toBeNull();
    expect(d.getByRole('option', { name: 'ESTACAO-01 (conectado)' })).toBeInTheDocument();
  });

  it('sem máquina ativa no Worker, o texto continua sendo o de sempre', async () => {
    api.on('GET', AGENTS, 'listAgents', { status: 200, body: { items: [agent({ status: 'REVOKED', workerId: null, endedBy: 'ADMINISTRATION' })] } });
    await openExecutar();
    const d = within(dialog());
    expect(d.getByText('Nenhum Agent ativo neste Worker')).toBeInTheDocument();
    expect(d.queryByText(/não recebe este tipo de pedido/)).toBeNull();
  });

  it('lista de máquinas que não pôde ser lida não vira "nenhum Agent"', async () => {
    api.on('GET', AGENTS, 'listAgents', { status: 503, body: { error: 'service_unavailable' } });
    await openExecutar();
    const d = within(dialog());
    expect(d.getByText(/Não foi possível ler as máquinas da organização agora/)).toBeInTheDocument();
    expect(d.queryByText('Nenhum Agent ativo neste Worker')).toBeNull();
    expect(d.getByRole('button', { name: 'Pedir execução' })).toBeDisabled();
  });
});
