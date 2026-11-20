import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { ApiError } from '../../api/http';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { CAPACITY_TEXT, MODEL_TEXT } from './LicensesPage';
import { STATE_TEXT } from './ActivationSection';
import { RESPONSIBLE_TEXT } from './OrganizationRequestsPage';
import { CAPACITY_PENDING_TEXT, licenseRefusalText, reducedValidityText } from './texts';

/**
 * PLATFORM-LICENCIAMENTO-001 — tela do administrador: licenças e, SEPARADA, a capacidade técnica; vínculo de uma licença
 * disponível a uma automação; pedidos de criação de organização com a escolha do responsável; e o aviso de validade
 * reduzida. Testes de componente ISOLADOS: as respostas por rota são conferidas contra o contrato; o comportamento real é
 * conferido no laboratório.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const WS = '5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f';
const AUT = '7f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const AUT2 = '8f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const L1 = '11111111-2222-4333-8444-555555555555';
const L2 = '21111111-2222-4333-8444-555555555555';
const M1 = '31111111-2222-4333-8444-555555555555';
const R1 = '41111111-2222-4333-8444-555555555555';
const NEW_ORG = '51111111-2222-4333-8444-555555555555';
const T = '2026-11-10T12:00:00Z';
const END = '2026-12-10T12:00:00Z';
const base = `/api/v1/o/${ORG}`;

let api: RouteApi;

const license = (over: Record<string, unknown> = {}) => ({
  licenseId: L1,
  number: 1,
  status: 'active',
  validFrom: T,
  validUntil: END,
  nextPeriodStartsAt: null,
  renewals: 0,
  automation: null,
  ...over,
});
const assigned = { automationId: AUT, name: 'Notas de entrada', status: 'active', workspaceId: WS, workspaceName: 'Fiscal', assignedAt: T, executionInProgress: true };
const summary = (over: Record<string, unknown> = {}) => ({
  model: 'licensed',
  modelSince: T,
  contracted: 2,
  used: 1,
  available: 1,
  licensedAutomations: 1,
  expiredWithAutomation: 0,
  asOf: T,
  ...over,
});
const capacity = (over: Record<string, unknown> = {}) => ({
  model: 'licensed',
  workers: { used: 3, limit: 50 },
  concurrentExecutions: { used: 5, limit: 5, active: 3, reservedUncertain: 2, breakdown: { remote: 2, unconfirmed: 1, platform: 0, previousAgent: 1, previousAgentUnconfirmed: 1 } },
  pendingExecutions: { used: 2, limit: 50 },
  asOf: T,
  ...over,
});
const automation = (id: string, name: string) => ({
  automationId: id,
  workspaceId: WS,
  workspaceName: 'Fiscal',
  name,
  description: null,
  status: 'active',
  latestPublishedVersion: null,
  lastExecution: null,
});

const AUT3 = '9f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const WK1 = '61111111-2222-4333-8444-555555555555';
const WK2 = '71111111-2222-4333-8444-555555555555';
const V1 = '81111111-2222-4333-8444-555555555555';
const V2 = '91111111-2222-4333-8444-555555555555';
const activation = (over: Record<string, unknown> = {}) => ({
  automationId: AUT,
  name: 'Notas de entrada',
  automationStatus: 'active',
  workspaceId: WS,
  workspaceName: 'Fiscal',
  state: 'ACTIVE',
  pending: [],
  license: { licenseId: L1, number: 1, assignedAt: T, lastPeriodEndsAt: END, state: 'OK', coverageUntil: END },
  currentVersion: { versionId: V1, number: 1, publishedAt: T },
  acceptedVersion: { versionId: V1, number: 1, publishedAt: T },
  workers: [
    {
      workerId: WK1,
      name: 'Estação 1',
      computerName: 'NOTE-FISCAL-01',
      lastContactAt: T,
      machineState: 'CONNECTED',
      execution: { authorizationId: L1, automationVersionId: V1, validUntil: END, status: 'active' },
      monitoring: { authorizationId: L2, automationVersionId: null, validUntil: END, status: 'active' },
    },
  ],
  ...over,
});
const activations = (items: unknown[]) => ({ model: 'licensed', licenses: { contracted: 2, used: 1, available: 1 }, items, asOf: T });
const options = (over: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  workspaceName: 'Fiscal',
  model: 'licensed',
  licenses: { contracted: 2, used: 1, available: 1 },
  nextLicense: { licenseId: L2, number: 2, validUntil: END },
  automations: [
    { automationId: AUT, name: 'Notas de entrada', licensed: true, state: 'ACTIVE', currentVersion: { versionId: V1, number: 1, publishedAt: T }, workerIds: [WK1] },
    { automationId: AUT2, name: 'Notas de saída', licensed: false, state: 'LICENSE_REQUIRED', currentVersion: { versionId: V2, number: 2, publishedAt: T }, workerIds: [] },
    { automationId: AUT3, name: 'Sem versão', licensed: false, state: 'LICENSE_REQUIRED', currentVersion: null, workerIds: [] },
  ],
  workers: [
    { workerId: WK1, name: 'Estação 1', computerName: 'NOTE-FISCAL-01', lastContactAt: T, machineState: 'CONNECTED' },
    { workerId: WK2, name: 'Estação 2', computerName: null, lastContactAt: null, machineState: 'REGISTERED' },
  ],
  ...over,
});
const outcome = (results: unknown[], act: unknown, consumed = true) => ({ licenseConsumedNow: consumed, results, activation: act });

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
  api.on('GET', `${base}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' },
  });
  api.on('GET', `${base}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: {
      organizationId: ORG,
      membershipId: M1,
      organization: { roles: ['ORG_ADMIN'], permissions: ['org.manage', 'worker.manage'] },
      allWorkspaces: { permissions: ['automation.read'] },
      hasWorkspaceAssignments: false,
    },
  });
  api.on('GET', `${base}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`${base}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `${base}/licenses/summary`, 'getLicenseSummary', { status: 200, body: summary() });
  api.on('GET', `${base}/licenses`, 'listOrganizationLicenses', {
    status: 200,
    body: { items: [license({ automation: assigned }), license({ licenseId: L2, number: 2 })], nextCursor: null, asOf: T },
  });
  api.on('GET', `${base}/capacity`, 'getOrganizationCapacity', { status: 200, body: capacity() });
  api.on('GET', `${base}/automation-activations`, 'listAutomationActivations', { status: 200, body: activations([activation()]) });
  api.on('GET', new RegExp(`${base}/automation-activations/options`), 'getAutomationActivationOptions', { status: 200, body: options() });
  api.on('GET', new RegExp(`${base}/workspaces`), 'listWorkspaces', {
    status: 200,
    body: { items: [{ workspaceId: WS, name: 'Fiscal', description: null, status: 'active', client: null, createdAt: T, updatedAt: T }], nextCursor: null },
  });
  api.on('GET', `${base}/automations`, 'listOrganizationAutomations', {
    status: 200,
    body: { items: [automation(AUT, 'Notas de entrada'), automation(AUT2, 'Notas de saída')], nextCursor: null },
  });
});

describe('Licenças e automações', () => {
  it('mostra a conta das licenças e, em seção separada, a capacidade com a composição da ocupação', async () => {
    renderApp(`/o/${ORG}/administracao/licencas`);
    const licenses = (await screen.findByRole('heading', { name: 'Licenças' })).closest('section')!;
    const cap = screen.getByRole('heading', { name: 'Capacidade' }).closest('section')!;
    expect(licenses).not.toBe(cap);
    expect(within(licenses).getByText(MODEL_TEXT.licensed.title)).toBeInTheDocument();
    const count = within(licenses).getByRole('group', { name: 'Conta das licenças' });
    expect(count.textContent).toMatch(/Contratadas \(vigentes\)2/);
    expect(count.textContent).toMatch(/Utilizadas \(com automação\)1/);
    expect(count.textContent).toMatch(/Disponíveis \(sem automação\)1/);
    const list = screen.getByRole('region', { name: 'Lista de licenças' });
    expect(within(list).getByText('Notas de entrada')).toBeInTheDocument();
    expect(within(list).getByText(/com execução em andamento agora/)).toBeInTheDocument();
    expect(within(list).getByText('Disponível (sem automação)')).toBeInTheDocument();
    // capacidade: nunca dentro da conta de licenças, e dita como coisa diferente
    expect(within(cap).getByText(CAPACITY_TEXT.intro)).toBeInTheDocument();
    const usage = within(cap).getByRole('group', { name: 'Capacidade técnica' });
    expect(usage.textContent).toMatch(/Máquinas cadastradas3 de 50/);
    expect(usage.textContent).toMatch(/Execuções simultâneas5 de 5/);
    // execuções ATIVAS e RESERVAS por situação incerta aparecem separadas
    expect(usage.textContent).toMatch(/Em execução: 3 \(2 pelo Agent Client · 1 pelo Agent anterior\)/);
    expect(usage.textContent).toMatch(/Reservadas por situação incerta: 2 \(1 com término não confirmado pela máquina \(Agent Client\) · 1 com resultado desconhecido \(Agent anterior\)\)/);
    expect(within(cap).getByText(CAPACITY_TEXT.previousAgentUnconfirmed)).toBeInTheDocument();
    expect(within(cap).getByText(CAPACITY_TEXT.concurrentFull)).toBeInTheDocument();
    expect(usage.textContent).toMatch(/Execuções pendentes \(na fila\)2 de 50/);
    expect(within(licenses).queryByText(/Máquinas cadastradas/)).toBeNull();
    // o vínculo avulso por licença saiu da tela (a ativação o faz)
    expect(screen.queryByRole('button', { name: /Vincular/ })).toBeNull();
  });

  it('organização que ainda não exige licença: diz isso, e a capacidade é a da ativação', async () => {
    api.on('GET', `${base}/licenses/summary`, 'getLicenseSummary', { status: 200, body: summary({ model: 'legacy', modelSince: null }) });
    api.on('GET', `${base}/capacity`, 'getOrganizationCapacity', {
      status: 200,
      body: capacity({
        model: 'legacy',
        workers: { used: 1, limit: null },
        concurrentExecutions: { used: 0, limit: null, active: 0, reservedUncertain: 0, breakdown: { remote: 0, unconfirmed: 0, platform: 0, previousAgent: 0, previousAgentUnconfirmed: 0 } },
        pendingExecutions: { used: 0, limit: null },
      }),
    });
    renderApp(`/o/${ORG}/administracao/licencas`);
    expect(await screen.findByText(MODEL_TEXT.legacy.title)).toBeInTheDocument();
    expect(screen.getByText(CAPACITY_TEXT.legacy)).toBeInTheDocument();
  });

  it('licença vencida ainda vinculada: avisa o que para e o que continua', async () => {
    api.on('GET', `${base}/licenses/summary`, 'getLicenseSummary', { status: 200, body: summary({ contracted: 0, used: 0, available: 0, expiredWithAutomation: 1 }) });
    api.on('GET', `${base}/licenses`, 'listOrganizationLicenses', {
      status: 200,
      body: { items: [license({ status: 'expired', automation: assigned })], nextCursor: null, asOf: T },
    });
    renderApp(`/o/${ORG}/administracao/licencas`);
    expect(await screen.findByText('Uma licença vencida continua vinculada a uma automação.')).toBeInTheDocument();
    expect(screen.getByText(/não iniciam trabalho novo até a renovação\. O que já estava em execução termina e entrega/)).toBeInTheDocument();
    expect(screen.getByText('Vencida')).toBeInTheDocument();
  });

  it('licença disponível: a conta diz qual está livre e qual automação usa cada licença, e a tela aponta "Ativar automação"', async () => {
    renderApp(`/o/${ORG}/administracao/licencas`);
    expect(await screen.findByText('Você tem 1 licença disponível.')).toBeInTheDocument();
    expect(screen.getByText(/use “Ativar automação” logo abaixo/)).toBeInTheDocument();
    const count = screen.getByRole('group', { name: 'Conta das licenças' });
    expect(count.textContent).toMatch(/Utilizadas \(com automação\)1nº 1: Notas de entrada/);
    expect(count.textContent).toMatch(/Disponíveis \(sem automação\)1nº 2/);
    // o vínculo avulso por licença saiu: a ativação é o caminho
    expect(screen.queryByRole('button', { name: /Vincular/ })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Ativar automação' })).toBeInTheDocument();
  });

  it('sem licença disponível: a tela não aponta licença livre', async () => {
    api.on('GET', `${base}/licenses/summary`, 'getLicenseSummary', { status: 200, body: summary({ contracted: 1, used: 1, available: 0 }) });
    api.on('GET', `${base}/licenses`, 'listOrganizationLicenses', { status: 200, body: { items: [license({ automation: assigned })], nextCursor: null, asOf: T } });
    renderApp(`/o/${ORG}/administracao/licencas`);
    await screen.findByRole('group', { name: 'Conta das licenças' });
    expect(screen.queryByText(/Você tem .* disponíve/)).toBeNull();
    expect(screen.getByRole('group', { name: 'Conta das licenças' }).textContent).toMatch(/Disponíveis \(sem automação\)0$/);
  });

  it('automações atendidas: ambiente, licença e validade, máquinas com execução e monitoramento, versão aceita e situação', async () => {
    renderApp(`/o/${ORG}/administracao/licencas`);
    const region = await screen.findByRole('region', { name: 'Lista de automações atendidas' });
    const row = within(region).getAllByRole('row')[1];
    expect(row).toHaveTextContent('Notas de entrada');
    expect(row).toHaveTextContent('Fiscal');
    expect(row).toHaveTextContent('nº 1');
    expect(row).toHaveTextContent(/Estação 1 \(computador NOTE-FISCAL-01\): execução até .*; monitoramento até/);
    expect(within(row).getByText('Conectada')).toBeInTheDocument();
    expect(row).toHaveTextContent('versão 1');
    expect(within(row).getByText(STATE_TEXT.ACTIVE.label)).toBeInTheDocument();
  });

  it('ativar: ambiente → automação → máquinas (nenhum marcado) → conferir licença, versão e máquinas → "Ativar execução e monitoramento"', async () => {
    api.on('POST', `${base}/automation-activations`, 'activateAutomation', {
      status: 200,
      body: outcome([{ workerId: WK1, kind: 'execution', automationVersionId: V2, outcome: 'issued', authorizationId: L1, validUntil: END }, { workerId: WK1, kind: 'monitoring', automationVersionId: null, outcome: 'issued', authorizationId: L2, validUntil: END }], activation({ automationId: AUT2, name: 'Notas de saída' })),
    });
    renderApp(`/o/${ORG}/administracao/licencas`);
    fireEvent.click(await screen.findByRole('button', { name: 'Ativar automação' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Ativar execução e monitoramento' });
    expect(confirm).toBeDisabled();
    fireEvent.change(await within(dialog).findByLabelText('1. Ambiente de trabalho'), { target: { value: WS } });
    fireEvent.change(await within(dialog).findByLabelText('2. Automação'), { target: { value: AUT2 } });
    // nenhum Worker vem marcado
    // a máquina pelo nome amigável e o computador vinculado, com o estado; cadastrar ou conectar não consome licença
    const w1 = await within(dialog).findByRole('checkbox', { name: 'Estação 1 (computador NOTE-FISCAL-01)' });
    expect(within(dialog).getByText('Conectada')).toBeInTheDocument();
    expect(within(dialog).getByText('Cadastrada')).toBeInTheDocument();
    expect(within(dialog).getByText(/Cadastrar ou conectar uma máquina não consome licença/)).toBeInTheDocument();
    expect(w1).not.toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Estação 2' })).not.toBeChecked();
    const review = within(dialog).getByRole('region', { name: 'Conferência da ativação' });
    expect(review).toHaveTextContent(/Máquinas: nenhuma escolhida. A ativação fica com “Configuração pendente”/);
    expect(review).toHaveTextContent(/será usada a licença nº 2, válida até/);
    expect(review).toHaveTextContent(/Versão publicada atual: versão 2. Versões futuras não são autorizadas sozinhas/);
    fireEvent.click(w1);
    expect(review).toHaveTextContent('Máquinas: Estação 1 (computador NOTE-FISCAL-01)');
    await waitFor(() => expect(confirm).toBeEnabled());
    const readsBefore = api.sent('GET', `${base}/licenses/summary`).length;
    fireEvent.click(confirm);
    expect(await screen.findByText('Uma licença foi vinculada a esta automação.')).toBeInTheDocument();
    expect(screen.getByText('2 autorização(ões) emitida(s).')).toBeInTheDocument();
    expect(api.sent('POST', `${base}/automation-activations`)[0]).toMatchObject({ body: { automationId: AUT2, workerIds: [WK1] } });
    // a página se atualiza depois do ato SEM voltar ao "carregando": o resumo do resultado continua à vista
    await waitFor(() => expect(api.sent('GET', `${base}/licenses/summary`).length).toBeGreaterThan(readsBefore));
    await screen.findByRole('group', { name: 'Conta das licenças' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Carregando licenças e automações…')).toBeNull();
    expect(screen.getByText('Uma licença foi vinculada a esta automação.')).toBeInTheDocument();
  });

  it('sem saldo: o impedimento aparece antes da confirmação e nada é enviado', async () => {
    api.on('GET', new RegExp(`${base}/automation-activations/options`), 'getAutomationActivationOptions', { status: 200, body: options({ nextLicense: null }) });
    renderApp(`/o/${ORG}/administracao/licencas`);
    fireEvent.click(await screen.findByRole('button', { name: 'Ativar automação' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(await within(dialog).findByLabelText('1. Ambiente de trabalho'), { target: { value: WS } });
    fireEvent.change(await within(dialog).findByLabelText('2. Automação'), { target: { value: AUT2 } });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Estação 1 (computador NOTE-FISCAL-01)' }));
    expect(within(dialog).getByText('Não há licença disponível para ativar esta automação.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Ativar execução e monitoramento' })).toBeDisabled();
    expect(api.sent('POST', `${base}/automation-activations`)).toHaveLength(0);
  });

  it('o que falhou fica dito exatamente, e concluir não consome outra licença', async () => {
    api.on('POST', `${base}/automation-activations`, 'activateAutomation', {
      status: 200,
      body: outcome(
        [
          { workerId: WK1, kind: 'execution', automationVersionId: V2, outcome: 'issued', authorizationId: L1, validUntil: END },
          { workerId: WK1, kind: 'monitoring', automationVersionId: null, outcome: 'failed', reason: 'conflict' },
        ],
        activation({ automationId: AUT2, name: 'Notas de saída', state: 'CONFIGURATION_PENDING', pending: ['WORKER_WITHOUT_MONITORING'] }),
      ),
    });
    renderApp(`/o/${ORG}/administracao/licencas`);
    fireEvent.click(await screen.findByRole('button', { name: 'Ativar automação' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(await within(dialog).findByLabelText('1. Ambiente de trabalho'), { target: { value: WS } });
    fireEvent.change(await within(dialog).findByLabelText('2. Automação'), { target: { value: AUT2 } });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Estação 1 (computador NOTE-FISCAL-01)' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ativar execução e monitoramento' }));
    const pending = await screen.findByRole('list', { name: 'O que ficou pendente' });
    expect(pending).toHaveTextContent('monitoramento em Estação 1 (computador NOTE-FISCAL-01): a máquina, a versão ou o ambiente de trabalho mudou');
    expect(screen.getByText(/Concluir não consome outra licença/)).toBeInTheDocument();
  });

  it('gerenciar: licença renovada → "Renovar autorizações" com as mesmas máquinas e a versão aceita; versão nova só por aceite', async () => {
    api.on('GET', `${base}/automation-activations`, 'listAutomationActivations', {
      status: 200,
      body: activations([activation({ state: 'RENEWAL_AVAILABLE', pending: ['NEW_VERSION_AVAILABLE', 'RENEWAL_AVAILABLE'], currentVersion: { versionId: V2, number: 2, publishedAt: T } })]),
    });
    api.on('POST', `${base}/automation-activations/${AUT}/renewal`, 'renewAutomationActivation', { status: 200, body: outcome([], activation()) });
    api.on('POST', `${base}/automation-activations/${AUT}/version`, 'acceptAutomationActivationVersion', { status: 200, body: outcome([], activation()) });
    renderApp(`/o/${ORG}/administracao/licencas`);
    const region = await screen.findByRole('region', { name: 'Lista de automações atendidas' });
    expect(within(region).getByText(/A licença foi renovada: renove as autorizações/)).toBeInTheDocument();
    expect(within(region).getByText(/Há uma versão publicada mais nova \(versão 2\). Ela só executa depois de aceita./)).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: 'Renovar autorizações de Notas de entrada' }));
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/Licença renovada até .* para as mesmas máquinas e a versão já aceita \(versão 1\): Estação 1/);
    expect(dialog).toHaveTextContent(/Não inclui máquinas novas nem autorizações retiradas por alguém, não troca para uma versão mais nova/);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Renovar autorizações' }));
    await waitFor(() => expect(api.sent('POST', `${base}/automation-activations/${AUT}/renewal`)).toHaveLength(1));
    fireEvent.click(await within(await screen.findByRole('region', { name: 'Lista de automações atendidas' })).findByRole('button', { name: 'Aceitar a versão nova de Notas de entrada' }));
    dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/A versão 2 passa a poder executar nas máquinas desta ativação: Estação 1. O monitoramento já autorizado continua valendo/);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Aceitar versão' }));
    await waitFor(() => expect(api.sent('POST', `${base}/automation-activations/${AUT}/version`)[0]).toMatchObject({ body: { automationVersionId: V2 } }));
  });

  it('quem não administra: a API recusa e a tela diz que não há permissão', async () => {
    api.on('GET', `${base}/licenses/summary`, 'getLicenseSummary', { status: 403, body: { error: 'forbidden' } });
    renderApp(`/o/${ORG}/administracao/licencas`);
    expect(await screen.findByText('Você não tem permissão para ver as licenças e as automações atendidas.')).toBeInTheDocument();
  });
});

describe('Pedidos de organização', () => {
  const request = (over: Record<string, unknown> = {}) => ({
    requestId: R1,
    name: 'Filial Norte',
    legalName: 'Filial Norte Ltda.',
    state: 'PENDING',
    requestedAt: T,
    decidedAt: null,
    responsible: null,
    refusalReason: null,
    requester: { membershipId: M1, displayName: 'Bruno', email: 'bruno@empresa.com' },
    decidedByDisplayName: null,
    ownRequest: false,
    ...over,
  });

  it('aprovar: o padrão é quem aprova, a escolha é explicada e enviada; entregar ao solicitante é explícito', async () => {
    api.on('GET', `${base}/organization-requests`, 'listOrganizationRequests', { status: 200, body: { items: [request()] } });
    api.on('POST', `${base}/organization-requests/${R1}/approve`, 'approveOrganizationRequest', {
      status: 200,
      body: { requestId: R1, state: 'APPROVED', responsible: 'REQUESTER', createdOrganizationId: null },
    });
    renderApp(`/o/${ORG}/administracao/pedidos-de-organizacao`);
    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar o pedido de Filial Norte' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(RESPONSIBLE_TEXT.intro)).toBeInTheDocument();
    expect(within(dialog).getByText(RESPONSIBLE_TEXT.noOthers)).toBeInTheDocument();
    const mine = within(dialog).getByRole('radio', { name: RESPONSIBLE_TEXT.APPROVER }) as HTMLInputElement;
    const theirs = within(dialog).getByRole('radio', { name: RESPONSIBLE_TEXT.REQUESTER }) as HTMLInputElement;
    expect(mine.checked).toBe(true);
    expect(theirs.checked).toBe(false);
    fireEvent.click(theirs);
    const confirm = within(dialog).getByRole('button', { name: 'Aprovar e criar a organização' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await screen.findByText(/foi criada sob a administração de Bruno\. Você não tem acesso a ela\./)).toBeInTheDocument();
    expect(api.sent('POST', `${base}/organization-requests/${R1}/approve`)[0]).toMatchObject({ body: { responsible: 'REQUESTER' } });
  });

  it('limite de vazias do responsável escolhido: a recusa diz que nada foi criado e que o pedido continua aguardando', async () => {
    api.on('GET', `${base}/organization-requests`, 'listOrganizationRequests', { status: 200, body: { items: [request()] } });
    api.on('POST', `${base}/organization-requests/${R1}/approve`, 'approveOrganizationRequest', {
      status: 409,
      body: { error: 'conflict', reason: 'empty_organization_limit_reached' },
    });
    renderApp(`/o/${ORG}/administracao/pedidos-de-organizacao`);
    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar o pedido de Filial Norte' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Aprovar e criar a organização' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await within(dialog).findByText(/já tem o limite de organizações vazias.*O pedido continua aguardando\. Nada foi criado\./)).toBeInTheDocument();
    expect(api.sent('POST', `${base}/organization-requests/${R1}/approve`)[0]).toMatchObject({ body: { responsible: 'APPROVER' } });
  });

  it('pedido próprio não oferece decisão; decididos mostram o responsável e o motivo', async () => {
    api.on('GET', `${base}/organization-requests`, 'listOrganizationRequests', {
      status: 200,
      body: {
        items: [
          request({ ownRequest: true }),
          request({ requestId: NEW_ORG, name: 'Filial Sul', state: 'APPROVED', decidedAt: T, responsible: 'REQUESTER', decidedByDisplayName: 'Ana' }),
          request({ requestId: L1, name: 'Filial Leste', state: 'REFUSED', decidedAt: T, refusalReason: 'a filial leste não será aberta este ano', decidedByDisplayName: 'Ana' }),
        ],
      },
    });
    renderApp(`/o/${ORG}/administracao/pedidos-de-organizacao`);
    expect(await screen.findByText('Pedido seu: outro administrador decide.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Aprovar o pedido/ })).toBeNull();
    expect(screen.getByText('Responsável: quem solicitou')).toBeInTheDocument();
    expect(screen.getByText('Motivo: a filial leste não será aberta este ano')).toBeInTheDocument();
  });
});

describe('textos de licença, capacidade e validade', () => {
  const requested = '2027-06-30T23:59:59.000Z';

  it('validade reduzida: diz a data efetiva e o motivo; validade igual à pedida não gera aviso', () => {
    const text = reducedValidityText(requested, '2027-01-15T12:00:00.000Z');
    expect(text).toMatch(/A autorização vale até 15\/01\/2027/);
    expect(text).toMatch(/e não até 30\/06\/2027/);
    expect(text).toMatch(/a licença desta automação termina nessa data/);
    expect(reducedValidityText(requested, requested)).toBeNull();
    expect(reducedValidityText(requested, '2027-06-30T23:59:30.000Z')).toBeNull();
    expect(reducedValidityText(requested, null)).toBeNull();
  });

  it('licença e capacidade têm textos diferentes; motivo desconhecido não é tratado como licença', () => {
    expect(licenseRefusalText(new ApiError('conflict', 409, undefined, undefined, 'license_required'))).toMatch(/não tem licença/);
    expect(licenseRefusalText(new ApiError('conflict', 409, undefined, undefined, 'license_expired'))).toMatch(/venceu/);
    expect(licenseRefusalText(new ApiError('conflict', 409, undefined, undefined, 'capacity_pending_limit_reached'))).toBe(CAPACITY_PENDING_TEXT);
    expect(CAPACITY_PENDING_TEXT).toMatch(/limite de capacidade, não de licença/);
    expect(licenseRefusalText(new ApiError('conflict', 409, undefined, undefined, 'outro_motivo'))).toBeNull();
    expect(licenseRefusalText(new ApiError('forbidden', 403))).toBeNull();
  });
});
