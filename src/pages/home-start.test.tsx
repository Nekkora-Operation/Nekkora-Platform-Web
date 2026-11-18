import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';
import { channelOf, versionLine } from '../app/version';
import { location, user } from '../test/helpers';
import { renderApp } from '../test/render';
import { RouteApi } from '../test/routeApi';

/**
 * PLATFORM-LOCAL-002 — página inicial como ponto de partida: entrada geral (com e sem organização) e, dentro da
 * organização, o próximo passo por situação (aguardando ativação, ativa sem workspace, workspace sem automações, com
 * atividade), lista vazia como vazia e consulta que falhou como "não foi possível carregar" (nunca zero). Respostas por
 * rota conferidas contra o contrato fixado.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const WS = '5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f';
const AUT = '7f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const EXE = '91a2b3c4-d5e6-4f70-8192-a3b4c5d6e7f8';
const VER = 'a2b3c4d5-e6f7-4081-92a3-b4c5d6e7f809';
const T = '2026-11-02T12:00:00Z';

let api: RouteApi;
beforeEach(() => {
  csrfStore.clear();
  sessionMemory.reset();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  api = new RouteApi().install();
});

const workspace = (status: 'active' | 'archived' = 'active') => ({ workspaceId: WS, name: 'Financeiro', description: null, status, client: null, createdAt: T, updatedAt: T });

function area(opts: { activation?: 'AGUARDANDO_ATIVACAO' | 'ATIVADA'; perms?: string[]; workspaces?: 'error' | ReturnType<typeof workspace>[] } = {}) {
  const perms = opts.perms ?? [];
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: opts.activation ?? 'ATIVADA', stepUpMethod: 'totp' },
  });
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: { organizationId: ORG, membershipId: ORG, organization: { roles: perms.length ? ['ORG_ADMIN'] : [], permissions: perms }, allWorkspaces: { permissions: perms.filter((p) => p.startsWith('automation.')) }, hasWorkspaceAssignments: false },
  });
  api.on('GET', `/api/v1/o/${ORG}/me/permissions/workspaces`, 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on(
    'GET',
    `/api/v1/o/${ORG}/workspaces`,
    'listWorkspaces',
    opts.workspaces === 'error' ? { status: 503, body: { error: 'service_unavailable' } } : { status: 200, body: { items: opts.workspaces ?? [], nextCursor: null } },
  );
  api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', {
    status: 200,
    body: { organizations: [{ organizationId: ORG, name: 'Acme', roles: ['ORG_ADMIN'], activationState: opts.activation ?? 'ATIVADA', handle: 'acme' }], canCreateOrganization: true },
  });
  // painel do Início (PLATFORM-INICIO-001): por padrão, período sem execuções e nenhuma automação
  api.on('GET', `/api/v1/o/${ORG}/execution-summary`, 'getExecutionSummary', { status: 200, body: summary() });
  api.on('GET', `/api/v1/o/${ORG}/automations`, 'listOrganizationAutomations', { status: 200, body: { items: [], nextCursor: null } });
}

type Counts = { succeeded?: number; failed?: number; inProgress?: number; cancelled?: number; notStarted?: number; unconfirmed?: number };
const counts = (c: Counts = {}) => {
  const full = { succeeded: 0, failed: 0, inProgress: 0, cancelled: 0, notStarted: 0, unconfirmed: 0, ...c };
  return { total: full.succeeded + full.failed + full.inProgress + full.cancelled + full.notStarted + full.unconfirmed, ...full };
};
/** Resumo do período com as contas por origem coerentes (tudo na origem "platform", para simplificar). */
const summary = (c: Counts = {}) => ({ from: '2026-10-03T12:00:00Z', to: T, ...counts(c), sources: { platform: counts(c), localAgent: counts(), remote: counts() } });
const card = (over: Record<string, unknown> = {}) => ({
  automationId: AUT,
  workspaceId: WS,
  workspaceName: 'Financeiro',
  name: 'Conciliação diária',
  description: 'Confere o extrato com o razão.',
  status: 'active',
  latestPublishedVersion: { automationVersionId: VER, versionNumber: 3, publishedAt: T },
  lastExecution: { source: 'remote', id: EXE, outcome: 'succeeded', requestedAt: T },
  ...over,
});

const automation = { automationId: AUT, workspaceId: WS, name: 'Conciliação diária', description: null, status: 'active', latestPublishedVersion: null, createdAt: T, updatedAt: T };

describe('entrada geral (área da identidade)', () => {
  const session = () => api.on('GET', '/api/v1/me/session', 'identitySessionState', { status: 200, body: { restricted: false, csrfToken: 'id-csrf', mfaEnabled: true, stepUpMethod: 'totp' } });

  it('sem organização: orientação curta e "Criar minha primeira organização"', async () => {
    session();
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', { status: 200, body: { organizations: [], canCreateOrganization: true } });
    renderApp('/organizacoes');
    expect(await screen.findByText('Você ainda não participa de nenhuma organização.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Criar minha primeira organização' }));
    await waitFor(() => expect(location()).toBe('/organizacoes/nova'));
  });

  it('com organizações: o nome e "Entrar", sem identificador técnico na lista', async () => {
    session();
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', {
      status: 200,
      body: { organizations: [{ organizationId: ORG, name: 'Acme', roles: ['ORG_ADMIN'], activationState: 'AGUARDANDO_ATIVACAO', handle: 'acme' }], canCreateOrganization: true },
    });
    renderApp('/organizacoes');
    const list = await screen.findByRole('list', { name: 'Organizações' });
    expect(within(list).getByRole('heading', { name: 'Acme' })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Entrar em Acme (acme)' })).toBeInTheDocument();
    expect(list.textContent).not.toMatch(/0a6e1f9c/);
    expect(screen.queryByRole('button', { name: 'Criar minha primeira organização' })).toBeNull();
  });
});

describe('página inicial da organização: próximo passo', () => {
  it('aguardando ativação: o estado, o que impede e quem ativa; sem e-mail nem identificador na página', async () => {
    area({ activation: 'AGUARDANDO_ATIVACAO', perms: ['workspace.lifecycle'] });
    renderApp(`/o/${ORG}`);
    expect(await screen.findByText('Organização aguardando ativação')).toBeInTheDocument();
    expect(screen.getByText(/nenhum Worker pode ser registrado e nenhuma automação executa/)).toBeInTheDocument();
    expect(screen.getByText(/A ativação é feita pela operação da Nekkora/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ativar/i })).toBeNull();
    const main = screen.getByRole('main');
    expect(main.textContent).not.toContain('ana@empresa.com');
    expect(main.textContent).not.toContain(ORG);
    expect(await screen.findByText('Acme', { selector: '.pw-dash__org' })).toBeInTheDocument();
  });

  it('ativa sem workspace, com permissão: "Criar primeiro workspace" abre o diálogo de criação', async () => {
    area({ perms: ['workspace.lifecycle'] });
    renderApp(`/o/${ORG}`);
    await user().click(await screen.findByRole('button', { name: 'Criar primeiro workspace' }));
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/workspaces`));
    expect(await screen.findByRole('alertdialog', { name: 'Criar workspace' })).toBeInTheDocument();
  });

  it('ativa sem workspace e sem permissão: diz que está vazio e quem pode criar, sem botão', async () => {
    area();
    renderApp(`/o/${ORG}`);
    expect(await screen.findByRole('heading', { name: 'Nenhum workspace ainda' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Criar primeiro workspace' })).toBeNull();
  });

  it('lista de workspaces que falhou: "não foi possível carregar", nunca zero', async () => {
    area({ workspaces: 'error' });
    renderApp(`/o/${ORG}`);
    expect(await screen.findByText('Não foi possível carregar os seus workspaces.')).toBeInTheDocument();
    expect(screen.queryByText('Nenhum workspace ainda')).toBeNull();
    expect(screen.queryByText(/^0 /)).toBeNull();
  });

  it('workspace sem automações, com permissão: "Criar primeira automação" leva à criação no workspace (T04)', async () => {
    area({ perms: ['workspace.lifecycle', 'automation.manage', 'automation.read'], workspaces: [workspace()] });
    api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/automations`, 'listAutomations', { status: 200, body: { items: [], nextCursor: null } });
    api.on('GET', `/api/v1/o/${ORG}/executions`, 'listExecutions', { status: 200, body: { items: [], nextCursor: null } });
    api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}`, 'getWorkspace', { status: 200, body: workspace() });
    renderApp(`/o/${ORG}`);
    await user().click(await screen.findByRole('button', { name: 'Criar primeira automação' }));
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/workspaces/${WS}/nova-automacao`));
    expect(await screen.findByRole('heading', { name: 'Nova automação' })).toBeInTheDocument();
  });

  it('automações que falharam ao carregar: diz que não carregou (não oferece criar a "primeira")', async () => {
    area({ perms: ['automation.manage'], workspaces: [workspace()] });
    api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/automations`, 'listAutomations', { status: 503, body: { error: 'service_unavailable' } });
    api.on('GET', `/api/v1/o/${ORG}/automations`, 'listOrganizationAutomations', { gateway: 503 });
    renderApp(`/o/${ORG}`);
    // uma mensagem só (a da seção de automações do painel), não duas
    expect(await screen.findAllByText('Não foi possível carregar as automações.')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Criar primeira automação' })).toBeNull();
  });

  it('com automações: nenhum "próximo passo"; o painel é o conteúdo da página', async () => {
    area({ perms: ['automation.manage'], workspaces: [workspace()] });
    api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/automations`, 'listAutomations', { status: 200, body: { items: [automation], nextCursor: null } });
    api.on('GET', `/api/v1/o/${ORG}/automations`, 'listOrganizationAutomations', { status: 200, body: { items: [card()], nextCursor: null } });
    renderApp(`/o/${ORG}`);
    expect(await screen.findByRole('list', { name: 'Automações' })).toBeInTheDocument();
    expect(screen.queryByText('Próximo passo')).toBeNull();
  });

  it('Minha conta: e-mail, identificador da organização e a versão em execução', async () => {
    area();
    renderApp(`/o/${ORG}/conta`);
    expect(await screen.findByRole('heading', { name: 'Minha conta', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('ana@empresa.com')).toBeInTheDocument();
    expect(screen.getByText(ORG)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sobre esta versão' })).toBeInTheDocument();
    expect(screen.getByText('Nekkora-lib')).toBeInTheDocument();
  });
});

describe('Início da organização como painel (PLATFORM-INICIO-001)', () => {
  const ready = () => area({ perms: ['automation.read'], workspaces: [workspace()] });
  const withAutomations = () => api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/automations`, 'listAutomations', { status: 200, body: { items: [automation], nextCursor: null } });
  const metric = (label: string) => screen.getByRole('heading', { level: 3, name: label }).parentElement!.querySelector('.pw-dash__metric-value')!.textContent;

  it('cabeçalho: organização, título e período (padrão: últimos 30 dias), com o intervalo consultado e o fuso', async () => {
    ready();
    withAutomations();
    renderApp(`/o/${ORG}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Olá, Ana' })).toBeInTheDocument();
    expect(await screen.findByText('Acme', { selector: '.pw-dash__org' })).toBeInTheDocument();
    const period = screen.getByLabelText('Período') as HTMLSelectElement;
    expect(period.value).toBe('30d');
    expect([...period.options].map((o) => o.textContent)).toEqual(['Últimas 24 horas', 'Últimos 7 dias', 'Últimos 30 dias', 'Últimos 90 dias']);
    const section = screen.getByRole('region', { name: 'Execuções no período' });
    const times = [...section.querySelectorAll('time')].map((x) => Date.parse(x.getAttribute('datetime')!));
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBe(30 * 86_400_000);
    expect(section.textContent).toMatch(/horários em UTC[+−-]\d{2}:\d{2}/);
    // a ordem das áreas
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Execuções no período', 'Próximas execuções', 'Automações', 'Seu acesso']);
  });

  it('métricas: total, sucessos e erros; os demais estados fecham a conta e não entram em erro', async () => {
    ready();
    withAutomations();
    api.on('GET', `/api/v1/o/${ORG}/execution-summary`, 'getExecutionSummary', {
      status: 200,
      body: summary({ succeeded: 1203, failed: 6, inProgress: 2, cancelled: 4, notStarted: 8, unconfirmed: 1 }),
    });
    renderApp(`/o/${ORG}`);
    await screen.findByRole('heading', { level: 3, name: 'Total de execuções' });
    expect(metric('Total de execuções')).toBe('1.224');
    expect(metric('Sucessos')).toBe('1.203');
    expect(metric('Erros')).toBe('6');
    const others = screen.getByText('O total também inclui:').parentElement!;
    expect(others.textContent).toContain('2 em andamento · 4 canceladas · 8 não iniciadas · 1 com resultado não confirmado');
    expect(others.textContent).toContain('não contam como erro');
    // 1.203 + 6 + (2 + 4 + 8 + 1) = 1.224: os números da tela fecham
    expect(1203 + 6 + 2 + 4 + 8 + 1).toBe(1224);
  });

  it('período sem execuções: zero é zero (com a frase), sem linha de outras situações', async () => {
    ready();
    withAutomations();
    renderApp(`/o/${ORG}`);
    await screen.findByRole('heading', { level: 3, name: 'Total de execuções' });
    expect(metric('Total de execuções')).toBe('0');
    expect(screen.getByText('Nenhuma execução pedida no período.')).toBeInTheDocument();
    expect(screen.queryByText('O total também inclui:')).toBeNull();
  });

  it('consulta do resumo que falhou: avisa e NÃO mostra número; "Tentar novamente" consulta de novo', async () => {
    ready();
    withAutomations();
    let down = true; // (o StrictMode consulta duas vezes na montagem: a resposta depende do estado, não da ordem)
    api.on('GET', `/api/v1/o/${ORG}/execution-summary`, 'getExecutionSummary', () => (down ? { gateway: 503 } : { status: 200, body: summary({ succeeded: 5 }) }));
    renderApp(`/o/${ORG}`);
    expect(await screen.findByText('Não foi possível carregar as execuções do período.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: 'Total de execuções' })).toBeNull();
    expect(document.querySelector('.pw-dash__metric-value')).toBeNull();
    down = false;
    await user().click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByRole('heading', { level: 3, name: 'Total de execuções' });
    expect(metric('Sucessos')).toBe('5');
  });

  it('mudar o período consulta de novo e troca os números', async () => {
    ready();
    withAutomations();
    let succeeded = 30;
    api.on('GET', `/api/v1/o/${ORG}/execution-summary`, 'getExecutionSummary', () => ({ status: 200, body: summary({ succeeded }) }));
    renderApp(`/o/${ORG}`);
    await screen.findByRole('heading', { level: 3, name: 'Total de execuções' });
    expect(metric('Sucessos')).toBe('30');
    const before = api.sent('GET', `/api/v1/o/${ORG}/execution-summary`).length;
    succeeded = 7;
    await user().selectOptions(screen.getByLabelText('Período'), '7d');
    await waitFor(() => expect(metric('Sucessos')).toBe('7'));
    const times = [...screen.getByRole('region', { name: 'Execuções no período' }).querySelectorAll('time')].map((x) => Date.parse(x.getAttribute('datetime')!));
    expect(times[1] - times[0]).toBe(7 * 86_400_000);
    expect(api.sent('GET', `/api/v1/o/${ORG}/execution-summary`)).toHaveLength(before + 1);
  });

  it('próximas execuções: a funcionalidade ainda não existe - diz isso, não "nenhum agendamento"', async () => {
    ready();
    withAutomations();
    renderApp(`/o/${ORG}`);
    const section = await screen.findByRole('region', { name: 'Próximas execuções' });
    expect(within(section).getByText('Agendamentos ainda não estão disponíveis')).toBeInTheDocument();
    expect(within(section).queryByText(/Nenhum agendamento/)).toBeNull();
  });

  it('cards de automações: nome em destaque, workspace, versão, última execução e "Ver automação"', async () => {
    ready();
    withAutomations();
    const OUTRA = 'b3c4d5e6-f708-4192-a3b4-c5d6e7f8091a';
    api.on('GET', `/api/v1/o/${ORG}/automations`, 'listOrganizationAutomations', {
      status: 200,
      body: {
        items: [
          card(),
          card({ automationId: OUTRA, workspaceName: 'Fiscal', description: null, status: 'suspended', latestPublishedVersion: null, lastExecution: null }),
        ],
        nextCursor: null,
      },
    });
    api.on('GET', `/api/v1/o/${ORG}/automations/${AUT}`, 'getAutomation', { status: 200, body: automation });
    api.on('GET', `/api/v1/o/${ORG}/automations/${AUT}/versions`, 'listAutomationVersions', { status: 200, body: { items: [], nextCursor: null } });
    renderApp(`/o/${ORG}`);
    const cards = within(await screen.findByRole('list', { name: 'Automações' })).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    // mesmo nome: o workspace distingue
    expect(within(cards[0]).getByRole('heading', { level: 3, name: 'Conciliação diária' })).toBeInTheDocument();
    expect(within(cards[0]).getByText('Workspace Financeiro')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Workspace Fiscal')).toBeInTheDocument();
    expect(within(cards[0]).getByText('Confere o extrato com o razão.')).toBeInTheDocument();
    expect(within(cards[0]).getByText('Versão 3')).toBeInTheDocument();
    expect(within(cards[0]).getByText('Sucesso')).toBeInTheDocument();
    expect(within(cards[0]).getByRole('link', { name: 'Abrir a última execução de Conciliação diária' })).toHaveAttribute('href', `/o/${ORG}/execucoes-remotas/${EXE}`);
    expect(within(cards[1]).getByText('Suspenso')).toBeInTheDocument();
    expect(within(cards[1]).getAllByText('Nenhuma ainda')).toHaveLength(2);
    expect(within(cards[1]).queryByRole('link', { name: /última execução/ })).toBeNull();
    // nenhuma ação de executar nos cards
    expect(screen.queryByRole('button', { name: /executar|solicitar/i })).toBeNull();
    await user().click(within(cards[0]).getByRole('button', { name: 'Ver automação Conciliação diária' }));
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/automacoes/${AUT}`));
  });

  it('última execução: cada origem abre o seu detalhe; resultado não confirmado não vira erro; pedido sem detalhe não tem link', async () => {
    ready();
    withAutomations();
    const ids = ['c4d5e6f7-0819-42a3-b4c5-d6e7f8091a2b', 'd5e6f708-192a-43b4-85d6-e7f8091a2b3c', 'e6f70819-2a3b-44c5-96e7-f8091a2b3c4d'];
    api.on('GET', `/api/v1/o/${ORG}/automations`, 'listOrganizationAutomations', {
      status: 200,
      body: {
        items: [
          card({ automationId: ids[0], name: 'A', lastExecution: { source: 'platform', id: EXE, outcome: 'failed', requestedAt: T } }),
          card({ automationId: ids[1], name: 'B', lastExecution: { source: 'localAgent', id: EXE, outcome: 'unconfirmed', requestedAt: T } }),
          card({ automationId: ids[2], name: 'C', lastExecution: { source: 'localAgent', id: null, outcome: 'notStarted', requestedAt: T } }),
        ],
        nextCursor: null,
      },
    });
    renderApp(`/o/${ORG}`);
    const cards = within(await screen.findByRole('list', { name: 'Automações' })).getAllByRole('listitem');
    expect(within(cards[0]).getByText('Erro')).toBeInTheDocument();
    expect(within(cards[0]).getByRole('link', { name: /última execução/ })).toHaveAttribute('href', `/o/${ORG}/execucoes/${EXE}`);
    expect(within(cards[1]).getByText('Resultado não confirmado')).toBeInTheDocument();
    expect(within(cards[1]).queryByText('Erro')).toBeNull();
    expect(within(cards[1]).getByRole('link', { name: /última execução/ })).toHaveAttribute('href', `/o/${ORG}/supervisao/${EXE}`);
    expect(within(cards[2]).getByText('Não iniciada')).toBeInTheDocument();
    expect(within(cards[2]).queryByRole('link', { name: /última execução/ })).toBeNull();
  });

  it('automações: falha não é lista vazia; vazio diz que está vazio; "Carregar mais" continua pelo cursor', async () => {
    ready();
    withAutomations();
    api.on('GET', `/api/v1/o/${ORG}/automations`, 'listOrganizationAutomations', { gateway: 503 });
    const first = renderApp(`/o/${ORG}`);
    expect(await screen.findByText('Não foi possível carregar as automações.')).toBeInTheDocument();
    expect(screen.queryByText('Nenhuma automação ainda')).toBeNull();
    first.unmount();

    const SEGUNDA = 'f7081920-3a4b-45d6-a7f8-091a2b3c4d5e';
    let second = false;
    api.on('GET', `/api/v1/o/${ORG}/automations`, 'listOrganizationAutomations', () =>
      !second ? { status: 200, body: { items: [card()], nextCursor: 'proxima' } } : { status: 200, body: { items: [card({ automationId: SEGUNDA, name: 'Segunda' })], nextCursor: null } },
    );
    renderApp(`/o/${ORG}`);
    const list = await screen.findByRole('list', { name: 'Automações' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    second = true;
    await user().click(screen.getByRole('button', { name: /mais/i }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(within(list).getByRole('heading', { level: 3, name: 'Segunda' })).toBeInTheDocument();
  });

  it('sem acesso a nenhum workspace: diz isso, sem métricas zeradas nem consulta de resumo', async () => {
    area({ perms: [], workspaces: [] });
    renderApp(`/o/${ORG}`);
    expect(await screen.findByText('Você ainda não tem acesso a nenhum workspace')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: 'Total de execuções' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Automações' })).toBeNull();
  });
});

describe('versão em execução', () => {
  it('main x candidata x desconhecida', () => {
    expect(channelOf({ webCommit: 'abc1234', webBranch: 'main', webDirty: false, apiCommit: null, lib: null })).toEqual({ label: 'main', candidate: false });
    expect(channelOf({ webCommit: 'abc1234', webBranch: 'feat/x', webDirty: false, apiCommit: null, lib: null }).label).toBe('candidata (branch feat/x)');
    expect(versionLine({ webCommit: null, webBranch: null, webDirty: false, apiCommit: null, lib: null })).toBe('Web desconhecida · origem não identificada · API desconhecida');
    expect(versionLine({ webCommit: 'abc1234', webBranch: 'main', webDirty: true, apiCommit: 'e04a57c', lib: '0.2.0' })).toBe('Web abc1234 com alterações locais · main · API e04a57c');
  });
});
