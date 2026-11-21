import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';
import { renderApp } from '../test/render';
import { RouteApi } from '../test/routeApi';

/**
 * PLATFORM-FLUXO-002 (070) — área do cliente: só o Portal, pela identidade. Cards só das automações compartilhadas, a
 * mensagem quando não há nada, a automação com as execuções, a execução com registros e resultados SÓ quando concedidos, e as
 * recusas do Portal (sem vínculo, fora do escopo) sem revelar o que não foi compartilhado.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ID = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const A1 = ID(21);
const EX = ID(71);
const AT = ID(72);
const T = '2026-11-20T10:00:00Z';
const P = `/portal/api/v1/o/${ORG}`;

let api: RouteApi;
beforeEach(() => {
  csrfStore.clear();
  sessionMemory.reset();
  vi.unstubAllGlobals();
  localStorage.clear();
  api = new RouteApi().install();
  api.on('GET', '/api/v1/csrf', 'getPreAuthCsrf', { status: 200, body: { csrfToken: 'pre' } });
  api.on('GET', '/api/v1/me/session', 'identitySessionState', { status: 200, body: { restricted: false, csrfToken: 'id-csrf', mfaEnabled: true, stepUpMethod: 'totp' } });
  api.on('GET', '/portal/api/v1/me/client-organizations', 'portalClientOrganizations', {
    status: 200,
    body: { items: [{ organizationId: ORG, organizationName: 'Escritório Exemplo', clientName: 'Contábil Exemplo', sharedAutomations: 1 }] },
  });
});

const automation = {
  automationId: A1,
  name: 'Conciliação',
  workspaceName: 'Fiscal',
  allMachines: false,
  machines: [{ workerId: ID(31), name: 'Estação fiscal' }],
  canReadLogs: true,
  canDownloadResults: false,
  executionsLast30Days: 2,
  lastRequestedAt: T,
  lastOutcome: 'succeeded',
  clientName: 'Contábil Exemplo',
};

describe('área do cliente', () => {
  it('cards só das automações compartilhadas; a automação com as execuções; a execução com registros e sem resultados não concedidos', async () => {
    api.on('GET', `${P}/shared-automations`, 'portalSharedAutomations', { status: 200, body: { items: [automation] } });
    api.on('GET', `${P}/shared-automations/${A1}/executions`, 'portalSharedExecutions', {
      status: 200,
      body: { items: [{ kind: 'remote', id: EX, machine: { workerId: ID(31), name: 'Estação fiscal' }, requestedAt: T, startedAt: T, endedAt: T, outcome: 'succeeded' }], nextCursor: null },
    });
    api.on('GET', `${P}/shared-executions/remote/${EX}`, 'portalSharedExecution', {
      status: 200,
      body: {
        kind: 'remote', id: EX, automation: { automationId: A1, name: 'Conciliação' }, machine: { workerId: ID(31), name: 'Estação fiscal' },
        requestedAt: T, startedAt: T, endedAt: T, outcome: 'succeeded',
        attempts: [{ attemptId: AT, number: 1, workerId: ID(31), workerName: 'Estação fiscal', startedAt: T, endedAt: T, canReadLogs: true, canDownloadResults: false }],
      },
    });
    api.on('GET', `${P}/shared-executions/remote/${EX}/attempts/${AT}/logs`, 'portalSharedLogs', {
      status: 200,
      body: {
        items: [{ sequence: 1, capturedAt: T, channel: 'STDOUT', truncated: false, message: 'processando lote 1', textRemoved: false }],
        total: 1, closedAt: T, droppedLines: 0, nextAfter: null,
      },
    });
    renderApp(`/cliente/o/${ORG}`);
    const cards = within(await screen.findByRole('list', { name: 'Automações compartilhadas' }));
    expect(cards.getAllByRole('listitem')).toHaveLength(1);
    expect(cards.getByText('Conciliação')).toBeInTheDocument();
    expect(cards.getByText(/Estação fiscal/)).toBeInTheDocument();
    expect(cards.getByText(/você vê registros/)).toBeInTheDocument();
    fireEvent.click(cards.getByRole('link', { name: 'Ver Conciliação' }));
    const list = within(await screen.findByRole('list', { name: 'Execuções' }));
    fireEvent.click(list.getByRole('link', { name: /Detalhes/ }));
    expect(await screen.findByText('processando lote 1')).toBeInTheDocument();
    expect(screen.getByText('Os arquivos de resultado não foram compartilhados com você.')).toBeInTheDocument();
    // nenhuma leitura de resultados sem a permissão, e nada fora do Portal
    expect(api.sent('GET', /\/results/)).toHaveLength(0);
    expect(api.sent('GET', /^\/api\/v1\/o\//)).toHaveLength(0);
  });

  it('sem nada compartilhado: "Nenhuma automação compartilhada com você"', async () => {
    api.on('GET', `${P}/shared-automations`, 'portalSharedAutomations', { status: 200, body: { items: [] } });
    renderApp(`/cliente/o/${ORG}`);
    expect(await screen.findByText('Nenhuma automação compartilhada com você')).toBeInTheDocument();
  });

  it('recusas do Portal: sem vínculo (403) e fora do escopo (404), sem revelar o que existe', async () => {
    api.on('GET', `${P}/shared-automations`, 'portalSharedAutomations', { status: 403, body: { error: 'forbidden' } });
    const v = renderApp(`/cliente/o/${ORG}`);
    expect(await screen.findByText('Você não tem acesso de cliente nesta organização (ou ele foi suspenso).')).toBeInTheDocument();
    v.unmount();
    api.on('GET', `${P}/shared-executions/platform/${EX}`, 'portalSharedExecution', { status: 404, body: { error: 'not_found' } });
    renderApp(`/cliente/o/${ORG}/execucoes/platform/${EX}`);
    expect(await screen.findByText('Não encontrado, ou não compartilhado com você.')).toBeInTheDocument();
  });
});
