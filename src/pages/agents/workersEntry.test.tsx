import axe from 'axe-core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { location } from '../../test/helpers';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { WORKER_LIMIT_TEXT } from './WorkersPage';

/**
 * PLATFORM-AGENT-V2-002, T07 — Workers como entrada única do fluxo diário: criar o Worker (sem Agent, sem código, sem
 * execução), vincular o Agent ao MESMO Worker (workerId), gerenciar o vínculo (renovar a credencial, revogar) e ver
 * separadas a situação do Worker, a máquina vinculada e a comunicação. Respostas por rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const AG = '33333333-3333-4333-8333-333333333333';
const ENR = '44444444-4444-4444-8444-444444444444';
const INST = '55555555-5555-4555-8555-555555555555';
const MEMBER = '66666666-6666-4666-8666-666666666666';
const T = '2026-11-10T12:00:00Z';
const ALL = ['worker.manage', 'agent.manage', 'agent_credential.manage', 'worker_agent.assign', 'worker_workspace.authorize'];
const CODE = `nkp1.${ENR}.${W1}.${'A'.repeat(43)}`;

type W = Record<string, unknown>;
const free = (workerId = W1, name = 'Worker financeiro'): W => ({
  workerId,
  name,
  status: 'ACTIVE',
  agentId: null,
  workspaceIds: [],
  agentName: null,
  agentStatus: null,
  agentVersion: null,
  installationId: null,
  lastHeartbeatAt: null,
  connectivity: null,
  credentialExpiresAt: null,
  createdAt: T,
});
const withAgent = (over: W = {}): W => ({
  ...free(),
  agentId: AG,
  agentName: 'ESTACAO-01',
  agentStatus: 'ACTIVE',
  agentVersion: '2.1.0',
  installationId: INST,
  lastHeartbeatAt: T,
  connectivity: 'CONNECTED',
  credentialExpiresAt: '2027-02-10T12:00:00Z',
  ...over,
});

let api: RouteApi;
let workers: W[];

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
  permissions(ALL);
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  workers = [];
  api.on('GET', `/api/v1/o/${ORG}/workers`, 'listWorkers', () => ({ status: 200, body: { items: workers } }));
});
afterEach(() => vi.unstubAllGlobals());

const listGets = () => api.sent('GET', `/api/v1/o/${ORG}/workers`).length;
const workerPosts = () => api.sent('POST', `/api/v1/o/${ORG}/workers`);
const pairingPosts = () => api.sent('POST', `/api/v1/o/${ORG}/agent-enrollments`);
const nothingElse = () => expect(api.sent('POST', /agent-enrollments|run-requests|local-run-authorizations|executions/)).toEqual([]);
const dialog = () => screen.getByRole('alertdialog');
const rowOf = (text: string) => {
  const row = screen.getAllByRole('row').find((r) => r.textContent?.includes(text));
  if (!row) throw new Error(`linha não encontrada: ${text}`);
  return row;
};

async function confirmIn(label: string) {
  const button = within(dialog()).getByRole('button', { name: label });
  // o registro da operação (proteção contra repetição) é lido ao abrir: só então a confirmação libera
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

async function openPage() {
  renderApp(`/o/${ORG}/workers`);
  await screen.findByRole('heading', { name: 'Workers', level: 1 });
}

async function openCreate(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Criar Worker' }));
  fireEvent.change(within(dialog()).getByLabelText(/^Nome do Worker/), { target: { value: name } });
  const confirm = within(dialog()).getByRole('button', { name: 'Criar Worker' });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
}

describe('Workers: criar Worker (T07)', () => {
  it('sem Worker: o estado vazio orienta a Criar Worker; criar envia só o nome, sem Agent, código ou execução', async () => {
    api.on('POST', `/api/v1/o/${ORG}/workers`, 'createWorker', () => {
      workers = [free(W1, 'Worker financeiro')];
      return { status: 201, body: { workerId: W1, name: 'Worker financeiro', status: 'ACTIVE' } };
    });
    await openPage();
    expect(await screen.findByText('Nenhum Worker criado.')).toBeInTheDocument();
    expect(screen.getByText(/Use Criar Worker para registrar onde as automações vão rodar/)).toBeInTheDocument();
    await openCreate('  Worker financeiro  ');
    expect(await screen.findByText(/Worker Worker financeiro criado, sem Agent/)).toBeInTheDocument();
    expect(workerPosts()).toHaveLength(1);
    expect(workerPosts()[0].body).toEqual({ name: 'Worker financeiro' });
    expect(workerPosts()[0].csrf).toBe('ses');
    const row = await waitFor(() => rowOf('Worker financeiro'));
    expect(within(row).getByText('Ativo')).toBeInTheDocument();
    expect(within(row).getByText('Sem Agent')).toBeInTheDocument();
    expect(within(row).getByText('—')).toBeInTheDocument();
    nothingElse();
  });

  it('409 worker_limit_reached: texto claro do limite (zero antes da ativação), um único envio, nada criado', async () => {
    api.on('POST', `/api/v1/o/${ORG}/workers`, 'createWorker', { status: 409, body: { error: 'conflict', reason: 'worker_limit_reached' } });
    await openPage();
    await openCreate('Worker financeiro');
    expect(await within(dialog()).findByText(WORKER_LIMIT_TEXT)).toBeInTheDocument();
    expect(WORKER_LIMIT_TEXT).toMatch(/aguarda ativação, o limite é zero; depois da ativação, ele é definido pela Nekkora/);
    expect(workerPosts()).toHaveLength(1);
    nothingElse();
  });

  it('resposta perdida: incerteza com orientação de conferir a lista; nada é reenviado, nem ao reabrir', async () => {
    api.on('POST', `/api/v1/o/${ORG}/workers`, 'createWorker', 'network');
    await openPage();
    await openCreate('Worker financeiro');
    expect(await within(dialog()).findByText(/Não foi possível confirmar se o Worker foi criado. Feche e confira a lista de Workers antes de criar de novo/)).toBeInTheDocument();
    expect(within(dialog()).getByText('Resultado não confirmado')).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Criar Worker' })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 50));
    expect(workerPosts()).toHaveLength(1);
    // reabrir: o registro da operação continua bloqueando até a conferência explícita
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Criar Worker' }));
    fireEvent.change(within(dialog()).getByLabelText(/^Nome do Worker/), { target: { value: 'Worker financeiro' } });
    expect(await within(dialog()).findByText(/ficou sem resposta confirmada/)).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Criar Worker' })).toBeDisabled();
    expect(workerPosts()).toHaveLength(1);
  });
});

describe('Workers: vincular e gerenciar o Agent (T07)', () => {
  it('Vincular Agent emite o código para ESTE Worker (workerId, sem workerName) e mostra o código uma vez; cancelar não cria máquina', async () => {
    workers = [free()];
    api.on('POST', `/api/v1/o/${ORG}/agent-enrollments`, 'createAgentPairingCode', { status: 201, body: { enrollmentId: ENR, code: CODE, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), workerId: W1 } });
    api.on('POST', `/api/v1/o/${ORG}/agent-enrollments/${ENR}/cancel`, 'cancelAgentCode', { status: 204 });
    await openPage();
    const row = await waitFor(() => rowOf('Worker financeiro'));
    // livre: autorizar em workspace e vincular Agent lado a lado
    expect(within(row).getByRole('button', { name: 'Autorizar Worker financeiro num workspace' })).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Vincular Agent a Worker financeiro' }));
    const name = within(dialog()).getByLabelText(/^Nome da máquina/) as HTMLInputElement;
    expect(name.value).toBe('Worker financeiro');
    fireEvent.change(name, { target: { value: 'ESTACAO-01' } });
    expect(within(dialog()).getByLabelText(/^Validade do código/)).toHaveValue(15);
    await confirmIn('Gerar código');
    expect(await screen.findByLabelText('Código de uso único')).toHaveTextContent(CODE);
    expect(screen.getAllByLabelText('Código de uso único')).toHaveLength(1);
    expect(screen.getByText('Código de pareamento para Worker financeiro')).toBeInTheDocument();
    expect(pairingPosts()).toHaveLength(1);
    expect(pairingPosts()[0].body).toEqual({ workerId: W1, agentName: 'ESTACAO-01', expiresInMinutes: 15 });
    expect(workerPosts()).toEqual([]);
    // nenhuma máquina fictícia: a linha continua sem Agent enquanto a lista do servidor não trouxer o vínculo
    expect(within(rowOf('Worker financeiro')).getByText('Sem Agent')).toBeInTheDocument();
    expect(screen.queryByText('ESTACAO-01')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar código' }));
    expect(await screen.findByText(/Código cancelado: ele não pode mais ser usado. Nenhuma máquina foi registrada./)).toBeInTheDocument();
    expect(api.sent('POST', `/api/v1/o/${ORG}/agent-enrollments/${ENR}/cancel`)).toHaveLength(1);
    const before = listGets();
    fireEvent.click(screen.getByRole('button', { name: 'Concluir' }));
    await waitFor(() => expect(listGets()).toBeGreaterThan(before));
    expect(screen.queryByLabelText('Código de uso único')).toBeNull();
    expect(within(await waitFor(() => rowOf('Worker financeiro'))).getByText('Sem Agent')).toBeInTheDocument();
    expect(screen.queryByText('ESTACAO-01')).toBeNull();
  });

  it('a máquina aparece só quando a lista do servidor traz o vínculo (depois do resgate), com versão e validade da credencial', async () => {
    workers = [free()];
    api.on('POST', `/api/v1/o/${ORG}/agent-enrollments`, 'createAgentPairingCode', { status: 201, body: { enrollmentId: ENR, code: CODE, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), workerId: W1 } });
    await openPage();
    fireEvent.click(within(await waitFor(() => rowOf('Worker financeiro'))).getByRole('button', { name: 'Vincular Agent a Worker financeiro' }));
    fireEvent.change(within(dialog()).getByLabelText(/^Nome da máquina/), { target: { value: 'ESTACAO-01' } });
    await confirmIn('Gerar código');
    await screen.findByLabelText('Código de uso único');
    // o Agent resgatou o código na máquina: a lista passa a trazer o vínculo
    workers = [withAgent()];
    fireEvent.click(screen.getByRole('button', { name: 'Concluir' }));
    const row = await waitFor(() => rowOf('ESTACAO-01'));
    expect(within(row).getByText('Worker financeiro')).toBeInTheDocument();
    expect(within(row).getByText('Agent ativo')).toBeInTheDocument();
    expect(within(row).getByText('Versão do Agent: 2.1.0')).toBeInTheDocument();
    expect(within(row).getByText(/Credencial vale até/)).toBeInTheDocument();
    expect(within(row).getByText('Conectada')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Vincular Agent/ })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Renovar credencial de ESTACAO-01' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Revogar vínculo de ESTACAO-01 com Worker financeiro' })).toBeInTheDocument();
    expect(pairingPosts()).toHaveLength(1);
  });

  it('comunicação: Conectada; Sem comunicação com último sinal ou "nunca"; Sem Agent com "—"; nota sobre a falta de sinal', async () => {
    workers = [
      withAgent({ workerId: W1, name: 'Worker A', agentName: 'MAQ-A', connectivity: 'CONNECTED' }),
      withAgent({ workerId: W2, name: 'Worker B', agentName: 'MAQ-B', connectivity: 'DISCONNECTED', lastHeartbeatAt: '2026-11-09T08:30:00Z' }),
      withAgent({ workerId: '77777777-7777-4777-8777-777777777777', name: 'Worker C', agentName: 'MAQ-C', connectivity: 'DISCONNECTED', lastHeartbeatAt: null, agentId: '88888888-8888-4888-8888-888888888888' }),
      free('99999999-9999-4999-8999-999999999999', 'Worker D'),
    ];
    await openPage();
    const a = await waitFor(() => rowOf('MAQ-A'));
    expect(within(a).getByText('Conectada')).toBeInTheDocument();
    const b = rowOf('MAQ-B');
    expect(within(b).getByText('Sem comunicação')).toBeInTheDocument();
    expect(within(b).getByText(/Último sinal:/).querySelector('time')).toHaveAttribute('dateTime', '2026-11-09T08:30:00Z');
    const c = rowOf('MAQ-C');
    expect(within(c).getByText('Sem comunicação')).toBeInTheDocument();
    expect(within(c).getByText(/Último sinal:/)).toHaveTextContent('Último sinal: nunca');
    const d = rowOf('Worker D');
    expect(within(d).getByText('Sem Agent')).toBeInTheDocument();
    expect(within(d).getByText('—')).toBeInTheDocument();
    expect(within(d).queryByText(/Sem comunicação|Conectada/)).toBeNull();
    // nunca diz que a máquina foi desligada; a falta de sinal não muda nada no servidor
    expect(document.body.textContent).not.toMatch(/Desligada|Desligado/);
    expect(
      screen.getByText(/A falta de sinal não revoga a credencial, não libera o Worker, não retira workspaces e não encerra execuções. Quando o sinal voltar, a máquina aparece conectada de novo, sem novo pareamento./),
    ).toBeInTheDocument();
  });

  it('Renovar credencial gera o código de rotação; Revogar vínculo explica que o Worker fica livre e envia o motivo', async () => {
    workers = [withAgent()];
    api.on('POST', `/api/v1/o/${ORG}/agents/${AG}/credential-rotations`, 'createAgentRotationCode', {
      status: 201,
      body: { enrollmentId: ENR, code: CODE, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), workerId: W1, agentId: AG },
    });
    api.on('POST', `/api/v1/o/${ORG}/agents/${AG}/revoke`, 'revokeAgent', () => {
      workers = [free()];
      return { status: 204 };
    });
    await openPage();
    fireEvent.click(within(await waitFor(() => rowOf('ESTACAO-01'))).getByRole('button', { name: 'Renovar credencial de ESTACAO-01' }));
    await confirmIn('Gerar código');
    expect(await screen.findByLabelText('Código de uso único')).toHaveTextContent(CODE);
    expect(screen.getByText('Código de renovação da credencial de ESTACAO-01')).toBeInTheDocument();
    expect(api.sent('POST', `/api/v1/o/${ORG}/agents/${AG}/credential-rotations`)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Concluir' }));

    fireEvent.click(within(await waitFor(() => rowOf('ESTACAO-01'))).getByRole('button', { name: 'Revogar vínculo de ESTACAO-01 com Worker financeiro' }));
    expect(within(dialog()).getByText(/O Worker fica livre na Platform e continua existindo, com as autorizações de workspace e o histórico/)).toBeInTheDocument();
    expect(within(dialog()).getByText(/A máquina em si não é contatada/)).toBeInTheDocument();
    await confirmIn('Revogar vínculo');
    expect(await screen.findByText(/Vínculo revogado: o Worker Worker financeiro está livre/)).toBeInTheDocument();
    expect(api.sent('POST', `/api/v1/o/${ORG}/agents/${AG}/revoke`)[0].body).toEqual({ reason: 'ADMINISTRATIVE' });
    expect(within(await waitFor(() => rowOf('Worker financeiro'))).getByText('Sem Agent')).toBeInTheDocument();
  });

  it('sem agent_credential.manage: nem Vincular Agent nem Renovar credencial; Revogar vínculo continua com agent.manage', async () => {
    permissions(ALL.filter((p) => p !== 'agent_credential.manage'));
    workers = [withAgent(), free(W2, 'Worker livre')];
    await openPage();
    const linked = await waitFor(() => rowOf('ESTACAO-01'));
    expect(within(linked).queryByRole('button', { name: /Renovar credencial/ })).toBeNull();
    expect(within(linked).getByRole('button', { name: /Revogar vínculo/ })).toBeInTheDocument();
    expect(within(rowOf('Worker livre')).queryByRole('button', { name: /Vincular Agent/ })).toBeNull();
    expect(within(rowOf('Worker livre')).getByRole('button', { name: /Autorizar Worker livre/ })).toBeInTheDocument();
  });

  it('sem agent.manage: sem Revogar vínculo (e sem Vincular Agent); Renovar credencial continua com agent_credential.manage', async () => {
    permissions(ALL.filter((p) => p !== 'agent.manage'));
    workers = [withAgent(), free(W2, 'Worker livre')];
    await openPage();
    const linked = await waitFor(() => rowOf('ESTACAO-01'));
    expect(within(linked).queryByRole('button', { name: /Revogar vínculo/ })).toBeNull();
    expect(within(linked).getByRole('button', { name: /Renovar credencial/ })).toBeInTheDocument();
    expect(within(rowOf('Worker livre')).queryByRole('button', { name: /Vincular Agent/ })).toBeNull();
  });

  it('acessibilidade (axe) da lista com máquina vinculada e Worker livre', async () => {
    workers = [withAgent(), free(W2, 'Worker livre')];
    await openPage();
    await waitFor(() => rowOf('ESTACAO-01'));
    const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

describe('compatibilidade com Agents (T07)', () => {
  it('/o/{org}/agents leva a /o/{org}/workers; o menu não tem item separado de Agents', async () => {
    renderApp(`/o/${ORG}/agents`);
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/workers`));
    expect(await screen.findByRole('heading', { name: 'Workers', level: 1 })).toBeInTheDocument();
    const nav = await screen.findByRole('navigation', { name: 'Navegação principal' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Workers' })).toHaveAttribute('aria-current', 'page'));
    expect(within(nav).queryByRole('link', { name: 'Agents' })).toBeNull();
    expect(api.sent('GET', `/api/v1/o/${ORG}/agents`)).toEqual([]);
  });
});
