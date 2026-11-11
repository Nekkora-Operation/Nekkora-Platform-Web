import axe from 'axe-core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { fakeResize } from '../../test/fakeResize';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';

/**
 * PLATFORM-AGENT-V2-002 T07 + T08 (R1) — Workers e Máquinas vinculadas no componente responsivo: cartões quando a tabela
 * não cabe, tabela quando cabe, com as MESMAS colunas e as permissões de cada perfil; trocar de formato não consulta a API;
 * as ações dos cartões são alcançáveis pelo teclado.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const AG = '33333333-3333-4333-8333-333333333333';
const AG2 = '77777777-7777-4777-8777-777777777777';
const ENR = '44444444-4444-4444-8444-444444444444';
const INST = '55555555-5555-4555-8555-555555555555';
const MEMBER = '66666666-6666-4666-8666-666666666666';
const WS = '88888888-8888-4888-8888-888888888888';
const T = '2026-11-10T12:00:00Z';
const ALL = ['worker.manage', 'agent.manage', 'agent_credential.manage', 'worker_agent.assign', 'worker_workspace.authorize'];
const CODE = `nkp1.${ENR}.${W1}.${'A'.repeat(43)}`;

const worker = (over: Record<string, unknown> = {}) => ({
  workerId: W1,
  name: 'Worker financeiro',
  status: 'ACTIVE',
  agentId: AG,
  workspaceIds: [WS],
  agentName: 'ESTACAO-01',
  agentStatus: 'ACTIVE',
  agentVersion: '2.1.0',
  installationId: INST,
  lastHeartbeatAt: T,
  connectivity: 'CONNECTED',
  credentialExpiresAt: '2027-02-10T12:00:00Z',
  createdAt: T,
  ...over,
});
const free = { ...worker({ workerId: W2, name: 'Worker livre', agentId: null, workspaceIds: [], agentName: null, agentStatus: null, agentVersion: null, installationId: null, lastHeartbeatAt: null, connectivity: null, credentialExpiresAt: null }) };
const agentItem = (over: Record<string, unknown> = {}) => ({
  agentId: AG,
  name: 'ESTACAO-01',
  installationId: INST,
  agentVersion: '2.1.0',
  status: 'ACTIVE',
  workerId: W1,
  registeredAt: T,
  lastHeartbeatAt: T,
  connectivity: 'CONNECTED',
  contractVersion: '1.0.0',
  capabilities: [],
  credentialExpiresAt: '2027-02-10T12:00:00Z',
  ...over,
});

let api: RouteApi;
let size: ReturnType<typeof fakeResize>;
function permissions(list: string[]) {
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: { organizationId: ORG, membershipId: MEMBER, organization: { roles: ['ORG_ADMIN'], permissions: list }, allWorkspaces: { permissions: [] }, hasWorkspaceAssignments: false },
  });
}

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  csrfStore.clear();
  sessionMemory.reset();
  localStorage.clear();
  const locks = fakeLocks();
  setOperationRegistryForTest(createOperationRegistry({ storage: () => localStorage, locks: () => locks, now: () => Date.now() }));
  api = new RouteApi().install();
  size = fakeResize(1100, 600);
  csrfStore.setSession(ORG, 'ses');
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' },
  });
  permissions(ALL);
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', {
    status: 200,
    body: { items: [{ workspaceId: WS, name: 'Financeiro', description: null, status: 'active', client: null, createdAt: T, updatedAt: T }], nextCursor: null },
  });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/workers`, 'listWorkers', { status: 200, body: { items: [worker(), free] } });
  api.on('GET', `/api/v1/o/${ORG}/agents`, 'listAgents', { status: 200, body: { items: [agentItem(), agentItem({ agentId: AG2, name: 'ESTACAO-ANTIGA', status: 'REVOKED', workerId: null })] } });
});
afterEach(() => size.restore());

const workersGets = () => api.sent('GET', `/api/v1/o/${ORG}/workers`).length;
const agentsGets = () => api.sent('GET', `/api/v1/o/${ORG}/agents`).length;
const cardOf = (region: HTMLElement, title: string) => within(region).getAllByRole('article').find((a) => within(a).getByRole('heading').textContent === title)!;

describe('Workers em cartões, por perfil (T07 + T08 R1)', () => {
  it('ORG_ADMIN: cartões com máquina, comunicação e todas as ações; sem tabela; trocar de formato não consulta a API', async () => {
    renderApp(`/o/${ORG}/workers`);
    const r = await screen.findByRole('region', { name: 'Lista de Workers' });
    await waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    expect(within(r).queryByRole('table')).toBeNull();
    const linked = cardOf(r, 'Worker financeiro');
    expect(linked).toHaveTextContent('Máquina vinculada');
    expect(linked).toHaveTextContent('ESTACAO-01');
    expect(linked).toHaveTextContent('Conectada');
    expect(within(linked).getByRole('button', { name: 'Retirar autorização de Financeiro do Worker Worker financeiro' })).toBeInTheDocument();
    expect(within(linked).getByRole('button', { name: 'Renovar credencial de ESTACAO-01' })).toBeInTheDocument();
    expect(within(linked).getByRole('button', { name: 'Revogar vínculo de ESTACAO-01 com Worker financeiro' })).toBeInTheDocument();
    const livre = cardOf(r, 'Worker livre');
    expect(livre).toHaveTextContent('Sem Agent');
    expect(within(livre).getByRole('button', { name: 'Vincular Agent a Worker livre' })).toBeInTheDocument();
    const gets = workersGets();
    size.resize(1300);
    await waitFor(() => expect(r).toHaveAttribute('data-format', 'tabela'));
    size.resize(640);
    await waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    expect(workersGets()).toBe(gets);
    expect(agentsGets()).toBe(0);
  });

  it('cartões pelo teclado: Renovar credencial do cartão abre o diálogo da máquina certa e gera o código', async () => {
    api.on('POST', `/api/v1/o/${ORG}/agents/${AG}/credential-rotations`, 'createAgentRotationCode', {
      status: 201,
      body: { enrollmentId: ENR, code: CODE, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), workerId: W1, agentId: AG },
    });
    renderApp(`/o/${ORG}/workers`);
    const r = await screen.findByRole('region', { name: 'Lista de Workers' });
    await waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    const b = within(cardOf(r, 'Worker financeiro')).getByRole('button', { name: 'Renovar credencial de ESTACAO-01' });
    b.focus();
    expect(b).toHaveFocus();
    fireEvent.click(b);
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Gerar código' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await screen.findByLabelText('Código de uso único')).toHaveTextContent(CODE);
    expect(api.sent('POST', `/api/v1/o/${ORG}/agents/${AG}/credential-rotations`)).toHaveLength(1);
  });

  it('worker.manage sem permissões de Agent: cartões sem Vincular, Renovar nem Revogar; Autorizar e Retirar continuam', async () => {
    permissions(['worker.manage', 'worker_workspace.authorize']);
    renderApp(`/o/${ORG}/workers`);
    const r = await screen.findByRole('region', { name: 'Lista de Workers' });
    await waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    expect(within(r).queryByRole('button', { name: /Vincular Agent|Renovar credencial|Revogar vínculo/ })).toBeNull();
    expect(within(cardOf(r, 'Worker livre')).getByRole('button', { name: 'Autorizar Worker livre num workspace' })).toBeInTheDocument();
    expect(within(cardOf(r, 'Worker financeiro')).getByRole('button', { name: /Retirar autorização de Financeiro/ })).toBeInTheDocument();
  });

  it('acessibilidade (axe) dos cartões de Workers', async () => {
    renderApp(`/o/${ORG}/workers`);
    const r = await screen.findByRole('region', { name: 'Lista de Workers' });
    await waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    const result = await axe.run(r, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

describe('Máquinas vinculadas em cartões (agent.manage sem worker.manage, R1)', () => {
  beforeEach(() => {
    api.on('GET', `/api/v1/o/${ORG}/workers`, 'listWorkers', { status: 403, body: { error: 'forbidden' } });
  });

  it('agent.manage + agent_credential.manage: um cartão por máquina (nome no título), Renovar e Revogar; revogada sem ações; troca sem consultar', async () => {
    permissions(['agent.manage', 'agent_credential.manage', 'worker_agent.assign']);
    renderApp(`/o/${ORG}/workers`);
    const r = await screen.findByRole('region', { name: 'Máquinas vinculadas' });
    await waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    expect(within(r).queryByRole('table')).toBeNull();
    const ativa = cardOf(r, 'ESTACAO-01');
    expect(ativa).toHaveTextContent('Agent ativo');
    expect(ativa).toHaveTextContent('Worker 11111111…');
    expect(ativa).toHaveTextContent('Conectada');
    expect(within(ativa).getByRole('button', { name: 'Renovar credencial de ESTACAO-01' })).toBeInTheDocument();
    const revogar = within(ativa).getByRole('button', { name: 'Revogar vínculo de ESTACAO-01 com Worker 11111111…' });
    revogar.focus();
    expect(revogar).toHaveFocus();
    expect(within(cardOf(r, 'ESTACAO-ANTIGA')).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Criar Worker' })).toBeNull();
    expect(workersGets()).toBe(0);
    const gets = agentsGets();
    size.resize(1400);
    await waitFor(() => expect(r).toHaveAttribute('data-format', 'tabela'));
    expect(within(r).getByRole('table')).toBeInTheDocument();
    size.resize(500);
    await waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    expect(agentsGets()).toBe(gets);
  });

  it('agent.manage sozinho: nos cartões, Revogar sim e Renovar não', async () => {
    permissions(['agent.manage']);
    renderApp(`/o/${ORG}/workers`);
    const r = await screen.findByRole('region', { name: 'Máquinas vinculadas' });
    await waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    const ativa = cardOf(r, 'ESTACAO-01');
    expect(within(ativa).getByRole('button', { name: /Revogar vínculo/ })).toBeInTheDocument();
    expect(within(ativa).queryByRole('button', { name: /Renovar credencial/ })).toBeNull();
  });

  it('acessibilidade (axe) dos cartões de máquinas', async () => {
    permissions(['agent.manage', 'agent_credential.manage']);
    renderApp(`/o/${ORG}/workers`);
    const r = await screen.findByRole('region', { name: 'Máquinas vinculadas' });
    await waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    const result = await axe.run(r, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});
