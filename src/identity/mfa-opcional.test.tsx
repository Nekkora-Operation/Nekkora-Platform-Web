import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { me, stepUp } from '../api/auth';
import { csrfStore } from '../api/csrf';
import { stepUpMethods } from '../api/stepUpMethod';
import { sessionMemory } from '../app/notices';
import { resetLinkTokenCapture } from '../auth/linkToken';
import { INVALID_CODE } from '../auth/messages';
import { lbl, location, user } from '../test/helpers';
import { renderApp } from '../test/render';
import { RouteApi } from '../test/routeApi';

/**
 * PLATFORM-LOCAL-002 (API 029): autenticação em duas etapas OPCIONAL. Respostas por rota conferidas contra o contrato.
 * Sem MFA: entra só com a senha, a senha reconfirmada confirma as ações sensíveis e "Ativar autenticação em duas etapas"
 * fica em Segurança da conta. Com MFA: nada muda (o código continua pedido).
 */
const ORG_A = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const PASSWORD = 'senha-muito-segura-123';
const OTPAUTH = 'otpauth://totp/Nekkora:ana%40empresa.com?secret=JBSWY3DPEHPK3PXP&issuer=Nekkora';

let api: RouteApi;
beforeEach(() => {
  csrfStore.clear();
  stepUpMethods.clear();
  sessionMemory.reset();
  resetLinkTokenCapture();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  api = new RouteApi().install();
  api.on('GET', '/api/v1/csrf', 'getPreAuthCsrf', { status: 200, body: { csrfToken: 'pre' } });
});

const semMfa = () =>
  api.on('GET', '/api/v1/me/session', 'identitySessionState', {
    status: 200,
    body: { restricted: false, csrfToken: 'id-csrf', mfaEnabled: false, stepUpMethod: 'password' },
  });
const comMfa = () =>
  api.on('GET', '/api/v1/me/session', 'identitySessionState', {
    status: 200,
    body: { restricted: false, csrfToken: 'id-csrf', mfaEnabled: true, stepUpMethod: 'totp' },
  });
const vazia = () =>
  api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', { status: 200, body: { organizations: [], canCreateOrganization: true } });

describe('conta nova sem autenticação em duas etapas', () => {
  it('entra só com a senha: sem tela de código nem QR, direto nas organizações', async () => {
    api.on('POST', '/api/v1/auth/login', 'identityLogin', { status: 200, body: { status: 'authenticated', csrfToken: 'id-csrf' } });
    semMfa();
    vazia();
    renderApp('/entrar');
    await user().type(screen.getByLabelText(lbl('E-mail')), 'ana@empresa.com');
    await user().type(screen.getByLabelText(lbl('Senha')), PASSWORD);
    await user().click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('button', { name: 'Criar minha primeira organização' })).toBeInTheDocument();
    expect(location()).toBe('/organizacoes');
    expect(screen.queryByText(/aplicativo autenticador/i)).not.toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/auth/mfa/enroll/start')).toEqual([]);
  });

  it('criar organização pede a SENHA (não o código) e só então envia a criação', async () => {
    semMfa();
    api.on('POST', '/api/v1/auth/password-confirm', 'identityPasswordConfirm', { status: 204 });
    api.on('POST', '/api/v1/organizations', 'identityCreateOrganization', { status: 201, body: { organizationId: ORG_A } });
    renderApp('/organizacoes/nova');
    await user().type(await screen.findByLabelText(lbl('Nome da organização')), 'Acme');
    await user().click(screen.getByRole('button', { name: 'Continuar' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByLabelText(/Código do seu aplicativo autenticador/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/não usa autenticação em duas etapas/)).toBeInTheDocument();
    await user().type(within(dialog).getByLabelText(lbl('Sua senha')), PASSWORD);
    await user().click(within(dialog).getByRole('button', { name: 'Criar organização' }));
    await vi.waitFor(() => expect(api.sent('POST', '/api/v1/organizations')).toHaveLength(1));
    expect(api.sent('POST', '/api/v1/auth/password-confirm')[0]).toMatchObject({ csrf: 'id-csrf', body: { password: PASSWORD } });
    expect(api.sent('POST', '/api/v1/auth/step-up')).toEqual([]);
  });

  it('senha recusada: nada é criado e a mensagem fala da senha', async () => {
    semMfa();
    api.on('POST', '/api/v1/auth/password-confirm', 'identityPasswordConfirm', { status: 403, body: { error: 'forbidden' } });
    api.on('POST', '/api/v1/organizations', 'identityCreateOrganization', { status: 201, body: { organizationId: ORG_A } });
    renderApp('/organizacoes/nova');
    await user().type(await screen.findByLabelText(lbl('Nome da organização')), 'Acme');
    await user().click(screen.getByRole('button', { name: 'Continuar' }));
    const dialog = await screen.findByRole('alertdialog');
    await user().type(within(dialog).getByLabelText(lbl('Sua senha')), 'senha-errada-qualquer');
    await user().click(within(dialog).getByRole('button', { name: 'Criar organização' }));
    expect(await within(dialog).findByText(/Não foi possível confirmar sua identidade com esta senha/)).toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/organizations')).toEqual([]);
  });
});

describe('ativação voluntária', () => {
  it('Segurança da conta oferece "Ativar autenticação em duas etapas"; a ativação passa por senha, QR, código e códigos de recuperação', async () => {
    semMfa();
    api.on('POST', '/api/v1/auth/password-confirm', 'identityPasswordConfirm', { status: 204 });
    api.on('POST', '/api/v1/auth/mfa/activate/start', 'identityMfaActivationStart', { status: 200, body: { otpauthUri: OTPAUTH } });
    api.on('POST', '/api/v1/auth/mfa/activate/confirm', 'identityMfaActivationConfirm', {
      status: 200,
      body: { recoveryCodes: Array.from({ length: 10 }, (_, i) => `ABCD-EFGH-IJKL-MN${String(i).padStart(2, '0')}`), csrfToken: 'id-csrf-nova', restricted: false },
    });
    renderApp('/conta');
    expect(await screen.findByText(/Desativada/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Códigos de recuperação' })).not.toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Ativar autenticação em duas etapas' }));
    expect(location()).toBe('/conta/ativar-autenticacao');
    await user().click(await screen.findByRole('button', { name: 'Começar' }));
    const dialog = await screen.findByRole('alertdialog');
    await user().type(within(dialog).getByLabelText(lbl('Sua senha')), PASSWORD);
    await user().click(within(dialog).getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByLabelText('QR Code para configurar o aplicativo autenticador')).toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/auth/password-confirm')).toHaveLength(1);
    await user().click(screen.getByRole('button', { name: 'Já adicionei a conta' }));
    fireEvent.change(screen.getByLabelText(/Código do aplicativo autenticador/), { target: { value: '123456' } });
    await user().click(screen.getByRole('button', { name: 'Ativar' }));
    expect(await screen.findByText('Guarde estes códigos agora.')).toBeInTheDocument();
    expect(screen.queryByText(/Os códigos anteriores deixaram de valer/)).not.toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/auth/mfa/activate/confirm')[0]).toMatchObject({ csrf: 'id-csrf', body: { code: '123456' } });
    expect(csrfStore.identitySession()).toBe('id-csrf-nova');
    expect(stepUpMethods.get()).toBe('totp');
  });

  it('código errado na ativação: pede de novo, sem códigos na tela', async () => {
    semMfa();
    api.on('POST', '/api/v1/auth/password-confirm', 'identityPasswordConfirm', { status: 204 });
    api.on('POST', '/api/v1/auth/mfa/activate/start', 'identityMfaActivationStart', { status: 200, body: { otpauthUri: OTPAUTH } });
    api.on('POST', '/api/v1/auth/mfa/activate/confirm', 'identityMfaActivationConfirm', { status: 403, body: { error: 'forbidden' } });
    renderApp('/conta/ativar-autenticacao');
    await user().click(await screen.findByRole('button', { name: 'Começar' }));
    const dialog = await screen.findByRole('alertdialog');
    await user().type(within(dialog).getByLabelText(lbl('Sua senha')), PASSWORD);
    await user().click(within(dialog).getByRole('button', { name: 'Continuar' }));
    await user().click(await screen.findByRole('button', { name: 'Já adicionei a conta' }));
    // 6 dígitos completos já confirmam (onComplete), como na troca do autenticador
    fireEvent.change(screen.getByLabelText(/Código do aplicativo autenticador/), { target: { value: '000000' } });
    expect(await screen.findByText(INVALID_CODE)).toBeInTheDocument();
    expect(screen.queryByText('Guarde estes códigos agora.')).not.toBeInTheDocument();
  });
});

describe('conta já protegida', () => {
  it('com MFA: Segurança da conta não oferece ativação e a criação continua pedindo o código', async () => {
    comMfa();
    renderApp('/conta');
    expect(await screen.findByText(/autenticação em duas etapas está ativa/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ativar autenticação em duas etapas' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Códigos de recuperação' })).toBeInTheDocument();
  });

  it('com MFA, o diálogo de criação pede o código do autenticador (nunca a senha)', async () => {
    comMfa();
    renderApp('/organizacoes/nova');
    await user().type(await screen.findByLabelText(lbl('Nome da organização')), 'Acme');
    await user().click(screen.getByRole('button', { name: 'Continuar' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(lbl('Sua senha'))).not.toBeInTheDocument();
  });
});

describe('sessão de organização sem autenticação em duas etapas', () => {
  it('o step-up da organização vira reconfirmação da senha NA sessão da organização, conforme /me informou', async () => {
    api.on('GET', `/api/v1/o/${ORG_A}/me`, 'getMe', {
      status: 200,
      body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG_A, organizationActivationState: 'ATIVADA', stepUpMethod: 'password' },
    });
    api.on('GET', `/api/v1/o/${ORG_A}/auth/csrf`, 'getSessionCsrf', { status: 200, body: { csrfToken: 'org-csrf' } });
    api.on('POST', `/api/v1/o/${ORG_A}/auth/password-confirm`, 'orgPasswordConfirm', { status: 204 });
    await me(ORG_A);
    expect(stepUpMethods.get(ORG_A)).toBe('password');
    expect(stepUpMethods.get()).toBe('totp'); // a identidade não herda o método da organização
    await stepUp(ORG_A, PASSWORD);
    expect(api.sent('POST', `/api/v1/o/${ORG_A}/auth/password-confirm`)[0]).toMatchObject({ csrf: 'org-csrf', body: { password: PASSWORD } });
    expect(api.sent('POST', `/api/v1/o/${ORG_A}/auth/mfa/step-up`)).toEqual([]);
  });
});
