import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../api/csrf';
import { stepUpMethods } from '../api/stepUpMethod';
import { sessionMemory } from '../app/notices';
import { onboarding } from '../auth/onboarding';
import { resetLinkTokenCapture } from '../auth/linkToken';
import { lbl, location, openLink, user } from '../test/helpers';
import { renderApp } from '../test/render';
import { RouteApi } from '../test/routeApi';

/**
 * Verificação em duas etapas OPCIONAL (API 029), oferecida na primeira entrada depois do cadastro: a configuração é o
 * foco da tela; seguir sem ela é possível e menos destacado. Fora desse momento, a entrada vai direto às organizações.
 */
const TOKEN = 'A'.repeat(43);
const PASSWORD = 'senha-muito-segura-123';

let api: RouteApi;
beforeEach(() => {
  csrfStore.clear();
  stepUpMethods.clear();
  sessionMemory.reset();
  resetLinkTokenCapture();
  onboarding.takeSignupCompleted();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  api = new RouteApi().install();
  api.on('GET', '/api/v1/csrf', 'getPreAuthCsrf', { status: 200, body: { csrfToken: 'pre' } });
  api.on('POST', '/api/v1/auth/login', 'identityLogin', { status: 200, body: { status: 'authenticated', csrfToken: 'id-csrf' } });
  api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', { status: 200, body: { organizations: [], canCreateOrganization: true } });
});

// `aposLogin`: como a API, sem sessão (401) até a entrada — a tela de entrada confere a sessão ao abrir
const sessao = (mfaEnabled: boolean, aposLogin = true) =>
  api.on('GET', '/api/v1/me/session', 'identitySessionState', () =>
    aposLogin && api.sent('POST', '/api/v1/auth/login').length === 0
      ? { status: 401, body: { error: 'unauthenticated' } }
      : { status: 200, body: { restricted: false, csrfToken: 'id-csrf', mfaEnabled, stepUpMethod: mfaEnabled ? 'totp' : 'password' } },
  );

async function cadastrarEEntrar() {
  api.on('POST', '/api/v1/signup/confirm', 'confirmSignup', { status: 204 });
  openLink('/cadastro/confirmar', TOKEN);
  renderApp('/cadastro/confirmar');
  await screen.findByRole('heading', { name: 'Conclua seu cadastro' });
  await user().type(screen.getByLabelText(lbl('Nome')), 'Ana');
  await user().type(screen.getByLabelText(lbl('Senha')), PASSWORD);
  await user().type(screen.getByLabelText(lbl('Confirmar senha')), PASSWORD);
  await user().click(screen.getByRole('button', { name: 'Concluir cadastro' }));
  await screen.findByRole('heading', { name: 'Cadastro concluído' });
  expect(screen.getByText(/vamos sugerir ativar a verificação em duas etapas/)).toBeInTheDocument();
  await user().click(screen.getByRole('button', { name: 'Entrar' }));
  await user().type(await screen.findByLabelText(lbl('E-mail')), 'ana@empresa.com');
  await user().type(screen.getByLabelText(lbl('Senha')), PASSWORD);
  await user().click(screen.getByRole('button', { name: 'Entrar' }));
}

describe('primeira entrada depois do cadastro', () => {
  it('mostra "Proteja sua conta" com a configuração em destaque e "seguir sem" discreto', async () => {
    sessao(false);
    await cadastrarEEntrar();
    expect(await screen.findByRole('heading', { name: 'Proteja sua conta' })).toBeInTheDocument();
    expect(location()).toBe('/conta/proteger');
    const configurar = screen.getByRole('button', { name: 'Configurar verificação em duas etapas' });
    const seguir = screen.getByRole('button', { name: 'Seguir sem a verificação em duas etapas' });
    expect(configurar.className).not.toBe(seguir.className); // ações com pesos visuais diferentes
    expect(configurar.className).toMatch(/lg/);
    expect(seguir.className).toMatch(/ghost/);
    expect(api.sent('GET', '/api/v1/me/organizations')).toEqual([]);
  });

  it('"Configurar" leva à ativação (que começa pela senha); nada é ativado sem o código', async () => {
    sessao(false);
    await cadastrarEEntrar();
    await user().click(await screen.findByRole('button', { name: 'Configurar verificação em duas etapas' }));
    await waitFor(() => expect(location()).toBe('/conta/ativar-autenticacao'));
    expect(await screen.findByRole('heading', { name: 'Ativar autenticação em duas etapas' })).toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/auth/mfa/activate/confirm')).toEqual([]);
  });

  it('"Seguir sem" vai às organizações; a oferta não volta numa próxima entrada', async () => {
    sessao(false);
    await cadastrarEEntrar();
    await user().click(await screen.findByRole('button', { name: 'Seguir sem a verificação em duas etapas' }));
    expect(await screen.findByRole('button', { name: 'Criar minha primeira organização' })).toBeInTheDocument();
    expect(location()).toBe('/organizacoes');
    expect(onboarding.takeSignupCompleted()).toBe(false);
  });
});

describe('fora do cadastro', () => {
  it('entrada comum sem o fator vai direto às organizações (a oferta é só depois do cadastro)', async () => {
    sessao(false);
    renderApp('/entrar');
    await user().type(screen.getByLabelText(lbl('E-mail')), 'ana@empresa.com');
    await user().type(screen.getByLabelText(lbl('Senha')), PASSWORD);
    await user().click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('button', { name: 'Criar minha primeira organização' })).toBeInTheDocument();
    expect(location()).toBe('/organizacoes');
  });

  it('conta que já tem o fator não vê a oferta, mesmo abrindo o endereço', async () => {
    sessao(true, false);
    renderApp('/conta/proteger');
    await waitFor(() => expect(location()).toBe('/organizacoes'));
    expect(screen.queryByRole('heading', { name: 'Proteja sua conta' })).not.toBeInTheDocument();
  });
});
