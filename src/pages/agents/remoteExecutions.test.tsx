import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import {
  ATTEMPT_STATE,
  CLOSURE_TEXT,
  DEPENDENCY_CHECK,
  ENDED_UNKNOWN_TEXT,
  MISSING,
  REQUEST_REFUSAL,
  PROCESSES_TEXT,
  RECONCILE,
  RECONCILIATION_REASON,
  RETRY_BLOCKED_PROCESSES_TEXT,
  RETRY_BLOCKED_TEXT,
  dependencyCheckText,
  endedUnknownText,
  environmentCode, ACCEPT_VERSION, WAITING_SLOT_LABEL, WAITING_SLOT_TEXT } from './RemoteExecutions';
import { logsExpiredText, storedText, writtenText } from './RemoteLogs';
import { resultsExpiredText } from './RemoteResults';
import { permissionsAutoRetry } from '../../area/useWorkspacePermissions';

/**
 * PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T02 — execução remota na página de uma versão publicada: por máquina, o que falta
 * para solicitar e a ação que resolve (só para quem pode); solicitar, acompanhar sem afirmar o que a máquina não disse,
 * pedir o cancelamento e executar novamente em outra máquina. Respostas por rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const VERSION = '22222222-3333-4444-8555-666666666666';
const AUT = '7f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const WS = '5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f';
const AG1 = '33333333-3333-4333-8333-333333333333';
const AG2 = '44444444-4444-4444-8444-444444444444';
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const X1 = '55555555-5555-4555-8555-555555555555';
const AUTHZ = '66666666-6666-4666-8666-666666666666';
const T = '2026-11-10T10:00:00Z';
const ENV_A = 'A'.repeat(43);
const ENV_B = 'B'.repeat(43);
const SHA = 'a'.repeat(64);
const FP = 'b'.repeat(64);
const CANDIDATES = `/api/v1/o/${ORG}/workspaces/${WS}/remote-executions/candidates`;
const LIST = `/api/v1/o/${ORG}/workspaces/${WS}/remote-executions`;

let api: RouteApi;
type Row = Record<string, unknown>;
let candidates: Row[];
/** O tipo do pacote da versão da página; a execução remota só aceita o externo. */
let packageKind: 'STUDIO_PYTHON' | 'EXTERNAL_PYTHON';
let executions: Row[];

const candidate = (over: Row = {}): Row => ({
  agentId: AG1,
  agentName: 'ESTACAO-01',
  workerId: W1,
  workerName: 'Worker financeiro',
  requestable: true,
  missing: [],
  authorization: { authorizationId: AUTHZ, validUntil: '2026-12-10T10:00:00Z', status: 'VALID' },
  python: { environmentId: ENV_A, pythonVersion: '3.12.10', inInventory: true, selectedAt: T },
  dependencyCheck: null,
  ...over,
});
const check = (over: Row = {}): Row => ({
  checkId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  environmentId: ENV_A,
  requirementsRevision: 1,
  requestedAt: T,
  answerValidUntil: '2026-11-10T10:02:00Z',
  state: 'ANSWERED',
  outcome: 'SATISFIED',
  missing: [],
  answeredAt: '2026-11-10T10:00:20Z',
  current: true,
  ...over,
});
const EXPIRED = {
  expiredAt: '2026-12-23T12:00:00Z',
  confirmedAt: '2026-12-23T12:00:05Z' as string | null,
  retentionDays: 30,
  deliveryEndedAt: '2026-11-23T12:00:00Z',
  deliveryEnd: 'CLOSED' as 'CLOSED' | 'LOSS_NOTICE' | 'LINK_ENDED',
  items: 6,
};

const attempt = (over: Row = {}): Row => ({
  attemptId: '77777777-7777-4777-8777-777777777777',
  attemptNumber: 1,
  agentId: AG1,
  agentName: 'ESTACAO-01',
  workerId: W1,
  workerName: 'Worker financeiro',
  state: 'QUEUED',
  refusalReason: null,
  communication: 'NONE',
  exitCode: null,
  createdAt: T,
  offerValidUntil: '2026-11-10T10:15:00Z',
  offeredAt: null,
  receivedAt: null,
  startedAt: null,
  endedAt: null,
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
  attempts,
  ...over,
});

function permissions(workspace: string[], roles: string[] = ['ORG_ADMIN']) {
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: { organizationId: ORG, membershipId: VERSION, organization: { roles, permissions: [] }, allWorkspaces: { permissions: workspace }, hasWorkspaceAssignments: false },
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
  candidates = [];
  executions = [];
  packageKind = 'EXTERNAL_PYTHON';
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' },
  });
  permissions(['automation.read', 'automation.manage', 'automation.execute']);
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/automations/${AUT}`, 'getAutomation', {
    status: 200,
    body: { automationId: AUT, workspaceId: WS, name: 'Relatório de pedidos', description: null, status: 'active', latestPublishedVersion: null, createdAt: T, updatedAt: T },
  });
  api.on('GET', `/api/v1/o/${ORG}/automation-versions/${VERSION}`, 'getAutomationVersion', () => ({
    status: 200,
    body: {
      automationVersionId: VERSION,
      automationId: AUT,
      workspaceId: WS,
      versionNumber: 3,
      status: 'PUBLISHED',
      runtime: 'python3.12',
      entrypoint: 'main.py',
      arguments: [],
      artifactReference: null,
      artifact: {
        artifactId: VERSION,
        sha256: SHA,
        sizeBytes: 2048,
        fingerprintRule: 'nekkora-agent/package-fingerprint/1',
        fingerprint: FP,
        filesCount: 10,
        manifestVersion: '1.4',
        framework: 'nekkora_rpa',
        executionMode: 'list',
        declaredGenerator: null,
        provenance: 'DECLARED',
        receivedAt: T,
        packageKind,
      },
      agentPackage: { fingerprintRule: 'nekkora-agent/package-fingerprint/1', fingerprint: FP },
      createdAt: T,
      publishedAt: T,
      publishedByMembershipId: VERSION,
    },
  }));
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workspaces/${WS}/local-run-authorizations`), 'listLocalRunAuthorizations', { status: 200, body: { items: [] } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/agents`), 'listAgents', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workers`), 'listWorkers', { status: 200, body: { items: [] } });
  api.on('GET', new RegExp(`^${CANDIDATES}`), 'listRemoteExecutionCandidates', () => ({ status: 200, body: { items: candidates } }));
  api.on('GET', LIST, 'listRemoteExecutions', () => ({ status: 200, body: { items: executions } }));
});
afterEach(() => vi.unstubAllGlobals());

const open = async () => {
  renderApp(`/o/${ORG}/versoes/${VERSION}`);
  await screen.findByRole('heading', { name: /Autorizações de execução local/ });
};
const section = () => screen.getByRole('heading', { name: 'Execução remota' }).closest('section')!;
const dialog = () => screen.getByRole('alertdialog');
async function confirmIn(label: string) {
  const button = within(dialog()).getByRole('button', { name: label });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe('Versão: execução remota (T02)', () => {
  it('por máquina, diz o que falta e oferece a ação que resolve; só a máquina sem pendência pode ser solicitada', async () => {
    candidates = [
      candidate(),
      candidate({
        agentId: AG2,
        agentName: 'ESTACAO-02',
        workerId: W2,
        workerName: 'Worker fiscal',
        requestable: false,
        missing: ['REQUIREMENTS_NOT_DECLARED', 'AUTHORIZATION_MISSING', 'MACHINE_PAUSED', 'MACHINE_INCOMPATIBLE'],
        authorization: null,
      }),
    ];
    await open();
    const s = await waitFor(section);
    const table = within(s).getByRole('table', { name: /Máquinas habilitadas do workspace/ });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]).getByText('Pode solicitar')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('button', { name: 'Solicitar execução em ESTACAO-01' })).toBeInTheDocument();
    const missing = within(rows[2]).getByRole('list', { name: 'O que falta em ESTACAO-02' });
    for (const m of ['REQUIREMENTS_NOT_DECLARED', 'AUTHORIZATION_MISSING', 'MACHINE_PAUSED', 'MACHINE_INCOMPATIBLE'] as const) {
      expect(within(missing).getByText(MISSING[m])).toBeInTheDocument();
    }
    // a ação correspondente, para quem tem a permissão dela
    expect(within(missing).getByRole('link', { name: 'Declarar as dependências na automação' })).toHaveAttribute('href', `/o/${ORG}/automacoes/${AUT}`);
    expect(within(missing).getByText(/Autorize a execução local desta versão para o Worker Worker fiscal/)).toBeInTheDocument();
    expect(within(missing).getByText(/voltam a ser recebidos no próprio computador/)).toBeInTheDocument();
    expect(within(rows[2]).queryByRole('button', { name: /Solicitar execução/ })).toBeNull();
    expect(within(s).getByText(/Solicitar não é iniciar/)).toBeInTheDocument();
  });

  it('a tela diz que só pacote Python externo é aceito; versão no formato Studio não oferece Solicitar', async () => {
    candidates = [candidate()];
    await open();
    let s = await waitFor(section);
    expect(within(s).getByText(/aceita apenas pacotes Python externos compatíveis\. Pacotes no formato Studio não são executados remotamente/)).toBeInTheDocument();
    expect(within(s).queryByText('Esta versão não pode ser executada remotamente')).toBeNull();
    expect(within(s).getByRole('button', { name: 'Solicitar execução em ESTACAO-01' })).toBeInTheDocument();
    cleanup();
    packageKind = 'STUDIO_PYTHON';
    await open();
    s = await waitFor(section);
    expect(within(s).getByText('Esta versão não pode ser executada remotamente')).toBeInTheDocument();
    expect(within(s).getByText(/O pacote desta versão está no formato Studio/)).toBeInTheDocument();
    // a máquina até poderia receber, mas a tela não oferece o que a máquina recusaria
    expect(within(s).getByText('Pode solicitar')).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: /Solicitar execução/ })).toBeNull();
  });

  it('a API recusa o pacote no formato Studio: a máquina aparece com o motivo, sem ação e sem Solicitar', async () => {
    packageKind = 'STUDIO_PYTHON';
    candidates = [candidate({ requestable: false, missing: ['PACKAGE_NOT_SUPPORTED'] })];
    await open();
    const s = await waitFor(section);
    const row = within(s).getAllByRole('row')[1];
    expect(within(row).getByText(MISSING.PACKAGE_NOT_SUPPORTED)).toBeInTheDocument();
    expect(within(row).getByText('Não há ação nesta máquina: esta versão não pode ser executada remotamente.')).toBeInTheDocument();
    expect(within(s).queryByText('Pode solicitar')).toBeNull();
    expect(within(s).queryByRole('button', { name: /Solicitar execução/ })).toBeNull();
  });

  it('versão sem pacote registrado na Platform: a máquina aparece com o motivo e o que fazer, sem Solicitar', async () => {
    candidates = [candidate({ requestable: false, missing: ['PACKAGE_NOT_REGISTERED'] })];
    await open();
    const s = await waitFor(section);
    const row = within(s).getAllByRole('row')[1];
    expect(within(row).getByText(MISSING.PACKAGE_NOT_REGISTERED)).toBeInTheDocument();
    expect(within(row).getByText('Não há ação nesta máquina: publique uma nova versão da automação com o pacote.')).toBeInTheDocument();
    expect(within(s).queryByText('Pode solicitar')).toBeNull();
    expect(within(s).queryByRole('button', { name: /Solicitar execução/ })).toBeNull();
    expect(REQUEST_REFUSAL.remote_package_not_registered).toBe(MISSING.PACKAGE_NOT_REGISTERED);
  });

  it('quem não pode resolver vê o que falta, sem a ação; quem não pode executar não vê Solicitar', async () => {
    permissions(['automation.read']);
    candidates = [candidate(), candidate({ agentId: AG2, agentName: 'ESTACAO-02', requestable: false, missing: ['REQUIREMENTS_CONFLICT', 'AUTHORIZATION_EXPIRED'] })];
    await open();
    const s = await waitFor(section);
    const missing = within(s).getByRole('list', { name: 'O que falta em ESTACAO-02' });
    expect(within(missing).getByText(MISSING.REQUIREMENTS_CONFLICT)).toBeInTheDocument();
    expect(within(missing).getByText('Peça a quem gerencia esta automação.')).toBeInTheDocument();
    expect(within(missing).getByText('Peça a autorização a quem pode executar neste workspace.')).toBeInTheDocument();
    expect(within(missing).queryByRole('link')).toBeNull();
    expect(within(s).queryByRole('button', { name: /Solicitar execução/ })).toBeNull();
  });

  it('solicitar manda a versão, a máquina e uma chave; a tela diz que registrar não é iniciar', async () => {
    candidates = [candidate()];
    api.on('POST', LIST, 'requestRemoteExecution', () => {
      executions = [execution([attempt()])];
      candidates = [candidate({ requestable: false, missing: ['MACHINE_BUSY'] })];
      return { status: 201, body: executions[0] };
    });
    await open();
    fireEvent.click(within(await waitFor(section)).getByRole('button', { name: 'Solicitar execução em ESTACAO-01' }));
    expect(within(dialog()).getByText(/confere de novo a autorização desta versão/)).toBeInTheDocument();
    await confirmIn('Solicitar execução');
    expect(await screen.findByText(/Solicitação registrada\. A máquina recebe na próxima consulta/)).toBeInTheDocument();
    const sent = api.sent('POST', LIST);
    expect(sent).toHaveLength(1);
    const body = sent[0].body as { automationVersionId: string; agentId: string; requestKey: string };
    expect(body.automationVersionId).toBe(VERSION);
    expect(body.agentId).toBe(AG1);
    expect(body.requestKey).toMatch(/^[0-9a-f-]{36}$/);
    const s = section();
    await waitFor(() => expect(within(s).getAllByText('Na fila · aguardando a máquina').length).toBeGreaterThan(0));
    expect(within(s).queryByText('Em execução')).toBeNull();
    expect(within(s).getByText(MISSING.MACHINE_BUSY)).toBeInTheDocument();
  });

  it('S2: falta só a autorização da versão - autorizar e solicitar no mesmo passo exige o aceite explícito e diz que não vale para versões futuras', async () => {
    candidates = [candidate({ requestable: false, missing: ['AUTHORIZATION_MISSING'], authorization: null })];
    api.on('POST', LIST, 'requestRemoteExecution', () => {
      executions = [execution([attempt()])];
      return { status: 201, body: executions[0] };
    });
    await open();
    const s = await waitFor(section);
    expect(within(s).queryByRole('button', { name: 'Solicitar execução em ESTACAO-01' })).toBeNull();
    fireEvent.click(within(s).getByRole('button', { name: `${ACCEPT_VERSION.BUTTON} em ESTACAO-01` }));
    expect(within(dialog()).getByText(ACCEPT_VERSION.SCOPE)).toBeInTheDocument();
    const confirm = within(dialog()).getByRole('button', { name: 'Autorizar e solicitar' });
    // modelo anterior: a validade é obrigatória, e sem o aceite marcado nada é enviado
    const until = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    fireEvent.change(within(dialog()).getByLabelText('Autorização válida até'), { target: { value: until } });
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: ACCEPT_VERSION.ACK('versão 3', 'Worker financeiro') }));
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await screen.findByText(/Versão autorizada para este Worker e solicitação registrada/)).toBeInTheDocument();
    const body = api.sent('POST', LIST)[0].body as { authorizeVersion: boolean; authorizationValidUntil: string; agentId: string };
    expect(body.authorizeVersion).toBe(true);
    expect(body.agentId).toBe(AG1);
    expect(body.authorizationValidUntil.slice(0, 10)).toBe(new Date(`${until}T23:59:59`).toISOString().slice(0, 10));
  });

  it('S2: com outra pendência além da autorização, o atalho não é oferecido', async () => {
    candidates = [candidate({ requestable: false, missing: ['AUTHORIZATION_MISSING', 'PYTHON_NOT_SELECTED'], authorization: null })];
    await open();
    const s = await waitFor(section);
    await within(s).findByText(MISSING.AUTHORIZATION_MISSING);
    expect(within(s).queryByRole('button', { name: new RegExp(ACCEPT_VERSION.BUTTON) })).toBeNull();
  });

  it('aguardando vaga: na fila com a organização no limite de simultâneas - diz que é capacidade, não licença', async () => {
    candidates = [candidate({ requestable: false, missing: ['MACHINE_BUSY'] })];
    executions = [execution([attempt()], { waitingForSlot: true })];
    await open();
    const s = await waitFor(section);
    expect(await within(s).findByText(WAITING_SLOT_LABEL)).toBeInTheDocument();
    expect(within(s).getByText(WAITING_SLOT_TEXT)).toBeInTheDocument();
    expect(WAITING_SLOT_TEXT).toMatch(/limite de capacidade, não falta de licença/);
  });

  it('na fila sem limite atingido: continua "aguardando a máquina", sem falar de vaga', async () => {
    candidates = [candidate({ requestable: false, missing: ['MACHINE_BUSY'] })];
    executions = [execution([attempt()], { waitingForSlot: false })];
    await open();
    const s = await waitFor(section);
    await waitFor(() => expect(within(s).getAllByText('Na fila · aguardando a máquina').length).toBeGreaterThan(0));
    expect(within(s).queryByText(WAITING_SLOT_LABEL)).toBeNull();
  });

  it('cada recusa do servidor diz a exigência que faltou, e nada é dado como solicitado', async () => {
    candidates = [candidate()];
    let reason = 'remote_authorization_revoked';
    api.on('POST', LIST, 'requestRemoteExecution', () => ({ status: 409, body: { error: 'conflict', reason } }));
    await open();
    fireEvent.click(within(await waitFor(section)).getByRole('button', { name: 'Solicitar execução em ESTACAO-01' }));
    await confirmIn('Solicitar execução');
    expect(await within(dialog()).findByText(`${MISSING.AUTHORIZATION_REVOKED} Nada foi alterado.`)).toBeInTheDocument();
    reason = 'remote_machine_paused';
    await confirmIn('Solicitar execução');
    expect(await within(dialog()).findByText(`${MISSING.MACHINE_PAUSED} Nada foi alterado.`)).toBeInTheDocument();
    expect(screen.queryByText(/Solicitação registrada/)).toBeNull();
  });

  it('acompanha sem afirmar o que a máquina não disse: recusa com o motivo, comunicação perdida, código de saída', async () => {
    candidates = [candidate()];
    executions = [
      execution([attempt({ state: 'REFUSED', refusalReason: 'AUTHORIZATION_REVOKED', endedAt: T })]),
      execution([attempt({ state: 'RUNNING', communication: 'LOST', startedAt: T })], { remoteExecutionId: '88888888-8888-4888-8888-888888888888', requestedAt: '2026-11-10T11:00:00Z' }),
      execution([attempt({ state: 'FAILED', exitCode: 3, endedAt: T })], { remoteExecutionId: '99999999-9999-4999-8999-999999999999', requestedAt: '2026-11-10T12:00:00Z' }),
    ];
    await open();
    const s = await waitFor(section);
    expect(within(s).getByText(/a autorização desta versão para o Worker foi revogada antes do início/)).toBeInTheDocument();
    // a comunicação perdida ainda não encerrou nada, e a tela diz o que vai acontecer se a máquina não voltar
    expect(within(s).getByText(/Sem comunicação com a máquina no momento\. O estado é o último que ela informou\. Se ela não voltar dentro do prazo/)).toBeInTheDocument();
    expect(within(s).getAllByText('Em execução').length).toBeGreaterThan(0);
    expect(within(s).getByText(/código de saída 3/)).toBeInTheDocument();
  });

  it('encerramento pela Platform: diz a causa, nunca sucesso, falha ou cancelamento, e mostra o relato tardio sem mudar o estado', async () => {
    candidates = [candidate()];
    const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
    executions = [
      execution([attempt({ state: 'ENDED_UNKNOWN', closureCause: 'MACHINE_UNLINKED', startedAt: T, endedAt: T })]),
      execution([attempt({ state: 'ENDED_UNKNOWN', closureCause: 'MACHINE_REVOKED', startedAt: T, endedAt: T })], { remoteExecutionId: id(2), requestedAt: '2026-11-10T11:00:00Z' }),
      execution(
        [
          attempt({
            state: 'ENDED_UNKNOWN',
            closureCause: 'COMMUNICATION_LOST',
            startedAt: T,
            endedAt: T,
            lateReport: { state: 'SUCCEEDED', exitCode: 0, reportedAt: '2026-11-10T14:00:00Z' },
          }),
        ],
        { remoteExecutionId: id(3), requestedAt: '2026-11-10T12:00:00Z' },
      ),
      execution([attempt({ state: 'REFUSED', refusalReason: 'COMMUNICATION_LOST', closureCause: 'COMMUNICATION_LOST', endedAt: T })], {
        remoteExecutionId: id(4),
        requestedAt: '2026-11-10T13:00:00Z',
      }),
      execution([attempt({ state: 'REFUSED', refusalReason: 'MACHINE_NOT_LINKED', closureCause: 'MACHINE_REVOKED', endedAt: T })], {
        remoteExecutionId: id(5),
        requestedAt: '2026-11-10T13:30:00Z',
      }),
    ];
    await open();
    const s = await waitFor(section);
    // em andamento quando o vínculo acabou ou a comunicação se perdeu: resultado não confirmado, com a causa
    expect(within(s).getByText(CLOSURE_TEXT.MACHINE_UNLINKED.unknown)).toBeInTheDocument();
    expect(within(s).getByText(CLOSURE_TEXT.MACHINE_REVOKED.unknown)).toBeInTheDocument();
    expect(within(s).getByText(CLOSURE_TEXT.COMMUNICATION_LOST.unknown)).toBeInTheDocument();
    expect(within(s).queryByText(ENDED_UNKNOWN_TEXT)).toBeNull();
    for (const cause of ['MACHINE_UNLINKED', 'MACHINE_REVOKED', 'COMMUNICATION_LOST']) {
      expect(CLOSURE_TEXT[cause].unknown).toMatch(/Não há confirmação de como a automação terminou, nem de que terminou/);
      expect(CLOSURE_TEXT[cause].unknown).toMatch(/não comprova sucesso/);
    }
    expect(endedUnknownText(null)).toBe(ENDED_UNKNOWN_TEXT);
    expect(endedUnknownText('MACHINE_REVOKED')).toBe(CLOSURE_TEXT.MACHINE_REVOKED.unknown);
    // antes de começar: não iniciada, com o motivo e a causa
    expect(within(s).getByText(/a máquina deixou de se comunicar antes do início/)).toBeInTheDocument();
    expect(within(s).getByText(CLOSURE_TEXT.COMMUNICATION_LOST.notStarted)).toBeInTheDocument();
    expect(within(s).getByText(CLOSURE_TEXT.MACHINE_REVOKED.notStarted)).toBeInTheDocument();
    // nenhum desfecho inventado
    expect(within(s).queryByText('Concluída')).toBeNull();
    expect(within(s).queryByText('Falhou')).toBeNull();
    expect(within(s).queryByText('Cancelada')).toBeNull();
    expect(within(s).queryByText('Em execução')).toBeNull();
    // o relato tardio aparece ao lado, dito como tardio; o estado continua "Resultado não confirmado"
    const late = within(s).getByText(/a máquina voltou e informou que a automação terminou, com código de saída 0/);
    expect(late.textContent).toMatch(/fora do prazo: fica registrada aqui e não\s+muda o estado desta tentativa/);
    expect(within(s).getAllByText('Resultado não confirmado').length).toBeGreaterThanOrEqual(3);
  });

  it('cancelar: o que a máquina já recebeu só para quando ela disser', async () => {
    candidates = [candidate({ requestable: false, missing: ['MACHINE_BUSY'] })];
    executions = [execution([attempt({ state: 'RUNNING', communication: 'OK', startedAt: T })])];
    api.on('POST', `/api/v1/o/${ORG}/remote-executions/${X1}/cancel`, 'cancelRemoteExecution', () => {
      executions = [execution([attempt({ state: 'RUNNING', communication: 'OK', startedAt: T })], { cancelRequestedAt: T })];
      return { status: 200, body: executions[0] };
    });
    await open();
    fireEvent.click(within(await waitFor(section)).getByRole('button', { name: 'Pedir cancelamento' }));
    expect(within(dialog()).getByText(/a execução só para quando a máquina obedecer e informar/)).toBeInTheDocument();
    await confirmIn('Pedir cancelamento');
    expect(await screen.findByText('Cancelamento pedido. A execução só para quando a máquina receber o pedido e informar.')).toBeInTheDocument();
    const s = section();
    await waitFor(() => expect(within(s).getByText(/até lá o estado não muda/)).toBeInTheDocument());
    expect(within(s).getAllByText('Em execução').length).toBeGreaterThan(0);
    expect(within(s).queryByText('Cancelada')).toBeNull();
    expect(within(s).queryByRole('button', { name: 'Pedir cancelamento' })).toBeNull();
  });

  it('T06: permissões com 429 — a tela avisa, não esconde em silêncio, e confere de novo sozinha; as ações voltam sem clique', async () => {
    const before = permissionsAutoRetry.delaysMs;
    permissionsAutoRetry.delaysMs = [40, 40];
    try {
      candidates = [candidate()];
      let failures = 1;
      api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', () =>
        failures-- > 0 ? { status: 429, body: { error: 'rate_limited' } } : { status: 200, body: { items: [], nextCursor: null } },
      );
      renderApp(`/o/${ORG}/versoes/${VERSION}`);
      // primeiro a tela diz que não conseguiu conferir, e que isso vale também para a execução remota
      const alert = await screen.findByText('Não foi possível verificar suas permissões neste workspace agora.');
      expect(alert.closest('.nk-alert')).toHaveTextContent(/As ações de execução local e de execução remota só aparecem depois dessa verificação/);
      // depois confere de novo sozinha: o aviso some e Solicitar aparece, sem a pessoa clicar em nada
      const s = await waitFor(section);
      expect(await within(s).findByRole('button', { name: /Solicitar execução/ })).toBeInTheDocument();
      expect(screen.queryByText('Não foi possível verificar suas permissões neste workspace agora.')).toBeNull();
      expect(api.sent('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`))).toHaveLength(2);
    } finally {
      permissionsAutoRetry.delaysMs = before;
    }
  });

  it('T06: permissões que continuam falhando — as repetições automáticas têm fim, e o botão Tentar novamente fica', async () => {
    const before = permissionsAutoRetry.delaysMs;
    permissionsAutoRetry.delaysMs = [20, 20];
    try {
      candidates = [candidate()];
      api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 429, body: { error: 'rate_limited' } });
      renderApp(`/o/${ORG}/versoes/${VERSION}`);
      await screen.findByText('Não foi possível verificar suas permissões neste workspace agora.');
      await waitFor(() => expect(api.sent('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`))).toHaveLength(3));
      await new Promise((r) => setTimeout(r, 150));
      // a primeira leitura e duas repetições: não mais que isso
      expect(api.sent('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`))).toHaveLength(3);
      expect(await screen.findByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
      expect(within(section()).queryByRole('button', { name: /Solicitar execução/ })).toBeNull();
    } finally {
      permissionsAutoRetry.delaysMs = before;
    }
  });

  it('executar novamente em outra máquina: só depois do término, e só em máquina sem pendência', async () => {
    candidates = [
      candidate({ requestable: false, missing: ['AUTHORIZATION_MISSING'], authorization: null }),
      candidate({ agentId: AG2, agentName: 'ESTACAO-02', workerId: W2, workerName: 'Worker fiscal' }),
    ];
    executions = [execution([attempt({ state: 'ENDED_UNKNOWN', endedAt: T, reconciliations: [{ kind: 'MACHINE', at: T, reason: null, verification: null, byMembershipId: null }] })])];
    api.on('POST', `/api/v1/o/${ORG}/remote-executions/${X1}/attempts`, 'retryRemoteExecution', () => {
      executions = [execution([attempt({ state: 'ENDED_UNKNOWN', endedAt: T, reconciliations: [{ kind: 'MACHINE', at: T, reason: null, verification: null, byMembershipId: null }] }), attempt({ attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attemptNumber: 2, agentId: AG2, agentName: 'ESTACAO-02' })])];
      return { status: 201, body: executions[0] };
    });
    await open();
    const s = await waitFor(section);
    // T06: o desfecho incerto é dito com honestidade - nem sucesso pela chegada de arquivos, nem falha pela falta do código de saída
    expect(within(s).getAllByText('Resultado não confirmado').length).toBeGreaterThan(0);
    expect(within(s).getByText(ENDED_UNKNOWN_TEXT)).toBeInTheDocument();
    expect(ENDED_UNKNOWN_TEXT).toBe(
      'O Agent foi interrompido e não conseguiu confirmar como a automação terminou. Os arquivos recebidos estão disponíveis, mas não comprovam sucesso.',
    );
    expect(ATTEMPT_STATE.ENDED_UNKNOWN.tone).toBe('warning');
    expect(within(s).queryByText('Concluída')).toBeNull();
    expect(within(s).queryByText('Falhou')).toBeNull();
    fireEvent.click(within(s).getByRole('button', { name: 'Executar novamente em outra máquina' }));
    // repetir continua sendo decisão de uma pessoa, avisada de que o trabalho pode já ter sido feito
    expect(within(dialog()).getByText(/terminou com resultado não confirmado: a automação pode ter feito parte do trabalho, ou todo ele/)).toBeInTheDocument();
    expect(within(dialog()).getByText(/a da máquina anterior não é\s+aproveitada/)).toBeInTheDocument();
    const select = within(dialog()).getByLabelText('Máquina') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options.some((o) => o?.includes('ESTACAO-02'))).toBe(true);
    expect(options.some((o) => o?.includes('ESTACAO-01'))).toBe(false);
    expect(within(dialog()).getByRole('button', { name: 'Executar novamente' })).toBeDisabled();
    fireEvent.change(select, { target: { value: AG2 } });
    await confirmIn('Executar novamente');
    expect(await screen.findByText(/Nova tentativa registrada/)).toBeInTheDocument();
    expect(api.sent('POST', `/api/v1/o/${ORG}/remote-executions/${X1}/attempts`)[0].body).toEqual({ agentId: AG2 });
    await waitFor(() => expect(within(section()).getByText(/Tentativa 2 · ESTACAO-02/)).toBeInTheDocument());
  });

  it('reconciliação: com resultado não confirmado a repetição fica bloqueada; a declaração de quem administra exige motivo, verificação e a afirmação dos efeitos parciais', async () => {
    candidates = [
      candidate({ requestable: false, missing: ['MACHINE_UNCONFIRMED'] }),
      candidate({ agentId: AG2, agentName: 'ESTACAO-02', workerId: W2, workerName: 'Worker fiscal' }),
    ];
    const lost = attempt({ state: 'ENDED_UNKNOWN', startedAt: T, endedAt: T, closureCause: 'MACHINE_REVOKED' });
    executions = [execution([lost])];
    const VERIFIED = 'Computador desligado pela equipe e mantido fora de operação.';
    const reconciled = { ...lost, reconciliations: [{ kind: 'MANUAL', at: T, reason: 'MACHINE_OFF_OUT_OF_OPERATION', verification: VERIFIED, byMembershipId: '99999999-9999-4999-8999-999999999999' }] };
    const RECONCILE_URL = `/api/v1/o/${ORG}/remote-executions/${X1}/attempts/${lost.attemptId as string}/reconciliation`;
    api.on('POST', RECONCILE_URL, 'reconcileRemoteAttempt', () => {
      executions = [execution([reconciled])];
      return { status: 201, body: executions[0] };
    });
    await open();
    const s = await waitFor(section);
    // a máquina com ocupação incerta: o motivo próprio, e o que a faz voltar - que NÃO é só voltar a se comunicar
    expect(within(s).getByText(MISSING.MACHINE_UNCONFIRMED)).toBeInTheDocument();
    expect(within(s).getByText(/confirmar que o processo parou\. Voltar a se comunicar, sozinho, não basta\./)).toBeInTheDocument();
    // a repetição está bloqueada, qualquer que tenha sido a causa: não há botão de executar novamente, e a tela diz por quê
    expect(within(s).getByText(RETRY_BLOCKED_TEXT)).toBeInTheDocument();
    expect(RETRY_BLOCKED_TEXT).toMatch(/Revogar a máquina ou esperar não libera\./);
    expect(within(s).queryByRole('button', { name: 'Executar novamente em outra máquina' })).toBeNull();
    // não existe mais "aceito o risco"
    expect(within(s).queryByText(/Sei que a execução anterior pode ainda estar em andamento/)).toBeNull();
    fireEvent.click(within(s).getByRole('button', { name: RECONCILE.BUTTON }));
    expect(within(dialog()).getByText(RECONCILE.INTRO)).toBeInTheDocument();
    expect(within(dialog()).getByText(RECONCILE.WARNING)).toBeInTheDocument();
    expect(RECONCILE.WARNING).toMatch(/pode ter causado efeitos parciais.*Se ninguém conseguiu verificar a máquina, não declare/);
    const confirm = () => within(dialog()).getByRole('button', { name: RECONCILE.CONFIRM });
    // sem motivo, sem verificação ou sem a afirmação: não confirma
    expect(confirm()).toBeDisabled();
    fireEvent.change(within(dialog()).getByLabelText(RECONCILE.REASON_LABEL), { target: { value: 'MACHINE_OFF_OUT_OF_OPERATION' } });
    fireEvent.click(within(dialog()).getByLabelText(RECONCILE.ACK));
    expect(confirm()).toBeDisabled();
    fireEvent.change(within(dialog()).getByLabelText(new RegExp(`^${RECONCILE.VERIFICATION_LABEL}`)), { target: { value: 'curto' } });
    expect(confirm()).toBeDisabled();
    fireEvent.change(within(dialog()).getByLabelText(new RegExp(`^${RECONCILE.VERIFICATION_LABEL}`)), { target: { value: VERIFIED } });
    fireEvent.click(within(dialog()).getByLabelText(RECONCILE.ACK));
    expect(confirm()).toBeDisabled();
    fireEvent.click(within(dialog()).getByLabelText(RECONCILE.ACK));
    await confirmIn(RECONCILE.CONFIRM);
    expect(await screen.findByText(RECONCILE.DONE)).toBeInTheDocument();
    expect(api.sent('POST', RECONCILE_URL)[0].body).toEqual({ reason: 'MACHINE_OFF_OUT_OF_OPERATION', verification: VERIFIED, acknowledgePartialEffects: true });
    // o resultado continua "não confirmado", agora dito como reconciliado manualmente, com o que foi verificado; e a repetição volta
    const line = await within(section()).findByText(/Resultado não confirmado — reconciliado manualmente em/);
    expect(line.textContent).toContain(RECONCILIATION_REASON.MACHINE_OFF_OUT_OF_OPERATION);
    expect(line.textContent).toContain(VERIFIED);
    expect(line.textContent).toMatch(/O resultado da tentativa não mudou/);
    expect(within(section()).queryByText(RETRY_BLOCKED_TEXT)).toBeNull();
    expect(within(section()).getAllByText('Resultado não confirmado').length).toBeGreaterThan(0);
    fireEvent.click(within(section()).getByRole('button', { name: 'Executar novamente em outra máquina' }));
    // depois da reconciliação, repetir mantém o aviso dos efeitos parciais
    expect(within(dialog()).getByText(/terminou com resultado não confirmado: a automação pode ter feito parte do trabalho, ou todo ele/)).toBeInTheDocument();
    // recusas ditas em palavras; revogação: a tela não afirma que o processo parou
    expect(REQUEST_REFUSAL.remote_previous_result_unconfirmed).toContain('executar novamente está bloqueado');
    expect(RECONCILE.FORBIDDEN).toContain('Só quem administra a organização');
    expect(CLOSURE_TEXT.MACHINE_REVOKED.unknown).toContain('se o computador estava sem contato, a automação pode ter continuado');
  });

  it('reconciliação: quem não administra a organização vê o bloqueio e a quem cabe a declaração, mas a tela não oferece declarar', async () => {
    permissions(['automation.read', 'automation.execute', 'automation.manage', 'logs.read'], []);
    candidates = [candidate({ requestable: false, missing: ['MACHINE_UNCONFIRMED'] })];
    executions = [execution([attempt({ state: 'ENDED_UNKNOWN', startedAt: T, endedAt: T, closureCause: 'COMMUNICATION_LOST' })])];
    await open();
    const s = await waitFor(section);
    expect(within(s).getByText(RETRY_BLOCKED_TEXT)).toBeInTheDocument();
    expect(within(s).getByText(RECONCILE.ADMIN_ONLY)).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: RECONCILE.BUTTON })).toBeNull();
    expect(within(s).queryByRole('button', { name: 'Executar novamente em outra máquina' })).toBeNull();
  });

  it('reconciliação pela máquina e evidência tardia: a tela mostra as duas, ao lado, e diz quando a máquina ainda executa', async () => {
    candidates = [candidate({ requestable: false, missing: ['MACHINE_BUSY'] })];
    executions = [
      execution([attempt({ state: 'ENDED_UNKNOWN', startedAt: T, endedAt: T, closureCause: 'COMMUNICATION_LOST', machineStillRunningAt: T })]),
    ];
    await open();
    let s = await waitFor(section);
    expect(within(s).getByText(/a máquina voltou e informou que ainda executa esta tentativa\. Ela continua ocupada/)).toBeInTheDocument();
    expect(within(s).getByText(RETRY_BLOCKED_TEXT)).toBeInTheDocument();
    cleanup();
    executions = [
      execution([
        attempt({
          state: 'ENDED_UNKNOWN',
          startedAt: T,
          endedAt: T,
          closureCause: 'COMMUNICATION_LOST',
          lateReport: { state: 'SUCCEEDED', exitCode: 0, reportedAt: T },
          reconciliations: [
            { kind: 'MANUAL', at: T, reason: 'PROCESS_ENDED_BY_ADMINISTRATOR', verification: 'Processo encerrado no computador por quem o administra.', byMembershipId: '99999999-9999-4999-8999-999999999999' },
            { kind: 'MACHINE', at: T, reason: null, verification: null, byMembershipId: null },
          ],
        }),
      ]),
    ];
    await open();
    s = await waitFor(section);
    expect(within(s).getByText(/reconciliado manualmente em/)).toBeInTheDocument();
    expect(within(s).getByText(/a própria máquina confirmou que nenhum processo desta tentativa continua em execução nela\. O resultado continua não confirmado\./)).toBeInTheDocument();
    expect(within(s).getByText(/a máquina voltou e informou que/)).toBeInTheDocument();
    expect(within(s).queryByText(RETRY_BLOCKED_TEXT)).toBeNull();
  });

  it('finalizando: o processo principal terminou e há processos da automação ativos — o desfecho fica dito, a máquina continua ocupada e a repetição bloqueada', async () => {
    candidates = [
      candidate({ requestable: false, missing: ['MACHINE_FINISHING'] }),
      candidate({ agentId: AG2, agentName: 'ESTACAO-02', workerId: W2, workerName: 'Worker fiscal' }),
    ];
    executions = [execution([attempt({ state: 'SUCCEEDED', exitCode: 0, startedAt: T, endedAt: T, processes: 'ACTIVE', processesAt: T })])];
    await open();
    let s = await waitFor(section);
    // o desfecho e o código de saída do processo principal continuam na tela
    expect(within(s).getAllByText('Concluída').length).toBeGreaterThan(0);
    expect(within(s).getByText(/código de saída 0/)).toBeInTheDocument();
    expect(within(s).getByText('Finalizando')).toBeInTheDocument();
    expect(within(s).getByText(new RegExp('^' + PROCESSES_TEXT.ACTIVE.slice(0, 60)))).toBeInTheDocument();
    expect(PROCESSES_TEXT.ACTIVE).toMatch(/^Finalizando — processos da automação ainda ativos/);
    // a máquina: ocupada, com o que a faz voltar; sem solicitar
    expect(within(s).getByText(MISSING.MACHINE_FINISHING)).toBeInTheDocument();
    expect(within(s).getByText('Volta a poder receber quando esses processos terminarem nesse computador.')).toBeInTheDocument();
    // repetir está bloqueado, com o motivo próprio; quem administra pode declarar
    expect(within(s).getByText(RETRY_BLOCKED_PROCESSES_TEXT)).toBeInTheDocument();
    expect(within(s).queryByText(RETRY_BLOCKED_TEXT)).toBeNull();
    expect(within(s).queryByRole('button', { name: 'Executar novamente em outra máquina' })).toBeNull();
    expect(within(s).getByRole('button', { name: RECONCILE.BUTTON })).toBeInTheDocument();
    expect(REQUEST_REFUSAL.remote_machine_finishing).toBe(MISSING.MACHINE_FINISHING);
    expect(REQUEST_REFUSAL.remote_previous_processes_pending).toContain('executar novamente está bloqueado');
    cleanup();
    // a própria máquina confirmou que acabaram: nada de finalizando, e a repetição volta
    candidates = [candidate()];
    executions = [
      execution([
        attempt({ state: 'SUCCEEDED', exitCode: 0, startedAt: T, endedAt: T, reconciliations: [{ kind: 'MACHINE', at: T, reason: null, verification: null, byMembershipId: null }] }),
      ]),
    ];
    await open();
    s = await waitFor(section);
    expect(within(s).queryByText('Finalizando')).toBeNull();
    expect(within(s).getByText(/a própria máquina confirmou que nenhum processo desta tentativa continua em execução nela\.$/)).toBeInTheDocument();
    expect(within(s).queryByText(RETRY_BLOCKED_PROCESSES_TEXT)).toBeNull();
    expect(within(s).getByRole('button', { name: 'Executar novamente em outra máquina' })).toBeInTheDocument();
  });

  it('ocupação incerta: a máquina que dizia "ainda executa" e depois informou o fim sem confirmar os processos não aparece como em andamento', async () => {
    candidates = [candidate({ requestable: false, missing: ['MACHINE_UNCONFIRMED'] })];
    executions = [
      execution([attempt({ state: 'ENDED_UNKNOWN', startedAt: T, endedAt: T, closureCause: 'COMMUNICATION_LOST', machineStillRunningAt: null, processes: 'UNCERTAIN', processesAt: T })]),
    ];
    await open();
    const s = await waitFor(section);
    expect(within(s).getByText(MISSING.MACHINE_UNCONFIRMED)).toBeInTheDocument();
    expect(MISSING.MACHINE_UNCONFIRMED).toMatch(/^Ocupação incerta/);
    expect(within(s).queryByText(MISSING.MACHINE_BUSY)).toBeNull();
    expect(within(s).getByText('Ocupação incerta')).toBeInTheDocument();
    expect(within(s).getByText(new RegExp('^' + PROCESSES_TEXT.UNCERTAIN.slice(0, 60)))).toBeInTheDocument();
    expect(PROCESSES_TEXT.UNCERTAIN).toMatch(/o tempo, um novo contato e a declaração de reconciliação não a liberam/);
    expect(within(s).queryByText(/ainda executa esta tentativa/)).toBeNull();
    expect(within(s).getByText(RETRY_BLOCKED_TEXT)).toBeInTheDocument();
  });

  it('disponibilidade: a máquina que informou estar ocupada, ou com pouco espaço, aparece assim - sem detalhe do que ela faz - e sem solicitar', async () => {
    candidates = [candidate({ requestable: false, missing: ['MACHINE_OCCUPIED', 'MACHINE_DISK_PRESSURE'] })];
    await open();
    const s = await waitFor(section);
    expect(within(s).getByText(MISSING.MACHINE_OCCUPIED)).toBeInTheDocument();
    expect(MISSING.MACHINE_OCCUPIED).toBe('Esta máquina informou que está ocupada. A Platform não recebe detalhes do que ela está fazendo.');
    expect(within(s).getByText('Volta a poder receber quando o aplicativo desse computador informar que está livre.')).toBeInTheDocument();
    expect(within(s).getByText(MISSING.MACHINE_DISK_PRESSURE)).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: /^Solicitar execução/ })).toBeNull();
  });

  it('Python da automação por máquina: mostra o escolhido, diz quando falta e só quem gerencia escolhe, do que a máquina informou', async () => {
    candidates = [
      candidate({ requestable: false, missing: ['PYTHON_NOT_SELECTED'], python: null }),
      candidate({
        agentId: AG2,
        agentName: 'ESTACAO-02',
        workerId: W2,
        requestable: false,
        missing: ['PYTHON_NOT_IN_INVENTORY'],
        python: { environmentId: ENV_B, pythonVersion: '3.11.9', inInventory: false, selectedAt: T },
      }),
    ];
    const PY = `/api/v1/o/${ORG}/workspaces/${WS}/remote-machines/${AG1}/python-environments`;
    api.on('GET', PY, 'listRemoteMachinePythonEnvironments', {
      status: 200,
      body: {
        items: [
          { environmentId: ENV_A, pythonVersion: '3.12.10', kind: 'INSTALLATION', observedAt: T, reportedAt: T },
          { environmentId: ENV_B, pythonVersion: '3.12.10', kind: 'VIRTUAL_ENVIRONMENT', observedAt: T, reportedAt: T },
        ],
      },
    });
    const PUT = `/api/v1/o/${ORG}/automations/${AUT}/remote-machines/${AG1}/python-selection`;
    api.on('PUT', PUT, 'selectRemoteMachinePython', () => {
      candidates = [candidate()];
      return { status: 200, body: { environmentId: ENV_B, pythonVersion: '3.12.10', inInventory: true, selectedAt: T } };
    });
    await open();
    const s = await waitFor(section);
    const rows = within(within(s).getByRole('table', { name: /Máquinas habilitadas do workspace/ })).getAllByRole('row');
    expect(within(rows[1]).getByText('Não escolhido')).toBeInTheDocument();
    expect(within(rows[1]).getByText(MISSING.PYTHON_NOT_SELECTED)).toBeInTheDocument();
    expect(within(rows[2]).getByText('Python 3.11.9 · código BBBBBB')).toBeInTheDocument();
    expect(within(rows[2]).getByText('A máquina não informa mais este Python.')).toBeInTheDocument();
    expect(within(rows[2]).getByText(MISSING.PYTHON_NOT_IN_INVENTORY)).toBeInTheDocument();
    expect(within(rows[2]).getByRole('button', { name: 'Trocar o Python de ESTACAO-02' })).toBeInTheDocument();
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Escolher o Python de ESTACAO-01' }));
    expect(within(dialog()).getByText(/nunca um caminho\. Nada é\s+instalado/)).toBeInTheDocument();
    const select = (await within(dialog()).findByLabelText('Python da máquina')) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent ?? '');
    // duas com a mesma versão: o tipo e o CÓDIGO distinguem (T06); o identificador opaco inteiro não é mostrado
    expect(options.filter((o) => o.includes('Python 3.12.10'))).toHaveLength(2);
    expect(options.some((o) => o.includes('Python 3.12.10') && o.includes('código AAAAAA'))).toBe(true);
    expect(options.some((o) => o.includes('Python 3.12.10') && o.includes('código BBBBBB'))).toBe(true);
    expect(options.some((o) => /nº \d/.test(o))).toBe(false);
    expect(within(dialog()).getByText(/O mesmo código aparece no computador/)).toBeInTheDocument();
    expect(environmentCode(ENV_A)).toBe('AAAAAA');
    expect(options.some((o) => o.includes('instalação'))).toBe(true);
    expect(options.some((o) => o.includes('ambiente virtual'))).toBe(true);
    expect(options.join(' ')).not.toContain(ENV_A);
    expect(within(dialog()).getByRole('button', { name: 'Escolher este Python' })).toBeDisabled();
    fireEvent.change(select, { target: { value: ENV_B } });
    await confirmIn('Escolher este Python');
    expect(await screen.findByText('Python 3.12.10 escolhido para esta automação em ESTACAO-01.')).toBeInTheDocument();
    expect(api.sent('PUT', PUT)[0].body).toEqual({ environmentId: ENV_B });
    await waitFor(() => expect(within(section()).getByText('Pode solicitar')).toBeInTheDocument());
  });

  it('verificação de dependências sob demanda: pede à máquina, mostra o que ela respondeu e nunca diz incompatível sem resposta', async () => {
    const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
    candidates = [
      candidate(),
      candidate({ agentId: AG2, agentName: 'ESTACAO-02', workerId: W2, dependencyCheck: check({ outcome: 'MISSING', missing: ['requests==2.32.3', 'idna==3.7'] }) }),
      candidate({ agentId: id(3), agentName: 'ESTACAO-03', dependencyCheck: check({ state: 'UNANSWERED', outcome: null, answeredAt: null }) }),
      candidate({ agentId: id(4), agentName: 'ESTACAO-04', dependencyCheck: check({ state: 'PENDING', outcome: null, answeredAt: null }) }),
      candidate({ agentId: id(5), agentName: 'ESTACAO-05', dependencyCheck: check({ current: false }) }),
      candidate({ agentId: id(6), agentName: 'ESTACAO-06', requestable: false, missing: ['PYTHON_NOT_SELECTED'], python: null }),
    ];
    let status = 201;
    const POST = `/api/v1/o/${ORG}/automations/${AUT}/remote-machines/${AG1}/dependency-check`;
    api.on('POST', POST, 'checkRemoteMachineDependencies', () => {
      if (status !== 201) return { status, body: status === 429 ? { error: 'rate_limited', reason: 'remote_dependency_check_too_soon' } : { error: 'conflict', reason: 'remote_python_not_in_inventory' } };
      candidates = [candidate({ dependencyCheck: check({ state: 'PENDING', outcome: null, answeredAt: null }) }), ...candidates.slice(1)];
      return { status: 201, body: check({ state: 'PENDING', outcome: null, answeredAt: null }) };
    });
    await open();
    const s = await waitFor(section);
    const rows = within(within(s).getByRole('table', { name: /Máquinas habilitadas do workspace/ })).getAllByRole('row');
    // nunca verificado; faltam (com a lista, e dito que nada é instalado); sem resposta; aguardando; verificação de outra configuração
    expect(within(rows[1]).getByText(DEPENDENCY_CHECK.NONE)).toBeInTheDocument();
    expect(within(rows[2]).getByText(/Faltam neste Python: requests==2\.32\.3, idna==3\.7\. A Platform não instala nada/)).toBeInTheDocument();
    expect(within(rows[3]).getByText(DEPENDENCY_CHECK.UNANSWERED)).toBeInTheDocument();
    expect(within(rows[4]).getByText(DEPENDENCY_CHECK.PENDING)).toBeInTheDocument();
    expect(within(rows[5]).getByText(new RegExp(DEPENDENCY_CHECK.STALE.slice(0, 40)))).toBeInTheDocument();
    // sem resposta e sem conseguir conferir: "não foi possível verificar", nunca "incompatível" como veredito
    for (const t of [DEPENDENCY_CHECK.UNANSWERED, DEPENDENCY_CHECK.NOT_VERIFIED, DEPENDENCY_CHECK.TOO_SOON]) {
      expect(t.startsWith('Não foi possível verificar')).toBe(true);
    }
    expect(DEPENDENCY_CHECK.UNANSWERED).toMatch(/não quer dizer que o Python seja incompatível/);
    expect(dependencyCheckText(null)).toBe(DEPENDENCY_CHECK.NONE);
    expect(dependencyCheckText(check({ outcome: 'ENVIRONMENT_GONE' }) as never)).toBe(DEPENDENCY_CHECK.ENVIRONMENT_GONE);
    expect(dependencyCheckText(check({ outcome: 'NOT_VERIFIED' }) as never)).toBe(DEPENDENCY_CHECK.NOT_VERIFIED);
    expect(DEPENDENCY_CHECK.SATISFIED).toMatch(/A máquina confere de novo antes de iniciar/);
    // o botão: só onde há Python escolhido, e não enquanto um pedido aguarda resposta
    expect(within(rows[1]).getByRole('button', { name: 'Verificar as dependências em ESTACAO-01' })).toBeInTheDocument();
    expect(within(rows[4]).queryByRole('button', { name: /Verificar as dependências/ })).toBeNull();
    expect(within(rows[6]).queryByRole('button', { name: /Verificar as dependências/ })).toBeNull();
    // o limite de um pedido por minuto: dito como "não foi possível verificar agora", nada muda
    status = 429;
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Verificar as dependências em ESTACAO-01' }));
    expect(await screen.findByText(DEPENDENCY_CHECK.TOO_SOON)).toBeInTheDocument();
    // outra recusa do servidor: o motivo dela
    status = 409;
    fireEvent.click(within(section()).getByRole('button', { name: 'Verificar as dependências em ESTACAO-01' }));
    expect(await screen.findByText(/Esse Python não está mais entre os que a máquina informou/)).toBeInTheDocument();
    // pedido aceito: a tela diz que o resultado vem depois, e a linha passa a aguardar
    status = 201;
    fireEvent.click(within(section()).getByRole('button', { name: 'Verificar as dependências em ESTACAO-01' }));
    expect(await screen.findByText(/Verificação pedida a ESTACAO-01\. O resultado aparece na linha dela quando a máquina responder/)).toBeInTheDocument();
    expect(api.sent('POST', POST).length).toBe(3);
    await waitFor(() => expect(within(section()).queryByRole('button', { name: 'Verificar as dependências em ESTACAO-01' })).toBeNull());
  });

  it('quem não executa a automação vê o resultado da verificação, sem o botão de verificar', async () => {
    permissions(['automation.read', 'automation.manage']);
    candidates = [candidate({ dependencyCheck: check() })];
    await open();
    const s = await waitFor(section);
    expect(within(s).getByText(new RegExp(DEPENDENCY_CHECK.SATISFIED.slice(0, 40)))).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: /Verificar as dependências/ })).toBeNull();
  });

  it('quem não gerencia a automação vê o Python escolhido e o que falta, sem o botão de escolher', async () => {
    permissions(['automation.read', 'automation.execute']);
    candidates = [candidate({ requestable: false, missing: ['PYTHON_NOT_SELECTED'], python: null })];
    await open();
    const s = await waitFor(section);
    expect(within(s).getByText('Não escolhido')).toBeInTheDocument();
    expect(within(s).getByText('Peça a quem gerencia esta automação.')).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: /o Python de/ })).toBeNull();
  });

  it('resultados: quem pode ver registros lista os arquivos da tentativa que executou, com o que ficou de fora e o que foi removido', async () => {
    permissions(['automation.read', 'automation.execute', 'logs.read']);
    const ATT = '77777777-7777-4777-8777-777777777777';
    const SHA_A = 'c'.repeat(64);
    candidates = [candidate()];
    executions = [execution([attempt({ state: 'SUCCEEDED', exitCode: 0, startedAt: T, endedAt: T })])];
    const RES = `/api/v1/o/${ORG}/remote-executions/${X1}/attempts/${ATT}/results`;
    let closure: Row | null = null;
    let retentionLoss: Row | null = null;
    let resultsExpiration: Row | null = null;
    api.on('GET', RES, 'listRemoteAttemptResults', () => ({
      status: 200,
      body: {
        attemptId: ATT,
        items: [
          { number: 1, fileName: 'dados/relatório final.csv', sizeBytes: 2048, sha256: SHA_A, receivedAt: T, available: true },
          { number: 2, fileName: 'antigo.txt', sizeBytes: 3, sha256: 'd'.repeat(64), receivedAt: T, available: false },
        ],
        closure,
        retentionLoss,
        expiration: resultsExpiration,
      },
    }));
    api.on('GET', `${RES}/1/content`, 'downloadRemoteAttemptResult', { status: 409, body: { error: 'conflict', reason: 'remote_result_unavailable' } });
    await open();
    const s = await waitFor(section);
    // nada é lido antes de a pessoa pedir
    expect(api.sent('GET', RES)).toHaveLength(0);
    fireEvent.click(within(s).getByRole('button', { name: 'Ver resultados da tentativa 1' }));
    const list = await within(s).findByRole('list', { name: 'Resultados da tentativa 1' });
    expect(within(list).getByText('dados/relatório final.csv · 2,0 KiB')).toBeInTheDocument();
    expect(within(list).getByText('antigo.txt · 3 B')).toBeInTheDocument();
    expect(within(list).getByText(/O arquivo expirou e foi removido da Platform; ficou só o registro/)).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Baixar antigo.txt' })).toBeNull();
    // envio ainda não fechado: a tela não afirma que a lista está completa
    expect(within(s).getByText(/ainda não informou que terminou de enviar os resultados/)).toBeInTheDocument();
    // o arquivo não está mais guardado: nada é baixado, e a tela diz
    fireEvent.click(within(list).getByRole('button', { name: 'Baixar dados/relatório final.csv' }));
    expect(await within(s).findByText('O arquivo não está mais guardado na Platform. Nada foi baixado.')).toBeInTheDocument();
    // a máquina fechou o envio dizendo que 2 arquivos ficaram de fora por limite
    closure = { sent: 2, skippedByLimit: 2, closedAt: T };
    fireEvent.click(within(s).getByRole('button', { name: 'Atualizar os resultados da tentativa 1' }));
    expect(await within(s).findByText(/2 arquivos não foram enviados/)).toBeInTheDocument();
    expect(within(s).getByText(/Isso não muda o resultado da execução/)).toBeInTheDocument();
    expect(within(s).queryByText(/ainda não informou que terminou/)).toBeNull();
    expect(within(s).queryByText(/removeu a pasta de saída/)).toBeNull();
    // a máquina avisa que removeu, pelo prazo de guarda dela, a pasta de saída sem confirmação: a lacuna aparece, com o que havia lá
    // e o que a Platform tem - e nada disso vira "entregue"
    retentionLoss = { localCount: 4, reportedAt: '2026-11-23T15:00:00Z' };
    fireEvent.click(within(s).getByRole('button', { name: 'Atualizar os resultados da tentativa 1' }));
    const lost = await within(s).findByText(/removeu a pasta de saída desta execução/);
    expect(lost.textContent).toMatch(/venceu o prazo de guarda dela sem a Platform ter\s+confirmado o recebimento de tudo/);
    expect(lost.textContent).toMatch(/Havia 4 arquivos lá; a\s+Platform tem 2\./);
    expect(lost.textContent).toMatch(/não pode mais ser recuperado pela Platform/);
    expect(lost.textContent).toMatch(/Isso não muda o\s+resultado da execução/);
    // o estado da execução continua o que a máquina informou
    expect(within(s).getAllByText('Concluída').length).toBeGreaterThan(0);
    // retenção do servidor: a tela diz que os arquivos expiraram, o prazo, de onde ele contou e o que ficou
    expect(within(s).queryByText(/arquivos de resultado expiraram/)).toBeNull();
    resultsExpiration = { ...EXPIRED, items: 2, deliveryEnd: 'LOSS_NOTICE' };
    fireEvent.click(within(s).getByRole('button', { name: 'Atualizar os resultados da tentativa 1' }));
    const expired = await within(s).findByText(/2 arquivos de resultado expiraram em 23\/12\/2026 e foram removidos da Platform\./);
    expect(expired.textContent).toMatch(/por 30 dias depois do fim da entrega \(a máquina avisou que não tinha mais o que enviar em 23\/11\/2026\)/);
    expect(expired.textContent).toMatch(/Ficam o nome, o tamanho e o SHA-256 de cada arquivo\. O histórico e o resultado da execução não mudam\./);
    expect(resultsExpiredText({ ...EXPIRED, items: 1, confirmedAt: null })).toMatch(/^1 arquivo de resultado expirou em 23\/12\/2026; a remoção está em andamento\./);
  });

  it('registros: quem pode ver registros lê a saída do processo em páginas, com canal, linha cortada, texto removido e o que foi descartado', async () => {
    permissions(['automation.read', 'automation.execute', 'logs.read']);
    const ATT = '77777777-7777-4777-8777-777777777777';
    candidates = [candidate()];
    // execução ainda em andamento: os registros já podem ser lidos; os resultados, não
    executions = [execution([attempt({ state: 'RUNNING', startedAt: T })])];
    const LOGS = `/api/v1/o/${ORG}/remote-executions/${X1}/attempts/${ATT}/logs`;
    const line = (sequence: number, channel: string, message: string, over: Row = {}): Row => ({
      sequence,
      capturedAt: T,
      channel,
      level: 'UNKNOWN',
      truncated: false,
      message,
      textRemoved: false,
      ...over,
    });
    const pages: Row[] = [
      {
        attemptId: ATT,
        items: [
          line(1, 'STDOUT', 'iniciando <b>não é HTML</b>'),
          line(2, 'STDERR', 'Traceback (most recent call last):'),
          line(3, 'STDOUT', 'x'.repeat(40), { truncated: true }),
          line(4, 'STDOUT', '', { textRemoved: true }),
        ],
        total: 6, automationLines: 5, systemLines: 1,
        nextAfter: 4,
        closure: null,
        retentionLoss: null, expiration: null,
      },
      { attemptId: ATT, items: [line(5, 'EXECUTOR', 'Limite de registros desta execução atingido'), line(6, 'STDOUT', 'fim')], total: 6, automationLines: 5, systemLines: 1, nextAfter: null, closure: null, retentionLoss: null, expiration: null },
      { attemptId: ATT, items: [], total: 6, automationLines: 5, systemLines: 1, nextAfter: null, closure: { lines: 6, droppedLines: 73000, closedAt: T }, retentionLoss: null, expiration: null },
      { attemptId: ATT, items: [], total: 6, automationLines: 5, systemLines: 1, nextAfter: null, closure: null, retentionLoss: { localCount: 1500, reportedAt: '2026-11-23T15:00:00Z' }, expiration: null },
      { attemptId: ATT, items: [], total: 6, automationLines: 5, systemLines: 1, nextAfter: null, closure: { lines: 6, droppedLines: 0, closedAt: T }, retentionLoss: null, expiration: EXPIRED },
    ];
    api.on('GET', LOGS, 'listRemoteAttemptLogs', (_call, n) => ({ status: 200, body: pages[Math.min(n, pages.length - 1)] }));
    await open();
    const s = await waitFor(section);
    // nada é lido antes de a pessoa pedir; em andamento não há resultados a oferecer
    expect(api.sent('GET', LOGS)).toHaveLength(0);
    expect(within(s).queryByRole('button', { name: /Ver resultados/ })).toBeNull();
    fireEvent.click(within(s).getByRole('button', { name: 'Ver registros da tentativa 1' }));
    const list = await within(s).findByRole('list', { name: 'Registros da tentativa 1' });
    // o texto é mostrado como texto, nunca interpretado
    expect(within(list).getByText('iniciando <b>não é HTML</b>')).toBeInTheDocument();
    expect(list.querySelector('b')).toBeNull();
    // saída de erro é canal, não nível: a tela diz isso e não conclui falha
    expect(within(list).getByText(/2 · .* · saída de erro$/)).toBeInTheDocument();
    expect(within(s).getByText(/sozinho, não indica falha/)).toBeInTheDocument();
    expect(within(list).getByText(/3 · .* · saída · linha cortada no limite de 8 KiB/)).toBeInTheDocument();
    expect(within(list).getByText(/O texto desta linha expirou e foi removido da Platform/)).toBeInTheDocument();
    expect(within(s).getByText(/Mostrando 4 de 6 linhas na Platform/)).toBeInTheDocument();
    expect(within(s).getByText(/ainda não informou que terminou de enviar os registros/)).toBeInTheDocument();
    // página seguinte, pela sequência
    fireEvent.click(within(s).getByRole('button', { name: 'Carregar mais registros da tentativa 1' }));
    expect(await within(list).findByText('fim')).toBeInTheDocument();
    expect(within(list).getByText(/5 · .* · aplicativo da máquina$/)).toBeInTheDocument();
    expect(within(s).getByText(/^6 linhas na Platform\./)).toBeInTheDocument();
    // o que a automação escreveu e o aviso do aplicativo da máquina são contados separados
    expect(within(s).getByText(/5 linhas são da automação e 1 é aviso do aplicativo da máquina\./)).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    // a máquina fecha o envio dizendo quantas linhas descartou por limite: a tela diz, e diz que o resultado não mudou
    fireEvent.click(within(s).getByRole('button', { name: 'Atualizar os registros da tentativa 1' }));
    expect(await within(s).findByText(/73\.000 linhas da automação não foram guardadas/)).toBeInTheDocument();
    // a conta fecha: escritas = guardadas + descartadas (o aviso do aplicativo não entra)
    expect(within(s).getByText(/A automação escreveu 73\.005 linhas: 5 guardadas e 73\.000 descartadas\./)).toBeInTheDocument();
    expect(within(s).getByText(/A execução continuou e o resultado dela não mudou/)).toBeInTheDocument();
    expect(within(s).queryByText(/ainda não informou que terminou de enviar os registros/)).toBeNull();
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    expect(api.sent('GET', LOGS)).toHaveLength(3);
    expect(within(s).queryByText(/removeu os registros que ainda guardava/)).toBeNull();
    // a máquina avisa que removeu, pelo prazo de guarda dela, registros sem confirmação: a tela diz quanto ela tinha e quanto a
    // Platform tem, sem dar o que falta por entregue
    fireEvent.click(within(s).getByRole('button', { name: 'Atualizar os registros da tentativa 1' }));
    const lost = await within(s).findByText(/removeu os registros que ainda guardava desta execução/);
    expect(lost.textContent).toMatch(/Ela tinha capturado 1\.500 linhas; a Platform tem 6\./);
    expect(lost.textContent).toMatch(/não pode mais ser recuperado pela Platform/);
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    expect(within(s).queryByText(/expirou em/)).toBeNull();
    // retenção do servidor: a tela diz que o conteúdo expirou, o prazo, de onde ele contou e o que ficou
    fireEvent.click(within(s).getByRole('button', { name: 'Atualizar os registros da tentativa 1' }));
    const expired = await within(s).findByText(/O texto de 6 linhas expirou em 23\/12\/2026 e foi removido da Platform\./);
    expect(expired.textContent).toMatch(/guarda esse conteúdo por 30 dias depois do fim da entrega \(a máquina concluiu o envio em 23\/11\/2026\)/);
    expect(expired.textContent).toMatch(/Fica o registro de que cada linha existiu.*O histórico e o resultado da execução não mudam\./);
    expect(logsExpiredText({ ...EXPIRED, confirmedAt: null, items: 1, deliveryEnd: 'LINK_ENDED' })).toMatch(
      /^O texto de 1 linha expirou em 23\/12\/2026; a remoção está em andamento\. .*o vínculo da máquina foi encerrado em 23\/11\/2026/,
    );
    expect(storedText(49999, 1)).toBe('49.999 linhas são da automação e 1 é aviso do aplicativo da máquina.');
    expect(writtenText(49999, 603, false)).toBe('A automação escreveu 50.602 linhas: 49.999 guardadas e 603 descartadas.');
  });

  it('registros: sem permissão, ou em tentativa que não iniciou, a tela não oferece; sem leitura, diz que não leu', async () => {
    candidates = [candidate()];
    executions = [execution([attempt({ state: 'FAILED', exitCode: 3, startedAt: T, endedAt: T })])];
    await open();
    let s = await waitFor(section);
    expect(within(s).queryByRole('button', { name: /Ver registros/ })).toBeNull();
    cleanup();
    permissions(['automation.read', 'automation.execute', 'logs.read']);
    executions = [execution([attempt({ state: 'REFUSED', refusalReason: 'SESSION_UNAVAILABLE', endedAt: T })])];
    await open();
    s = await waitFor(section);
    expect(within(s).queryByRole('button', { name: /Ver registros/ })).toBeNull();
    cleanup();
    executions = [execution([attempt({ state: 'FAILED', exitCode: 3, startedAt: T, endedAt: T })])];
    api.on('GET', `/api/v1/o/${ORG}/remote-executions/${X1}/attempts/77777777-7777-4777-8777-777777777777/logs`, 'listRemoteAttemptLogs', {
      status: 429,
      body: { error: 'rate_limited' },
    });
    await open();
    s = await waitFor(section);
    fireEvent.click(within(s).getByRole('button', { name: 'Ver registros da tentativa 1' }));
    expect(await within(s).findByText('Muitos pedidos seguidos. Aguarde um pouco e tente de novo.')).toBeInTheDocument();
    // a falha de leitura não muda o que a tela diz da execução
    expect(within(s).getAllByText(/Falhou/).length).toBeGreaterThan(0);
    expect(within(s).getByText(/código de saída 3/)).toBeInTheDocument();
  });

  it('resultados: sem permissão de ver registros, ou em tentativa que não executou, a tela não oferece os arquivos', async () => {
    candidates = [candidate()];
    executions = [execution([attempt({ state: 'SUCCEEDED', exitCode: 0, startedAt: T, endedAt: T })])];
    await open();
    const s = await waitFor(section);
    expect(within(s).getAllByText('Concluída').length).toBeGreaterThan(0);
    expect(within(s).queryByRole('button', { name: /Ver resultados/ })).toBeNull();
  });

  it('resultados: tentativa recusada antes de iniciar não tem o que mostrar', async () => {
    permissions(['automation.read', 'automation.execute', 'logs.read']);
    candidates = [candidate()];
    executions = [execution([attempt({ state: 'REFUSED', refusalReason: 'SESSION_UNAVAILABLE', endedAt: T })])];
    await open();
    const s = await waitFor(section);
    expect(within(s).getByText(/a tela do Windows estava bloqueada/)).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: /Ver resultados/ })).toBeNull();
  });

  it('sem máquina habilitada e sem solicitação, ou numa Platform sem o recurso: a seção não aparece', async () => {
    await open();
    await waitFor(() => expect(api.sent('GET', new RegExp(`^${CANDIDATES}`)).length).toBeGreaterThan(0));
    expect(screen.queryByRole('heading', { name: 'Execução remota' })).toBeNull();
  });

  it('Platform sem o recurso (404): a seção não aparece e a página segue', async () => {
    api.on('GET', new RegExp(`^${CANDIDATES}`), 'listRemoteExecutionCandidates', { status: 404, body: { error: 'not_found' } });
    await open();
    await waitFor(() => expect(api.sent('GET', new RegExp(`^${CANDIDATES}`)).length).toBeGreaterThan(0));
    expect(screen.queryByRole('heading', { name: 'Execução remota' })).toBeNull();
    expect(screen.getByRole('heading', { name: /Autorizações de execução local/ })).toBeInTheDocument();
  });
});
