import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import type { RunRequest } from '../../api/agents';
import { sessionMemory } from '../../app/notices';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { requestStage } from './runRequests';
import { durationText, outcomeLabel } from './supervision';
import { responseViolations } from '../../api/validate';

/**
 * AGENT-PYTHON-001 (030) no Web, com respostas por rota conferidas contra o contrato: a supervisão mostra automação, máquina,
 * origem, início, fim/duração e o desfecho do monitoramento SEM promover código 0 a sucesso de negócio; o pedido de
 * execução distingue registrado, aguardando a máquina, aceito, iniciado e desfecho (entregar ou aceitar não é iniciar).
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const monitoredRun = (over: Record<string, unknown> = {}) => ({
  runId: ID(9),
  correlation: {
    agentExecutionId: `ex-${'b'.repeat(32)}`,
    frameworkExecutionId: null,
    platformExecutionId: null,
    agentId: ID(1),
    workerId: ID(2),
    workspaceId: ID(3),
    automationId: ID(4),
    automationVersionId: null,
    authorizationId: ID(6),
    runRequestId: null,
  },
  origin: 'LOCAL_AUTHORIZED',
  sourceKind: 'EXTERNAL_MONITORED',
  automationName: 'Relatório CSV',
  agentName: 'Estação fiscal',
  authorizationStateAtRegistration: 'ACTIVE',
  registeredAt: '2026-11-03T10:00:00Z',
  supervisor: {
    state: 'SUCCEEDED',
    code: 'AGT-EXT-001',
    exitCode: 0,
    counts: {},
    agentStartedAt: '2026-11-03T10:00:01Z',
    agentEndedAt: '2026-11-03T10:01:06Z',
    adopted: false,
    suspensions: 0,
    locks: 0,
    reports: 3,
    conflicts: 0,
    lastReportAt: '2026-11-03T10:01:07Z',
  },
  process: 'ENDED',
  outcome: 'KNOWN',
  transport: { connectivity: 'CONNECTED', lastHeartbeatAt: '2026-11-03T10:01:00Z', lastEventAt: null },
  history: { completeness: 'COMPLETE', reasons: [], eventsStored: 9, storedThrough: 9, settledThrough: 9, maxSequence: 9, declaredMissing: 0, collectionCompletedSequence: 9, invalidRefused: 0, stepsAvailable: false },
  ...over,
});

let api: RouteApi;
beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  csrfStore.clear();
  sessionMemory.reset();
  vi.unstubAllGlobals();
  api = new RouteApi().install();
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' },
  });
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: { organizationId: ORG, membershipId: ID(7), organization: { roles: [], permissions: [] }, allWorkspaces: { permissions: [] }, hasWorkspaceAssignments: true },
  });
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
});

describe('Python externo na supervisão', () => {
  it('lista mostra automação, máquina, origem, início, duração e "sem erro sinalizado" (não sucesso de negócio)', async () => {
    api.on('GET', `/api/v1/o/${ORG}/agent-runs`, 'listAgentRuns', {
      status: 200,
      body: {
        items: [
          monitoredRun(),
          monitoredRun({
            runId: ID(8),
            correlation: { ...monitoredRun().correlation, agentExecutionId: `ex-${'c'.repeat(32)}` },
            supervisor: { ...monitoredRun().supervisor, state: 'FAILED', code: 'AGT-EXT-002', exitCode: 3 },
          }),
        ],
        nextCursor: null,
      },
    });
    renderApp(`/o/${ORG}/supervisao`);
    expect(await screen.findAllByText('Relatório CSV')).toHaveLength(2);
    expect(screen.getAllByText('Estação fiscal')).toHaveLength(2);
    expect(screen.getAllByText('Python externo monitorado')).toHaveLength(2);
    expect(screen.getByText(/Terminou sem erro sinalizado \(código 0; sucesso de negócio não sinalizado\)/)).toBeInTheDocument();
    expect(screen.getByText('Terminou com erro (código de saída 3)')).toBeInTheDocument();
    // nenhuma linha diz "Concluída com sucesso" (o texto só existe no filtro)
    expect(screen.getByRole('region', { name: 'Execuções locais' }).textContent).not.toContain('Concluída com sucesso');
    expect(screen.getAllByText(/1 min 05 s/)).toHaveLength(2);
    // a legenda descreve a ordem que a API devolve (registeredAt, runId crescente; contrato listAgentRuns), sem reordenar
    const rows = within(screen.getByRole('region', { name: 'Execuções locais' })).getAllByRole('row').slice(1);
    expect(rows[0].textContent).not.toContain('código de saída 3');
    expect(rows[1].textContent).toContain('código de saída 3');
    expect(screen.getByText('Execuções locais em ordem de registro, da mais antiga para a mais recente (as 25 primeiras).')).toBeInTheDocument();
  });

  it('detalhe diz que não há versão no monitoramento', async () => {
    api.on('GET', `/api/v1/o/${ORG}/agent-runs/${ID(9)}`, 'getAgentRun', { status: 200, body: { ...monitoredRun(), transactionsSeen: {}, retention: { state: 'AVAILABLE', eventsPurged: 0 } } });
    api.on('GET', new RegExp(`/api/v1/o/${ORG}/agent-runs/${ID(9)}/events`), 'listAgentRunEvents', { status: 200, body: { items: [], nextCursor: null } });
    renderApp(`/o/${ORG}/supervisao/${ID(9)}`);
    expect(await screen.findByText(/sem versão \(Python externo monitorado/)).toBeInTheDocument();
    expect(screen.getByText(/Supervisor: Terminou sem erro sinalizado/)).toBeInTheDocument();
  });
});

describe('textos do desfecho e do pedido', () => {
  it('fixture conforme', () => {
    expect(responseViolations('getAgentRun', { status: 200, contentType: 'application/json', body: { ...monitoredRun(), transactionsSeen: {}, retention: { state: 'AVAILABLE', eventsPurged: 0 } } })).toEqual([]);
  });

  it('código 0 sem sinal nunca vira sucesso; sinal explícito sim; desconhecido continua desconhecido', () => {
    expect(outcomeLabel('SUCCEEDED', 'AGT-EXT-001', 0).label).toMatch(/sem erro sinalizado/);
    expect(outcomeLabel('SUCCEEDED', 'AGT-EXT-001', 0).tone).not.toBe('success');
    expect(outcomeLabel('SUCCEEDED', null, 0)).toEqual({ label: 'Concluída com sucesso', tone: 'success' });
    expect(outcomeLabel('OUTCOME_UNKNOWN', 'AGT-EXT-004', null).label).toMatch(/Desconhecido/);
    expect(durationText('2026-11-03T10:00:00Z', null)).toBe('—');
  });

  const req = (over: Partial<RunRequest>): RunRequest => ({ runRequestId: ID(1), state: 'REQUESTED', run: null, ...over }) as RunRequest;

  it('entregar e aceitar não são iniciar; iniciado só com o instante do supervisor', () => {
    expect(requestStage(req({ state: 'REQUESTED' })).label).toBe('Solicitação registrada · aguardando a máquina');
    expect(requestStage(req({ state: 'DELIVERED' })).label).toBe('Entregue à máquina · aguardando decisão');
    expect(requestStage(req({ state: 'ACCEPTED' })).label).toBe('Aceita pela máquina · início ainda não confirmado');
    const linked = (run: Record<string, unknown>) => requestStage(req({ state: 'RUN_LINKED', run: run as RunRequest['run'] }));
    expect(linked({ state: 'STARTING', process: 'STARTING', outcome: 'PENDING', startedAt: null }).label).toBe('Execução registrada · início ainda não confirmado');
    expect(linked({ state: 'RUNNING', process: 'RUNNING', outcome: 'PENDING', startedAt: '2026-11-03T10:00:00Z' }).label).toBe('Execução iniciada');
    expect(linked({ state: 'FAILED', code: 'AGT-EXT-002', exitCode: 3, process: 'ENDED', outcome: 'KNOWN', startedAt: '2026-11-03T10:00:00Z' }).label).toBe(
      'Desfecho reportado: Terminou com erro (código de saída 3)',
    );
    // queda na fronteira do início: desconhecido continua visível, nunca relançado
    expect(linked({ state: 'OUTCOME_UNKNOWN', code: 'AGT-EXE-025', process: 'ENDED', outcome: 'UNKNOWN', startedAt: null }).label).toMatch(/Desfecho reportado: Desfecho desconhecido/);
    expect(requestStage(req({ state: 'EXPIRED' })).done).toBe(true);
    expect(requestStage(req({ state: 'REFUSED' })).label).toBe('Recusada pela máquina');
  });
});
