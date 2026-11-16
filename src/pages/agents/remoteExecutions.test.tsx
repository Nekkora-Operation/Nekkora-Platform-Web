import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { ATTEMPT_STATE, ENDED_UNKNOWN_TEXT, MISSING, REQUEST_REFUSAL, environmentCode } from './RemoteExecutions';
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
    expect(within(missing).getByText(/retomado no próprio computador/)).toBeInTheDocument();
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
    executions = [execution([attempt({ state: 'ENDED_UNKNOWN', endedAt: T })])];
    api.on('POST', `/api/v1/o/${ORG}/remote-executions/${X1}/attempts`, 'retryRemoteExecution', () => {
      executions = [execution([attempt({ state: 'ENDED_UNKNOWN', endedAt: T }), attempt({ attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attemptNumber: 2, agentId: AG2, agentName: 'ESTACAO-02' })])];
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
    expect(within(list).getByText(/foi removido da Platform; ficou só o registro/)).toBeInTheDocument();
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
        total: 6,
        nextAfter: 4,
        closure: null,
        retentionLoss: null,
      },
      { attemptId: ATT, items: [line(5, 'EXECUTOR', 'Limite de registros desta execução atingido'), line(6, 'STDOUT', 'fim')], total: 6, nextAfter: null, closure: null, retentionLoss: null },
      { attemptId: ATT, items: [], total: 6, nextAfter: null, closure: { lines: 6, droppedLines: 73000, closedAt: T }, retentionLoss: null },
      { attemptId: ATT, items: [], total: 6, nextAfter: null, closure: null, retentionLoss: { localCount: 1500, reportedAt: '2026-11-23T15:00:00Z' } },
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
    expect(within(list).getByText(/O texto desta linha foi removido da Platform/)).toBeInTheDocument();
    expect(within(s).getByText(/Mostrando 4 de 6 linhas na Platform/)).toBeInTheDocument();
    expect(within(s).getByText(/ainda não informou que terminou de enviar os registros/)).toBeInTheDocument();
    // página seguinte, pela sequência
    fireEvent.click(within(s).getByRole('button', { name: 'Carregar mais registros da tentativa 1' }));
    expect(await within(list).findByText('fim')).toBeInTheDocument();
    expect(within(list).getByText(/5 · .* · aplicativo da máquina$/)).toBeInTheDocument();
    expect(within(s).getByText(/^6 linhas na Platform\./)).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    // a máquina fecha o envio dizendo quantas linhas descartou por limite: a tela diz, e diz que o resultado não mudou
    fireEvent.click(within(s).getByRole('button', { name: 'Atualizar os registros da tentativa 1' }));
    expect(await within(s).findByText(/73\.000 linhas não foram guardadas/)).toBeInTheDocument();
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
