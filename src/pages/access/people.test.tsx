import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';

/**
 * PLATFORM-FLUXO-002 — "Pessoas e acessos": membros e convites numa tabela só (ordem da API: pendentes primeiro, depois
 * membros), formulário de convite no topo, busca e filtro no endereço, "Gerenciar acessos" num modal com rascunho
 * (Salvar aplica; Cancelar não envia nada), linha atualizada sem reler a lista, e os endereços antigos. Respostas por
 * rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ID = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const WS = ID(11);
const ANA = ID(1);
const BRUNO = ID(2);
const INV = ID(30);
const location = () => screen.getByTestId('location').textContent;
const T = '2026-11-20T10:00:00Z';

const member = (n: number, name: string, roles: { role: string; workspaceId: string | null; workspaceName: string | null }[], over: Record<string, unknown> = {}) => ({
  kind: 'member',
  id: ID(n + 50),
  invitation: null,
  client: null,
  member: {
    membershipId: ID(n + 50),
    userId: ID(n),
    displayName: name,
    email: `${name.split(' ')[0].toLowerCase()}@empresa.com`,
    emailVerified: true,
    accountStatus: 'active',
    membershipStatus: 'active',
    mfaConfigured: true,
    joinedAt: T,
    roles,
    ...over,
  },
});
const invitation = (n: number, email: string, state = 'PENDENTE', over: Record<string, unknown> = {}) => ({
  kind: 'invitation',
  id: ID(n),
  member: null,
  client: null,
  invitation: {
    invitationId: ID(n),
    email,
    role: 'VIEWER',
    workspaceId: WS,
    workspaceName: 'Fiscal',
    state,
    createdAt: T,
    expiresAt: '2026-11-27T10:00:00Z',
    acceptedAt: null,
    revokedAt: null,
    revokeReason: null,
    acceptedUserId: null,
    audience: 'internal',
    clientScope: null,
    ...over,
  },
});

let api: RouteApi;
let roles: { assignmentId: string; role: string; workspaceId: string | null }[];
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
    body: { organizationId: ORG, membershipId: ID(51), organization: { roles: ['ORG_ADMIN'], permissions: ['org.manage', 'identity.mfa.reset'] }, allWorkspaces: { permissions: [] }, hasWorkspaceAssignments: false },
  });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workspaces`), 'listWorkspaces', {
    status: 200,
    body: {
      items: [
        { workspaceId: WS, name: 'Fiscal', description: null, status: 'active', client: null, createdAt: T, updatedAt: T },
        { workspaceId: ID(12), name: 'Compras', description: null, status: 'active', client: null, createdAt: T, updatedAt: T },
      ],
      nextCursor: null,
    },
  });
  api.on('GET', `/api/v1/o/${ORG}/people`, 'listPeople', {
    status: 200,
    body: {
      items: [
        invitation(30, 'nova@empresa.com'),
        member(2, 'Bruno Lima', [{ role: 'OPERATOR', workspaceId: WS, workspaceName: 'Fiscal' }]),
        member(1, 'Ana Souza', [{ role: 'ORG_ADMIN', workspaceId: null, workspaceName: null }]),
      ],
      nextCursor: null,
      invitationsEnabled: true,
    },
  });
  roles = [{ assignmentId: ID(40), role: 'OPERATOR', workspaceId: WS }];
  api.on('GET', `/api/v1/o/${ORG}/users/${BRUNO}/roles`, 'listMemberRoles', () => ({
    status: 200,
    body: { userId: BRUNO, membershipId: ID(52), membershipState: 'ATIVO', organizationRoles: [], workspaceRoles: roles },
  }));
});

const table = async () => within(await screen.findByRole('region', { name: 'Lista de pessoas e convites' }));
const peopleCalls = () => api.sent('GET', `/api/v1/o/${ORG}/people`);
const query = (i = -1) => new URL(peopleCalls().at(i)!.url, 'http://x').searchParams;

describe('Pessoas e acessos: a tabela', () => {
  it('uma tabela, sem abas: convite pendente primeiro, depois membros; colunas e diferenciação de convite e membro; ações pelo tipo', async () => {
    renderApp(`/o/${ORG}/administracao/pessoas`);
    const t = await table();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(t.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Pessoa/e-mail', 'Perfil', 'Situação', 'Data', 'Ações']);
    const rows = t.getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      expect.stringContaining('nova@empresa.com'),
      expect.stringContaining('Bruno Lima'),
      expect.stringContaining('Ana Souza'),
    ]);
    expect(rows[0]).toHaveTextContent('Convite pendente');
    expect(rows[0]).toHaveTextContent('Leitura · Fiscal');
    expect(within(rows[0]).getByRole('button', { name: 'Reenviar convite para nova@empresa.com' })).toBeInTheDocument();
    expect(within(rows[0]).getByRole('button', { name: 'Revogar convite para nova@empresa.com' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Membro ativo');
    expect(rows[1]).toHaveTextContent('Operação · Fiscal');
    expect(within(rows[1]).getByRole('button', { name: 'Gerenciar acessos de Bruno Lima' })).toBeInTheDocument();
    // a própria conta: sem ações
    expect(rows[2]).toHaveTextContent('Sua conta');
    expect(within(rows[2]).queryByRole('button')).toBeNull();
    // a consulta padrão: sem situação (pendentes e membros, pela API)
    expect(query().getAll('situation')).toEqual([]);
    // o formulário de convite no topo
    expect(screen.getByRole('form', { name: 'Novo convite' })).toBeInTheDocument();
  });

  it('busca por nome/e-mail e filtro por situação vão ao endereço e à API; o histórico de convites só pelo filtro', async () => {
    renderApp(`/o/${ORG}/administracao/pessoas`);
    await table();
    fireEvent.change(screen.getByLabelText('Buscar por nome ou e-mail'), { target: { value: 'bruno' } });
    await waitFor(() => expect(query().get('q')).toBe('bruno'));
    expect(location()).toBe(`/o/${ORG}/administracao/pessoas`);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Convite aceito' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Convite vencido' }));
    await waitFor(() => expect(query().getAll('situation')).toEqual(['invitation_expired', 'invitation_accepted']));
    expect(query().get('q')).toBe('bruno');
  });

  it('enviar convite: confirmação, a tabela é lida de novo e a confirmação aparece', async () => {
    api.on('POST', `/api/v1/o/${ORG}/invitations`, 'issueInvitation', {
      status: 201,
      body: { invitationId: ID(31), email: 'outra@empresa.com', role: 'OPERATOR', workspaceId: WS, expiresAt: '2026-11-27T10:00:00Z' },
    });
    renderApp(`/o/${ORG}/administracao/pessoas`);
    await table();
    const before = peopleCalls().length;
    fireEvent.change(screen.getByLabelText(/^E-mail da pessoa/), { target: { value: 'outra@empresa.com' } });
    fireEvent.change(screen.getByLabelText(/^Perfil \(opcional\)/), { target: { value: 'OPERATOR' } });
    fireEvent.change(await screen.findByLabelText(/^Ambiente de trabalho do perfil/), { target: { value: WS } });
    fireEvent.click(screen.getByRole('button', { name: 'Convidar' }));
    const d = await screen.findByRole('alertdialog', { name: 'Convidar outra@empresa.com?' });
    fireEvent.click(within(d).getByRole('button', { name: 'Enviar convite' }));
    expect(await screen.findByText('Convite enviado. A pessoa recebe o link por e-mail.')).toBeInTheDocument();
    expect(api.sent('POST', `/api/v1/o/${ORG}/invitations`)[0].body).toEqual({ email: 'outra@empresa.com', role: 'OPERATOR', workspaceId: WS });
    await waitFor(() => expect(peopleCalls().length).toBeGreaterThan(before));
  });

  it('sem org.manage: a API recusa (403) e a tela não mostra formulário, dados nem ações', async () => {
    api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
      status: 200,
      body: { organizationId: ORG, membershipId: ID(52), organization: { roles: [], permissions: [] }, allWorkspaces: { permissions: [] }, hasWorkspaceAssignments: true },
    });
    api.on('GET', `/api/v1/o/${ORG}/people`, 'listPeople', { status: 403, body: { error: 'forbidden' } });
    renderApp(`/o/${ORG}/administracao/pessoas`);
    expect(await screen.findByText('Você não tem permissão para ver as pessoas e os convites desta organização.')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Novo convite' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('Gerenciar acessos (modal)', () => {
  it('abre pelo botão e pelo endereço (?acessos=), inclusive depois de recarregar', async () => {
    const v = renderApp(`/o/${ORG}/administracao/pessoas`);
    const t = await table();
    fireEvent.click(t.getByRole('button', { name: 'Gerenciar acessos de Bruno Lima' }));
    expect(await screen.findByRole('alertdialog', { name: 'Gerenciar acessos de Bruno Lima' })).toBeInTheDocument();
    expect(location()).toBe(`/o/${ORG}/administracao/pessoas`);
    v.unmount();
    renderApp(`/o/${ORG}/administracao/pessoas?acessos=${BRUNO}`);
    expect(await screen.findByRole('alertdialog', { name: /Gerenciar acessos de/ })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Acessos atuais' })).toHaveTextContent('Fiscal');
  });

  it('Cancelar não envia nada; "Salvar acessos" sem mudança fica indisponível', async () => {
    renderApp(`/o/${ORG}/administracao/pessoas?acessos=${BRUNO}`);
    const d = await screen.findByRole('alertdialog', { name: /Gerenciar acessos de/ });
    await within(d).findByRole('list', { name: 'Acessos atuais' });
    expect(within(d).getByRole('button', { name: 'Salvar acessos' })).toBeDisabled();
    fireEvent.change(within(d).getByLabelText('Perfil em Fiscal'), { target: { value: 'VIEWER' } });
    expect(within(d).getByRole('list', { name: 'Mudanças a salvar' })).toHaveTextContent('Trocar Operação · Fiscal por Leitura');
    fireEvent.click(within(d).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.sent('POST', /.*/)).toEqual([]);
  });

  it('Salvar aplica o rascunho (trocar, acrescentar, revogar) e atualiza a linha sem reler a lista (busca, filtros e posição continuam)', async () => {
    api.on('POST', `/api/v1/o/${ORG}/role-assignments/${ID(40)}/replace`, 'replaceRole', () => {
      roles = [{ assignmentId: ID(41), role: 'VIEWER', workspaceId: WS }];
      return { status: 200, body: { assignmentId: ID(41), role: 'VIEWER', workspaceId: WS } };
    });
    api.on('POST', `/api/v1/o/${ORG}/users/${BRUNO}/roles`, 'assignRole', () => {
      roles = [...roles, { assignmentId: ID(42), role: 'OPERATOR', workspaceId: ID(12) }];
      return { status: 200, body: { assignmentId: ID(42), role: 'OPERATOR', workspaceId: ID(12) } };
    });
    renderApp(`/o/${ORG}/administracao/pessoas?q=bruno`);
    const t = await table();
    const reads = peopleCalls().length;
    fireEvent.click(t.getByRole('button', { name: 'Gerenciar acessos de Bruno Lima' }));
    const d = await screen.findByRole('alertdialog', { name: 'Gerenciar acessos de Bruno Lima' });
    await within(d).findByRole('list', { name: 'Acessos atuais' });
    fireEvent.change(within(d).getByLabelText('Perfil em Fiscal'), { target: { value: 'VIEWER' } });
    fireEvent.change(within(d).getByLabelText('Perfil'), { target: { value: 'OPERATOR' } });
    fireEvent.change(within(d).getByLabelText('Ambiente de trabalho'), { target: { value: ID(12) } });
    fireEvent.click(within(d).getByRole('button', { name: 'Acrescentar' }));
    expect(within(d).getByRole('list', { name: 'Acessos a acrescentar' })).toHaveTextContent('Operação · Compras');
    fireEvent.click(within(d).getByRole('button', { name: 'Salvar acessos' }));
    expect(await screen.findByText('Acessos de Bruno Lima salvos.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.sent('POST', `/api/v1/o/${ORG}/role-assignments/${ID(40)}/replace`)[0].body).toEqual({ role: 'VIEWER' });
    expect(api.sent('POST', `/api/v1/o/${ORG}/users/${BRUNO}/roles`)[0].body).toEqual({ role: 'OPERATOR', workspaceId: ID(12) });
    const row = (await table()).getAllByRole('row').find((r) => r.textContent!.includes('Bruno Lima'))!;
    expect(row).toHaveTextContent('Leitura · Fiscal');
    expect(row).toHaveTextContent('Operação · Compras');
    // a lista não foi lida de novo e a busca continua no endereço
    expect(peopleCalls().length).toBe(reads);
    expect((screen.getByLabelText('Buscar por nome ou e-mail') as HTMLInputElement).value).toBe('bruno');
    // o foco volta ao botão da linha
    await waitFor(() => expect(screen.getByRole('button', { name: 'Gerenciar acessos de Bruno Lima' })).toHaveFocus());
  });

  it('mudança que falha depois de outra aplicada: o resultado diz o que ficou de fora (as aplicadas valem)', async () => {
    api.on('POST', `/api/v1/o/${ORG}/role-assignments/${ID(40)}/replace`, 'replaceRole', { status: 200, body: { assignmentId: ID(41), role: 'VIEWER', workspaceId: WS } });
    api.on('POST', `/api/v1/o/${ORG}/users/${BRUNO}/roles`, 'assignRole', { status: 409, body: { error: 'conflict' } });
    renderApp(`/o/${ORG}/administracao/pessoas?acessos=${BRUNO}`);
    const d = await screen.findByRole('alertdialog', { name: /Gerenciar acessos de/ });
    await within(d).findByRole('list', { name: 'Acessos atuais' });
    fireEvent.change(within(d).getByLabelText('Perfil em Fiscal'), { target: { value: 'VIEWER' } });
    fireEvent.change(within(d).getByLabelText('Perfil'), { target: { value: 'ORG_ADMIN' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Acrescentar' }));
    fireEvent.click(within(d).getByRole('button', { name: 'Salvar acessos' }));
    expect(await screen.findByText(/Parte dos acessos de .* foi salva\. Ficou de fora: atribuir Administração da organização/)).toBeInTheDocument();
  });

  it('primeira mudança recusada: nada foi feito, o modal continua aberto com a recusa', async () => {
    api.on('POST', `/api/v1/o/${ORG}/role-assignments/${ID(40)}/revoke`, 'revokeRole', { status: 403, body: { error: 'forbidden' } });
    renderApp(`/o/${ORG}/administracao/pessoas?acessos=${BRUNO}`);
    const d = await screen.findByRole('alertdialog', { name: /Gerenciar acessos de/ });
    await within(d).findByRole('list', { name: 'Acessos atuais' });
    fireEvent.click(within(d).getByRole('button', { name: 'Revogar Operação · Fiscal' }));
    fireEvent.click(within(d).getByRole('button', { name: 'Salvar acessos' }));
    expect(await within(d).findByText(/Nada foi alterado\./)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('endereços antigos', () => {
  it('Membros, Convites e os acessos de um membro levam a "Pessoas e acessos" (o modal do membro aberto)', async () => {
    let v = renderApp(`/o/${ORG}/administracao/convites`);
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/administracao/pessoas`));
    v.unmount();
    v = renderApp(`/o/${ORG}/administracao/membros`);
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/administracao/pessoas`));
    v.unmount();
    renderApp(`/o/${ORG}/administracao/membros/${BRUNO}`);
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/administracao/pessoas`));
    expect(await screen.findByRole('alertdialog', { name: /Gerenciar acessos de/ })).toBeInTheDocument();
    await act(async () => undefined);
  });
});

void ANA;
void INV;
