import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { CHANGED_TEXT, UNRESOLVED_TEXT } from './RuntimeRequirements';

/**
 * PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T01c (parte 2) — dependências de execução na página da automação. A tela mostra o
 * que a API leu (por linha), só deixa declarar um texto conferido e sem problema, e diz que nada é instalado e que o pacote
 * publicado não muda. Respostas por rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const WS = '0b6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const AUT = '0c6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const V1 = '11111111-2222-4333-8444-555555555555';
const MEMBER = '66666666-6666-4666-8666-666666666666';
const T = '2026-11-10T12:00:00Z';
const REQ = `/api/v1/o/${ORG}/automations/${AUT}/runtime-requirements`;

let api: RouteApi;
type View = Record<string, unknown>;
const view = (over: View = {}): View => ({
  automationId: AUT,
  declared: null,
  published: null,
  effective: { dependencies: [], conflicts: [], resolved: true },
  ...over,
});
const declared = (revision: number, source: string, dependencies: string[]) => ({ revision, source, dependencies, contentSha256: 'a'.repeat(64), declaredAt: T });
const line = (number: number, text: string, kind: string, problem: boolean, dependency: string | null) => ({ number, text, kind, problem, dependency });

function permissions(workspace: string[]) {
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: { organizationId: ORG, membershipId: MEMBER, organization: { roles: ['ORG_ADMIN'], permissions: [] }, allWorkspaces: { permissions: workspace }, hasWorkspaceAssignments: false },
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
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', remoteExecutionAvailable: true, stepUpMethod: 'totp' },
  });
  permissions(['automation.read', 'automation.manage']);
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/automations/${AUT}`, 'getAutomation', {
    status: 200,
    body: { automationId: AUT, workspaceId: WS, name: 'Relatório de pedidos', description: null, status: 'active', latestPublishedVersion: null, createdAt: T, updatedAt: T },
  });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/automations/${AUT}/versions`), 'listAutomationVersions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/local-run-authorizations`, 'listLocalRunAuthorizations', { status: 200, body: { items: [] } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/agents`), 'listAgents', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workers`), 'listWorkers', { status: 200, body: { items: [] } });
});
afterEach(() => vi.unstubAllGlobals());

const open = async () => {
  renderApp(`/o/${ORG}/automacoes/${AUT}`);
  await screen.findByRole('heading', { name: 'Relatório de pedidos', level: 1 });
};
const section = () => screen.getByRole('heading', { name: 'Dependências de execução' }).closest('section')!;
const puts = () => api.sent('PUT', REQ);

describe('Automação: dependências de execução (T01c)', () => {
  it('sem declaração: diz que ainda não foi declarado, que nada é instalado e que o pacote não muda', async () => {
    api.on('GET', REQ, 'getRuntimeRequirements', { status: 200, body: view() });
    await open();
    const s = await waitFor(section);
    expect(within(s).getByText('Ainda não declarado.')).toBeInTheDocument();
    expect(within(s).getByText(/não poderá ser executada a pedido da\s+Platform/)).toBeInTheDocument();
    expect(within(s).getByText(/Nada é instalado por aqui e o pacote\s+publicado não muda/)).toBeInTheDocument();
    expect(within(s).getByText('Esta automação ainda não tem versão publicada.')).toBeInTheDocument();
    expect(within(s).getByRole('button', { name: 'Declarar dependências' })).toBeInTheDocument();
  });

  it('lista digitada: só declara depois de conferir, e a tela mostra a situação de cada linha', async () => {
    let current = view();
    api.on('GET', REQ, 'getRuntimeRequirements', () => ({ status: 200, body: current }));
    const bad = 'requests==2.32.3\nnumpy\n';
    api.on('POST', `${REQ}/analysis`, 'analyzeRuntimeRequirements', (r) => {
      const text = (r.body as { text: string }).text;
      return text === bad
        ? { status: 200, body: { lines: [line(1, 'requests==2.32.3', 'EXACT', false, 'requests==2.32.3'), line(2, 'numpy', 'NO_VERSION', true, null)], dependencies: ['requests==2.32.3'], resolved: false } }
        : { status: 200, body: { lines: [line(1, 'requests==2.32.3', 'EXACT', false, 'requests==2.32.3')], dependencies: ['requests==2.32.3'], resolved: true } };
    });
    api.on('PUT', REQ, 'declareRuntimeRequirements', () => {
      current = view({ declared: declared(1, 'TEXT', ['requests==2.32.3']), effective: { dependencies: ['requests==2.32.3'], conflicts: [], resolved: true } });
      return { status: 201, body: current };
    });
    await open();
    fireEvent.click(within(await waitFor(section)).getByRole('button', { name: 'Declarar dependências' }));
    fireEvent.click(screen.getByRole('radio', { name: /Lista digitada/ }));
    const declare = screen.getByRole('button', { name: 'Declarar' });
    expect(declare).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Lista de dependências/), { target: { value: bad } });
    fireEvent.click(screen.getByRole('button', { name: 'Conferir o texto' }));
    const table = await screen.findByRole('table', { name: /Situação de cada linha/ });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]).getByText('Aceita')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Impede declarar')).toBeInTheDocument();
    expect(within(rows[2]).getByText(/Sem versão: é preciso a versão exata/)).toBeInTheDocument();
    expect(screen.getByText(UNRESOLVED_TEXT)).toBeInTheDocument();
    expect(declare).toBeDisabled();
    // mexeu no texto: a conferência anterior não vale mais
    fireEvent.change(screen.getByLabelText(/^Lista de dependências/), { target: { value: 'requests==2.32.3\n' } });
    expect(screen.queryByRole('table', { name: /Situação de cada linha/ })).toBeNull();
    expect(declare).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Conferir o texto' }));
    await screen.findByRole('table', { name: /Situação de cada linha/ });
    await waitFor(() => expect(declare).toBeEnabled());
    expect(puts()).toEqual([]);
    fireEvent.click(declare);
    expect(await screen.findByText('Dependências declaradas (revisão 1). O pacote publicado não mudou.')).toBeInTheDocument();
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body).toEqual({ source: 'TEXT', text: 'requests==2.32.3\n' });
    const s = section();
    expect(within(s).getByText('Lista digitada')).toBeInTheDocument();
    expect(within(within(s).getByRole('list', { name: 'Dependências efetivas' })).getByText('requests==2.32.3')).toBeInTheDocument();
    expect(within(s).getByRole('button', { name: 'Declarar de novo' })).toBeInTheDocument();
  });

  it('"só as do pacote" e "sem dependências externas" não pedem texto e levam a revisão vista', async () => {
    const before = view({
      declared: declared(3, 'TEXT', ['idna==3.7']),
      published: { automationVersionId: V1, versionNumber: 2, dependencies: ['requests==2.32.3'] },
      effective: { dependencies: ['requests==2.32.3', 'idna==3.7'], conflicts: [], resolved: true },
    });
    api.on('GET', REQ, 'getRuntimeRequirements', { status: 200, body: before });
    api.on('PUT', REQ, 'declareRuntimeRequirements', {
      status: 201,
      body: view({ declared: declared(4, 'NONE_CONFIRMED', []), published: before.published, effective: { dependencies: ['requests==2.32.3'], conflicts: [], resolved: true } }),
    });
    await open();
    const s = await waitFor(section);
    expect(within(s).getByText('Pacote publicado (versão 2): 1 no manifesto.')).toBeInTheDocument();
    fireEvent.click(within(s).getByRole('button', { name: 'Declarar de novo' }));
    fireEvent.click(screen.getByRole('radio', { name: /Sem dependências externas/ }));
    expect(screen.queryByLabelText(/^Lista de dependências/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conferir o texto' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Declarar' }));
    expect(await screen.findByText('Dependências declaradas (revisão 4). O pacote publicado não mudou.')).toBeInTheDocument();
    expect(puts()[0].body).toEqual({ source: 'NONE_CONFIRMED', expectedRevision: 3 });
    expect(api.sent('POST', `${REQ}/analysis`)).toEqual([]);
  });

  it('conflito com o pacote publicado: fica dito, e vale a do pacote', async () => {
    api.on('GET', REQ, 'getRuntimeRequirements', {
      status: 200,
      body: view({
        declared: declared(1, 'TEXT', ['requests==2.31.0']),
        published: { automationVersionId: V1, versionNumber: 1, dependencies: ['requests==2.32.3'] },
        effective: { dependencies: ['requests==2.32.3'], conflicts: [{ name: 'requests', published: 'requests==2.32.3', declared: 'requests==2.31.0' }], resolved: false },
      }),
    });
    await open();
    const conflicts = await screen.findByRole('list', { name: 'Conflitos com o pacote publicado' });
    expect(conflicts.textContent).toContain('requests==2.31.0');
    expect(conflicts.textContent).toContain('Vale a do pacote');
    expect(within(screen.getByRole('list', { name: 'Dependências efetivas' })).getByText('requests==2.32.3')).toBeInTheDocument();
  });

  it('recusas do servidor: linha com problema e declaração de outra pessoa; nada é dado como gravado', async () => {
    let current = view();
    api.on('GET', REQ, 'getRuntimeRequirements', () => ({ status: 200, body: current }));
    let reason = 'runtime_requirements_unresolved';
    api.on('PUT', REQ, 'declareRuntimeRequirements', () => ({ status: 409, body: { error: 'conflict', reason } }));
    await open();
    fireEvent.click(within(await waitFor(section)).getByRole('button', { name: 'Declarar dependências' }));
    fireEvent.click(screen.getByRole('button', { name: 'Declarar' }));
    expect(await screen.findByText(UNRESOLVED_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(/Dependências declaradas \(revisão/)).toBeNull();
    // outra pessoa declarou: a tela recarrega e mostra o que está valendo
    reason = 'runtime_requirements_changed';
    current = view({ declared: declared(1, 'NONE_CONFIRMED', []) });
    fireEvent.click(screen.getByRole('button', { name: 'Declarar' }));
    expect(await screen.findByText(CHANGED_TEXT)).toBeInTheDocument();
    await waitFor(() => expect(within(section()).getByText('Sem dependências externas (confirmado)')).toBeInTheDocument());
  });

  it('sem automation.manage: vê a situação, não declara; Platform sem o recurso (404): a seção não aparece', async () => {
    permissions(['automation.read']);
    api.on('GET', REQ, 'getRuntimeRequirements', { status: 200, body: view({ declared: declared(2, 'PACKAGE', []) }) });
    await open();
    const s = await waitFor(section);
    expect(within(s).getByText('Só as do pacote')).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: /Declarar/ })).toBeNull();
  });

  it('Platform sem o recurso (404): a seção não aparece e a página segue', async () => {
    api.on('GET', REQ, 'getRuntimeRequirements', { status: 404, body: { error: 'not_found' } });
    await open();
    await waitFor(() => expect(api.sent('GET', REQ).length).toBeGreaterThan(0));
    expect(screen.queryByRole('heading', { name: 'Dependências de execução' })).toBeNull();
  });
});

describe('RELEASE-2.2: Platform sem execução remota', () => {
  it('a página da automação diz que a execução pela Platform está indisponível e não mostra nem lê as dependências', async () => {
    api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', { status: 200, body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' } });
    await open();
    expect(await screen.findByText('Execução pela Platform indisponível nesta versão')).toBeInTheDocument();
    expect(screen.getByText(/as dependências de execução .* não aparecem aqui/)).toBeInTheDocument();
    expect(screen.getByText(/Executar pelo Nekkora Agent, no próprio computador, continua como hoje/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dependências de execução' })).toBeNull();
    expect(api.sent('GET', REQ)).toEqual([]);
  });
});
