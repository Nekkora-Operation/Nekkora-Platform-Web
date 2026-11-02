import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { sessionMemory } from '../../app/notices';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';

/**
 * Supervisão — testes de COMPONENTE com respostas por rota conferidas contra o contrato (FIXTURES identificadas): estados
 * raros no laboratório (desfecho desconhecido, histórico incompleto, expurgo, etapas indisponíveis). O acompanhamento
 * de uma execução real está no E2E com o Agent real (e2e-real/m4-agent.spec.ts).
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const RUN = '11111111-2222-4333-8444-555555555555';
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const run = (over: Record<string, unknown> = {}) => ({
  runId: RUN,
  correlation: {
    agentExecutionId: `ex-${'a'.repeat(32)}`,
    frameworkExecutionId: null,
    platformExecutionId: null,
    agentId: ID(1),
    workerId: ID(2),
    workspaceId: ID(3),
    automationId: ID(4),
    automationVersionId: ID(5),
    authorizationId: ID(6),
  },
  origin: 'LOCAL_AUTHORIZED',
  authorizationStateAtRegistration: 'ACTIVE',
  registeredAt: '2026-10-30T10:00:00Z',
  supervisor: { state: 'OUTCOME_UNKNOWN', code: 'AGT-SUP-007', exitCode: null, counts: {}, adopted: false, suspensions: 0, locks: 0, reports: 2, conflicts: 1, lastReportAt: '2026-10-30T10:05:00Z' },
  process: 'ENDED',
  outcome: 'UNKNOWN',
  transport: { connectivity: 'DISCONNECTED', lastHeartbeatAt: '2026-10-30T10:04:00Z', lastEventAt: null },
  history: { completeness: 'INCOMPLETE', reasons: ['LOST_LOCAL'], eventsStored: 0, storedThrough: 0, settledThrough: 0, maxSequence: 0, declaredMissing: 3, collectionCompletedSequence: null, invalidRefused: 0, stepsAvailable: false },
  transactionsSeen: {},
  retention: { state: 'PARTIALLY_PURGED', eventsPurged: 4 },
  ...over,
});

let api: RouteApi;
beforeEach(() => {
  // jsdom começa com a aba "oculta": a supervisão pausaria a consulta (comportamento correto); aqui a aba está visível
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  csrfStore.clear();
  sessionMemory.reset();
  vi.unstubAllGlobals();
  api = new RouteApi().install();
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA' },
  });
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: { organizationId: ORG, membershipId: ID(7), organization: { roles: [], permissions: [] }, allWorkspaces: { permissions: [] }, hasWorkspaceAssignments: true },
  });
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
});

describe('supervisão (fixtures de contrato)', () => {
  it('desfecho desconhecido, histórico incompleto com motivo, retenção parcial e etapas indisponíveis ficam separados', async () => {
    api.on('GET', `/api/v1/o/${ORG}/agent-runs/${RUN}`, 'getAgentRun', { status: 200, body: run() });
    renderApp(`/o/${ORG}/supervisao/${RUN}`);
    expect(await screen.findByRole('heading', { name: 'Execução local' })).toBeInTheDocument();
    expect(screen.getByText('Encerrado')).toBeInTheDocument();
    expect(screen.getByText('Desconhecido')).toBeInTheDocument();
    expect(screen.getByText(/Supervisor: Desfecho desconhecido/)).toBeInTheDocument();
    expect(screen.getByText('Agent sem sinal recente')).toBeInTheDocument();
    expect(screen.getByText('Presença do Agent, não término do processo.')).toBeInTheDocument();
    expect(screen.getByText('Incompleto')).toBeInTheDocument();
    expect(screen.getByText('perdidos na máquina')).toBeInTheDocument();
    expect(screen.getByText(/4 eventos expurgados \(não é perda na origem\)/)).toBeInTheDocument();
    expect(screen.getByText('Etapas indisponíveis')).toBeInTheDocument();
    expect(screen.getByText(/1 contraditórios registrados/)).toBeInTheDocument();
    // acompanhamento encerrado: desfecho e entrega não estão pendentes; nenhum evento é consultado sem etapas
    expect(screen.getByText(/Acompanhamento automático encerrado: nada pendente./)).toBeInTheDocument();
    expect(api.sent('GET', new RegExp(`/agent-runs/${RUN}/events`))).toEqual([]);
    // sem porcentagem inventada e sem botão de executar/cancelar remoto
    expect(document.body.textContent).not.toMatch(/\d+ ?%/);
    expect(screen.queryByRole('button', { name: /executar|cancelar|iniciar/i })).toBeNull();
  });

  it('entrega pendente mantém o acompanhamento mesmo com o processo encerrado; eventos em ordem de sequence', async () => {
    api.on('GET', `/api/v1/o/${ORG}/agent-runs/${RUN}`, 'getAgentRun', {
      status: 200,
      body: run({
        supervisor: { state: 'SUCCEEDED', code: null, exitCode: 0, counts: { ok: 1 }, adopted: false, suspensions: 0, locks: 0, reports: 1, conflicts: 0, lastReportAt: '2026-10-30T10:05:00Z' },
        outcome: 'KNOWN',
        history: { completeness: 'PENDING', reasons: ['DELIVERY_PENDING'], eventsStored: 2, storedThrough: 2, settledThrough: 2, maxSequence: 3, declaredMissing: 0, collectionCompletedSequence: null, invalidRefused: 0, stepsAvailable: true },
        retention: { state: 'AVAILABLE', eventsPurged: 0 },
      }),
    });
    const event = (sequence: number, eventCode: string) => ({
      sequence,
      source: 'FRAMEWORK',
      eventCode,
      severity: 'INFO',
      category: 'ACTIVITY',
      phase: 'Pesquisa do artigo',
      stepId: `s${sequence}`,
      studioStepId: null,
      action: 'fill',
      status: 'OK',
      errorCode: null,
      attempt: 1,
      elapsedMs: 1200,
      transactionRef: null,
      counts: null,
      timestampUtc: null,
      observedUtc: '2026-10-30T10:01:00Z',
      receivedAt: '2026-10-30T10:01:05Z',
      purged: false,
    });
    api.on('GET', new RegExp(`/agent-runs/${RUN}/events$`), 'listAgentRunEvents', { status: 200, body: { items: [event(1, 'STEP_STARTED'), event(2, 'STEP_DONE')], nextCursor: null } });
    renderApp(`/o/${ORG}/supervisao/${RUN}`);
    expect(await screen.findByText('Entrega pendente')).toBeInTheDocument();
    expect(screen.getByText('eventos ainda não entregues pelo Agent')).toBeInTheDocument();
    expect(screen.getByText(/Atualiza a cada 10 s/)).toBeInTheDocument();
    const codes = screen.getAllByText(/^STEP_/).map((e) => e.textContent);
    expect(codes).toEqual(['STEP_STARTED', 'STEP_DONE']);
  });

  it('desfecho conhecido não é pintado de sucesso: a cor vem do supervisor', async () => {
    api.on('GET', `/api/v1/o/${ORG}/agent-runs/${RUN}`, 'getAgentRun', {
      status: 200,
      body: run({ supervisor: { ...run().supervisor, state: 'FAILED', code: 'AGT-SUP-003' }, outcome: 'KNOWN' }),
    });
    renderApp(`/o/${ORG}/supervisao/${RUN}`);
    const known = await screen.findByText('Conhecido');
    expect(known.closest('[class*="success"]')).toBeNull();
  });

  it('com o histórico igual no servidor, "Atualizar" relê a execução mas não as páginas de eventos; mudou, relê', async () => {
    const pending = { completeness: 'PENDING', reasons: ['DELIVERY_PENDING'], eventsStored: 1, storedThrough: 1, settledThrough: 1, maxSequence: 2, declaredMissing: 0, collectionCompletedSequence: null, invalidRefused: 0, stepsAvailable: true };
    let history = pending;
    api.on('GET', `/api/v1/o/${ORG}/agent-runs/${RUN}`, 'getAgentRun', () => ({
      status: 200,
      body: run({ supervisor: { ...run().supervisor, state: 'RUNNING', code: null }, process: 'RUNNING', outcome: 'PENDING', history, retention: { state: 'AVAILABLE', eventsPurged: 0 } }),
    }));
    api.on('GET', new RegExp(`/agent-runs/${RUN}/events$`), 'listAgentRunEvents', { status: 200, body: { items: [], nextCursor: null } });
    renderApp(`/o/${ORG}/supervisao/${RUN}`);
    await screen.findByText('Entrega pendente');
    const events = () => api.sent('GET', new RegExp(`/agent-runs/${RUN}/events$`)).length;
    const runs = () => api.sent('GET', `/api/v1/o/${ORG}/agent-runs/${RUN}`).length;
    await waitFor(() => expect(events()).toBeGreaterThan(0));
    const e0 = events();
    const r0 = runs();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(runs()).toBe(r0 + 1));
    expect(events()).toBe(e0);
    history = { ...pending, eventsStored: 2, storedThrough: 2, settledThrough: 2 };
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(events()).toBe(e0 + 1));
  });

  it('lista vazia continua sendo consultada: a execução iniciada depois no Agent aparece sem "Atualizar"', async () => {
    let items: unknown[] = [];
    api.on('GET', `/api/v1/o/${ORG}/agent-runs`, 'listAgentRuns', () => ({ status: 200, body: { items, nextCursor: null } }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true });
    try {
      renderApp(`/o/${ORG}/supervisao`);
      expect(await screen.findByText('Nenhuma execução local registrada.')).toBeInTheDocument();
      expect(screen.getByText(/Atualiza a cada 30 s\./)).toBeInTheDocument();
      items = [run({ supervisor: { ...run().supervisor, state: 'RUNNING', code: null }, process: 'RUNNING', outcome: 'PENDING' })];
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(() => expect(screen.queryByText('Nenhuma execução local registrada.')).toBeNull());
      expect(screen.getByRole('region', { name: 'Execuções locais' })).toHaveTextContent('Em execução');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falha da consulta não vira lista vazia; 403 é recusa', async () => {
    api.on('GET', `/api/v1/o/${ORG}/agent-runs`, 'listAgentRuns', { status: 503, body: { error: 'service_unavailable' } });
    const view = renderApp(`/o/${ORG}/supervisao`);
    expect(await screen.findByText('Serviço temporariamente indisponível.')).toBeInTheDocument();
    expect(screen.queryByText('Nenhuma execução local registrada.')).toBeNull();
    view.unmount();
    api.on('GET', `/api/v1/o/${ORG}/agent-runs`, 'listAgentRuns', { status: 403, body: { error: 'forbidden' } });
    renderApp(`/o/${ORG}/supervisao`);
    expect(await screen.findByText('Você não tem permissão para ver estas execuções.')).toBeInTheDocument();
  });
});
