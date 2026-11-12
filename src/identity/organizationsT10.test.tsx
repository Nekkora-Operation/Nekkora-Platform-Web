import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';
import { resetLinkTokenCapture } from '../auth/linkToken';
import { lbl, user } from '../test/helpers';
import { renderApp } from '../test/render';
import { RouteApi } from '../test/routeApi';
import { NAME_TAKEN_TEXT } from './CreateOrganizationPage';

/**
 * PLATFORM-AGENT-V2-003, T10 — organizações identificáveis (API 034). Na lista, organizações de mesmo nome aparecem com o
 * identificador legível e o papel real da pessoa, e cada "Entrar" leva à organização certa (pelo ID); a criação com um
 * nome que a mesma identidade já usou (409 organization_name_taken) diz que nada foi criado e mantém o formulário
 * preenchido. Respostas por rota conferidas contra o contrato.
 */
const ORG_A = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ORG_B = '1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d';

let api: RouteApi;
beforeEach(() => {
  csrfStore.clear();
  sessionMemory.reset();
  resetLinkTokenCapture();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  api = new RouteApi().install();
  api.on('GET', '/api/v1/csrf', 'getPreAuthCsrf', { status: 200, body: { csrfToken: 'pre' } });
  api.on('GET', '/api/v1/me/session', 'identitySessionState', { status: 200, body: { restricted: false, csrfToken: 'id-csrf', mfaEnabled: true, stepUpMethod: 'totp' } });
});

describe('T10: organizações de mesmo nome', () => {
  it('cada uma com o identificador e o papel real; "Entrar" distingue e leva à organização certa', async () => {
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', {
      status: 200,
      body: {
        organizations: [
          { organizationId: ORG_A, name: 'Padaria Central', roles: ['ORG_ADMIN'], activationState: 'ATIVADA', handle: 'padaria-central' },
          { organizationId: ORG_B, name: 'Padaria Central', roles: [], activationState: 'ATIVADA', handle: 'padaria-central-2' },
        ],
        canCreateOrganization: true,
      },
    });
    api.on('POST', '/api/v1/sessions/organization', 'exchangeOrganizationSession', { status: 200, body: { status: 'sem_acesso' } });
    renderApp('/organizacoes');
    const cards = (await screen.findAllByRole('heading', { name: 'Padaria Central' })).map((h) => h.closest('li')!);
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('padaria-central')).toBeInTheDocument();
    expect(within(cards[0]).getByText(/Seu papel: Administração da organização/)).toBeInTheDocument();
    expect(within(cards[1]).getByText('padaria-central-2')).toBeInTheDocument();
    expect(within(cards[1]).getByText(/Seu papel: sem papel na organização/)).toBeInTheDocument();
    // nunca "Proprietária": o papel é o real
    expect(document.body.textContent).not.toMatch(/Propriet[aá]ri/);
    // os botões têm nomes distintos para teclado e leitor de tela, e cada um envia o ID da sua organização
    await user().click(screen.getByRole('button', { name: 'Entrar em Padaria Central (padaria-central-2)' }));
    await waitFor(() => expect(api.sent('POST', '/api/v1/sessions/organization')).toHaveLength(1));
    expect(api.sent('POST', '/api/v1/sessions/organization')[0]).toMatchObject({ body: { organizationId: ORG_B } });
    expect(screen.getByRole('button', { name: 'Entrar em Padaria Central (padaria-central)' })).toBeInTheDocument();
  });
});

describe('T10: criação com nome já usado pela mesma identidade', () => {
  it('409 organization_name_taken: "nada foi criado", o formulário continua preenchido e o campo mostra o motivo', async () => {
    api.on('POST', '/api/v1/auth/step-up', 'identityStepUp', { status: 204 });
    api.on('POST', '/api/v1/organizations', 'identityCreateOrganization', { status: 409, body: { error: 'conflict', reason: 'organization_name_taken' } });
    renderApp('/organizacoes/nova');
    const field = await screen.findByLabelText(lbl('Nome da organização'));
    await user().type(field, 'padaria  central');
    await user().type(screen.getByLabelText(lbl('Razão social (opcional)')), 'Padaria Ltda.');
    await user().click(screen.getByRole('button', { name: 'Continuar' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(await within(dialog).findByLabelText(/Código do seu aplicativo autenticador/), { target: { value: '123456' } });
    await user().click(within(dialog).getByRole('button', { name: 'Criar organização' }));
    expect(await within(dialog).findByText(NAME_TAKEN_TEXT)).toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/organizations')).toHaveLength(1);
    await user().click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    // o formulário fica como estava, com o motivo no campo
    expect(screen.getByLabelText(lbl('Nome da organização'))).toHaveValue('padaria  central');
    expect(screen.getByLabelText(lbl('Razão social (opcional)'))).toHaveValue('Padaria Ltda.');
    expect(await screen.findByText('Você já criou uma organização com esse nome.')).toBeInTheDocument();
    expect(screen.getByLabelText(lbl('Nome da organização'))).toHaveAttribute('aria-invalid', 'true');
    // outro nome tira o aviso
    await user().type(screen.getByLabelText(lbl('Nome da organização')), ' Filial');
    expect(screen.queryByText('Você já criou uma organização com esse nome.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeEnabled();
  });
});
