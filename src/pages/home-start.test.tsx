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
}

const automation = { automationId: AUT, workspaceId: WS, name: 'Conciliação diária', description: null, status: 'active', latestPublishedVersion: null, createdAt: T, updatedAt: T };
const execution = {
  executionId: EXE,
  workspaceId: WS,
  automation: { automationId: AUT, name: 'Conciliação diária' },
  automationVersion: { automationVersionId: VER, versionNumber: 1 },
  origin: 'manual',
  status: 'succeeded',
  statusReason: null,
  createdAt: T,
  startedAt: T,
  finishedAt: T,
  durationMs: 0,
  cancelRequestedAt: null,
};

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
    expect(await screen.findByText('Acme', { selector: '.pw-start__org' })).toBeInTheDocument();
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
    api.on('GET', `/api/v1/o/${ORG}/executions`, 'listExecutions', { status: 200, body: { items: [], nextCursor: null } });
    renderApp(`/o/${ORG}`);
    expect(await screen.findByText('Não foi possível carregar as automações.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Criar primeira automação' })).toBeNull();
  });

  it('com atividade: automações e execuções recentes com os estados da API; execuções vazias aparecem como vazias', async () => {
    area({ perms: ['automation.manage'], workspaces: [workspace()] });
    api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/automations`, 'listAutomations', { status: 200, body: { items: [automation], nextCursor: null } });
    api.on('GET', `/api/v1/o/${ORG}/executions`, 'listExecutions', { status: 200, body: { items: [execution], nextCursor: null } });
    const view = renderApp(`/o/${ORG}`);
    const autos = await screen.findByRole('list', { name: 'Automações' });
    expect(within(autos).getByRole('link', { name: 'Conciliação diária' })).toHaveAttribute('href', `/o/${ORG}/automacoes/${AUT}`);
    expect(within(autos).getByText('nenhuma versão publicada')).toBeInTheDocument();
    const execs = await screen.findByRole('list', { name: 'Execuções recentes' });
    expect(within(execs).getByText('Concluída')).toBeInTheDocument();
    view.unmount();

    api.on('GET', `/api/v1/o/${ORG}/executions`, 'listExecutions', { status: 200, body: { items: [], nextCursor: null } });
    renderApp(`/o/${ORG}`);
    expect(await screen.findByText('Nenhuma execução ainda.')).toBeInTheDocument();
  });

  it('execuções que falharam: "não foi possível carregar", não "nenhuma"', async () => {
    area({ perms: ['automation.manage'], workspaces: [workspace()] });
    api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/automations`, 'listAutomations', { status: 200, body: { items: [automation], nextCursor: null } });
    api.on('GET', `/api/v1/o/${ORG}/executions`, 'listExecutions', { status: 503, body: { error: 'service_unavailable' } });
    renderApp(`/o/${ORG}`);
    expect(await screen.findByText('Não foi possível carregar as execuções recentes.')).toBeInTheDocument();
    expect(screen.queryByText('Nenhuma execução ainda.')).toBeNull();
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

describe('versão em execução', () => {
  it('main x candidata x desconhecida', () => {
    expect(channelOf({ webCommit: 'abc1234', webBranch: 'main', webDirty: false, apiCommit: null, lib: null })).toEqual({ label: 'main', candidate: false });
    expect(channelOf({ webCommit: 'abc1234', webBranch: 'feat/x', webDirty: false, apiCommit: null, lib: null }).label).toBe('candidata (branch feat/x)');
    expect(versionLine({ webCommit: null, webBranch: null, webDirty: false, apiCommit: null, lib: null })).toBe('Web desconhecida · origem não identificada · API desconhecida');
    expect(versionLine({ webCommit: 'abc1234', webBranch: 'main', webDirty: true, apiCommit: 'e04a57c', lib: '0.2.0' })).toBe('Web abc1234 com alterações locais · main · API e04a57c');
  });
});
