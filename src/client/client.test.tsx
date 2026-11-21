import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';
import { renderApp } from '../test/render';
import { RouteApi } from '../test/routeApi';

/**
 * PLATFORM-FLUXO-002 (070/071) — área do cliente: só o Portal, pela identidade. Dashboards de execução (indicadores e estado em
 * linguagem simples) e arquivos de retorno autorizados; nada de registros técnicos, máquinas ou ambiente. Cards só das automações
 * compartilhadas, a mensagem quando não há nada, o dashboard de uma automação, a lista de arquivos com ver/baixar, e as recusas
 * do Portal (sem vínculo, sem o conteúdo, fora do escopo) sem revelar o que não foi compartilhado.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ID = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const A1 = ID(21);
const A2 = ID(22);
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
    body: { items: [{ organizationId: ORG, organizationName: 'Escritório Exemplo', clientName: 'Contábil Exemplo', sharedAutomations: 2 }] },
  });
});

const withDashboard = {
  automationId: A1,
  name: 'Conciliação',
  canViewDashboard: true,
  canDownloadResults: true,
  dashboard: { executionsLast30Days: 4, succeededLast30Days: 3, failedLast30Days: 1, inProgress: 0, lastRequestedAt: T, lastOutcome: 'succeeded' as const },
  filesAvailable: 1,
  clientName: 'Contábil Exemplo',
};
const filesOnly = {
  automationId: A2,
  name: 'Folha',
  canViewDashboard: false,
  canDownloadResults: true,
  dashboard: null,
  filesAvailable: 0,
  clientName: 'Contábil Exemplo',
};

describe('área do cliente', () => {
  it('cards: dashboard com indicadores e estado em linguagem simples; sem máquina, ambiente nem registros técnicos', async () => {
    api.on('GET', `${P}/shared-automations`, 'portalSharedAutomations', { status: 200, body: { items: [withDashboard, filesOnly] } });
    renderApp(`/cliente/o/${ORG}`);
    const cards = within(await screen.findByRole('list', { name: 'Automações compartilhadas' }));
    expect(cards.getAllByRole('listitem')).toHaveLength(2);
    const ind = within(cards.getByRole('group', { name: 'Indicadores de Conciliação nos últimos 30 dias' }));
    expect(ind.getByText('4')).toBeInTheDocument();
    expect(ind.getByText('não concluídas')).toBeInTheDocument();
    expect(cards.getByText('Concluída')).toBeInTheDocument();
    expect(cards.getByText('O dashboard desta automação não foi compartilhado com você.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver arquivos de retorno' })).toBeInTheDocument();
    expect(screen.queryByText(/máquina|registros|ambiente/i)).toBeNull();
    expect(api.sent('GET', /^\/api\/v1\/o\//)).toHaveLength(0);
  });

  it('dashboard de uma automação: resumo do período e execuções; arquivos pela lista própria', async () => {
    api.on('GET', `${P}/shared-automations`, 'portalSharedAutomations', { status: 200, body: { items: [withDashboard] } });
    api.on('GET', new RegExp(`^${P}/shared-automations/${A1}/summary`), 'portalSharedSummary', {
      status: 200,
      body: { from: T, to: T, total: 4, succeeded: 3, failed: 1, inProgress: 0, notStarted: 0, cancelled: 0, other: 0, lastRequestedAt: T, lastOutcome: 'succeeded' },
    });
    api.on('GET', new RegExp(`^${P}/shared-automations/${A1}/executions`), 'portalSharedExecutions', {
      status: 200,
      body: { items: [{ id: EX, requestedAt: T, startedAt: T, endedAt: T, outcome: 'failed', files: 1 }], nextCursor: null },
    });
    renderApp(`/cliente/o/${ORG}/automacoes/${A1}`);
    const stats = within(await screen.findByRole('group', { name: 'Indicadores do período' }));
    expect(stats.getByText('3')).toBeInTheDocument();
    const list = within(await screen.findByRole('list', { name: 'Execuções' }));
    expect(list.getByText('Não concluída')).toBeInTheDocument();
    expect(list.getByRole('link', { name: '1 arquivo de retorno' })).toBeInTheDocument();
    // o período escolhido vai para o Portal (que aplica o escopo de automação e máquina)
    expect(api.calls.filter((c) => /\/summary\?from=.*&to=/.test(c.url)).length).toBeGreaterThan(0);
  });

  it('arquivos de retorno: identificados pela automação e pela data; busca no servidor; ver na página e baixar', async () => {
    api.on('GET', `${P}/shared-automations`, 'portalSharedAutomations', { status: 200, body: { items: [withDashboard] } });
    api.on('GET', new RegExp(`^${P}/shared-files`), 'portalSharedFiles', {
      status: 200,
      body: {
        items: [
          { attemptId: AT, number: 1, automation: { automationId: A1, name: 'Conciliação' }, executionRequestedAt: T, fileName: 'relatorio.csv', sizeBytes: 12, receivedAt: T, available: true },
        ],
        nextCursor: null,
      },
    });
    const fetchMock = vi.fn(async () => new Response('a;b\n1;2', { status: 200 }));
    vi.stubGlobal('fetch', new Proxy(globalThis.fetch, { apply: (t, self, args: Parameters<typeof fetch>) => (String(args[0]).includes('/content') ? fetchMock() : Reflect.apply(t, self, args)) }));
    renderApp(`/cliente/o/${ORG}/arquivos?automacao=${A1}`);
    const files = within(await screen.findByRole('list', { name: 'Arquivos de retorno' }));
    expect(files.getByText('relatorio.csv')).toBeInTheDocument();
    expect(files.getByText(/Conciliação · execução de/)).toBeInTheDocument();
    expect(files.getByRole('link', { name: 'Baixar relatorio.csv' })).toHaveAttribute('href', `${P}/shared-files/${AT}/1/content`);
    fireEvent.click(files.getByRole('button', { name: 'Visualizar relatorio.csv' }));
    expect(await screen.findByLabelText('Conteúdo de relatorio.csv')).toHaveTextContent('a;b');
    fireEvent.change(screen.getByLabelText('Nome do arquivo'), { target: { value: 'relat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await screen.findByText('relatorio.csv');
    expect(api.calls.filter((c) => /\/shared-files\?.*q=relat/.test(c.url)).length).toBeGreaterThan(0);
  });

  it('sem nada compartilhado: "Nenhuma automação compartilhada com você"', async () => {
    api.on('GET', `${P}/shared-automations`, 'portalSharedAutomations', { status: 200, body: { items: [] } });
    renderApp(`/cliente/o/${ORG}`);
    expect(await screen.findByText('Nenhuma automação compartilhada com você')).toBeInTheDocument();
  });

  it('recusas do Portal: sem vínculo (403), sem o dashboard (403) e endereço antigo do detalhe técnico volta ao dashboard', async () => {
    api.on('GET', `${P}/shared-automations`, 'portalSharedAutomations', { status: 403, body: { error: 'forbidden' } });
    const v = renderApp(`/cliente/o/${ORG}`);
    expect(await screen.findByText('Você não tem acesso de cliente nesta organização (ou ele foi suspenso).')).toBeInTheDocument();
    v.unmount();
    api.on('GET', `${P}/shared-automations`, 'portalSharedAutomations', { status: 200, body: { items: [filesOnly] } });
    api.on('GET', new RegExp(`^${P}/shared-automations/${A2}/summary`), 'portalSharedSummary', { status: 403, body: { error: 'forbidden' } });
    api.on('GET', new RegExp(`^${P}/shared-automations/${A2}/executions`), 'portalSharedExecutions', { status: 403, body: { error: 'forbidden' } });
    const w = renderApp(`/cliente/o/${ORG}/automacoes/${A2}`);
    expect(await screen.findByText('O dashboard desta automação não foi compartilhado com você.')).toBeInTheDocument();
    w.unmount();
    renderApp(`/cliente/o/${ORG}/execucoes/remote/${EX}`);
    expect(await screen.findByRole('heading', { name: 'Dashboards de execução' })).toBeInTheDocument();
  });
});
