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
  api.on('GET', `${base}/automations`, 'listOrganizationAutomations', {
    status: 200,
    body: { items: [automation(AUT, 'Notas de entrada'), automation(AUT2, 'Notas de saída')], nextCursor: null },
  });
});

describe('Licenças e capacidade', () => {
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
    expect(within(licenses).getByText('Notas de entrada')).toBeInTheDocument();
    expect(within(licenses).getByText(/com execução em andamento agora/)).toBeInTheDocument();
    expect(within(licenses).getByText('Disponível (sem automação)')).toBeInTheDocument();
    // capacidade: nunca dentro da conta de licenças, e dita como coisa diferente
    expect(within(cap).getByText(CAPACITY_TEXT.intro)).toBeInTheDocument();
    const usage = within(cap).getByRole('group', { name: 'Capacidade técnica' });
    expect(usage.textContent).toMatch(/Workers cadastrados3 de 50/);
    expect(usage.textContent).toMatch(/Execuções simultâneas5 de 5/);
    // execuções ATIVAS e RESERVAS por situação incerta aparecem separadas
    expect(usage.textContent).toMatch(/Em execução: 3 \(2 pelo Agent Client · 1 pelo Agent anterior\)/);
    expect(usage.textContent).toMatch(/Reservadas por situação incerta: 2 \(1 com término não confirmado pela máquina \(Agent Client\) · 1 com resultado desconhecido \(Agent anterior\)\)/);
    expect(within(cap).getByText(CAPACITY_TEXT.previousAgentUnconfirmed)).toBeInTheDocument();
    expect(within(cap).getByText(CAPACITY_TEXT.concurrentFull)).toBeInTheDocument();
    expect(usage.textContent).toMatch(/Execuções pendentes \(na fila\)2 de 50/);
    expect(within(licenses).queryByText(/Workers cadastrados/)).toBeNull();
    // só a licença vigente e sem automação oferece o vínculo
    expect(screen.getAllByRole('button', { name: /Vincular a licença/ })).toHaveLength(1);
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
    expect(screen.queryByRole('button', { name: /Vincular a licença/ })).toBeNull();
  });

  it('vincular: só automações sem licença; avisa que o vínculo não é desfeito por aqui; envia a automação escolhida', async () => {
    api.on('POST', `${base}/licenses/${L2}/assignment`, 'assignLicense', {
      status: 200,
      body: { licenseId: L2, number: 2, automationId: AUT2, workspaceId: WS, assignedAt: T },
    });
    renderApp(`/o/${ORG}/administracao/licencas`);
    fireEvent.click(await screen.findByRole('button', { name: 'Vincular a licença nº 2 a uma automação' }));
    const dialog = await screen.findByRole('alertdialog');
    const select = (await within(dialog).findByLabelText('Automação que vai usar esta licença')) as HTMLSelectElement;
    // a automação que já tem licença não é oferecida
    expect([...select.options].map((o) => o.textContent)).toEqual(['Escolha a automação', 'Notas de saída · Fiscal']);
    expect(within(dialog).getByText('Você não desfaz este vínculo por aqui.')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Vincular licença' });
    expect(confirm).toBeDisabled();
    fireEvent.change(select, { target: { value: AUT2 } });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await screen.findByText('Licença vinculada a Notas de saída.')).toBeInTheDocument();
    expect(api.sent('POST', `${base}/licenses/${L2}/assignment`)[0]).toMatchObject({ body: { automationId: AUT2 } });
  });

  it('quem não administra: a API recusa e a tela diz que não há permissão', async () => {
    api.on('GET', `${base}/licenses/summary`, 'getLicenseSummary', { status: 403, body: { error: 'forbidden' } });
    renderApp(`/o/${ORG}/administracao/licencas`);
    expect(await screen.findByText('Você não tem permissão para ver as licenças e a capacidade.')).toBeInTheDocument();
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
