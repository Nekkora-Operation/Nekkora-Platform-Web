import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi, type Reply } from '../../test/routeApi';
import { REFRESH_MS } from './presence';

/**
 * PLATFORM-AGENT-V2-003, T11 — vínculo, comunicação e situação do Worker separados nas duas listas (Workers e Máquinas
 * vinculadas); a tela se atualiza sozinha (a cada 30 s, só com a página visível, uma requisição por vez); falha ou 429 na
 * releitura NÃO vira offline (os dados ficam como não confirmados, e a próxima tentativa é automática); revogado nunca
 * aparece online; offline continua vinculada. Respostas por rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const W1 = '11111111-1111-4111-8111-111111111111';
const AG = '33333333-3333-4333-8333-333333333333';
const AG2 = '34444444-3333-4333-8333-333333333333';
const INST = '55555555-5555-4555-8555-555555555555';
const MEMBER = '66666666-6666-4666-8666-666666666666';
const T = '2026-11-10T12:00:00Z';

type W = Record<string, unknown>;
const worker = (over: W = {}): W => ({
  workerId: W1,
  name: 'Worker financeiro',
  status: 'ACTIVE',
  agentId: AG,
  workspaceIds: [],
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
const agent = (over: W = {}): W => ({
  agentId: AG,
  name: 'ESTACAO-01',
  installationId: INST,
  agentVersion: '2.1.0',
  status: 'ACTIVE',
  workerId: W1,
  registeredAt: T,
  lastHeartbeatAt: T,
  connectivity: 'CONNECTED',
  contractVersion: '1.0',
  capabilities: [],
  credentialExpiresAt: '2027-02-10T12:00:00Z',
  ...over,
});

let api: RouteApi;
let workersReply: Reply;
let agentsReply: Reply;
let hidden = false;

function permissions(list: string[]) {
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: { organizationId: ORG, membershipId: MEMBER, organization: { roles: ['ORG_ADMIN'], permissions: list }, allWorkspaces: { permissions: [] }, hasWorkspaceAssignments: false },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
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
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' },
  });
  permissions(['worker.manage', 'agent.manage', 'agent_credential.manage', 'worker_agent.assign', 'worker_workspace.authorize']);
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  workersReply = { status: 200, body: { items: [worker()] } };
  agentsReply = { status: 200, body: { items: [agent()] } };
  api.on('GET', `/api/v1/o/${ORG}/workers`, 'listWorkers', () => workersReply);
  api.on('GET', `/api/v1/o/${ORG}/agents`, 'listAgents', () => agentsReply);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const workerGets = () => api.sent('GET', `/api/v1/o/${ORG}/workers`).length;
const agentGets = () => api.sent('GET', `/api/v1/o/${ORG}/agents`).length;
const rowOf = (text: string) => {
  const row = screen.getAllByRole('row').find((r) => r.textContent?.includes(text));
  if (!row) throw new Error(`linha não encontrada: ${text}`);
  return row;
};
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

async function openWorkers() {
  renderApp(`/o/${ORG}/workers`);
  await screen.findByRole('heading', { name: 'Workers', level: 1 });
  await waitFor(() => rowOf('ESTACAO-01'));
}

describe('T11: releitura automática', () => {
  it('relê a cada 30 s com a página visível, uma requisição por vez; com a aba oculta, nenhuma; ao voltar, relê', async () => {
    await openWorkers();
    const first = workerGets();
    expect(screen.getByText(/^Atualizado às .*A lista se atualiza sozinha a cada 30 segundos/)).toBeInTheDocument();
    await tick(REFRESH_MS - 1000);
    expect(workerGets()).toBe(first);
    await tick(1000);
    expect(workerGets()).toBe(first + 1);
    await tick(REFRESH_MS);
    expect(workerGets()).toBe(first + 2);
    // aba oculta: nenhuma releitura
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(REFRESH_MS * 3);
    expect(workerGets()).toBe(first + 2);
    // de volta: relê uma vez na hora (passou mais de 30 s)
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(workerGets()).toBe(first + 3));
  });

  it('online vira offline pela leitura da API, e offline continua vinculada (não é desvinculado)', async () => {
    await openWorkers();
    expect(within(rowOf('ESTACAO-01')).getByText('Online')).toBeInTheDocument();
    workersReply = { status: 200, body: { items: [worker({ connectivity: 'DISCONNECTED', lastHeartbeatAt: '2026-11-10T11:55:00Z' })] } };
    await tick(REFRESH_MS);
    await waitFor(() => expect(within(rowOf('ESTACAO-01')).getByText('Offline')).toBeInTheDocument());
    const row = rowOf('ESTACAO-01');
    expect(within(row).getByText('Vinculada')).toBeInTheDocument();
    expect(within(row).getByText('Ativo')).toBeInTheDocument();
    expect(within(row).getByText(/Último contato:/).querySelector('time')).toHaveAttribute('dateTime', '2026-11-10T11:55:00Z');
    expect(document.body.textContent).not.toMatch(/Desvinculad|Desligad/);
  });
});

describe('T11: falha de consulta não é prova de offline', () => {
  for (const [name, reply, text] of [
    ['erro da API (503)', { status: 503, body: { error: 'service_unavailable' } }, /Não foi possível atualizar a lista às/],
    ['429 da API', { status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '5' } }, /Muitas consultas em pouco tempo/],
    ['429 do gateway', { gateway: 429 }, /Muitas consultas em pouco tempo/],
    ['rede', 'network', /Não foi possível atualizar a lista às/],
  ] as const) {
    it(`${name}: mantém as linhas, marca a comunicação como não confirmada e se recupera sozinha`, async () => {
      await openWorkers();
      workersReply = reply as Reply;
      await tick(REFRESH_MS);
      await waitFor(() => expect(screen.getByText('Dados não confirmados')).toBeInTheDocument());
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.getByText(/Nenhuma máquina foi considerada offline por causa disso/)).toBeInTheDocument();
      const row = rowOf('ESTACAO-01');
      // as linhas continuam; nada vira offline
      expect(within(row).getByText('Não confirmada')).toBeInTheDocument();
      expect(within(row).getByText(/Na leitura das .*: online/)).toBeInTheDocument();
      expect(within(row).queryByText('Offline')).toBeNull();
      expect(within(row).getByText('Vinculada')).toBeInTheDocument();
      // recuperação automática
      workersReply = { status: 200, body: { items: [worker()] } };
      await tick(REFRESH_MS);
      await waitFor(() => expect(screen.queryByText('Dados não confirmados')).toBeNull());
      expect(within(rowOf('ESTACAO-01')).getByText('Online')).toBeInTheDocument();
    });
  }

  it('"Tentar agora" relê na hora, sem esperar o ciclo', async () => {
    await openWorkers();
    workersReply = { status: 503, body: { error: 'service_unavailable' } };
    await tick(REFRESH_MS);
    await waitFor(() => expect(screen.getByText('Dados não confirmados')).toBeInTheDocument());
    workersReply = { status: 200, body: { items: [worker()] } };
    const before = workerGets();
    await act(async () => {
      screen.getByRole('button', { name: 'Tentar agora' }).click();
    });
    await waitFor(() => expect(screen.queryByText('Dados não confirmados')).toBeNull());
    expect(workerGets()).toBe(before + 1);
  });
});

describe('T11: vínculo e comunicação separados', () => {
  it('ainda sem comunicação: nunca online antes do primeiro contato', async () => {
    workersReply = { status: 200, body: { items: [worker({ lastHeartbeatAt: null, connectivity: 'DISCONNECTED' })] } };
    await openWorkers();
    const row = rowOf('ESTACAO-01');
    expect(within(row).getByText('Ainda sem comunicação')).toBeInTheDocument();
    expect(within(row).queryByText(/^(Online|Offline)$/)).toBeNull();
    expect(within(row).getByText('Vinculada')).toBeInTheDocument();
  });

  it('Máquinas vinculadas (agent.manage sem worker.manage): revogada mostra "Vínculo revogado" e nunca online; a outra continua online; relê sozinha', async () => {
    permissions(['agent.manage', 'agent_credential.manage']);
    // mesmo que uma resposta antiga trouxesse CONNECTED, revogado nunca é mostrado online
    agentsReply = { status: 200, body: { items: [agent(), agent({ agentId: AG2, name: 'ESTACAO-02', status: 'REVOKED', workerId: null, connectivity: 'CONNECTED', credentialExpiresAt: null })] } };
    renderApp(`/o/${ORG}/workers`);
    await waitFor(() => rowOf('ESTACAO-02'));
    const revoked = rowOf('ESTACAO-02');
    expect(within(revoked).getByText('Vínculo revogado')).toBeInTheDocument();
    expect(within(revoked).getByText('Não se aplica: vínculo revogado')).toBeInTheDocument();
    expect(within(revoked).queryByText('Online')).toBeNull();
    expect(within(rowOf('ESTACAO-01')).getByText('Online')).toBeInTheDocument();
    const before = agentGets();
    await tick(REFRESH_MS);
    expect(agentGets()).toBe(before + 1);
  });
});

/**
 * PLATFORM-AGENT-V2-004, T13 — "Desvincular esta máquina" no Agent passa a encerrar o vínculo na Platform. A tela reflete a
 * conclusão na próxima releitura (até 30 s com a página visível), sem recarregar: o Worker fica "Sem máquina vinculada",
 * com "Vincular Agent" para quem pode parear, e continua administrativamente ativo. Antes da conclusão (pedido esperando na
 * máquina), continua vinculada e offline, com "Revogar vínculo".
 */
describe('T13: desvínculo pela máquina', () => {
  it('Workers: pedido esperando na máquina = vinculada e offline (com Revogar vínculo); confirmado = Sem máquina vinculada + Vincular Agent, sem recarregar', async () => {
    workersReply = { status: 200, body: { items: [worker({ connectivity: 'DISCONNECTED', lastHeartbeatAt: '2026-11-10T11:50:00Z' })] } };
    await openWorkers();
    const row = rowOf('Worker financeiro');
    expect(within(row).getByText('Vinculada')).toBeInTheDocument();
    expect(within(row).getByText('Offline')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Revogar vínculo/ })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Vincular Agent/ })).toBeNull();
    // a Platform confirmou o desvínculo pedido pela máquina: a próxima releitura (30 s) traz o Worker livre
    workersReply = {
      status: 200,
      body: { items: [worker({ agentId: null, agentName: null, agentStatus: null, agentVersion: null, installationId: null, lastHeartbeatAt: null, connectivity: null, credentialExpiresAt: null })] },
    };
    await tick(REFRESH_MS);
    await waitFor(() => expect(within(rowOf('Worker financeiro')).getByText('Sem máquina vinculada')).toBeInTheDocument());
    const free = rowOf('Worker financeiro');
    expect(within(free).getByText('Ativo')).toBeInTheDocument();
    expect(within(free).getByRole('button', { name: 'Vincular Agent a Worker financeiro' })).toBeInTheDocument();
    expect(within(free).queryByRole('button', { name: /Revogar vínculo/ })).toBeNull();
    expect(within(free).queryByText(/^(Online|Offline)$/)).toBeNull();
  });

  it('Workers: falha ou 429 na releitura depois do pedido não deduz desvínculo nem offline (continua "Não confirmada")', async () => {
    await openWorkers();
    workersReply = { status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '30' } };
    await tick(REFRESH_MS);
    const row = rowOf('Worker financeiro');
    await waitFor(() => expect(within(row).getByText('Não confirmada')).toBeInTheDocument());
    expect(within(row).getByText('Vinculada')).toBeInTheDocument();
    expect(within(row).queryByText('Sem máquina vinculada')).toBeNull();
  });

  it('Máquinas vinculadas: encerrado pela máquina aparece "Desvinculada pela máquina" (nunca online); revogado pela administração continua "Vínculo revogado"', async () => {
    permissions(['agent.manage', 'agent_credential.manage']);
    agentsReply = {
      status: 200,
      body: {
        items: [
          agent({ status: 'REVOKED', workerId: null, connectivity: 'CONNECTED', credentialExpiresAt: null, endedBy: 'MACHINE' }),
          agent({ agentId: AG2, name: 'ESTACAO-02', status: 'REVOKED', workerId: null, connectivity: 'DISCONNECTED', credentialExpiresAt: null, endedBy: 'ADMINISTRATION' }),
        ],
      },
    };
    renderApp(`/o/${ORG}/workers`);
    await waitFor(() => rowOf('ESTACAO-02'));
    const machine = rowOf('ESTACAO-01');
    expect(within(machine).getByText('Desvinculada pela máquina')).toBeInTheDocument();
    expect(within(machine).getByText('Não se aplica: máquina desvinculada')).toBeInTheDocument();
    expect(within(machine).queryByText('Online')).toBeNull();
    expect(within(machine).queryByText('Vínculo revogado')).toBeNull();
    const admin = rowOf('ESTACAO-02');
    expect(within(admin).getByText('Vínculo revogado')).toBeInTheDocument();
    expect(within(admin).getByText('Não se aplica: vínculo revogado')).toBeInTheDocument();
  });
});
