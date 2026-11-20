import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';

/**
 * PLATFORM-FLUXO-002 — as autorizações de execução e de monitoramento deixam de ser criadas à mão nas páginas da automação e
 * da versão: a ativação (Administração › Licenças e automações) as emite. As páginas continuam LISTANDO as autorizações, com
 * a validade, "Executar" (pedido ao Agent anterior) e "Revogar", e dizem onde a ativação é feita. A regra de uma vigente por
 * escopo (033) continua no servidor (AutorizacaoVigenteUnicaIT). Respostas por rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const WS = '5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f';
const AUT = '7f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const V1 = '11111111-2222-4333-8444-555555555555';
const W1 = '21111111-2222-4333-8444-555555555555';
const W2 = '31111111-2222-4333-8444-555555555555';
const A1 = '41111111-2222-4333-8444-555555555555';
const T = '2026-11-10T12:00:00Z';
const LIST = `/api/v1/o/${ORG}/workspaces/${WS}/local-run-authorizations`;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

type Auth = Record<string, unknown>;
const monitor = (over: Auth = {}): Auth => ({
  authorizationId: A1,
  workspaceId: WS,
  workerId: W1,
  automationId: AUT,
  automationVersionId: null,
  packageFingerprint: null,
  packageFingerprintRule: null,
  sourceKind: 'EXTERNAL_MONITORED',
  grantedAt: T,
  validUntil: future(20),
  revokedAt: null,
  ...over,
});

let api: RouteApi;
let authorizations: Auth[];
const worker = (id: string, name: string) => ({
  workerId: id,
  name,
  status: 'ACTIVE',
  agentId: null,
  agentName: null,
  agentStatus: null,
  agentVersion: null,
  installationId: null,
  lastHeartbeatAt: null,
  connectivity: null,
  credentialExpiresAt: null,
  workspaceIds: [WS],
});

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  csrfStore.clear();
  sessionMemory.reset();
  vi.unstubAllGlobals();
  localStorage.clear();
  const locks = fakeLocks();
  setOperationRegistryForTest(createOperationRegistry({ storage: () => localStorage, locks: () => locks, now: () => Date.now() }));
  authorizations = [];
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
      membershipId: V1,
      organization: { roles: ['ORG_ADMIN'], permissions: ['org.manage', 'worker.manage'] },
      allWorkspaces: { permissions: ['automation.read', 'automation.execute', 'automation.manage', 'automation.publish'] },
      hasWorkspaceAssignments: false,
    },
  });
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/automations/${AUT}`, 'getAutomation', {
    status: 200,
    body: { automationId: AUT, workspaceId: WS, name: 'Relatório de pedidos', description: null, status: 'active', latestPublishedVersion: null, createdAt: T, updatedAt: T },
  });
  api.on('GET', `/api/v1/o/${ORG}/automations/${AUT}/versions`, 'listAutomationVersions', {
    status: 200,
    body: { items: [{ automationVersionId: V1, versionNumber: 1, status: 'published', publishedAt: T, createdAt: T }], nextCursor: null },
  });
  api.on('GET', LIST, 'listLocalRunAuthorizations', () => ({ status: 200, body: { items: authorizations } }));
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/agents`), 'listAgents', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workers`), 'listWorkers', { status: 200, body: { items: [worker(W1, 'Estação fiscal'), worker(W2, 'Estação 2')] } });
});
afterEach(() => vi.unstubAllGlobals());

const posts = () => api.sent('POST', LIST);

async function openAutomation() {
  renderApp(`/o/${ORG}/automacoes/${AUT}`);
  await screen.findByRole('heading', { name: 'Relatório de pedidos' });
  await screen.findByRole('heading', { name: 'Monitoramento de Python externo' });
}

describe('FLUXO-002: sem criação manual de autorizações', () => {
  it('automação: não oferece "Autorizar monitoramento"; diz que a ativação libera e leva a Licenças e automações', async () => {
    authorizations = [monitor()];
    await openAutomation();
    expect(await screen.findByText('O monitoramento é liberado pela ativação da automação.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Autorizar monitoramento' })).toBeNull();
    expect(screen.queryByLabelText(/Worker autorizado neste ambiente de trabalho/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Abrir Licenças e automações' })).toHaveAttribute('href', `/o/${ORG}/administracao/licencas`);
    // a lista continua: a vigente aparece com a validade e pode ser revogada
    const list = await screen.findByRole('region', { name: 'Autorizações de execução local' });
    expect(within(list).getByText('Vigente')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /Revogar/ })).toBeInTheDocument();
    // o identificador para o comando vincular do Agent continua à vista
    expect(screen.getByText(AUT)).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('quem não administra a organização: o aviso fica, sem o atalho para uma página que não pode abrir', async () => {
    api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
      status: 200,
      body: {
        organizationId: ORG,
        membershipId: V1,
        organization: { roles: [], permissions: [] },
        allWorkspaces: { permissions: ['automation.read', 'automation.execute'] },
        hasWorkspaceAssignments: false,
      },
    });
    authorizations = [monitor()];
    await openAutomation();
    expect(await screen.findByText('O monitoramento é liberado pela ativação da automação.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Abrir Licenças e automações' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Autorizar monitoramento' })).toBeNull();
  });
});
