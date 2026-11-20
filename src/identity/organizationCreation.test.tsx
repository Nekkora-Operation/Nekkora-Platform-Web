import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../api/pendingOps';
import { sessionMemory } from '../app/notices';
import { resetLinkTokenCapture } from '../auth/linkToken';
import { fakeLocks } from '../test/fakeLocks';
import { lbl, user } from '../test/helpers';
import { renderApp } from '../test/render';
import { RouteApi } from '../test/routeApi';
import { BORN_LICENSED } from './labels';
import { CANNOT_CREATE, creationRateLimitText, DEACTIVATE_TEXT } from './OrganizationCreationPanel';

/**
 * PLATFORM-LICENCIAMENTO-001 — criação por perfil na área da conta: o membro solicita, o Cliente não cria nem solicita, o
 * limite de vazias é explicado, e o responsável desativa e reativa (bloqueio da Nekkora não tem ação). Testes de componente
 * ISOLADOS, com as respostas conferidas contra o contrato; a API é quem decide.
 */
const ORG_A = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ORG_B = '1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d';
const ORG_C = '2b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d';
const REQ = '3b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d';
const T = '2026-11-10T12:00:00Z';

let api: RouteApi;

const creation = (over: Record<string, unknown> = {}) => ({
  profile: 'ADMIN',
  canCreate: true,
  cannotCreateReason: null,
  canRequest: false,
  emptyOrganizations: { used: 0, limit: 3, organizationIds: [] },
  pendingRequests: { used: 0, limit: 3 },
  newOrganizationLicenseModel: 'legacy',
  responsibleFor: [],
  ...over,
});
const org = (id: string, name: string, roles: string[]) => ({ organizationId: id, name, roles, activationState: 'ATIVADA', handle: null });

function listing(organizations: unknown[], canCreateOrganization: boolean) {
  api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', { status: 200, body: { organizations, canCreateOrganization } });
}

beforeEach(() => {
  csrfStore.clear();
  sessionMemory.reset();
  resetLinkTokenCapture();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  localStorage.clear();
  const locks = fakeLocks();
  setOperationRegistryForTest(createOperationRegistry({ storage: () => localStorage, locks: () => locks, now: () => Date.now() }));
  api = new RouteApi().install();
  api.on('GET', '/api/v1/csrf', 'getPreAuthCsrf', { status: 200, body: { csrfToken: 'pre' } });
  api.on('GET', '/api/v1/me/session', 'identitySessionState', { status: 200, body: { restricted: false, csrfToken: 'id-csrf', mfaEnabled: true, stepUpMethod: 'totp' } });
  api.on('GET', '/api/v1/me/organization-requests', 'identityOrganizationRequests', { status: 200, body: { items: [] } });
  api.on('POST', '/api/v1/auth/step-up', 'identityStepUp', { status: 204 });
});

describe('o que a tela de criação diz antes de criar, pelo modelo em que a organização nasce', () => {
  it('modelo por licença: nasce pronta para configurar, sem "aguardando ativação" e sem depender de aprovação da Nekkora', async () => {
    api.on('GET', '/api/v1/me/organization-creation', 'identityOrganizationCreation', { status: 200, body: creation({ newOrganizationLicenseModel: 'licensed' }) });
    renderApp('/organizacoes/nova');
    expect(await screen.findByText(BORN_LICENSED.title)).toBeInTheDocument();
    expect(screen.getByText(BORN_LICENSED.body)).toBeInTheDocument();
    expect(BORN_LICENSED.body).toMatch(/sem depender de aprovação da Nekkora/);
    expect(BORN_LICENSED.body).toMatch(/Para executar e monitorar uma automação, vincule a ela uma licença vigente\./);
    expect(screen.queryByText(/aguardando ativação/i)).toBeNull();
    expect(screen.queryByText(/nenhum Worker pode ser registrado/)).toBeNull();
  });

  it('modelo anterior (chave desligada): continua dizendo que nasce aguardando ativação', async () => {
    api.on('GET', '/api/v1/me/organization-creation', 'identityOrganizationCreation', { status: 200, body: creation() });
    renderApp('/organizacoes/nova');
    expect(await screen.findByText('A organização nasce aguardando ativação.')).toBeInTheDocument();
    expect(screen.queryByText(BORN_LICENSED.title)).toBeNull();
  });

  it('sem a informação do modelo: a tela não afirma nenhum dos dois', async () => {
    api.on('GET', '/api/v1/me/organization-creation', 'identityOrganizationCreation', { status: 404, body: { error: 'not_found' } });
    renderApp('/organizacoes/nova');
    expect(await screen.findByRole('heading', { name: 'Criar organização' })).toBeInTheDocument();
    await waitFor(() => expect(api.sent('GET', '/api/v1/me/organization-creation').length).toBeGreaterThanOrEqual(1));
    expect(screen.queryByText(BORN_LICENSED.title)).toBeNull();
    expect(screen.queryByText(/aguardando ativação/i)).toBeNull();
  });

  it('situação e disponibilidade de execução têm rótulos que dizem a dimensão', async () => {
    listing([{ ...org(ORG_A, 'Casa', ['ORG_ADMIN']), activationState: 'AGUARDANDO_ATIVACAO', licenseModel: 'licensed' }], true);
    api.on('GET', '/api/v1/me/organization-creation', 'identityOrganizationCreation', {
      status: 200,
      body: creation({ responsibleFor: [{ organizationId: ORG_A, name: 'Casa', state: 'ACTIVE', empty: true, deactivatedAt: null, canReactivate: false }] }),
    });
    renderApp('/organizacoes');
    expect(await screen.findByText('Situação: ativa')).toBeInTheDocument();
    expect(screen.getByText('Execução: por licença')).toBeInTheDocument();
    expect(screen.queryByText('Ativa')).toBeNull();
    expect(screen.queryByText(/aguardando ativação/i)).toBeNull();
  });
});

describe('criação por perfil', () => {
  it('membro: não vê "Criar organização"; vê o motivo e pode solicitar', async () => {
    listing([org(ORG_A, 'Casa', [])], false);
    api.on('GET', '/api/v1/me/organization-creation', 'identityOrganizationCreation', {
      status: 200,
      body: creation({ profile: 'MEMBER', canCreate: false, cannotCreateReason: 'organization_creation_requires_request', canRequest: true }),
    });
    renderApp('/organizacoes');
    expect(await screen.findByText(CANNOT_CREATE.organization_creation_requires_request.title)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Criar organização' })).toBeNull();
    await user().click(screen.getByRole('button', { name: 'Solicitar organização' }));
    expect(await screen.findByRole('heading', { name: 'Solicitar organização' })).toBeInTheDocument();
  });

  it('solicitar: envia a organização escolhida e o nome, com a confirmação; diz que nada é criado antes da aprovação', async () => {
    listing([org(ORG_A, 'Casa', [])], false);
    api.on('GET', '/api/v1/me/organization-creation', 'identityOrganizationCreation', {
      status: 200,
      body: creation({ profile: 'MEMBER', canCreate: false, cannotCreateReason: 'organization_creation_requires_request', canRequest: true }),
    });
    api.on('POST', '/api/v1/organization-requests', 'identityRequestOrganization', { status: 201, body: { requestId: REQ } });
    renderApp('/organizacoes/solicitar');
    await user().type(await screen.findByLabelText(lbl('Nome da nova organização')), 'Filial Norte');
    expect(screen.getByText(/Nada é criado antes da aprovação\./)).toBeInTheDocument();
    expect(screen.getByText('Quem aprova decide quem fica responsável.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Continuar' }));
    const dialog = await screen.findByRole('alertdialog');
    await user().type(await within(dialog).findByLabelText(/Código/), '123456');
    const confirm = within(dialog).getByRole('button', { name: 'Enviar pedido' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user().click(confirm);
    expect(await screen.findByText('Pedido enviado.')).toBeInTheDocument();
    // a única organização de que participa já vem escolhida
    expect(api.sent('POST', '/api/v1/organization-requests')[0]).toMatchObject({ body: { organizationId: ORG_A, name: 'Filial Norte' } });
    expect(api.sent('POST', '/api/v1/auth/step-up')).toHaveLength(1);
  });

  it('Cliente: explica que não cria nem solicita, sem oferecer ação', async () => {
    listing([], false);
    api.on('GET', '/api/v1/me/organization-creation', 'identityOrganizationCreation', {
      status: 200,
      body: creation({ profile: 'CLIENT', canCreate: false, cannotCreateReason: 'organization_creation_client_profile' }),
    });
    renderApp('/organizacoes');
    expect(await screen.findByText(CANNOT_CREATE.organization_creation_client_profile.title)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Criar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Solicitar organização' })).toBeNull();
  });

  it('limite de vazias: diz o limite e quais são as vazias', async () => {
    listing([org(ORG_A, 'Um', ['ORG_ADMIN']), org(ORG_B, 'Dois', ['ORG_ADMIN']), org(ORG_C, 'Três', ['ORG_ADMIN'])], false);
    api.on('GET', '/api/v1/me/organization-creation', 'identityOrganizationCreation', {
      status: 200,
      body: creation({
        canCreate: false,
        cannotCreateReason: 'empty_organization_limit_reached',
        emptyOrganizations: { used: 3, limit: 3, organizationIds: [ORG_A, ORG_B, ORG_C] },
        responsibleFor: [ORG_A, ORG_B, ORG_C].map((id, i) => ({ organizationId: id, name: ['Um', 'Dois', 'Três'][i], state: 'ACTIVE', empty: true, deactivatedAt: null, canReactivate: false })),
      }),
    });
    renderApp('/organizacoes');
    expect(await screen.findByText(CANNOT_CREATE.empty_organization_limit_reached.title)).toBeInTheDocument();
    expect(screen.getByText('Organizações vazias hoje (3 de 3): Um, Dois, Três.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Criar organização' })).toBeNull();
  });

  it('instalação sem o recurso (404): a lista de organizações continua como sempre', async () => {
    listing([org(ORG_A, 'Casa', ['ORG_ADMIN'])], true);
    api.on('GET', '/api/v1/me/organization-creation', 'identityOrganizationCreation', { status: 404, body: { error: 'not_found' } });
    renderApp('/organizacoes');
    expect(await screen.findByRole('heading', { name: 'Casa' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Criar organização' })).toBeInTheDocument();
    expect(screen.queryByText('Organizações sob sua responsabilidade')).toBeNull();
  });
});

describe('desativar e reativar', () => {
  const responsible = [
    { organizationId: ORG_A, name: 'Ativa', state: 'ACTIVE', empty: false, deactivatedAt: null, canReactivate: false },
    { organizationId: ORG_B, name: 'Parada por mim', state: 'DEACTIVATED', empty: true, deactivatedAt: T, canReactivate: true },
    { organizationId: ORG_C, name: 'Parada pela Nekkora', state: 'BLOCKED', empty: false, deactivatedAt: T, canReactivate: false },
  ];

  beforeEach(() => {
    listing([org(ORG_A, 'Ativa', ['ORG_ADMIN'])], true);
    api.on('GET', '/api/v1/me/organization-creation', 'identityOrganizationCreation', { status: 200, body: creation({ responsibleFor: responsible }) });
  });

  it('a desativada aparece para o responsável com "Reativar"; a bloqueada pela Nekkora não tem ação e diz por quê', async () => {
    renderApp('/organizacoes');
    const list = await screen.findByRole('list', { name: 'Organizações sob sua responsabilidade' });
    expect(within(list).getByRole('button', { name: 'Desativar a organização Ativa' })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Reativar a organização Parada por mim' })).toBeInTheDocument();
    const blocked = within(list).getByRole('heading', { name: 'Parada pela Nekkora' }).closest('li')!;
    expect(within(blocked).getByText('Situação: bloqueada pela Nekkora')).toBeInTheDocument();
    expect(within(blocked).getByText(DEACTIVATE_TEXT.blocked)).toBeInTheDocument();
    expect(within(blocked).queryByRole('button')).toBeNull();
  });

  it('desativar: explica que nada é apagado e que a licença não é liberada; envia a organização', async () => {
    api.on('POST', '/api/v1/organization-deactivations', 'identityDeactivateOrganization', { status: 204 });
    renderApp('/organizacoes');
    fireEvent.click(await screen.findByRole('button', { name: 'Desativar a organização Ativa' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(DEACTIVATE_TEXT.consequences)).toBeInTheDocument();
    expect(within(dialog).getByText(DEACTIVATE_TEXT.licenses)).toBeInTheDocument();
    await user().type(await within(dialog).findByLabelText(/Código/), '123456');
    const confirm = within(dialog).getByRole('button', { name: 'Desativar organização' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user().click(confirm);
    expect(await screen.findByText(/Organização "Ativa" desativada\./)).toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/organization-deactivations')[0]).toMatchObject({ body: { organizationId: ORG_A } });
    // a lista de organizações é relida depois do ato e a confirmação continua na tela. ATENÇÃO: este teste NÃO reproduz o
    // defeito visto no laboratório (a releitura trocava a página por "Carregando" e a mensagem sumia) - ele passa com e sem a
    // correção. A prova da correção é o roteiro real (e2e-real/licenciamento-001.spec.ts, etapa A7)
    await waitFor(() => expect(api.sent('GET', '/api/v1/me/organizations').length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(api.sent('GET', '/api/v1/me/organization-creation').length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText(/Organização "Ativa" desativada\./)).toBeInTheDocument();
    expect(screen.queryByText('Carregando organizações…')).toBeNull();
  });

  it('reativar com o limite de vazias cheio: a recusa explica e nada muda', async () => {
    api.on('POST', '/api/v1/organization-reactivations', 'identityReactivateOrganization', {
      status: 409,
      body: { error: 'conflict', reason: 'empty_organization_limit_reached' },
    });
    renderApp('/organizacoes');
    fireEvent.click(await screen.findByRole('button', { name: 'Reativar a organização Parada por mim' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/conta de novo no seu limite de organizações vazias/)).toBeInTheDocument();
    await user().type(await within(dialog).findByLabelText(/Código/), '123456');
    const confirm = within(dialog).getByRole('button', { name: 'Reativar organização' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user().click(confirm);
    expect(await within(dialog).findByText(/você já tem o limite de organizações vazias ativas.*Nada foi alterado\./)).toBeInTheDocument();
  });

  it('trabalho em andamento: a recusa da desativação diz o que fazer', async () => {
    api.on('POST', '/api/v1/organization-deactivations', 'identityDeactivateOrganization', {
      status: 409,
      body: { error: 'conflict', reason: 'organization_work_in_progress' },
    });
    renderApp('/organizacoes');
    fireEvent.click(await screen.findByRole('button', { name: 'Desativar a organização Ativa' }));
    const dialog = await screen.findByRole('alertdialog');
    await user().type(await within(dialog).findByLabelText(/Código/), '123456');
    const confirm = within(dialog).getByRole('button', { name: 'Desativar organização' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user().click(confirm);
    expect(await within(dialog).findByText(/Há trabalho em andamento nesta organização.*Nada foi alterado\./)).toBeInTheDocument();
  });
  it('limite de frequência da criação: diz a regra, quando será possível tentar de novo e que não é o limite de vazias', () => {
    const now = new Date(2026, 10, 19, 20, 0, 0);
    const amanha = creationRateLimitText(22 * 3600 + 30 * 60, now);
    expect(amanha).toContain('Cada pessoa pode criar até três organizações por dia.');
    expect(amanha).toContain('poderá criar outra amanhã, a partir das 18:30.');
    expect(amanha).toContain('não tem relação com o limite de organizações vazias');
    expect(amanha).toContain('Nada foi criado.');
    expect(creationRateLimitText(2 * 3600, now)).toContain('poderá criar outra hoje, a partir das 22:00.');
    expect(creationRateLimitText(50 * 3600, now)).toContain('poderá criar outra em 21/11, a partir das 22:00.');
    expect(creationRateLimitText(20 * 60, now)).toContain('poderá criar outra em cerca de 20 minutos.');
    expect(creationRateLimitText(30, now)).toContain('em cerca de um minuto');
    // sem o tempo informado pelo servidor, não inventa um horário
    expect(creationRateLimitText(undefined, now)).toContain('tente de novo mais tarde');
    expect(creationRateLimitText(undefined, now)).not.toMatch(/a partir das/);
  });
});
