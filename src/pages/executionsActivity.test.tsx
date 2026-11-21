import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../api/pendingOps';
import { sessionMemory } from '../app/notices';
import { fakeLocks } from '../test/fakeLocks';
import { renderApp } from '../test/render';
import { RouteApi } from '../test/routeApi';
import { ATTENTION_LABEL, IN_PROGRESS_INTERVAL_MS } from './ExecutionsPage';
import * as fx from '../test/contractFixtures';

/**
 * PLATFORM-FLUXO-002 — acompanhamento unificado em Execuções: abas "Em andamento" (padrão, sem período) e "Histórico" (com
 * período); a pendência de resultado desconhecido aparece como atenção, nunca como em andamento; da execução para a
 * máquina e da máquina para a sua atividade; os endereços antigos de Supervisão levam até lá. Respostas por rota
 * conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ID = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const W1 = ID(31);
const RUN = ID(41);
const EXE = ID(42);
const location = () => screen.getByTestId('location').textContent;

const item = (over: Record<string, unknown>) => ({
  kind: 'platform',
  id: EXE,
  workspace: { id: ID(11), name: 'Financeiro' },
  automation: { id: ID(21), name: 'Conciliação' },
  machine: null,
  outcome: 'in_progress',
  attention: false,
  requestedAt: '2026-11-20T10:00:00Z',
  startedAt: '2026-11-20T10:00:05Z',
  endedAt: null,
  ...over,
});

let api: RouteApi;
beforeEach(() => {
  csrfStore.clear();
  csrfStore.setSession(ORG, 'ses');
  sessionMemory.reset();
  vi.unstubAllGlobals();
  localStorage.clear();
  const locks = fakeLocks();
  setOperationRegistryForTest(createOperationRegistry({ storage: () => localStorage, locks: () => locks, now: () => Date.now() }));
  api = new RouteApi().install();
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' },
  });
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: {
      organizationId: ORG,
      membershipId: ID(90),
      organization: { roles: ['ORG_ADMIN'], permissions: ['org.manage', 'worker.manage'] },
      allWorkspaces: { permissions: ['automation.read'] },
      hasWorkspaceAssignments: false,
    },
  });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workspaces`), 'listWorkspaces', {
    status: 200,
    body: { items: [{ workspaceId: ID(11), name: 'Financeiro', description: null, status: 'active', client: null, createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z' }], nextCursor: null },
  });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/activity$`), 'listActivity', (call) => {
    const tab = new URL(call.url, 'http://x').searchParams.get('tab');
    return tab === 'history'
      ? { status: 200, body: { items: [item({ id: ID(43), outcome: 'succeeded', endedAt: '2026-11-19T10:00:00Z', requestedAt: '2026-11-19T09:00:00Z' })], nextCursor: null } }
      : {
          status: 200,
          body: {
            items: [
              item({}),
              item({
                kind: 'local_agent',
                id: RUN,
                machine: { workerId: W1, name: 'Estação fiscal', computerName: 'NOTE-01' },
                outcome: 'unconfirmed',
                attention: true,
                requestedAt: '2025-02-01T08:00:00Z',
                startedAt: null,
              }),
            ],
            nextCursor: null,
          },
        };
  });
});

const sentActivity = () => api.sent('GET', new RegExp(`/api/v1/o/${ORG}/activity$`)).map((c) => new URL(c.url, 'http://x').searchParams);

describe('Execuções: acompanhamento unificado', () => {
  it('"Em andamento" é o padrão, sem período; a pendência antiga aparece como atenção e leva ao detalhe e à máquina', async () => {
    renderApp(`/o/${ORG}/execucoes`);
    const region = await screen.findByRole('region', { name: 'Lista de execuções' });
    expect(screen.getByRole('tab', { name: 'Em andamento' })).toHaveAttribute('aria-selected', 'true');
    const q = sentActivity().at(-1)!;
    expect(q.get('tab')).toBe('in_progress');
    expect(q.get('from')).toBeNull();
    expect(screen.queryByLabelText('Período')).toBeNull();
    expect(screen.getByText(/Sem filtro de período/)).toBeInTheDocument();
    // a pendência: situação "não confirmada" + atenção; nunca "Em andamento"
    expect(screen.getByText('1 execução requer atenção.')).toBeInTheDocument();
    const rows = within(region).getAllByRole('row').slice(1);
    expect(within(rows[1]).getByText(ATTENTION_LABEL)).toBeInTheDocument();
    expect(within(rows[1]).getByText('Resultado não confirmado')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('Em andamento')).toBeNull();
    // da execução para o seu detalhe (Agent anterior) e para a sua máquina
    expect(within(rows[1]).getByRole('link', { name: /^Execução de Conciliação/ })).toHaveAttribute('href', `/o/${ORG}/execucoes-locais/${RUN}`);
    expect(within(rows[1]).getByRole('link', { name: 'Máquina Estação fiscal (nome da máquina: NOTE-01)' })).toHaveAttribute('href', `/o/${ORG}/workers?maquina=${W1}`);
    expect(within(rows[0]).getByRole('link', { name: /^Execução de Conciliação/ })).toHaveAttribute('href', `/o/${ORG}/execucoes/${EXE}`);
  });

  it('"Em andamento" se atualiza sozinha: a execução iniciada depois aparece sem "Atualizar"; o Histórico não relê sozinho', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let extra = false;
      api.on('GET', new RegExp(`/api/v1/o/${ORG}/activity$`), 'listActivity', (call) => {
        const tab = new URL(call.url, 'http://x').searchParams.get('tab');
        const items = tab === 'history' ? [] : extra ? [item({ id: ID(44), automation: { id: ID(22), name: 'Nova execução' } })] : [];
        return { status: 200, body: { items, nextCursor: null } };
      });
      renderApp(`/o/${ORG}/execucoes`);
      expect(await screen.findByText('Nada em andamento agora.')).toBeInTheDocument();
      const before = sentActivity().length;
      extra = true;
      await vi.advanceTimersByTimeAsync(IN_PROGRESS_INTERVAL_MS + 100);
      expect(await screen.findByRole('link', { name: /^Execução de Nova execução/ })).toBeInTheDocument();
      expect(sentActivity().length).toBe(before + 1);
      fireEvent.click(screen.getByRole('tab', { name: 'Histórico' }));
      await waitFor(() => expect(sentActivity().at(-1)!.get('tab')).toBe('history'));
      const inHistory = sentActivity().length;
      await vi.advanceTimersByTimeAsync(IN_PROGRESS_INTERVAL_MS * 2);
      expect(sentActivity().length).toBe(inHistory);
    } finally {
      vi.useRealTimers();
    }
  });

  it('"Histórico" consulta com o período padrão de 30 dias; voltar à primeira aba não envia período', async () => {
    renderApp(`/o/${ORG}/execucoes`);
    await screen.findByRole('region', { name: 'Lista de execuções' });
    fireEvent.click(screen.getByRole('tab', { name: 'Histórico' }));
    await waitFor(() => expect(sentActivity().at(-1)!.get('tab')).toBe('history'));
    expect(sentActivity().at(-1)!.get('from')).not.toBeNull();
    expect(await screen.findByLabelText('Período')).toBeInTheDocument();
    expect(screen.getByText(/Pendências que requerem atenção continuam em “Em andamento”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Em andamento' }));
    await waitFor(() => expect(sentActivity().at(-1)!.get('tab')).toBe('in_progress'));
    expect(sentActivity().at(-1)!.get('from')).toBeNull();
  });

  it('Python externo com código 0 sem sinal: "Terminou sem erro sinalizado", nunca "Concluída com sucesso"', async () => {
    api.on('GET', new RegExp(`/api/v1/o/${ORG}/activity$`), 'listActivity', {
      status: 200,
      body: { items: [item({ kind: 'local_agent', id: RUN, outcome: 'no_error_signaled', endedAt: '2026-11-20T10:01:00Z' })], nextCursor: null },
    });
    renderApp(`/o/${ORG}/execucoes?aba=historico`);
    const region = await screen.findByRole('region', { name: 'Lista de execuções' });
    expect(within(region).getByText('Terminou sem erro sinalizado')).toBeInTheDocument();
    expect(within(region).queryByText('Concluída com sucesso')).toBeNull();
  });

  it('"Ver atividade" de uma máquina: o filtro vem do endereço e pode ser removido', async () => {
    renderApp(`/o/${ORG}/execucoes?maquina=${W1}`);
    await screen.findByRole('region', { name: 'Lista de execuções' });
    expect(sentActivity().at(-1)!.get('workerId')).toBe(W1);
    expect(await screen.findByText('Somente a máquina Estação fiscal (nome da máquina: NOTE-01).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Abrir a máquina' })).toHaveAttribute('href', `/o/${ORG}/workers?maquina=${W1}`);
    fireEvent.click(screen.getByRole('button', { name: 'Remover filtro de máquina' }));
    await waitFor(() => expect(sentActivity().at(-1)!.get('workerId')).toBeNull());
  });

  it('endereços antigos de Supervisão levam a Execuções e ao detalhe da execução local', async () => {
    const a = renderApp(`/o/${ORG}/supervisao`);
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/execucoes`));
    a.unmount();
    api.on('GET', `/api/v1/o/${ORG}/agent-runs/${RUN}`, 'getAgentRun', { status: 404, body: { error: 'not_found' } });
    renderApp(`/o/${ORG}/supervisao/${RUN}`);
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/execucoes-locais/${RUN}`));
    expect(await screen.findByText('Execução não encontrada.')).toBeInTheDocument();
  });

  it('o menu não tem mais Supervisão', async () => {
    renderApp(`/o/${ORG}/execucoes`);
    const nav = await screen.findByRole('navigation', { name: 'Navegação principal' });
    expect(within(nav).queryByRole('link', { name: 'Supervisão' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Execuções' })).toBeInTheDocument();
  });
});

describe('Detalhe da execução da Platform: a máquina', () => {
  const detalhe = (machine: unknown) => {
    api.on('GET', `/api/v1/o/${ORG}/executions/${EXE}`, 'getExecution', {
      status: 200,
      body: { ...fx.executionDetail, executionId: EXE, workspaceId: ID(11), machine },
    });
    api.on('GET', new RegExp(`/api/v1/o/${ORG}/executions/${EXE}/events`), 'listExecutionEvents', { status: 200, body: { items: [], nextCursor: null } });
  };

  it('com máquina: o nome (e o nome da máquina do pareamento), "Abrir a máquina" e "Ver atividade" com o filtro pelo nome', async () => {
    detalhe({ workerId: W1, name: 'Estação fiscal', computerName: 'NOTE-01' });
    renderApp(`/o/${ORG}/execucoes/${EXE}`);
    expect(await screen.findByText(/Estação fiscal \(nome da máquina: NOTE-01\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Abrir a máquina' })).toHaveAttribute('href', `/o/${ORG}/workers?maquina=${W1}`);
    const atividade = screen.getByRole('link', { name: 'Ver atividade' });
    expect(atividade).toHaveAttribute('href', `/o/${ORG}/execucoes?maquina=${W1}`);
    fireEvent.click(atividade);
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/execucoes`));
    await waitFor(() => expect(sentActivity().at(-1)!.get('workerId')).toBe(W1));
    expect(await screen.findByText('Somente a máquina Estação fiscal (nome da máquina: NOTE-01).')).toBeInTheDocument();
  });

  it('sem máquina registrada: diz isso e não oferece link de máquina', async () => {
    detalhe(null);
    renderApp(`/o/${ORG}/execucoes/${EXE}`);
    expect(await screen.findByText('Sem máquina registrada para esta execução.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Abrir a máquina' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ver atividade' })).toBeNull();
  });
});

describe('Máquinas: atividade e foco numa máquina', () => {
  beforeEach(() => {
    api.on('GET', `/api/v1/o/${ORG}/workers`, 'listWorkers', {
      status: 200,
      body: {
        items: [
          { workerId: W1, name: 'Estação fiscal', status: 'ACTIVE', agentId: null, workspaceIds: [], machineState: 'NO_CONTACT', lastHeartbeatAt: '2026-11-19T08:00:00Z' },
          { workerId: ID(32), name: 'Estação dois', status: 'ACTIVE', agentId: null, workspaceIds: [], machineState: 'REGISTERED' },
        ],
      },
    });
    api.on('GET', `/api/v1/o/${ORG}/activity/machines`, 'listMachineActivity', {
      status: 200,
      body: { items: [{ workerId: W1, inProgress: 0, attention: 1, lastActivityAt: '2025-02-01T08:00:00Z' }] },
    });
  });

  it('resumo de atividade por máquina, com "Ver atividade"; a pendência não conta como em andamento', async () => {
    renderApp(`/o/${ORG}/workers`);
    const row = await screen.findByRole('row', { name: /Estação fiscal/ });
    await waitFor(() => expect(within(row).getByText('1 requer atenção')).toBeInTheDocument());
    expect(within(row).getByText('0 em andamento')).toBeInTheDocument();
    expect(within(row).getByText('Sem contato')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Ver atividade de Estação fiscal' })).toHaveAttribute('href', `/o/${ORG}/execucoes?maquina=${W1}`);
    const other = screen.getByRole('row', { name: /Estação dois/ });
    expect(within(other).getByText('Nenhuma execução visível para você.')).toBeInTheDocument();
  });

  it('"Ver atividade" leva o nome: o filtro identifica a máquina mesmo sem nenhuma linha dela na aba', async () => {
    renderApp(`/o/${ORG}/workers`);
    const row = await screen.findByRole('row', { name: /Estação dois/ });
    fireEvent.click(within(row).getByRole('link', { name: 'Ver atividade de Estação dois' }));
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/execucoes`));
    await waitFor(() => expect(sentActivity().at(-1)!.get('workerId')).toBe(ID(32)));
    expect(await screen.findByText('Somente a máquina Estação dois.')).toBeInTheDocument();
  });

  it('da execução para a máquina: ?maquina= mostra só ela, com o caminho de volta para todas', async () => {
    renderApp(`/o/${ORG}/workers?maquina=${W1}`);
    expect(await screen.findByText('Mostrando só a máquina da execução.')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Estação dois/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar todas as máquinas' }));
    expect(await screen.findByRole('row', { name: /Estação dois/ })).toBeInTheDocument();
  });
});
