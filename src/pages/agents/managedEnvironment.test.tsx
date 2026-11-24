import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { MANAGED, MANAGED_REQUEST_REFUSAL, STALE_REASON, deriveManagedSteps, normalizeName } from './ManagedEnvironment';
import { MANAGED_REDECLARE_TEXT } from '../product/RuntimeRequirements';
import type { RemoteAttempt } from '../../api/remoteExecutions';

/**
 * AMBIENTE-PYTHON-001 — dependências gerenciadas por execução, na página da versão (Execução remota), no detalhe da execução
 * remota e na declaração de dependências. Com a chave desligada, nada novo aparece e o pedido sai como hoje. Respostas por rota
 * conferidas contra o contrato (modo estrito).
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const VERSION = '22222222-3333-4444-8555-666666666666';
const AUT = '7f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const WS = '5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f';
const AG1 = '33333333-3333-4333-8333-333333333333';
const AG2 = '44444444-4444-4444-8444-444444444444';
const AG3 = '12121212-1212-4212-8212-121212121212';
const AG4 = '34343434-3434-4434-8434-343434343434';
const W1 = '11111111-1111-4111-8111-111111111111';
const X1 = '55555555-5555-4555-8555-555555555555';
const AUTHZ = '66666666-6666-4666-8666-666666666666';
const RES = '88888888-8888-4888-8888-888888888888';
const MAUTH = '99999999-9999-4999-8999-999999999999';
const ATT = '77777777-7777-4777-8777-777777777777';
const T = '2026-11-10T10:00:00Z';
const ENV_A = 'A'.repeat(43);
const SHA = 'a'.repeat(64);
const LOCK_SHA = 'c'.repeat(64);
const FP = 'b'.repeat(64);
const CANDIDATES = `/api/v1/o/${ORG}/workspaces/${WS}/remote-executions/candidates`;
const LIST = `/api/v1/o/${ORG}/workspaces/${WS}/remote-executions`;
const MENV = `/api/v1/o/${ORG}/automations/${AUT}/remote-machines/${AG1}/managed-environment`;

type Row = Record<string, unknown>;
let api: RouteApi;
let candidates: Row[];
let executions: Row[];
let managedOn: boolean;

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
const managedCandidate = (authorized: 'NONE' | 'CURRENT' | 'STALE', over: Row = {}) => candidate({ managedEnvironment: { compatible: true, authorized }, ...over });

const lockItem = (name: string, version: string, ch = 'd') => ({ name, version, sha256: ch.repeat(64), fileName: `${name.replace(/-/g, '_')}-${version}-py3-none-any.whl` });
const resolution = (over: Row = {}): Row => ({
  resolutionId: RES,
  state: 'ANSWERED',
  outcome: 'RESOLVED',
  requestedAt: T,
  answerValidUntil: '2026-11-10T10:30:00Z',
  waitingForExecution: false,
  answeredAt: '2026-11-10T10:00:40Z',
  pythonVersion: '3.12.10',
  pipVersion: '24.3.1',
  lock: [lockItem('requests', '2.32.3', 'd'), lockItem('urllib3', '2.2.3', 'e'), lockItem('certifi', '2024.8.30', 'f')],
  lockSha256: LOCK_SHA,
  failure: null,
  current: true,
  ...over,
});
const managedEnv = (over: Row = {}): Row => ({
  available: true,
  machineCompatible: true,
  baseEligible: true,
  basePython: { environmentId: ENV_A, pythonVersion: '3.12.10', kind: 'INSTALLATION' },
  requirements: { revision: 3, dependencies: ['requests==2.32.3'] },
  resolution: null,
  externalPrerequisites: [],
  authorization: null,
  ...over,
});

const attempt = (over: Row = {}): Row => ({
  attemptId: ATT,
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
  requirementsRevision: 3,
  dependencies: ['requests==2.32.3'],
  requestedAt: T,
  cancelRequestedAt: null,
  attempts,
  ...over,
});
const environment = (over: Row = {}): Row => ({
  lockSha256: LOCK_SHA,
  packages: 3,
  checks: [],
  stages: [],
  report: null,
  ...over,
});
const failedPreparation = () =>
  attempt({
    state: 'REFUSED',
    refusalReason: 'DEPENDENCY_INSTALL_FAILED',
    receivedAt: '2026-11-10T10:00:06Z',
    endedAt: '2026-11-10T10:00:50Z',
    environment: environment({
      stages: [
        { stage: 'ENV_CREATING', at: '2026-11-10T10:00:07Z' },
        { stage: 'DEPS_INSTALLING', at: '2026-11-10T10:00:15Z' },
      ],
      report: {
        outcome: 'FAILED',
        pythonVersion: '3.13.0',
        pipVersion: '24.3.1',
        installed: [],
        failure: { requirement: 'pandas==2.2.3', phase: 'NO_COMPATIBLE_WHEEL', summary: 'No matching distribution' },
        createMs: 8000,
        installMs: null,
        logAvailable: true,
        logExpiredAt: null,
        reportedAt: '2026-11-10T10:00:49Z',
      },
    }),
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
  managedOn = true;
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', () => ({
    status: 200,
    body: {
      accountType: 'internal',
      displayName: 'Ana',
      email: 'ana@empresa.com',
      organizationId: ORG,
      organizationActivationState: 'ATIVADA',
      remoteExecutionAvailable: true,
      ...(managedOn ? { managedEnvironmentAvailable: true } : {}),
      stepUpMethod: 'totp',
    },
  }));
  permissions(['automation.read', 'automation.manage', 'automation.execute', 'logs.read']);
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
        packageKind: 'EXTERNAL_PYTHON',
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
  return waitFor(() => screen.getByRole('heading', { name: 'Execução remota' }).closest('section')!);
};
const dialog = () => screen.getByRole('alertdialog');
/** Folga para a suíte completa (máquina carregada): o diálogo com a tabela e a confirmação demoram mais. */
const SLOW = { timeout: 8_000 };
async function confirmIn(label: string) {
  const button = within(dialog()).getByRole('button', { name: label });
  await waitFor(() => expect(button).toBeEnabled(), SLOW);
  fireEvent.click(button);
}
/** Marca o consentimento quando a caixa já está habilitada (as permissões chegam por outra leitura) e confere que ficou marcada. */
async function consentir(d: HTMLElement) {
  const box = within(d).getByRole('checkbox', { name: /Autorizo instalar estes 3 pacotes/ });
  await waitFor(() => expect(box).toBeEnabled(), SLOW);
  fireEvent.click(box);
  await waitFor(() => expect(box).toBeChecked(), SLOW);
}
const openManaged = async (s: HTMLElement, agent = 'ESTACAO-01') => {
  fireEvent.click(await within(s).findByRole('button', { name: `Ambiente por execução em ${agent}` }, SLOW));
  return dialog();
};

describe('AMBIENTE-PYTHON-001: chave desligada (regressão)', () => {
  it('sem managedEnvironmentAvailable, a lista de máquinas, a solicitação e a tentativa ficam como hoje', async () => {
    managedOn = false;
    // mesmo que a API mande o campo, a tela não mostra nada novo sem a chave
    candidates = [managedCandidate('CURRENT')];
    executions = [execution([attempt()])];
    api.on('POST', LIST, 'requestRemoteExecution', () => ({ status: 201, body: execution([attempt()]) }));
    const s = await open();
    const table = within(s).getByRole('table', { name: /Máquinas habilitadas/ });
    expect(within(table).queryByRole('columnheader', { name: MANAGED.COLUMN })).toBeNull();
    expect(within(s).queryByText(MANAGED.ACCEPTED)).toBeNull();
    expect(within(s).queryByRole('button', { name: /Ambiente por execução/ })).toBeNull();
    expect(within(s).queryByRole('button', { name: /Voltar ao Python preparado/ })).toBeNull();
    fireEvent.click(within(s).getByRole('button', { name: 'Solicitar execução em ESTACAO-01' }));
    expect(within(dialog()).queryByRole('radio')).toBeNull();
    await confirmIn('Solicitar execução');
    await waitFor(() => expect(api.sent('POST', LIST)).toHaveLength(1));
    expect(api.sent('POST', LIST)[0].body).not.toHaveProperty('environmentMode');
    expect(api.sent('GET', new RegExp('managed-environment'))).toHaveLength(0);
  });

  it('detalhe da execução sem a chave: sem "Ambiente", sem dependências e sem etapas', async () => {
    managedOn = false;
    api.on('GET', `/api/v1/o/${ORG}/remote-executions/${X1}`, 'getRemoteExecution', { status: 200, body: execution([attempt({ state: 'RUNNING', startedAt: T })]) });
    renderApp(`/o/${ORG}/execucoes-remotas/${X1}`);
    await screen.findByRole('heading', { name: 'Solicitação' });
    expect(screen.queryByText('Ambiente')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Dependências da solicitação' })).toBeNull();
    expect(screen.queryByRole('list', { name: /Etapas da tentativa/ })).toBeNull();
  });
});

describe('AMBIENTE-PYTHON-001: página da versão', () => {
  it('cada máquina diz o ambiente: Python preparado, aceito, dependências mudaram ou não compatível', async () => {
    candidates = [
      managedCandidate('NONE'),
      managedCandidate('CURRENT', { agentId: AG2, agentName: 'ESTACAO-02' }),
      managedCandidate('STALE', { agentId: AG3, agentName: 'ESTACAO-03' }),
      candidate({ agentId: AG4, agentName: 'ESTACAO-04', managedEnvironment: { compatible: false, authorized: 'NONE' } }),
    ];
    const s = await open();
    const table = within(s).getByRole('table', { name: /Máquinas habilitadas/ });
    expect(within(table).getByRole('columnheader', { name: MANAGED.COLUMN })).toBeInTheDocument();
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]).getByText(MANAGED.PREPARED)).toBeInTheDocument();
    expect(within(rows[2]).getByText(MANAGED.ACCEPTED)).toBeInTheDocument();
    expect(within(rows[3]).getByText(MANAGED.STALE)).toBeInTheDocument();
    expect(within(rows[4]).getByText(MANAGED.INCOMPATIBLE)).toBeInTheDocument();
    // a máquina incompatível não oferece a ação; as aceitas oferecem voltar ao Python preparado
    expect(within(rows[4]).queryByRole('button', { name: /Ambiente por execução/ })).toBeNull();
    expect(within(rows[1]).queryByRole('button', { name: /Voltar ao Python preparado/ })).toBeNull();
    expect(within(rows[2]).getByRole('button', { name: 'Voltar ao Python preparado em ESTACAO-02' })).toBeInTheDocument();
  });

  it('gera a lista completa: pede à máquina, mostra os pacotes com hash curto, arquivo e se cada um foi declarado ou é indireto', async () => {
    candidates = [managedCandidate('NONE')];
    let env = managedEnv();
    api.on('GET', MENV, 'getManagedEnvironment', () => ({ status: 200, body: env }));
    api.on('POST', `${MENV}/resolutions`, 'requestManagedEnvironmentResolution', () => {
      env = managedEnv({ resolution: resolution() });
      return { status: 201, body: managedEnv({ resolution: resolution({ state: 'PENDING', outcome: null, answeredAt: null, lock: null, lockSha256: null }) }) };
    });
    const s = await open();
    const d = await openManaged(s);
    expect(within(d).getByText(MANAGED.EXPLAIN)).toBeInTheDocument();
    expect(within(d).getByText(MANAGED.ORIGIN)).toBeInTheDocument();
    expect(await within(d).findByText(/Python 3\.12\.10 · instalação/)).toBeInTheDocument();
    expect(within(d).getByText(/revisão 3/)).toBeInTheDocument();
    expect(within(within(d).getByRole('list', { name: 'Dependências declaradas' })).getByText('requests==2.32.3')).toBeInTheDocument();
    // sem lista, nada a aceitar
    expect(within(d).getByRole('button', { name: MANAGED.CONFIRM })).toBeDisabled();
    fireEvent.click(within(d).getByRole('button', { name: MANAGED.GENERATE }));
    const table = await within(d).findByRole('table', { name: /Lista completa gerada pela máquina: 3 pacotes/ });
    expect(api.sent('POST', `${MENV}/resolutions`)[0].body).toEqual({ versionId: VERSION });
    expect(api.sent('GET', MENV)[0].url).toContain(`versionId=${VERSION}`);
    expect(within(d).getByText(/Lista completa: 3 pacotes/)).toBeInTheDocument();
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]).getByText('requests')).toBeInTheDocument();
    expect(within(rows[1]).getByText('d'.repeat(12))).toBeInTheDocument();
    expect(within(rows[1]).getByText('requests-2.32.3-py3-none-any.whl')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Declarada')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Indireta')).toBeInTheDocument();
    expect(within(d).getByRole('checkbox', { name: 'Autorizo instalar estes 3 pacotes, a cada execução da versão 3 na máquina Worker financeiro, num ambiente temporário.' })).not.toBeChecked();
  });

  it('pedido em aberto e sem resposta: aguardando, e depois "a máquina não respondeu; nada foi decidido"', async () => {
    candidates = [managedCandidate('NONE')];
    let env = managedEnv({ resolution: resolution({ state: 'PENDING', outcome: null, answeredAt: null, lock: null, lockSha256: null }) });
    api.on('GET', MENV, 'getManagedEnvironment', () => ({ status: 200, body: env }));
    const s = await open();
    const d = await openManaged(s);
    expect(await within(d).findByText(MANAGED.PENDING)).toBeInTheDocument();
    expect(within(d).getByText(/Prazo da resposta:/)).toBeInTheDocument();
    expect(within(d).queryByText(MANAGED.WAITING_EXECUTION)).not.toBeInTheDocument();
    expect(within(d).getByRole('button', { name: MANAGED.GENERATE })).toBeDisabled();
    // a máquina está com uma execução em andamento: a tela diz que a lista espera ela terminar
    env = managedEnv({ resolution: resolution({ state: 'PENDING', outcome: null, answeredAt: null, lock: null, lockSha256: null, waitingForExecution: true }) });
    expect(await within(d).findByText(MANAGED.WAITING_EXECUTION, {}, { timeout: 5_000 })).toBeInTheDocument();
    env = managedEnv({ resolution: resolution({ state: 'UNANSWERED', outcome: null, answeredAt: null, lock: null, lockSha256: null }) });
    expect(await within(d).findByText(MANAGED.UNANSWERED, {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: MANAGED.GENERATE })).toBeEnabled();
  });

  it('incompatível: diz qual dependência falhou e por quê, sem autorizar nada', async () => {
    candidates = [managedCandidate('NONE')];
    api.on('GET', MENV, 'getManagedEnvironment', {
      status: 200,
      body: managedEnv({
        resolution: resolution({
          outcome: 'INCOMPATIBLE',
          pythonVersion: '3.13.0',
          lock: null,
          lockSha256: null,
          failure: { requirement: 'pandas==2.2.3', phase: 'NO_COMPATIBLE_WHEEL', summary: 'No matching distribution found' },
        }),
      }),
    });
    const s = await open();
    const d = await openManaged(s);
    const alert = await within(d).findByText(/a dependência pandas==2\.2\.3 falhou/);
    expect(alert).toHaveTextContent('não há pacote compilado (wheel) compatível com Python 3.13.0 nesta máquina');
    expect(alert).toHaveTextContent('No matching distribution found');
    expect(alert).toHaveTextContent('Nada foi autorizado.');
    expect(within(d).queryByRole('table')).toBeNull();
    expect(within(d).queryByRole('checkbox')).toBeNull();
    expect(within(d).getByRole('button', { name: MANAGED.CONFIRM })).toBeDisabled();
  });

  it('o Python escolhido é um venv: explica que a base precisa ser uma instalação e não deixa gerar', async () => {
    candidates = [managedCandidate('NONE')];
    api.on('GET', MENV, 'getManagedEnvironment', {
      status: 200,
      body: managedEnv({ baseEligible: false, basePython: { environmentId: ENV_A, pythonVersion: '3.12.10', kind: 'VIRTUAL_ENVIRONMENT' } }),
    });
    const s = await open();
    const d = await openManaged(s);
    expect(await within(d).findByText(MANAGED.BASE_IS_VENV)).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: MANAGED.GENERATE })).toBeDisabled();
  });

  it('Playwright: exige escolher ao menos um navegador; o aceite com step-up manda a resolução, o lock, as verificações e o consentimento', async () => {
    candidates = [managedCandidate('NONE')];
    const lock = [lockItem('playwright', '1.49.0', 'd'), lockItem('greenlet', '3.1.1', 'e'), lockItem('pyee', '12.0.0', 'f')];
    api.on('GET', MENV, 'getManagedEnvironment', {
      status: 200,
      body: managedEnv({
        requirements: { revision: 3, dependencies: ['playwright==1.49.0'] },
        resolution: resolution({ lock }),
        externalPrerequisites: [{ code: 'PLAYWRIGHT_BROWSER', package: 'playwright', checks: ['PLAYWRIGHT_CHROMIUM', 'PLAYWRIGHT_FIREFOX', 'PLAYWRIGHT_WEBKIT'] }],
      }),
    });
    api.on('POST', `${MENV}/authorizations`, 'authorizeManagedEnvironment', () => ({ status: 201, body: managedEnv() }));
    const s = await open();
    const d = await openManaged(s);
    await within(d).findByRole('table', { name: /Lista completa/ }, SLOW);
    expect(within(d).getByText(/nunca instala navegadores nem componentes do sistema/)).toBeInTheDocument();
    expect(within(d).getByText(/mesma versão do Playwright desta lista/)).toBeInTheDocument();
    await consentir(d);
    // consentimento sem navegador: ainda não
    expect(within(d).getByText(MANAGED.BROWSERS_REQUIRED)).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: MANAGED.CONFIRM })).toBeDisabled();
    fireEvent.click(within(within(d).getByRole('group', { name: MANAGED.BROWSERS_LEGEND })).getByRole('checkbox', { name: 'Chromium' }));
    await confirmIn(MANAGED.CONFIRM);
    expect(await screen.findByText(MANAGED.DONE, {}, SLOW)).toBeInTheDocument();
    const sent = api.sent('POST', `${MENV}/authorizations`);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ versionId: VERSION, resolutionId: RES, lockSha256: LOCK_SHA, checks: ['PLAYWRIGHT_CHROMIUM'], acknowledge: true });
    expect(sent[0].csrf).toBe('ses');
  });

  it('sem consentimento não confirma; a recusa da API (lock mudou) aparece em palavras', async () => {
    candidates = [managedCandidate('NONE')];
    api.on('GET', MENV, 'getManagedEnvironment', { status: 200, body: managedEnv({ resolution: resolution() }) });
    api.on('POST', `${MENV}/authorizations`, 'authorizeManagedEnvironment', { status: 409, body: { error: 'conflict', reason: 'managed_environment_lock_changed' } });
    const s = await open();
    const d = await openManaged(s);
    await within(d).findByRole('table', { name: /Lista completa/ }, SLOW);
    expect(within(d).getByRole('button', { name: MANAGED.CONFIRM })).toBeDisabled();
    await consentir(d);
    await confirmIn(MANAGED.CONFIRM);
    expect(await within(dialog()).findByText(new RegExp(MANAGED_REQUEST_REFUSAL.managed_environment_lock_changed.slice(0, 40)))).toBeInTheDocument();
  });

  it('aceite desatualizado: mostra os motivos e o que mudou (acrescentados, removidos, versão trocada) e pede gerar e aceitar de novo', async () => {
    candidates = [managedCandidate('STALE')];
    api.on('GET', MENV, 'getManagedEnvironment', {
      status: 200,
      body: managedEnv({
        resolution: resolution({ current: false }),
        authorization: {
          authorizationId: MAUTH,
          status: 'STALE',
          staleReasons: ['REQUIREMENTS_CHANGED', 'LOCK_CHANGED'],
          lockSha256: 'f'.repeat(64),
          packages: 12,
          checks: [],
          grantedAt: T,
          requirementsRevision: 2,
          diff: { added: ['x==1'], removed: ['y==2'], changed: [{ name: 'z', from: '1.0', to: '1.1' }] },
        },
      }),
    });
    const s = await open();
    const d = await openManaged(s);
    expect(await within(d).findByText(MANAGED.STALE_TITLE)).toBeInTheDocument();
    expect(within(d).getByText(`Motivo: ${STALE_REASON.REQUIREMENTS_CHANGED}; ${STALE_REASON.LOCK_CHANGED}.`)).toBeInTheDocument();
    const diff = within(d).getByRole('list', { name: 'O que mudou na lista' });
    expect(within(diff).getByText('Acrescentado: x==1')).toBeInTheDocument();
    expect(within(diff).getByText('Removido: y==2')).toBeInTheDocument();
    expect(within(diff).getByText('Versão trocada: z 1.0 → 1.1')).toBeInTheDocument();
    expect(within(d).getByText(MANAGED.STALE_ACTION)).toBeInTheDocument();
    // a lista que aparece não é a corrente: não dá para aceitar sem gerar de novo
    expect(within(d).getByText(MANAGED.NOT_CURRENT)).toBeInTheDocument();
    expect(within(d).queryByRole('checkbox', { name: /Autorizo/ })).toBeNull();
    expect(within(d).getByRole('button', { name: MANAGED.CONFIRM })).toBeDisabled();
  });

  it('voltar ao Python preparado revoga o aceite (step-up) pela versão', async () => {
    candidates = [managedCandidate('CURRENT')];
    api.on('DELETE', `${MENV}/authorizations/current`, 'revokeManagedEnvironmentAuthorization', { status: 204 });
    const s = await open();
    fireEvent.click(within(s).getByRole('button', { name: 'Voltar ao Python preparado em ESTACAO-01' }));
    expect(within(dialog()).getByText(MANAGED.REVOKE_TEXT)).toBeInTheDocument();
    await confirmIn(MANAGED.BACK);
    expect(await screen.findByText(MANAGED.REVOKED)).toBeInTheDocument();
    const sent = api.sent('DELETE', `${MENV}/authorizations/current`);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain(`versionId=${VERSION}`);
  });

  it('solicitar com aceite vigente: oferece a escolha com o Python preparado marcado; manda o modo escolhido', async () => {
    candidates = [managedCandidate('CURRENT')];
    api.on('POST', LIST, 'requestRemoteExecution', () => ({ status: 201, body: execution([attempt()], { environmentMode: 'PREPARED' }) }));
    const s = await open();
    fireEvent.click(within(s).getByRole('button', { name: 'Solicitar execução em ESTACAO-01' }));
    const prepared = within(dialog()).getByRole('radio', { name: /Python preparado/ });
    const managed = within(dialog()).getByRole('radio', { name: /Ambiente por execução \(aceito\)/ });
    expect(prepared).toBeChecked();
    expect(managed).not.toBeChecked();
    await confirmIn('Solicitar execução');
    await waitFor(() => expect(api.sent('POST', LIST)).toHaveLength(1));
    expect((api.sent('POST', LIST)[0].body as Row).environmentMode).toBe('PREPARED');

    // de novo, escolhendo o ambiente por execução: o diálogo volta ao padrão a cada abertura
    fireEvent.click(within(s).getByRole('button', { name: 'Solicitar execução em ESTACAO-01' }));
    await waitFor(() => expect(within(dialog()).getByRole('radio', { name: /Python preparado/ })).toBeChecked());
    fireEvent.click(within(dialog()).getByRole('radio', { name: /Ambiente por execução \(aceito\)/ }));
    await confirmIn('Solicitar execução');
    await waitFor(() => expect(api.sent('POST', LIST)).toHaveLength(2));
    expect((api.sent('POST', LIST)[1].body as Row).environmentMode).toBe('MANAGED');
  });

  it('sem aceite vigente (dependências mudaram), a solicitação não oferece o ambiente por execução', async () => {
    candidates = [managedCandidate('STALE')];
    const s = await open();
    fireEvent.click(within(s).getByRole('button', { name: 'Solicitar execução em ESTACAO-01' }));
    expect(within(dialog()).queryByRole('radio')).toBeNull();
  });

  it('a recusa managed_environment_changed na solicitação aparece em palavras', async () => {
    candidates = [managedCandidate('CURRENT')];
    api.on('POST', LIST, 'requestRemoteExecution', { status: 409, body: { error: 'conflict', reason: 'managed_environment_changed' } });
    const s = await open();
    fireEvent.click(within(s).getByRole('button', { name: 'Solicitar execução em ESTACAO-01' }));
    fireEvent.click(within(dialog()).getByRole('radio', { name: /Ambiente por execução \(aceito\)/ }));
    await confirmIn('Solicitar execução');
    expect(await within(dialog()).findByText(`${MANAGED_REQUEST_REFUSAL.managed_environment_changed} Nada foi alterado.`)).toBeInTheDocument();
  });

  it('tentativa que falhou no preparo: etapas, "Não iniciada — a dependência X não pôde ser instalada" e o motivo novo', async () => {
    candidates = [managedCandidate('CURRENT')];
    executions = [execution([failedPreparation()], { environmentMode: 'MANAGED' })];
    const s = await open();
    const tentativas = within(s).getByRole('list', { name: 'Tentativas' });
    expect(within(tentativas).getByText(/uma dependência não pôde ser instalada no ambiente temporário; a automação não foi executada/)).toBeInTheDocument();
    expect(
      within(tentativas).getByText(
        'Não iniciada — a dependência pandas==2.2.3 não pôde ser instalada: não há pacote compilado (wheel) compatível com Python 3.13.0 nesta máquina. A automação não foi executada.',
      ),
    ).toBeInTheDocument();
    const steps = within(tentativas).getByRole('list', { name: /Etapas da tentativa 1/ });
    const items = within(steps).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Concluída');
    expect(items[0]).toHaveTextContent('Preparando ambiente');
    expect(items[1]).toHaveTextContent('Falhou');
    expect(items[1]).toHaveTextContent('Instalando dependências');
    expect(items[2]).toHaveTextContent('Não executada');
    expect(items[3]).toHaveTextContent('Não executada');
  });
});

describe('AMBIENTE-PYTHON-001: detalhe da execução remota', () => {
  const detail = (x: Row) => {
    api.on('GET', `/api/v1/o/${ORG}/remote-executions/${X1}`, 'getRemoteExecution', { status: 200, body: x });
    renderApp(`/o/${ORG}/execucoes-remotas/${X1}`);
  };

  it('mostra o ambiente e as dependências congeladas (com a revisão); o registro do preparo vencido diz "removido após 30 dias"', async () => {
    detail(execution([failedPreparation()], { environmentMode: 'MANAGED' }));
    api.on('GET', `/api/v1/o/${ORG}/remote-executions/${X1}/attempts/${ATT}/environment-log`, 'getRemoteAttemptEnvironmentLog', {
      status: 410,
      body: { error: 'not_found', reason: 'managed_environment_log_expired' },
    });
    await screen.findByRole('heading', { name: 'Solicitação' });
    expect(screen.getByText('Ambiente por execução (temporário, com a lista aceita)')).toBeInTheDocument();
    expect(screen.getByText('Dependências (revisão 3)')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Dependências da solicitação' })).getByText('requests==2.32.3')).toBeInTheDocument();
    expect(screen.getByText(/Não iniciada — a dependência pandas==2\.2\.3 não pôde ser instalada/)).toBeInTheDocument();
    expect(screen.getByText('Resumo da máquina: No matching distribution')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Registro do preparo' }));
    expect(await screen.findByText(/Registro do preparo: removido após 30 dias/)).toBeInTheDocument();
  });

  it('registro do preparo disponível: mostrado como texto; tentativa concluída com o envio fechado tem as quatro etapas concluídas', async () => {
    const done = attempt({
      state: 'SUCCEEDED',
      exitCode: 0,
      receivedAt: '2026-11-10T10:00:06Z',
      startedAt: '2026-11-10T10:01:00Z',
      endedAt: '2026-11-10T10:02:00Z',
      environment: environment({
        stages: [
          { stage: 'ENV_CREATING', at: '2026-11-10T10:00:07Z' },
          { stage: 'DEPS_INSTALLING', at: '2026-11-10T10:00:15Z' },
        ],
        report: {
          outcome: 'READY',
          pythonVersion: '3.12.10',
          pipVersion: '24.3.1',
          installed: [
            { name: 'requests', version: '2.32.3', sha256: 'd'.repeat(64) },
            { name: 'urllib3', version: '2.2.3', sha256: 'e'.repeat(64) },
          ],
          failure: null,
          createMs: 8000,
          installMs: 41000,
          logAvailable: true,
          logExpiredAt: null,
          reportedAt: '2026-11-10T10:00:58Z',
        },
      }),
    });
    detail(execution([done], { environmentMode: 'MANAGED' }));
    const closedAt = '2026-11-10T10:02:05Z';
    api.on('GET', new RegExp(`/attempts/${ATT}/logs$`), 'listRemoteAttemptLogs', {
      status: 200,
      body: { attemptId: ATT, items: [], total: 0, automationLines: 0, systemLines: 0, nextAfter: null, closure: { lines: 0, droppedLines: 0, closedAt }, retentionLoss: null, expiration: null },
    });
    api.on('GET', new RegExp(`/attempts/${ATT}/results$`), 'listRemoteAttemptResults', {
      status: 200,
      body: { attemptId: ATT, items: [], closure: { sent: 0, skippedByLimit: 0, closedAt }, retentionLoss: null, expiration: null },
    });
    api.on('GET', `/api/v1/o/${ORG}/remote-executions/${X1}/attempts/${ATT}/environment-log`, 'getRemoteAttemptEnvironmentLog', {
      status: 200,
      text: 'criando o ambiente\ninstalando 2 pacotes\n<b>pronto</b>',
      contentType: 'text/plain',
    });
    await screen.findByRole('heading', { name: 'Solicitação' });
    expect(screen.getByText(/Preparado com Python 3\.12\.10 e pip 24\.3\.1 · ambiente criado em 8 s · dependências instaladas em 41 s/)).toBeInTheDocument();
    expect(screen.getByText('Pacotes instalados (2)')).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: /Etapas da tentativa 1/ });
    await waitFor(() => within(steps).getAllByRole('listitem').forEach((li) => expect(li).toHaveTextContent('Concluída')));
    fireEvent.click(screen.getByRole('button', { name: 'Registro do preparo' }));
    const log = await screen.findByRole('region', { name: 'Registro do preparo da tentativa 1' });
    // texto como texto: nada é interpretado como HTML
    expect(log).toHaveTextContent('<b>pronto</b>');
    expect(log.querySelector('b')).toBeNull();
  });
});

describe('AMBIENTE-PYTHON-001: derivação das etapas', () => {
  const base = (over: Partial<RemoteAttempt>): RemoteAttempt => ({ ...(attempt() as unknown as RemoteAttempt), ...over });
  const env = (over: Row = {}) => environment(over) as unknown as RemoteAttempt['environment'];
  const statuses = (a: RemoteAttempt, d: 'done' | 'pending' | 'unknown' = 'unknown') => deriveManagedSteps(a, d).map((s) => s.status);

  it('na fila: todas aguardando; criando: a primeira em andamento', () => {
    expect(statuses(base({ environment: env() }))).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(statuses(base({ state: 'PREPARING', environment: env({ stages: [{ stage: 'ENV_CREATING', at: T }] }) }))).toEqual(['current', 'pending', 'pending', 'pending']);
  });

  it('instalando, depois executando (relatório READY), depois enviando e concluída quando os dois fechamentos chegam', () => {
    const stages = [
      { stage: 'ENV_CREATING', at: T },
      { stage: 'DEPS_INSTALLING', at: T },
    ];
    expect(statuses(base({ state: 'PREPARING', environment: env({ stages }) }))).toEqual(['done', 'current', 'pending', 'pending']);
    const report = { outcome: 'READY', installed: [], failure: null, createMs: 1, installMs: 2, logAvailable: true, logExpiredAt: null, reportedAt: T };
    expect(statuses(base({ state: 'RUNNING', startedAt: T, environment: env({ stages, report }) }))).toEqual(['done', 'done', 'current', 'pending']);
    const ended = base({ state: 'FAILED', startedAt: T, endedAt: T, exitCode: 1, environment: env({ stages, report }) });
    expect(statuses(ended, 'pending')).toEqual(['done', 'done', 'done', 'current']);
    expect(statuses(ended, 'unknown')).toEqual(['done', 'done', 'done', 'current']);
    expect(statuses(ended, 'done')).toEqual(['done', 'done', 'done', 'done']);
    expect(deriveManagedSteps(ended)[3].at).toBe(T);
  });

  it('falha ao criar o ambiente (fase VENV) e reinício durante o preparo', () => {
    const report = (outcome: string, phase: string | null) => ({
      outcome,
      installed: [],
      failure: phase ? { requirement: null, phase, summary: null } : null,
      createMs: null,
      installMs: null,
      logAvailable: true,
      logExpiredAt: null,
      reportedAt: T,
    });
    expect(
      statuses(base({ state: 'REFUSED', refusalReason: 'ENVIRONMENT_SETUP_FAILED', endedAt: T, environment: env({ stages: [{ stage: 'ENV_CREATING', at: T }], report: report('FAILED', 'VENV') }) })),
    ).toEqual(['failed', 'skipped', 'skipped', 'skipped']);
    expect(
      statuses(
        base({
          state: 'REFUSED',
          refusalReason: 'ENVIRONMENT_SETUP_INTERRUPTED',
          endedAt: T,
          environment: env({ stages: [{ stage: 'ENV_CREATING', at: T }, { stage: 'DEPS_INSTALLING', at: T }], report: report('INTERRUPTED', null) }),
        }),
      ),
    ).toEqual(['done', 'failed', 'skipped', 'skipped']);
  });

  it('recusa sem relação com o preparo (aceite revogado) depois de começar a instalar: interrompida, não "falhou"', () => {
    expect(
      statuses(base({ state: 'REFUSED', refusalReason: 'AUTHORIZATION_REVOKED', endedAt: T, environment: env({ stages: [{ stage: 'ENV_CREATING', at: T }, { stage: 'DEPS_INSTALLING', at: T }] }) })),
    ).toEqual(['done', 'stopped', 'skipped', 'skipped']);
  });

  it('nome normalizado (PEP 503) para dizer o que foi declarado', () => {
    expect(normalizeName('Typing_Extensions')).toBe('typing-extensions');
    expect(normalizeName('zope.interface')).toBe('zope-interface');
  });
});

describe('AMBIENTE-PYTHON-001: declaração de dependências', () => {
  const RR = `/api/v1/o/${ORG}/automations/${AUT}/runtime-requirements`;
  const view = {
    automationId: AUT,
    declared: { revision: 3, source: 'TEXT', dependencies: ['requests==2.32.3'], contentSha256: SHA, declaredAt: T },
    published: { automationVersionId: VERSION, versionNumber: 3, dependencies: [] },
    effective: { dependencies: ['requests==2.32.3'], conflicts: [], resolved: true },
  };
  const openEditor = async () => {
    renderApp(`/o/${ORG}/automacoes/${AUT}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Declarar de novo' }));
  };

  it('com a chave ligada, avisa que declarar de novo exige um novo aceite nas máquinas do ambiente por execução; sem ela, não', async () => {
    api.on('GET', RR, 'getRuntimeRequirements', { status: 200, body: view });
    api.on('GET', new RegExp(`/api/v1/o/${ORG}/automations/${AUT}/versions`), 'listAutomationVersions', { status: 200, body: { items: [], nextCursor: null } });
    await openEditor();
    expect(screen.getByText(MANAGED_REDECLARE_TEXT)).toBeInTheDocument();
  });

  it('sem a chave, a declaração fica como hoje', async () => {
    managedOn = false;
    api.on('GET', RR, 'getRuntimeRequirements', { status: 200, body: view });
    api.on('GET', new RegExp(`/api/v1/o/${ORG}/automations/${AUT}/versions`), 'listAutomationVersions', { status: 200, body: { items: [], nextCursor: null } });
    await openEditor();
    expect(screen.queryByText(MANAGED_REDECLARE_TEXT)).toBeNull();
  });
});
