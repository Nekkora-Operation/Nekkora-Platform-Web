import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { confirmWhenReady } from '../../test/dialog';

/**
 * PLATFORM-FLUXO-002 (070/071) — clientes e acessos de cliente, contra respostas conferidas pelo contrato: o compartilhamento
 * por pessoa (nome e e-mail, automação, conteúdos dashboard/arquivos, máquina em opções adicionais, cliente opcional, sem registros
 * técnicos; resumo e confirmação com o escopo), os pedidos de membro aprovados por outra pessoa, a pessoa de cliente na tabela única e o modal dela (revogar só aquele acesso, só reduzir permissões, compartilhar
 * outra automação como pedido), "Acessos e histórico" (abas, filtros no endereço, "Ver histórico"), os endereços antigos e a
 * área do cliente (só o Portal).
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ID = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const WS = ID(11);
const A1 = ID(21);
const A2 = ID(22);
const W1 = ID(31);
const W2 = ID(32);
const CLIENT = ID(41);
const CM = ID(42);
const CLIENT_USER = ID(43);
const G1 = ID(61);
const G2 = ID(62);
const T = '2026-11-20T10:00:00Z';
const location = () => screen.getByTestId('location').textContent;

const grant = (id: string, automation: string, name: string, machine: { workerId: string; name: string } | null, over: Record<string, unknown> = {}) => ({
  kind: 'automation',
  grantId: id,
  situation: 'active',
  person: { userId: CLIENT_USER, name: 'Carla Cliente', email: 'carla@cliente.com' },
  clientMembershipId: CM,
  membershipStatus: 'active',
  client: { clientId: CLIENT, name: 'Contábil Exemplo' },
  workspace: { workspaceId: WS, name: 'Fiscal' },
  automation: { automationId: automation, name },
  machine,
  canViewDashboard: true,
  canDownloadResults: false,
  basis: 'client_invitation',
  requestedBy: 'Ana Souza',
  approvedBy: 'Ana Souza',
  createdAt: T,
  approvedAt: T,
  revokedAt: null,
  revokeReason: null,
  replacesGrantId: null,
  expiresAt: null,
  nextReviewAt: null,
  ...over,
});

const clientPerson = (grants: unknown[]) => ({
  kind: 'client',
  id: CM,
  member: null,
  invitation: null,
  client: {
    clientMembershipId: CM,
    userId: CLIENT_USER,
    displayName: 'Carla Cliente',
    email: 'carla@cliente.com',
    status: 'active',
    joinedAt: T,
    clientId: CLIENT,
    clientName: 'Contábil Exemplo',
    linkedToIdentity: true,
    grants,
  },
});

const memberPerson = {
  kind: 'member',
  id: ID(51),
  invitation: null,
  client: null,
  member: {
    membershipId: ID(51),
    userId: ID(1),
    displayName: 'Ana Souza',
    email: 'ana@empresa.com',
    emailVerified: true,
    accountStatus: 'active',
    membershipStatus: 'active',
    mfaConfigured: true,
    joinedAt: T,
    roles: [{ role: 'ORG_ADMIN', workspaceId: null, workspaceName: null }],
  },
};

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
      membershipId: ID(51),
      organization: { roles: ['ORG_ADMIN'], permissions: ['org.manage', 'external_access.manage'] },
      allWorkspaces: { permissions: [] },
      hasWorkspaceAssignments: false,
    },
  });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workspaces`), 'listWorkspaces', {
    status: 200,
    body: { items: [{ workspaceId: WS, name: 'Fiscal', description: null, status: 'active', client: null, createdAt: T, updatedAt: T }], nextCursor: null },
  });
  api.on('GET', `/api/v1/o/${ORG}/people`, 'listPeople', {
    status: 200,
    body: { items: [clientPerson([grant(G1, A1, 'Conciliação', { workerId: W1, name: 'Estação fiscal' })]), memberPerson], nextCursor: null, invitationsEnabled: true },
  });
  api.on('GET', `/api/v1/o/${ORG}/clients`, 'listClients', {
    status: 200,
    body: { items: [{ clientId: CLIENT, name: 'Contábil Exemplo', status: 'active', createdAt: T, updatedAt: T }], nextCursor: null },
  });
  api.on('GET', `/api/v1/o/${ORG}/client-share-options`, 'listClientShareOptions', {
    status: 200,
    body: {
      mode: 'invite',
      automations: [
        { automationId: A1, name: 'Conciliação', workspaceId: WS, workspaceName: 'Fiscal', machines: [{ workerId: W1, name: 'Estação fiscal' }], canShareDashboard: true, canShareFiles: true },
        { automationId: A2, name: 'Folha interna', workspaceId: WS, workspaceName: 'Fiscal', machines: [{ workerId: W2, name: 'Estação dois' }], canShareDashboard: true, canShareFiles: true },
      ],
    },
  });
  api.on('GET', new RegExp(`^/api/v1/o/${ORG}/client-share-requests`), 'listClientShareRequests', { status: 200, body: { items: [] } });
});

const table = async () => within(await screen.findByRole('region', { name: 'Lista de pessoas e convites' }));

describe('compartilhamento por pessoa (convite de Cliente)', () => {
  it('nome e e-mail, automação e conteúdos; máquina em opções adicionais filtra; sem registros técnicos; confirmação com o escopo; corpo enviado', async () => {
    api.on('POST', `/api/v1/o/${ORG}/client-invitations`, 'inviteClient', {
      status: 201,
      body: {
        invitationId: ID(70), email: 'nova@cliente.com', recipientName: 'Nova Pessoa', clientId: CLIENT, workspaceId: WS, automationId: A1, workerId: W1,
        canViewDashboard: true, canDownloadResults: true, shareRequestId: null, expiresAt: '2026-11-27T10:00:00Z',
      },
    });
    renderApp(`/o/${ORG}/administracao/pessoas`);
    await table();
    fireEvent.click(screen.getByRole('radio', { name: /Pessoa externa/ }));
    fireEvent.change(screen.getByLabelText(/^Nome da pessoa/), { target: { value: 'Nova Pessoa' } });
    fireEvent.change(screen.getByLabelText(/^E-mail da pessoa/), { target: { value: 'nova@cliente.com' } });
    fireEvent.change(await screen.findByLabelText(/^Ambiente de trabalho/), { target: { value: WS } });
    // nada de cadastro de cliente obrigatório nem registros técnicos
    expect(screen.queryByRole('checkbox', { name: /registros/i })).toBeNull();
    expect((screen.getByLabelText(/^Cliente cadastrado/) as HTMLSelectElement).value).toBe('');
    const automation = screen.getByLabelText(/^Automação/) as HTMLSelectElement;
    expect([...automation.options].map((o) => o.textContent)).toEqual(expect.arrayContaining(['Conciliação', 'Folha interna']));
    fireEvent.change(screen.getByLabelText(/^Máquina/), { target: { value: W1 } });
    expect([...(screen.getByLabelText(/^Automação/) as HTMLSelectElement).options].map((o) => o.textContent)).not.toContain('Folha interna');
    fireEvent.change(screen.getByLabelText(/^Automação/), { target: { value: A1 } });
    expect(screen.getByRole('checkbox', { name: /Dashboard de execução/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /Arquivos de retorno/ }));
    expect(screen.getByText('Relatórios personalizados: ainda não disponíveis.')).toBeInTheDocument();
    expect(
      await screen.findByText('Você está compartilhando a automação Conciliação (ambiente de trabalho Fiscal) com Nova Pessoa, considerando execuções da máquina Estação fiscal.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Convidar' }));
    const d = await screen.findByRole('alertdialog', { name: 'Compartilhar Conciliação com Nova Pessoa?' });
    for (const t of ['Nova Pessoa (nova@cliente.com)', 'Conciliação', 'Fiscal', 'Estação fiscal', 'Dashboard de execução e arquivos de retorno', 'Criado ou reutilizado com o nome da pessoa'])
      expect(d).toHaveTextContent(t);
    await confirmWhenReady(d, 'Compartilhar e enviar convite');
    expect(await screen.findByText('Compartilhamento enviado por convite. O acesso só começa quando a pessoa aceitar.', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(api.sent('POST', `/api/v1/o/${ORG}/client-invitations`).map((c) => c.body)).toEqual([
      { email: 'nova@cliente.com', name: 'Nova Pessoa', clientId: null, automationId: A1, workerId: W1, canViewDashboard: true, canDownloadResults: true },
    ]);
  });

  it('sem nome ou sem conteúdo: não envia; e-mail de membro interno: aviso e a recusa do servidor explica o alcance', async () => {
    api.on('POST', `/api/v1/o/${ORG}/client-invitations`, 'inviteClient', {
      status: 409,
      body: { error: 'conflict', reason: 'client_invitation_internal_member' },
    });
    renderApp(`/o/${ORG}/administracao/pessoas`);
    await table();
    fireEvent.click(screen.getByRole('radio', { name: /Pessoa externa/ }));
    fireEvent.change(screen.getByLabelText(/^E-mail da pessoa/), { target: { value: 'ana@empresa.com' } });
    expect(await screen.findByText(/Ana Souza já é membro interno desta organização/)).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText(/^Ambiente de trabalho/), { target: { value: WS } });
    fireEvent.change(screen.getByLabelText(/^Automação/), { target: { value: A2 } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Dashboard de execução/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Convidar' }));
    expect(await screen.findByText('Informe o nome da pessoa.')).toBeInTheDocument();
    expect(screen.getByText('Escolha ao menos um conteúdo.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Nome da pessoa/), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Dashboard de execução/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Convidar' }));
    const d = await screen.findByRole('alertdialog', { name: /Compartilhar Folha interna com Ana\?/ });
    await confirmWhenReady(d, 'Compartilhar e enviar convite');
    expect(await within(d).findByText(/já é membro interno da organização. Um convite de Cliente não reduziria/, {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('sem external_access.manage: só o convite de pessoa da equipe', async () => {
    api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
      status: 200,
      body: { organizationId: ORG, membershipId: ID(51), organization: { roles: [], permissions: ['org.manage'] }, allWorkspaces: { permissions: [] }, hasWorkspaceAssignments: false },
    });
    renderApp(`/o/${ORG}/administracao/pessoas`);
    await table();
    expect(screen.queryByRole('radio', { name: /Pessoa externa/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Acessos e histórico/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Gerenciar clientes/ })).toBeInTheDocument();
  });
});

describe('pessoa de cliente na tabela e o modal', () => {
  it('a linha identifica o cliente e a automação; o modal revoga só um acesso, reduz o outro e pede uma automação nova; Cancelar não envia nada', async () => {
    const twoGrants = [
      grant(G1, A1, 'Conciliação', { workerId: W1, name: 'Estação fiscal' }),
      grant(G2, A2, 'Folha interna', null, { canViewDashboard: true, canDownloadResults: true, basis: 'second_person' }),
    ];
    api.on('GET', `/api/v1/o/${ORG}/access-grants`, 'listAccessGrants', { status: 200, body: { items: twoGrants, nextCursor: null } });
    api.on('POST', `/api/v1/o/${ORG}/client-automation-grants/${G1}/revoke`, 'revokeClientAutomationGrant', { status: 204 });
    api.on('POST', `/api/v1/o/${ORG}/client-automation-grants/${G2}/reduce`, 'reduceClientAutomationGrant', {
      status: 200,
      body: { grantId: G2, status: 'ATIVA', basis: 'SEGUNDA_PESSOA', clientId: CLIENT, clientMembershipId: CM, workspaceId: WS, automationId: A2, workerId: null, canViewDashboard: true, canDownloadResults: false, replacesGrantId: null },
    });
    renderApp(`/o/${ORG}/administracao/pessoas`);
    const t = await table();
    const row = t.getAllByRole('row')[1];
    expect(row).toHaveTextContent('Cliente · Contábil Exemplo');
    expect(row).toHaveTextContent('Acompanha Conciliação');
    expect(row).toHaveTextContent('máquina Estação fiscal');
    expect(row).toHaveTextContent('Cliente ativo');

    // Cancelar: nenhum envio
    fireEvent.click(within(row).getByRole('button', { name: 'Gerenciar acessos de Carla Cliente' }));
    expect(location()).toBe(`/o/${ORG}/administracao/pessoas`);
    let d = await screen.findByRole('alertdialog', { name: 'Gerenciar acessos de Carla Cliente' });
    await within(d).findByRole('list', { name: 'Automações compartilhadas' });
    fireEvent.click(within(d).getByRole('button', { name: 'Revogar Conciliação' }));
    fireEvent.click(within(d).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.sent('POST', /client-automation-grants/)).toHaveLength(0);

    // de novo: revogar um, reduzir o outro (arquivos de retorno desligados); ligar não é oferecido
    fireEvent.click(within(row).getByRole('button', { name: 'Gerenciar acessos de Carla Cliente' }));
    d = await screen.findByRole('alertdialog', { name: 'Gerenciar acessos de Carla Cliente' });
    await within(d).findByRole('list', { name: 'Automações compartilhadas' });
    fireEvent.click(within(d).getByRole('button', { name: 'Revogar Conciliação' }));
    const results = within(d).getAllByRole('checkbox', { name: /Arquivos de retorno/ });
    fireEvent.click(results[results.length - 1]);
    const changes = within(d).getByRole('list', { name: 'Mudanças a salvar' });
    expect(changes).toHaveTextContent('Revogar: Conciliação');
    expect(changes).toHaveTextContent('Reduzir Folha interna');
    await confirmWhenReady(d, 'Salvar acessos');
    expect(await screen.findByText('Acessos de Carla Cliente salvos.')).toBeInTheDocument();
    expect(api.sent('POST', /client-automation-grants/).map((c) => new URL(c.url, 'http://x').pathname)).toEqual([
      `/api/v1/o/${ORG}/client-automation-grants/${G1}/revoke`,
      `/api/v1/o/${ORG}/client-automation-grants/${G2}/reduce`,
    ]);
    expect(api.sent('POST', /reduce/)[0].body).toEqual({ canViewDashboard: true, canDownloadResults: false });
  });

  it('compartilhar outra automação vira pedido pendente (outra pessoa aprova); a mesma pessoa, sem convite novo', async () => {
    api.on('GET', `/api/v1/o/${ORG}/access-grants`, 'listAccessGrants', { status: 200, body: { items: [grant(G1, A1, 'Conciliação', null)], nextCursor: null } });
    api.on('POST', `/api/v1/o/${ORG}/client-automation-grants`, 'requestClientAutomationGrant', {
      status: 201,
      body: { grantId: G2, status: 'PENDENTE', basis: 'SEGUNDA_PESSOA', clientId: CLIENT, clientMembershipId: CM, workspaceId: WS, automationId: A2, workerId: W2, canViewDashboard: true, canDownloadResults: true, replacesGrantId: null },
    });
    renderApp(`/o/${ORG}/administracao/pessoas?cliente=${CM}`);
    const d = await screen.findByRole('alertdialog', { name: 'Gerenciar acessos de Carla Cliente' });
    await within(d).findByRole('list', { name: 'Automações compartilhadas' });
    fireEvent.click(within(d).getByText('Compartilhar outra automação'));
    fireEvent.change(within(d).getByLabelText(/^Automação/), { target: { value: A2 } });
    fireEvent.change(within(d).getByLabelText(/^Máquina/), { target: { value: W2 } });
    fireEvent.click(within(d).getByRole('checkbox', { name: 'Ver e baixar os arquivos de retorno' }));
    expect(within(d).getByRole('list', { name: 'Mudanças a salvar' })).toHaveTextContent('fica pendente até outra pessoa aprovar');
    await confirmWhenReady(d, 'Salvar acessos');
    expect(await screen.findByText(/O novo compartilhamento aguarda a aprovação de outra pessoa/)).toBeInTheDocument();
    expect(api.sent('POST', `/api/v1/o/${ORG}/client-automation-grants`)[0].body).toEqual({
      clientMembershipId: CM, automationId: A2, workerId: W2, canViewDashboard: true, canDownloadResults: true,
    });
  });
});

describe('Pessoas e acessos: abas Compartilhamentos e Histórico', () => {
  beforeEach(() => {
    api.on('GET', `/api/v1/o/${ORG}/access-grants`, 'listAccessGrants', {
      status: 200,
      body: { items: [grant(G2, A2, 'Folha interna', null, { situation: 'pending', basis: 'second_person', approvedBy: null, approvedAt: null }), grant(G1, A1, 'Conciliação', { workerId: W1, name: 'Estação fiscal' })], nextCursor: null },
    });
    api.on('GET', `/api/v1/o/${ORG}/access-history`, 'listAccessHistory', {
      status: 200,
      body: {
        scope: 'all',
        nextCursor: null,
        items: [
          {
            eventId: ID(80), type: 'CLIENTE_CONCESSAO_APLICADA_NO_ACEITE', category: 'grants', createdAt: T,
            actor: { userId: ID(1), name: 'Ana Souza', email: 'ana@empresa.com' }, byInvitee: false,
            target: { userId: CLIENT_USER, name: 'Carla Cliente', email: 'carla@cliente.com' }, role: null, previousRole: null,
            workspace: { workspaceId: WS, name: 'Fiscal' }, client: { clientId: CLIENT, name: 'Contábil Exemplo' },
            automation: { automationId: A1, name: 'Conciliação' }, machine: { workerId: W1, name: 'Estação fiscal' },
            grant: { kind: 'automation', grantId: G1 }, invitationId: ID(70), decision: null, technicalLogs: false, canViewDashboard: true,
            canDownloadResults: false, shareRequestId: null, grantException: true, correlationId: ID(81),
          },
        ],
      },
    });
  });

  it('abas Concessões e Histórico; filtros no endereço e na API; "Ver histórico" abre a outra aba filtrada; aprovar pede a confirmação', async () => {
    api.on('POST', `/api/v1/o/${ORG}/client-automation-grants/${G2}/approve`, 'approveClientAutomationGrant', {
      status: 200,
      body: { grantId: G2, status: 'ATIVA', basis: 'SEGUNDA_PESSOA', clientId: CLIENT, clientMembershipId: CM, workspaceId: WS, automationId: A2, workerId: null, canViewDashboard: true, canDownloadResults: false, replacesGrantId: null },
    });
    api.on('POST', `/api/v1/o/${ORG}/auth/mfa/step-up`, 'mfaStepUp', { status: 204 });
    renderApp(`/o/${ORG}/administracao/pessoas/acessos`); // endereço anterior: redireciona para a aba Compartilhamentos
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/administracao/pessoas`));
    const list = within(await screen.findByRole('region', { name: 'Lista de concessões de clientes' }));
    expect(screen.getByRole('tab', { name: 'Compartilhamentos' })).toHaveAttribute('aria-selected', 'true');
    const rows = list.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Aguardando aprovação');
    expect(rows[1]).toHaveTextContent('Pelo convite de cliente (exceção registrada)');
    expect(rows[1]).toHaveTextContent('as execuções da máquina Estação fiscal');
    // filtro de situação e de cliente
    fireEvent.click(screen.getByRole('checkbox', { name: 'Revogada' }));
    fireEvent.change(await screen.findByRole('combobox', { name: /^Cliente/ }), { target: { value: CLIENT } });
    await waitFor(() => {
      const q = new URL(api.sent('GET', `/api/v1/o/${ORG}/access-grants`).at(-1)!.url, 'http://x').searchParams;
      expect(q.getAll('situation')).toEqual(['revoked']);
      expect(q.get('clientId')).toBe(CLIENT);
    });
    // aprovar o pedido (a lista foi relida com os filtros: as linhas são as novas)
    const fresh = within(await screen.findByRole('region', { name: 'Lista de concessões de clientes' })).getAllByRole('row').slice(1);
    fireEvent.click(within(fresh[0]).getByRole('button', { name: /Aprovar Folha interna/ }));
    const d = await screen.findByRole('alertdialog', { name: /Aprovar o compartilhamento de Folha interna/ });
    expect(d).toHaveTextContent('Quem pediu não pode aprovar');
    // Ver histórico da outra concessão
    fireEvent.click(within(d).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    fireEvent.click(within(fresh[1]).getByRole('button', { name: /Ver histórico/ }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Histórico' })).toHaveAttribute('aria-selected', 'true'));
    const h = within(await screen.findByRole('region', { name: 'Histórico de acessos' }));
    expect(h.getAllByRole('row')[1]).toHaveTextContent('Compartilhamento aplicado no aceite');
    expect(h.getAllByRole('row')[1]).toHaveTextContent('Exceção do convite de cliente');
    expect(h.getAllByRole('row')[1]).toHaveTextContent('Ana Souza (ana@empresa.com)');
    expect(new URL(api.sent('GET', `/api/v1/o/${ORG}/access-history`).at(-1)!.url, 'http://x').searchParams.get('grantId')).toBe(G1);
  });

  it('pedidos de compartilhamento de membros: aparecem para aprovar (o convite sai na aprovação) ou recusar', async () => {
    const SR = ID(90);
    api.on('GET', new RegExp(`^/api/v1/o/${ORG}/client-share-requests`), 'listClientShareRequests', {
      status: 200,
      body: {
        items: [
          {
            shareRequestId: SR, status: 'PENDENTE', recipientName: 'Pedro Pedido', email: 'pedro@cliente.com', automation: { automationId: A1, name: 'Conciliação' },
            workspace: { workspaceId: WS, name: 'Fiscal' }, machine: null, requestedBy: 'Bruno Membro', decidedBy: null, canViewDashboard: true,
            canDownloadResults: false, requestedByMembershipId: ID(52), createdAt: T, decidedAt: null, invitationId: null,
          },
        ],
      },
    });
    api.on('POST', `/api/v1/o/${ORG}/client-share-requests/${SR}/approve`, 'approveClientShare', {
      status: 200,
      body: {
        shareRequestId: SR, status: 'APROVADO', recipientName: 'Pedro Pedido', email: 'pedro@cliente.com', workspaceId: WS, automationId: A1, workerId: null,
        canViewDashboard: true, canDownloadResults: false, requestedByMembershipId: ID(52), createdAt: T, decidedAt: T, invitationId: ID(91),
      },
    });
    api.on('POST', `/api/v1/o/${ORG}/auth/mfa/step-up`, 'mfaStepUp', { status: 204 });
    renderApp(`/o/${ORG}/administracao/pessoas?aba=compartilhamentos`);
    const panel = within(await screen.findByRole('list', { name: 'Pedidos de compartilhamento aguardando decisão' }));
    expect(panel.getByText('Pedro Pedido (pedro@cliente.com)')).toBeInTheDocument();
    expect(panel.getByText(/Só o dashboard de execução/)).toBeInTheDocument();
    fireEvent.click(panel.getByRole('button', { name: 'Aprovar o compartilhamento com Pedro Pedido' }));
    const d = await screen.findByRole('alertdialog', { name: 'Aprovar o compartilhamento de Conciliação com Pedro Pedido?' });
    expect(d).toHaveTextContent('Bruno Membro');
    expect(within(d).getByRole('button', { name: 'Aprovar e enviar convite' })).toBeInTheDocument();
  });

  it('endereços antigos: Auditoria abre o Histórico; Clientes e Concessões conservam os filtros', async () => {
    renderApp(`/o/${ORG}/administracao/auditoria`);
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/administracao/pessoas`)); // ?aba=historico (o probe mostra só o caminho)
    expect(await screen.findByRole('region', { name: 'Histórico de acessos' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Histórico' })).toHaveAttribute('aria-selected', 'true');
  });
});
