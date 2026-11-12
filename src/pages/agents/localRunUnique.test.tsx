import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';

/**
 * PLATFORM-AGENT-V2-003, T12 — uma autorização VIGENTE por escopo (API 033). Na automação (monitoramento) e na versão
 * (pacote): com uma vigente para o Worker escolhido, a tela mostra a atual e a validade e não oferece criar outra
 * equivalente; revogada ou vencida não impede; outro Worker continua autorizável; a recusa do servidor (409
 * local_run_authorization_exists, por exemplo de outra aba) diz que nada foi criado e relê a lista, sem presumir quem a
 * criou. Respostas por rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const WS = '5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f';
const AUT = '7f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const V1 = '11111111-2222-4333-8444-555555555555';
const W1 = '21111111-2222-4333-8444-555555555555';
const W2 = '31111111-2222-4333-8444-555555555555';
const A1 = '41111111-2222-4333-8444-555555555555';
const T = '2026-11-10T12:00:00Z';
const FP = 'c'.repeat(64);
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
const pkg = (over: Auth = {}): Auth => ({
  ...monitor(),
  automationVersionId: V1,
  packageFingerprint: FP,
  packageFingerprintRule: 'nekkora-agent/package-fingerprint/1',
  sourceKind: 'STUDIO_PACKAGE',
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
const button = () => screen.getByRole('button', { name: 'Autorizar monitoramento' });

async function openAutomation() {
  renderApp(`/o/${ORG}/automacoes/${AUT}`);
  await screen.findByRole('heading', { name: 'Relatório de pedidos' });
  await screen.findByRole('heading', { name: 'Monitoramento de Python externo' });
}
async function chooseWorker(id: string) {
  const select = (await screen.findByLabelText('Worker autorizado neste workspace')) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: id } });
  return select;
}

describe('T12: uma autorização vigente por escopo (monitoramento)', () => {
  it('com vigente para o Worker: mostra a atual e a validade, não oferece outra; outro Worker continua autorizável', async () => {
    authorizations = [monitor()];
    await openAutomation();
    const select = await chooseWorker(W1);
    await waitFor(() => expect(screen.getByText('Já autorizado')).toBeInTheDocument());
    expect(screen.getByText(/Este Worker já tem uma autorização vigente para o monitoramento desta automação, válida até/)).toBeInTheDocument();
    expect(button()).toBeDisabled();
    // a opção do Worker diz que ele já está autorizado e até quando
    expect(within(select).getByRole('option', { name: /Estação fiscal \(já autorizado até \d{2}\/\d{2}\/\d{4}\)/ })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Estação 2' })).toBeInTheDocument();
    // outro Worker: sem vigente, pode autorizar
    await chooseWorker(W2);
    expect(screen.queryByText('Já autorizado')).not.toBeInTheDocument();
    expect(button()).toBeEnabled();
    expect(posts()).toHaveLength(0);
  });

  it('revogada ou vencida não impede uma nova', async () => {
    authorizations = [monitor({ revokedAt: T }), monitor({ authorizationId: V1, validUntil: '2026-01-01T00:00:00Z', grantedAt: '2025-12-01T00:00:00Z' })];
    await openAutomation();
    await chooseWorker(W1);
    await waitFor(() => expect(button()).toBeEnabled());
    expect(screen.queryByText('Já autorizado')).not.toBeInTheDocument();
  });

  it('autorização criada em outra aba: o servidor recusa (409), a tela diz que nada foi criado e relê a lista', async () => {
    let created = false;
    api.on('POST', LIST, 'createLocalRunAuthorization', () => {
      // outra aba já criou a vigente: a partir daqui a lista também a mostra
      authorizations = [monitor()];
      created = true;
      return { status: 409, body: { error: 'conflict', reason: 'local_run_authorization_exists' } };
    });
    await openAutomation();
    await chooseWorker(W1);
    await waitFor(() => expect(button()).toBeEnabled());
    const listReads = api.sent('GET', LIST).length;
    fireEvent.click(button());
    const dialog = await screen.findByRole('alertdialog');
    // o registro da operação (proteção contra repetição) é lido ao abrir: só então a confirmação libera
    const confirm = within(dialog).getByRole('button', { name: 'Autorizar monitoramento' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await within(dialog).findByText(/Este Worker já tem uma autorização vigente para o monitoramento desta automação\. Nada foi criado/)).toBeInTheDocument();
    expect(created).toBe(true);
    expect(posts()).toHaveLength(1);
    // releitura: a vigente aparece e o formulário deixa de oferecer outra
    await waitFor(() => expect(api.sent('GET', LIST).length).toBeGreaterThan(listReads));
    fireEvent.click(within(dialog).getByRole('button', { name: /Cancelar/ }));
    await waitFor(() => expect(screen.getByText('Já autorizado')).toBeInTheDocument());
    expect(button()).toBeDisabled();
    expect(posts()).toHaveLength(1);
  });

  it('sem conseguir ler as autorizações atuais, não oferece criar', async () => {
    api.on('GET', LIST, 'listLocalRunAuthorizations', { status: 503, body: { error: 'service_unavailable' } });
    await openAutomation();
    await chooseWorker(W1);
    expect(await screen.findByText('Não foi possível conferir as autorizações atuais. Tente carregar a lista de novo antes de autorizar.')).toBeInTheDocument();
    expect(button()).toBeDisabled();
  });
});

describe('T12: uma autorização vigente por escopo (versão)', () => {
  const V2 = '51111111-2222-4333-8444-555555555555';
  beforeEach(() => {
    api.on('GET', new RegExp(`/api/v1/o/${ORG}/automation-versions/${V1}$`), 'getAutomationVersion', {
      status: 200,
      body: {
        automationVersionId: V1,
        automationId: AUT,
        workspaceId: WS,
        versionNumber: 1,
        status: 'PUBLISHED',
        runtime: 'python3.12',
        entrypoint: 'main.py',
        arguments: [],
        artifactReference: `nekkora-artifact:${V1}`,
        artifact: {
          artifactId: V1,
          sha256: 'a'.repeat(64),
          sizeBytes: 11,
          fingerprintRule: 'nekkora-agent/package-fingerprint/1',
          fingerprint: FP,
          filesCount: 7,
          manifestVersion: '1.4',
          framework: 'nekkora_rpa',
          executionMode: 'list',
          declaredGenerator: null,
          provenance: 'DECLARED',
          receivedAt: T,
          packageKind: 'STUDIO_PYTHON',
        },
        agentPackage: { fingerprintRule: 'nekkora-agent/package-fingerprint/1', fingerprint: FP },
        createdAt: T,
        publishedAt: T,
        publishedByMembershipId: V1,
      },
    });
  });

  it('a vigente de OUTRA versão não impede', async () => {
    authorizations = [pkg({ automationVersionId: V2, authorizationId: V2 })];
    renderApp(`/o/${ORG}/versoes/${V1}`);
    const authorize = await screen.findByRole('button', { name: 'Autorizar execução local' });
    await chooseWorker(W1);
    await waitFor(() => expect(authorize).toBeEnabled());
    expect(screen.queryByText('Já autorizado')).not.toBeInTheDocument();
  });

  it('a vigente DESTA versão para o Worker: mostra a atual e não oferece outra', async () => {
    authorizations = [pkg()];
    renderApp(`/o/${ORG}/versoes/${V1}`);
    const authorize = await screen.findByRole('button', { name: 'Autorizar execução local' });
    await chooseWorker(W1);
    await waitFor(() => expect(screen.getByText('Já autorizado')).toBeInTheDocument());
    expect(screen.getByText(/Este Worker já tem uma autorização vigente para esta versão, válida até/)).toBeInTheDocument();
    expect(authorize).toBeDisabled();
    expect(posts()).toHaveLength(0);
  });
});
