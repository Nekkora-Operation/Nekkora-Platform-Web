import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { activationLabel, LICENSED_MODEL_TEXT } from '../../identity/labels';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { onlyAuthorizationMissing } from '../agents/RemoteExecutions';
import { OPERATOR_TEXT, SESSION_STATE } from './LicenseOperatorPage';

/**
 * PLATFORM-LICENCIAMENTO-001 — interface mínima do operador de licenças da Nekkora, e os textos que dependem do modelo da
 * organização. Testes de componente ISOLADOS: as respostas por rota são conferidas contra o contrato; o comportamento real
 * é conferido no laboratório.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const TARGET = '9a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const AUT = '7f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const AUT2 = '8f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const L1 = '11111111-2222-4333-8444-555555555555';
const M1 = '31111111-2222-4333-8444-555555555555';
const S1 = '41111111-2222-4333-8444-555555555555';
const S2 = '51111111-2222-4333-8444-555555555555';
const T = '2026-11-10T12:00:00Z';
const base = `/api/v1/o/${ORG}`;
const ops = `${base}/license-operations`;

let api: RouteApi;

const preview = (over: Record<string, unknown> = {}) => ({
  organizationId: TARGET,
  model: 'legacy',
  modelSince: null,
  contracted: 2,
  used: 1,
  available: 1,
  blockedAutomations: [{ automationId: AUT2, name: 'Folha', workspaceName: 'Fiscal', inUseBecause: ['validAuthorization'], authorizationsValidUntil: T }],
  licensedAutomations: [],
  offlineAuthorizations: 1,
  offlineAuthorizationsValidUntil: T,
  workInProgress: 0,
  previewToken: 'resumo-1',
  asOf: T,
  ...over,
});
const organization = {
  organizationId: TARGET,
  name: 'Cliente Matriz',
  model: 'legacy',
  licenses: [
    { licenseId: L1, number: 1, status: 'VALID', validUntil: T, automationId: AUT, automationName: 'Notas de entrada' },
    { licenseId: M1, number: 2, status: 'VALID', validUntil: T, automationId: null, automationName: null },
  ],
  automations: [
    { automationId: AUT, name: 'Notas de entrada' },
    { automationId: AUT2, name: 'Folha' },
  ],
};
const session = (over: Record<string, unknown> = {}) => ({
  sessionId: S1,
  automationId: AUT,
  automationName: 'Notas de entrada',
  state: 'OUTCOME_UNKNOWN',
  registeredAt: T,
  lastReportAt: T,
  reconcilable: true,
  holdsSlot: false,
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
  api.on('GET', `${base}/me`, 'getMe', {
    status: 200,
    body: {
      accountType: 'internal',
      displayName: 'Nara',
      email: 'nara@nekkora.test',
      organizationId: ORG,
      organizationActivationState: 'ATIVADA',
      organizationLicenseModel: 'legacy',
      stepUpMethod: 'totp',
    },
  });
  api.on('GET', `${base}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: {
      organizationId: ORG,
      membershipId: M1,
      organization: { roles: [], permissions: [] },
      allWorkspaces: { permissions: [] },
      hasWorkspaceAssignments: false,
    },
  });
  api.on('GET', `${base}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`${base}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', ops, 'getLicenseOperatorStatus', { status: 200, body: { operator: true } });
  api.on('GET', `${ops}/organizations/${TARGET}`, 'getLicenseOperatorOrganization', { status: 200, body: organization });
  api.on('GET', `${ops}/organizations/${TARGET}/enforcement-preview`, 'previewLicenseEnforcement', { status: 200, body: preview() });
  api.on('GET', `${ops}/organizations/${TARGET}/previous-agent-sessions`, 'listUnresolvedPreviousAgentSessions', {
    status: 200,
    body: { items: [session(), session({ sessionId: S2, automationName: 'Folha', automationId: AUT2, state: 'RUNNING', holdsSlot: true, reconcilable: false })] },
  });
});

async function openTarget() {
  renderApp(`/o/${ORG}/operador-de-licencas`);
  fireEvent.change(await screen.findByLabelText('Identificador da organização'), { target: { value: TARGET } });
  fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));
  await screen.findByRole('heading', { name: 'Cliente Matriz' });
}

describe('Operador de licenças', () => {
  it('o menu só mostra a área do operador a quem a API reconhece como operador', async () => {
    renderApp(`/o/${ORG}/operador-de-licencas`);
    expect(await screen.findByRole('link', { name: 'Operador de licenças' })).toBeInTheDocument();
    expect(screen.getByText(OPERATOR_TEXT.intro)).toBeInTheDocument();
  });

  it('quem não é operador não vê o item de menu', async () => {
    api.on('GET', ops, 'getLicenseOperatorStatus', { status: 403, body: { error: 'forbidden' } });
    renderApp(`/o/${ORG}/operador-de-licencas`);
    await screen.findByRole('heading', { name: 'Criação excepcional de organização' });
    expect(screen.queryByRole('link', { name: 'Operador de licenças' })).toBeNull();
  });

  it('abre a organização do cliente: modelo, prévia, licenças e sessões sem desfecho', async () => {
    await openTarget();
    expect(screen.getByText('Modelo anterior (exigência desligada)')).toBeInTheDocument();
    expect(screen.getByText(/1 automação\(ões\) em uso ficaria\(m\) sem licença/)).toBeInTheDocument();
    const licenses = screen.getByRole('region', { name: 'Lista de licenças da organização' });
    expect(within(licenses).getByText('Notas de entrada')).toBeInTheDocument();
    expect(within(licenses).getByText('sem vínculo')).toBeInTheDocument();
    // transferir só para licença vinculada
    expect(screen.getByRole('button', { name: 'Transferir a licença nº 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transferir a licença nº 2' })).toBeNull();
    const sessions = screen.getByRole('region', { name: 'Lista de sessões sem desfecho' });
    expect(within(sessions).getByText(SESSION_STATE.OUTCOME_UNKNOWN)).toBeInTheDocument();
    expect(within(sessions).getByText('transferência e uma vaga de execução')).toBeInTheDocument();
    // sessão com notícia recente não oferece o ato
    expect(within(sessions).getByText('Notícia há menos de uma hora: aguarde.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconciliar a sessão de Folha' })).toBeNull();
  });

  it('reconciliar: explica que a sessão não muda e exige justificativa, verificação e a confirmação de que foi conferido', async () => {
    api.on('POST', `${ops}/organizations/${TARGET}/previous-agent-sessions/${S1}/reconciliation`, 'reconcilePreviousAgentSession', {
      status: 200,
      body: { reconciliationId: L1, sessionId: S1 },
    });
    await openTarget();
    fireEvent.click(screen.getByRole('button', { name: 'Reconciliar a sessão de Notas de entrada' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(OPERATOR_TEXT.reconcile)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Registrar a reconciliação' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Verificação realizada'), { target: { value: 'cliente confirmou por escrito que a máquina foi formatada' } });
    fireEvent.change(within(dialog).getByLabelText('Justificativa'), { target: { value: 'chamado CH-77: máquina substituída' } });
    expect(confirm).toBeDisabled(); // falta a confirmação explícita
    fireEvent.click(within(dialog).getByRole('checkbox', { name: OPERATOR_TEXT.reconcileAck }));
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await screen.findByText(/Reconciliação registrada\. A sessão não foi alterada/)).toBeInTheDocument();
    expect(api.sent('POST', `${ops}/organizations/${TARGET}/previous-agent-sessions/${S1}/reconciliation`)[0]).toMatchObject({
      body: { justification: 'chamado CH-77: máquina substituída', verification: 'cliente confirmou por escrito que a máquina foi formatada' },
    });
  });

  it('ligar a exigência: mostra as automações que ficariam sem trabalho novo e envia o resumo da prévia conferida', async () => {
    api.on('POST', `${ops}/organizations/${TARGET}/enforcement`, 'setLicenseEnforcement', {
      status: 200,
      body: { organizationId: TARGET, model: 'licensed', blockedAutomations: 1 },
    });
    await openTarget();
    fireEvent.click(screen.getByRole('button', { name: 'Ligar a exigência de licença' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(OPERATOR_TEXT.enforceOn)).toBeInTheDocument();
    expect(within(dialog).getByRole('list', { name: 'Automações que ficariam sem trabalho novo' })).toHaveTextContent('Folha (Fiscal)');
    const confirm = within(dialog).getByRole('button', { name: 'Ligar a exigência' });
    fireEvent.change(within(dialog).getByLabelText('Justificativa'), { target: { value: 'contrato assinado em 10/11' } });
    expect(confirm).toBeDisabled(); // sem conferir a prévia não liga
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Conferi a prévia: 1 automação/ }));
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await screen.findByText('Exigência de licença ligada.')).toBeInTheDocument();
    expect(api.sent('POST', `${ops}/organizations/${TARGET}/enforcement`)[0]).toMatchObject({
      body: { model: 'licensed', confirmPreview: 'resumo-1', justification: 'contrato assinado em 10/11' },
    });
  });

  it('transferência recusada por trabalho possível na origem: diz o que precisa acontecer e que nada mudou', async () => {
    api.on('POST', `${ops}/organizations/${TARGET}/licenses/${L1}/transfer`, 'transferLicense', {
      status: 409,
      body: { error: 'conflict', reason: 'license_transfer_work_in_progress' },
    });
    await openTarget();
    fireEvent.click(screen.getByRole('button', { name: 'Transferir a licença nº 1' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText('Automação de destino'), { target: { value: AUT2 } });
    fireEvent.change(within(dialog).getByLabelText('E-mail do administrador que pediu'), { target: { value: 'ana@cliente.test' } });
    fireEvent.change(within(dialog).getByLabelText('Referência do chamado'), { target: { value: 'CH-2026-0042' } });
    fireEvent.change(within(dialog).getByLabelText('Como a identidade do solicitante foi verificada'), { target: { value: 'retorno por telefone ao número do cadastro' } });
    fireEvent.change(within(dialog).getByLabelText('Justificativa'), { target: { value: 'a automação foi substituída' } });
    const confirm = within(dialog).getByRole('button', { name: 'Transferir' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await within(dialog).findByText(/sessão do Agent anterior sem desfecho confiável.*Nada foi alterado\./)).toBeInTheDocument();
  });

  it('criação excepcional: o responsável é indicado; a tela diz que o operador não recebe acesso', async () => {
    api.on('POST', `${ops}/organizations`, 'createOrganizationByOperator', { status: 201, body: { organizationId: TARGET } });
    renderApp(`/o/${ORG}/operador-de-licencas`);
    fireEvent.click(await screen.findByRole('button', { name: 'Criar organização por exceção' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(OPERATOR_TEXT.create)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Criar a organização' });
    fireEvent.change(within(dialog).getByLabelText('Nome da organização'), { target: { value: 'Filial Norte' } });
    fireEvent.change(within(dialog).getByLabelText('Razão social'), { target: { value: 'Filial Norte Ltda' } });
    fireEvent.change(within(dialog).getByLabelText('Justificativa'), { target: { value: 'contrato novo da matriz' } });
    expect(confirm).toBeDisabled(); // sem a pessoa responsável não cria
    fireEvent.change(within(dialog).getByLabelText('E-mail da pessoa responsável'), { target: { value: 'bruno@cliente.test' } });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await screen.findByText(/A pessoa indicada a administra; você não tem acesso a ela\./)).toBeInTheDocument();
    expect(api.sent('POST', `${ops}/organizations`)[0]).toMatchObject({
      body: { responsibleEmail: 'bruno@cliente.test', name: 'Filial Norte', legalName: 'Filial Norte Ltda', justification: 'contrato novo da matriz' },
    });
  });
});

describe('Textos que dependem do modelo da organização', () => {
  it('modelo por licença: não diz "aguardando ativação" nem que nenhum Worker pode ser registrado', () => {
    const licensed = activationLabel('AGUARDANDO_ATIVACAO', 'licensed');
    expect(licensed.label).toBe('Modelo por licença');
    expect(licensed.description).toBe(LICENSED_MODEL_TEXT);
    expect(licensed.description).not.toMatch(/nenhum Worker pode/);
    // modelo anterior (ou API sem o campo): o texto de ativação continua valendo
    expect(activationLabel('AGUARDANDO_ATIVACAO', 'legacy').label).toBe('Aguardando ativação');
    expect(activationLabel('AGUARDANDO_ATIVACAO').description).toMatch(/nenhum Worker pode ser registrado/);
  });

  it('autorizar e solicitar no mesmo passo só é oferecido quando falta SÓ a autorização da versão', () => {
    expect(onlyAuthorizationMissing(['AUTHORIZATION_MISSING'])).toBe(true);
    expect(onlyAuthorizationMissing(['AUTHORIZATION_EXPIRED'])).toBe(true);
    expect(onlyAuthorizationMissing(['AUTHORIZATION_MISSING', 'PYTHON_NOT_SELECTED'])).toBe(false);
    expect(onlyAuthorizationMissing([])).toBe(false);
  });
});
