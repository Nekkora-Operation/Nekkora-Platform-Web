import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';
import { resetLinkTokenCapture } from '../auth/linkToken';
import { lbl, location, openLink, user } from '../test/helpers';
import { renderApp } from '../test/render';
import { RouteApi } from '../test/routeApi';

/**
 * M1 — testes de COMPONENTE (isolados): respostas por rota conferidas contra o contrato. O comportamento real está nos
 * E2E contra a API do laboratório (e2e-real/m1-identidade.spec.ts).
 */
const ORG_A = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const TOKEN = 'A'.repeat(43);
const PASSWORD = 'senha-muito-segura-123';

let api: RouteApi;
beforeEach(() => {
  csrfStore.clear();
  sessionMemory.reset();
  resetLinkTokenCapture();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  api = new RouteApi().install();
  api.on('GET', '/api/v1/csrf', 'getPreAuthCsrf', { status: 200, body: { csrfToken: 'pre' } });
});

const session = (restricted = false) =>
  api.on('GET', '/api/v1/me/session', 'identitySessionState', { status: 200, body: { restricted, csrfToken: 'id-csrf' } });

describe('cadastro', () => {
  it('cadastro desligado (404) aparece como indisponível, nunca como criação nem erro de credencial', async () => {
    api.on('POST', '/api/v1/signup', 'signup', { status: 404, body: { error: 'not_found' } });
    renderApp('/cadastro');
    await user().type(screen.getByLabelText(lbl('E-mail')), 'nova@empresa.com');
    await user().click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText(/O cadastro não está disponível no momento/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Confira seu e-mail' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  });

  it('o pedido leva SÓ o e-mail e a tela depois do 202 é a mesma para qualquer endereço', async () => {
    api.on('POST', '/api/v1/signup', 'signup', { status: 202 });
    const texts: string[] = [];
    for (const email of ['nova@empresa.com', 'ja-cadastrada@empresa.com']) {
      const view = renderApp('/cadastro');
      await user().type(screen.getByLabelText(lbl('E-mail')), email);
      await user().click(screen.getByRole('button', { name: 'Continuar' }));
      await screen.findByRole('heading', { name: 'Confira seu e-mail' });
      texts.push(screen.getByRole('main').textContent ?? '');
      view.unmount();
    }
    expect(texts[0]).toBe(texts[1]);
    expect(api.sent('POST', '/api/v1/signup').map((c) => Object.keys(c.body as object))).toEqual([['email'], ['email']]);
  });

  it('abrir o link não consome o token: ele sai da URL e só é enviado ao concluir; 400 vira "link inválido" com reenvio', async () => {
    api.on('POST', '/api/v1/signup/confirm', 'confirmSignup', { status: 400, body: { error: 'invalid_request' } });
    api.on('POST', '/api/v1/signup/confirmation/resend', 'resendSignupConfirmation', { status: 202 });
    openLink('/cadastro/confirmar', TOKEN);
    expect(window.location.hash).toBe('');
    renderApp('/cadastro/confirmar');
    await screen.findByRole('heading', { name: 'Conclua seu cadastro' });
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([]);

    await user().type(screen.getByLabelText(lbl('Nome')), 'Ana');
    await user().type(screen.getByLabelText(lbl('Senha')), PASSWORD);
    await user().type(screen.getByLabelText(lbl('Confirmar senha')), PASSWORD);
    await user().click(screen.getByRole('button', { name: 'Concluir cadastro' }));
    expect(await screen.findByRole('heading', { name: 'Este link não é mais válido' })).toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/signup/confirm')[0].body).toEqual({ token: TOKEN, password: PASSWORD, displayName: 'Ana' });

    await user().type(screen.getByLabelText(lbl('E-mail do cadastro')), 'ana@empresa.com');
    await user().click(screen.getByRole('button', { name: 'Enviar nova mensagem' }));
    expect(await screen.findByText(/Pedido recebido/)).toBeInTheDocument();
  });

  it('senha fora da política não é enviada', async () => {
    openLink('/cadastro/confirmar', TOKEN);
    renderApp('/cadastro/confirmar');
    await user().type(await screen.findByLabelText(lbl('Nome')), 'Ana');
    await user().type(screen.getByLabelText(lbl('Senha')), 'curta');
    await user().type(screen.getByLabelText(lbl('Confirmar senha')), 'curta');
    await user().click(screen.getByRole('button', { name: 'Concluir cadastro' }));
    expect(await screen.findByText(/A senha precisa ter entre 12 e 128 caracteres/)).toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/signup/confirm')).toEqual([]);
  });
});

describe('entrada geral', () => {
  it('entrada desligada (404) não vira "e-mail ou senha incorretos"', async () => {
    api.on('POST', '/api/v1/auth/login', 'identityLogin', { status: 404, body: { error: 'not_found' } });
    renderApp('/entrar');
    await user().type(screen.getByLabelText(lbl('E-mail')), 'ana@empresa.com');
    await user().type(screen.getByLabelText(lbl('Senha')), PASSWORD);
    await user().click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText(/Este acesso não está disponível no momento/)).toBeInTheDocument();
    expect(screen.queryByText('E-mail ou senha incorretos.')).not.toBeInTheDocument();
  });

  it('código de recuperação → sessão restrita: só a troca do fator; organizações não são consultadas', async () => {
    api.on('POST', '/api/v1/auth/login', 'identityLogin', { status: 200, body: { status: 'mfa_required', csrfToken: 'desafio' } });
    api.on('POST', '/api/v1/auth/mfa/verify', 'identityVerifyMfa', { status: 200, body: { csrfToken: 'id-csrf', restricted: true } });
    session(true);
    renderApp('/entrar');
    await user().type(screen.getByLabelText(lbl('E-mail')), 'ana@empresa.com');
    await user().type(screen.getByLabelText(lbl('Senha')), PASSWORD);
    await user().click(screen.getByRole('button', { name: 'Entrar' }));
    await user().click(await screen.findByRole('button', { name: 'Usar código de recuperação' }));
    await user().type(screen.getByLabelText(lbl('Código de recuperação')), 'ABCDEFGHIJKLMNOP');
    await user().click(screen.getByRole('button', { name: 'Usar código de recuperação' }));
    expect(await screen.findByText('Você entrou com um código de recuperação.')).toBeInTheDocument();
    expect(location()).toBe('/conta/fator');
    expect(api.sent('POST', '/api/v1/auth/mfa/verify')[0]).toMatchObject({ csrf: 'desafio', body: { recoveryCode: 'ABCD-EFGH-IJKL-MNOP' } });
    expect(api.sent('GET', '/api/v1/me/organizations')).toEqual([]);
    // navegação direta para outra tela da identidade volta à troca do fator
    expect(screen.queryByRole('link', { name: 'Organizações' })).not.toBeInTheDocument();
  });
});

describe('organizações', () => {
  it('falha da consulta não é lista vazia', async () => {
    session();
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', { status: 503, body: { error: 'service_unavailable' }, headers: { 'Retry-After': '5' } });
    renderApp('/organizacoes');
    expect(await screen.findByText('Serviço temporariamente indisponível.')).toBeInTheDocument();
    expect(screen.queryByText('Você ainda não participa de nenhuma organização.')).not.toBeInTheDocument();
  });

  it('lista vazia legítima, aguardando ativação e "sem_acesso" genérico na troca', async () => {
    session();
    let joined = false; // a lista muda quando a pessoa é admitida (StrictMode lê duas vezes na montagem)
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', () =>
      !joined
        ? { status: 200, body: { organizations: [], canCreateOrganization: false } }
        : {
            status: 200,
            body: {
              organizations: [{ organizationId: ORG_A, name: 'Acme', roles: ['ORG_ADMIN'], activationState: 'AGUARDANDO_ATIVACAO' }],
              canCreateOrganization: true,
            },
          },
    );
    api.on('POST', '/api/v1/sessions/organization', 'exchangeOrganizationSession', { status: 200, body: { status: 'sem_acesso' } });
    renderApp('/organizacoes');
    expect(await screen.findByText('Você ainda não participa de nenhuma organização.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Criar organização' })).not.toBeInTheDocument();

    joined = true;
    await user().click(screen.getByRole('button', { name: 'Atualizar lista' }));
    const card = (await screen.findByRole('heading', { name: 'Acme' })).closest('li')!;
    expect(within(card).getByText('Aguardando ativação')).toBeInTheDocument();
    expect(within(card).getByText(/nenhuma automação executa até a ativação/)).toBeInTheDocument();
    await user().click(within(card).getByRole('button', { name: 'Entrar em Acme' }));
    expect(await within(card).findByText(/Não foi possível entrar nesta organização/)).toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/sessions/organization')[0]).toMatchObject({ csrf: 'id-csrf', body: { organizationId: ORG_A } });
    expect(location()).toBe('/organizacoes');
  });

  it('criação: resultado desconhecido não é repetido e orienta a conferir a lista', async () => {
    session();
    api.on('POST', '/api/v1/auth/step-up', 'identityStepUp', { status: 204 });
    api.on('POST', '/api/v1/organizations', 'identityCreateOrganization', 'network');
    renderApp('/organizacoes/nova');
    await user().type(await screen.findByLabelText(lbl('Nome da organização')), 'Acme');
    await user().click(screen.getByRole('button', { name: 'Continuar' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/), { target: { value: '123456' } });
    await user().click(within(dialog).getByRole('button', { name: 'Criar organização' }));
    expect(await within(dialog).findByText(/A organização pode ter sido criada/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Criar organização' })).toBeDisabled();
    expect(api.sent('POST', '/api/v1/organizations')).toHaveLength(1);
    await user().click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByText('Não foi possível confirmar se a organização foi criada.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  });

  it.each([502, 503, 504] as const)('criação: %i do proxy sem corpo da API é resultado desconhecido, nunca "nada foi criado"', async (gateway) => {
    session();
    api.on('POST', '/api/v1/auth/step-up', 'identityStepUp', { status: 204 });
    api.on('POST', '/api/v1/organizations', 'identityCreateOrganization', { gateway });
    renderApp('/organizacoes/nova');
    await user().type(await screen.findByLabelText(lbl('Nome da organização')), 'Acme');
    await user().click(screen.getByRole('button', { name: 'Continuar' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/), { target: { value: '123456' } });
    await user().click(within(dialog).getByRole('button', { name: 'Criar organização' }));
    expect(await within(dialog).findByText(/A organização pode ter sido criada/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Nada foi criado/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Criar organização' })).toBeDisabled();
    expect(api.sent('POST', '/api/v1/organizations')).toHaveLength(1);
  });

  it('criação: step-up recusado não envia a criação', async () => {
    session();
    api.on('POST', '/api/v1/auth/step-up', 'identityStepUp', { status: 403, body: { error: 'forbidden' } });
    api.on('POST', '/api/v1/organizations', 'identityCreateOrganization', { status: 201, body: { organizationId: ORG_A } });
    renderApp('/organizacoes/nova');
    await user().type(await screen.findByLabelText(lbl('Nome da organização')), 'Acme');
    await user().click(screen.getByRole('button', { name: 'Continuar' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/), { target: { value: '123456' } });
    await user().click(within(dialog).getByRole('button', { name: 'Criar organização' }));
    expect(await within(dialog).findByText(/Não foi possível confirmar sua identidade com este código/)).toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/organizations')).toEqual([]);
  });

  it('nome fora da regra do contrato não abre a confirmação', async () => {
    session();
    renderApp('/organizacoes/nova');
    await user().type(await screen.findByLabelText(lbl('Nome da organização')), ' Acme');
    await user().click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('Retire os espaços do começo e do fim.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('vinculação de conta antiga', () => {
  it('resultado desconhecido da vinculação: aviso fica na tela depois de fechar e "Vincular" não volta a ser oferecido', async () => {
    session();
    api.on('POST', '/api/v1/links/start', 'identityLinkStart', { status: 204 });
    api.on('POST', '/api/v1/auth/step-up', 'identityStepUp', { status: 204 });
    api.on('POST', '/api/v1/links/confirm', 'identityLinkConfirm', { gateway: 504 });
    renderApp('/vincular-conta');
    await user().type(await screen.findByLabelText(lbl('Identificador da organização')), ORG_A);
    await user().type(screen.getByLabelText(lbl('Senha da conta antiga')), PASSWORD);
    fireEvent.change(screen.getByLabelText(/Código do autenticador da conta antiga/), { target: { value: '123456' } });
    await user().click(screen.getByRole('button', { name: 'Conferir conta antiga' }));
    await user().click(await screen.findByRole('button', { name: 'Vincular à minha identidade' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/), { target: { value: '654321' } });
    await user().click(within(dialog).getByRole('button', { name: 'Vincular' }));
    expect(await within(dialog).findByText(/A conta pode ter sido vinculada/)).toBeInTheDocument();
    await user().click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByText('Não foi possível confirmar se a conta foi vinculada.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vincular à minha identidade' })).toBeDisabled();
    expect(api.sent('POST', '/api/v1/links/confirm')).toHaveLength(1);
  });
});

describe('saída', () => {
  it('saída sem confirmação do servidor avisa que a sessão pode continuar; com 204, "Você saiu"', async () => {
    session();
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', { status: 200, body: { organizations: [], canCreateOrganization: false } });
    api.on('POST', '/api/v1/auth/logout', 'identityLogout', 'network');
    const view = renderApp('/organizacoes');
    await screen.findByText('Você ainda não participa de nenhuma organização.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Sair' })[0]);
    expect(await screen.findByText(/não foi possível confirmar o fim da sessão no servidor/)).toBeInTheDocument();
    expect(screen.queryByText('Você saiu da sua conta.')).not.toBeInTheDocument();
    view.unmount();

    api.on('POST', '/api/v1/auth/logout', 'identityLogout', { status: 204 });
    window.history.replaceState(null, '', '/');
    renderApp('/organizacoes');
    await screen.findByText('Você ainda não participa de nenhuma organização.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Sair' })[0]);
    expect(await screen.findByText('Você saiu da sua conta.')).toBeInTheDocument();
  });
});

describe('outra aba', () => {
  it('entrar numa organização em outra aba não tira esta da área de identidade; identidade nova ou saída tira', async () => {
    session();
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', { status: 200, body: { organizations: [], canCreateOrganization: false } });
    renderApp('/organizacoes');
    expect(await screen.findByText('Você ainda não participa de nenhuma organização.')).toBeInTheDocument();
    await waitFor(() => expect(csrfStore.identitySession()).toBe('id-csrf'));
    const otherTab = new BroadcastChannel('nekkora-sessao');
    otherTab.postMessage({ tipo: 'sessao-alterada', alcance: 'organizacao' });
    await new Promise((r) => setTimeout(r, 50));
    expect(location()).toBe('/organizacoes');
    expect(csrfStore.identitySession()).toBe('id-csrf');
    otherTab.postMessage({ tipo: 'sessao-alterada' });
    await waitFor(() => expect(location()).toBe('/entrar'));
    expect(csrfStore.identitySession()).toBeUndefined();
    otherTab.close();
  });
});

describe('sessão de organização nascida da identidade', () => {
  it('401 na área da organização com identidade válida leva à reentrada explícita (sem troca automática)', async () => {
    session();
    api.on('GET', `/api/v1/o/${ORG_A}/me`, 'getMe', { status: 401, body: { error: 'unauthenticated' } });
    renderApp(`/o/${ORG_A}`);
    expect(await screen.findByRole('heading', { name: 'Entrar na organização' })).toBeInTheDocument();
    expect(location()).toBe(`/o/${ORG_A}/entrar`);
    expect(api.sent('POST', '/api/v1/sessions/organization')).toEqual([]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Entrar nesta organização' })).toBeInTheDocument());
  });

  it('sem sessão de identidade, a reentrada oferece a entrada geral e a conta antiga da organização', async () => {
    api.on('GET', '/api/v1/me/session', 'identitySessionState', { status: 401, body: { error: 'unauthenticated' } });
    renderApp(`/o/${ORG_A}/entrar`);
    expect(await screen.findByRole('button', { name: 'Entrar com a identidade Nekkora' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Entrar com uma conta antiga desta organização' })).toHaveAttribute('href', `/o/${ORG_A}/login`);
  });
});
