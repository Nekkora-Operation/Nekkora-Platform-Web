import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { MISSING } from './RemoteExecutions';

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
const SHA = 'a'.repeat(64);
const FP = 'b'.repeat(64);
const CANDIDATES = `/api/v1/o/${ORG}/workspaces/${WS}/remote-executions/candidates`;
const LIST = `/api/v1/o/${ORG}/workspaces/${WS}/remote-executions`;

let api: RouteApi;
type Row = Record<string, unknown>;
let candidates: Row[];
let executions: Row[];

const candidate = (over: Row = {}): Row => ({
  agentId: AG1,
  agentName: 'ESTACAO-01',
  workerId: W1,
  workerName: 'Worker financeiro',
  requestable: true,
  missing: [],
  authorization: { authorizationId: AUTHZ, validUntil: '2026-12-10T10:00:00Z', status: 'VALID' },
  ...over,
});
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
  candidates = [];
  executions = [];
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
  api.on('GET', `/api/v1/o/${ORG}/automation-versions/${VERSION}`, 'getAutomationVersion', {
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
        packageKind: 'STUDIO_PYTHON',
      },
      agentPackage: { fingerprintRule: 'nekkora-agent/package-fingerprint/1', fingerprint: FP },
      createdAt: T,
      publishedAt: T,
      publishedByMembershipId: VERSION,
    },
  });
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
    expect(within(missing).getByText(/retomado no próprio computador/)).toBeInTheDocument();
    expect(within(rows[2]).queryByRole('button', { name: /Solicitar execução/ })).toBeNull();
    expect(within(s).getByText(/Solicitar não é iniciar/)).toBeInTheDocument();
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
    expect(within(s).getByText(/Sem comunicação com a máquina no momento\. Isso não encerra a execução/)).toBeInTheDocument();
    expect(within(s).getAllByText('Em execução').length).toBeGreaterThan(0);
    expect(within(s).getByText(/código de saída 3/)).toBeInTheDocument();
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

  it('executar novamente em outra máquina: só depois do término, e só em máquina sem pendência', async () => {
    candidates = [
      candidate({ requestable: false, missing: ['AUTHORIZATION_MISSING'], authorization: null }),
      candidate({ agentId: AG2, agentName: 'ESTACAO-02', workerId: W2, workerName: 'Worker fiscal' }),
    ];
    executions = [execution([attempt({ state: 'ENDED_UNKNOWN', endedAt: T })])];
    api.on('POST', `/api/v1/o/${ORG}/remote-executions/${X1}/attempts`, 'retryRemoteExecution', () => {
      executions = [execution([attempt({ state: 'ENDED_UNKNOWN', endedAt: T }), attempt({ attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attemptNumber: 2, agentId: AG2, agentName: 'ESTACAO-02' })])];
      return { status: 201, body: executions[0] };
    });
    await open();
    const s = await waitFor(section);
    expect(within(s).getAllByText('Encerrada sem prova do resultado').length).toBeGreaterThan(0);
    fireEvent.click(within(s).getByRole('button', { name: 'Executar novamente em outra máquina' }));
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
