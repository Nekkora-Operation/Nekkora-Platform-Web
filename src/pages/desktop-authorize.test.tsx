import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { csrfStore } from '../api/csrf';
import { loopbackReturn, parseDesktopRequest } from '../api/desktop';
import { stepUpMethods } from '../api/stepUpMethod';
import { sessionMemory } from '../app/notices';
import { clearDesktopPending, desktopPending, leave, markDesktopPending } from '../desktop/pending';
import { lbl, location, user } from '../test/helpers';
import { renderApp } from '../test/render';
import { RouteApi } from '../test/routeApi';

/**
 * AGENT-CLIENT-LOGIN-001 (T03): entrada no aplicativo desktop pelo navegador. Respostas por rota conferidas contra o
 * contrato (teste ISOLADO de componente). A prova com a API real fica no E2E do laboratório.
 */
const STATE = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'http://127.0.0.1:49152/callback';
const QUERY =
  `?response_type=code&client_id=nekkora-agent-client&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&state=${STATE}&code_challenge=${CHALLENGE}&code_challenge_method=S256&scope=identity`;
const RETURN = `${REDIRECT}?code=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&state=${STATE}&iss=https%3A%2F%2Fplatform.example`;
const DENIED = `${REDIRECT}?error=access_denied&state=${STATE}&iss=https%3A%2F%2Fplatform.example`;

let api: RouteApi;
let left: MockInstance<(url: string) => void>;

beforeEach(() => {
  csrfStore.clear();
  stepUpMethods.clear();
  sessionMemory.reset();
  clearDesktopPending();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  left = vi.spyOn(leave, 'to').mockImplementation(() => undefined);
  api = new RouteApi().install();
  api.on('GET', '/api/v1/csrf', 'getPreAuthCsrf', { status: 200, body: { csrfToken: 'pre' } });
});

const sessao = () =>
  api.on('GET', '/api/v1/me/session', 'identitySessionState', {
    status: 200,
    body: { restricted: false, csrfToken: 'id-csrf', mfaEnabled: false, stepUpMethod: 'password' },
  });
const pedidoAceito = () => api.on('POST', '/api/v1/desktop/authorizations', 'desktopAuthorizationStart', { status: 204 });
const pedidoVivo = (email = 'ana@empresa.com', scope: 'identity' | 'identity navigation' = 'identity') =>
  api.on('GET', '/api/v1/desktop/authorization', 'desktopAuthorizationPending', {
    status: 200,
    body: { application: 'Nekkora Agent', account: { email }, scope },
  });

describe('o que o aplicativo pediu (AGENT-CLIENT-NAVEGACAO-001)', () => {
  it('escopo de navegação: a página diz o que o aplicativo poderá ver, pelo que a API guardou', async () => {
    pedidoAceito();
    pedidoVivo('ana@empresa.com', 'identity navigation');
    sessao();
    renderApp(`/entrar/aplicativo${QUERY.replace('scope=identity', 'scope=identity%20navigation')}`);
    expect(await screen.findByTestId('desktop-account')).toHaveTextContent('ana@empresa.com');
    const texto = screen.getByTestId('desktop-scope');
    expect(texto).toHaveTextContent('as organizações de que você participa');
    expect(texto).toHaveTextContent('ambientes e automações a que você tem acesso');
    expect(texto).toHaveTextContent('renomear automações onde você já tem essa permissão');
    expect(texto).toHaveTextContent('Ele não recebe nenhuma permissão nova');
    expect(screen.getByText(/A organização é escolhida depois, no próprio aplicativo/)).toBeInTheDocument();
    // o pedido foi entregue à API com o escopo que veio do aplicativo, sem alteração
    expect(api.sent('POST', '/api/v1/desktop/authorizations')[0].body).toMatchObject({ scope: 'identity navigation' });
    // e continua exigindo o clique
    expect(api.sent('POST', '/api/v1/desktop/authorization/approve')).toHaveLength(0);
  });

  it('escopo só de identidade: nada sobre organizações é prometido', async () => {
    pedidoAceito();
    pedidoVivo();
    sessao();
    renderApp(`/entrar/aplicativo${QUERY}`);
    expect(await screen.findByTestId('desktop-account')).toHaveTextContent('ana@empresa.com');
    expect(screen.queryByTestId('desktop-scope')).toBeNull();
    expect(screen.getByText(/Nenhuma organização é escolhida agora/)).toBeInTheDocument();
  });

  it('o texto vem do que a API devolve, não do que está na URL', async () => {
    pedidoAceito();
    pedidoVivo('ana@empresa.com', 'identity'); // a API guardou só identidade
    sessao();
    renderApp(`/entrar/aplicativo${QUERY.replace('scope=identity', 'scope=identity%20navigation')}`);
    expect(await screen.findByTestId('desktop-account')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-scope')).toBeNull();
  });
});

describe('pedido do aplicativo', () => {
  it('entrega o pedido à API uma única vez, com os nomes do contrato e o CSRF de pré-autenticação', async () => {
    pedidoAceito();
    pedidoVivo();
    sessao();
    renderApp(`/entrar/aplicativo${QUERY}`);
    expect(await screen.findByTestId('desktop-account')).toHaveTextContent('ana@empresa.com');
    const enviados = api.sent('POST', '/api/v1/desktop/authorizations');
    expect(enviados).toHaveLength(1); // o modo estrito repete o efeito; o pedido, não
    expect(enviados[0].csrf).toBe('pre');
    expect(enviados[0].body).toEqual({
      responseType: 'code',
      clientId: 'nekkora-agent-client',
      redirectUri: REDIRECT,
      state: STATE,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      scope: 'identity',
    });
    expect(location()).toBe('/entrar/aplicativo');
    expect(desktopPending()).toBe(true);
  });

  it('com sessão já aberta, mostra a conta e NÃO autoriza sozinho', async () => {
    pedidoAceito();
    pedidoVivo('bia@empresa.com');
    sessao();
    renderApp(`/entrar/aplicativo${QUERY}`);
    expect(await screen.findByRole('heading', { name: 'Entrar no Nekkora Agent' })).toBeInTheDocument();
    expect(screen.getByTestId('desktop-account')).toHaveTextContent('bia@empresa.com');
    expect(screen.getByRole('button', { name: 'Autorizar entrada' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Usar outra conta' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeEnabled();
    expect(api.sent('POST', '/api/v1/desktop/authorization/approve')).toEqual([]);
    expect(left).not.toHaveBeenCalled();
  });

  it.each([
    ['parâmetro repetido', `${QUERY}&state=${STATE}`],
    ['parâmetro a mais', `${QUERY}&returnUrl=https%3A%2F%2Fexemplo.test`],
    ['parâmetro faltando', QUERY.replace('&code_challenge_method=S256', '')],
    ['parâmetro vazio', QUERY.replace(`state=${STATE}`, 'state=')],
  ])('%s: não é um pedido, nada é enviado', async (_nome, query) => {
    renderApp(`/entrar/aplicativo${query}`);
    expect(await screen.findByText(/Não foi possível reconhecer este pedido de entrada/)).toBeInTheDocument();
    expect(api.sent('POST', '/api/v1/desktop/authorizations')).toEqual([]);
    expect(location()).toBe('/entrar/aplicativo');
    expect(desktopPending()).toBe(false);
  });

  it('pedido recusado pela API (400) ou entrada desligada (404): mensagem própria, sem marca de entrada em andamento', async () => {
    api.on('POST', '/api/v1/desktop/authorizations', 'desktopAuthorizationStart', { status: 400, body: { error: 'invalid_request' } });
    const { unmount } = renderApp(`/entrar/aplicativo${QUERY}`);
    expect(await screen.findByText(/Não foi possível reconhecer este pedido de entrada/)).toBeInTheDocument();
    expect(desktopPending()).toBe(false);
    unmount();
    api.on('POST', '/api/v1/desktop/authorizations', 'desktopAuthorizationStart', { status: 404, body: { error: 'not_found' } });
    renderApp(`/entrar/aplicativo${QUERY.replace(STATE, `${STATE}x`)}`);
    expect(await screen.findByText('A entrada pelo aplicativo não está disponível no momento.')).toBeInTheDocument();
    expect(desktopPending()).toBe(false);
  });
});

describe('login antes da confirmação', () => {
  it('sem sessão: vai ao login normal e, depois dele, volta para a confirmação da conta (não para as organizações)', async () => {
    pedidoAceito();
    let logado = false;
    api.on('GET', '/api/v1/desktop/authorization', 'desktopAuthorizationPending', () =>
      logado ? { status: 200, body: { application: 'Nekkora Agent', account: { email: 'ana@empresa.com' }, scope: 'identity' } } : { status: 401, body: { error: 'unauthenticated' } },
    );
    api.on('POST', '/api/v1/auth/login', 'identityLogin', () => {
      logado = true;
      return { status: 200, body: { status: 'authenticated', csrfToken: 'id-csrf' } };
    });
    renderApp(`/entrar/aplicativo${QUERY}`);
    expect(await screen.findByText(/Você está entrando no aplicativo Nekkora Agent/)).toBeInTheDocument();
    expect(location()).toBe('/entrar');
    await user().type(screen.getByLabelText(lbl('E-mail')), 'ana@empresa.com');
    await user().type(screen.getByLabelText(lbl('Senha')), 'senha-muito-segura-123');
    await user().click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByTestId('desktop-account')).toHaveTextContent('ana@empresa.com');
    expect(location()).toBe('/entrar/aplicativo');
    expect(api.sent('POST', '/api/v1/desktop/authorizations')).toHaveLength(1); // o login não reenvia o pedido
    expect(api.sent('GET', '/api/v1/me/organizations')).toEqual([]);
    expect(left).not.toHaveBeenCalled();
  });

  it('sem entrada do aplicativo em andamento, o login continua indo para as organizações', async () => {
    api.on('POST', '/api/v1/auth/login', 'identityLogin', { status: 200, body: { status: 'authenticated', csrfToken: 'id-csrf' } });
    sessao();
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', { status: 200, body: { organizations: [], canCreateOrganization: true } });
    renderApp('/entrar');
    expect(screen.queryByText(/Você está entrando no aplicativo/)).not.toBeInTheDocument();
    await user().type(screen.getByLabelText(lbl('E-mail')), 'ana@empresa.com');
    await user().type(screen.getByLabelText(lbl('Senha')), 'senha-muito-segura-123');
    await user().click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(location()).toBe('/organizacoes'));
  });
});

describe('decisão da pessoa', () => {
  const pronta = async () => {
    pedidoVivo();
    sessao();
    markDesktopPending();
    renderApp('/entrar/aplicativo');
    await screen.findByTestId('desktop-account');
  };

  it('autorizar: um envio, com o CSRF da sessão, e a saída para o retorno local do aplicativo', async () => {
    await pronta();
    api.on('POST', '/api/v1/desktop/authorization/approve', 'desktopAuthorizationApprove', { status: 200, body: { redirectTo: RETURN } });
    const botao = screen.getByRole('button', { name: 'Autorizar entrada' });
    await user().click(botao);
    await user().click(botao).catch(() => undefined);
    await waitFor(() => expect(left).toHaveBeenCalledWith(RETURN));
    expect(left).toHaveBeenCalledTimes(1);
    const enviados = api.sent('POST', '/api/v1/desktop/authorization/approve');
    expect(enviados).toHaveLength(1);
    expect(enviados[0].csrf).toBe('id-csrf');
    expect(enviados[0].body).toBeUndefined(); // nada do pedido é reenviado pelo navegador
    expect(desktopPending()).toBe(false);
  });

  it('cancelar: avisa a API e sai para o retorno local com a recusa', async () => {
    await pronta();
    api.on('POST', '/api/v1/desktop/authorization/deny', 'desktopAuthorizationDeny', { status: 200, body: { redirectTo: DENIED } });
    await user().click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(left).toHaveBeenCalledWith(DENIED));
    expect(api.sent('POST', '/api/v1/desktop/authorization/deny')[0].csrf).toBe('pre');
    expect(api.sent('POST', '/api/v1/desktop/authorization/approve')).toEqual([]);
    expect(desktopPending()).toBe(false);
  });

  it('usar outra conta: sai desta conta e volta ao login, com a entrada do aplicativo ainda em andamento', async () => {
    await pronta();
    api.on('POST', '/api/v1/auth/logout', 'identityLogout', { status: 204 });
    await user().click(screen.getByRole('button', { name: 'Usar outra conta' }));
    await waitFor(() => expect(location()).toBe('/entrar'));
    expect(api.sent('POST', '/api/v1/auth/logout')).toHaveLength(1);
    expect(api.sent('POST', '/api/v1/desktop/authorization/approve')).toEqual([]);
    expect(desktopPending()).toBe(true);
    expect(left).not.toHaveBeenCalled();
  });

  it.each([
    ['outro site', 'https://exemplo.test/callback?code=x&state=y'],
    ['localhost', `http://localhost:49152/callback?code=x&state=${STATE}`],
    ['outro caminho', `http://127.0.0.1:49152/outro?code=x&state=${STATE}`],
    ['host parecido', `http://127.0.0.1.exemplo.test:49152/callback?code=x`],
    ['esquema de script', 'javascript:alert(1)'],
  ])('retorno que não é o local do aplicativo (%s): a página não navega', async (_nome, redirectTo) => {
    await pronta();
    api.on('POST', '/api/v1/desktop/authorization/approve', 'desktopAuthorizationApprove', { status: 200, body: { redirectTo } });
    await user().click(screen.getByRole('button', { name: 'Autorizar entrada' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(left).not.toHaveBeenCalled();
  });

  it('pedido que expirou entre a tela e o clique: explica e não navega', async () => {
    await pronta();
    api.on('POST', '/api/v1/desktop/authorization/approve', 'desktopAuthorizationApprove', { status: 404, body: { error: 'not_found' } });
    await user().click(screen.getByRole('button', { name: 'Autorizar entrada' }));
    expect(await screen.findByText(/Este pedido de entrada não vale mais/)).toBeInTheDocument();
    expect(left).not.toHaveBeenCalled();
    expect(desktopPending()).toBe(false);
  });
});

describe('sem pedido vivo', () => {
  it('aberta sem o aplicativo (ou com o pedido vencido): orienta a recomeçar pelo aplicativo', async () => {
    api.on('GET', '/api/v1/desktop/authorization', 'desktopAuthorizationPending', { status: 404, body: { error: 'not_found' } });
    markDesktopPending();
    renderApp('/entrar/aplicativo');
    expect(await screen.findByText(/Este pedido de entrada não vale mais/)).toBeInTheDocument();
    expect(desktopPending()).toBe(false);
    expect(screen.queryByRole('button', { name: 'Autorizar entrada' })).not.toBeInTheDocument();
  });

  it('sessão restrita (código de recuperação): pede a troca do autenticador, sem botão de autorizar', async () => {
    api.on('GET', '/api/v1/desktop/authorization', 'desktopAuthorizationPending', { status: 403, body: { error: 'forbidden' } });
    renderApp('/entrar/aplicativo');
    expect(await screen.findByText(/Troque o autenticador antes de entrar no aplicativo/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Autorizar entrada' })).not.toBeInTheDocument();
  });
});

describe('regras locais', () => {
  it('parseDesktopRequest exige cada parâmetro uma vez e nenhum outro', () => {
    expect(parseDesktopRequest(QUERY)?.redirectUri).toBe(REDIRECT);
    expect(parseDesktopRequest('')).toBeNull();
    expect(parseDesktopRequest(`${QUERY}&client_id=outro`)).toBeNull();
    expect(parseDesktopRequest(`${QUERY}&success=true`)).toBeNull();
  });

  it('loopbackReturn só aceita http://127.0.0.1:<porta>/callback?…', () => {
    expect(loopbackReturn(RETURN)).toBe(RETURN);
    expect(loopbackReturn(DENIED)).toBe(DENIED);
    for (const ruim of [REDIRECT, `${REDIRECT}?`, 'http://127.0.0.1:80/callback?code=x', 'http://127.0.0.1:70000/callback?code=x', `${REDIRECT}?code=x#y`, undefined, 42]) {
      expect(() => loopbackReturn(ruim)).toThrow();
    }
  });

  it('a marca de entrada em andamento vale 5 minutos, fica só em memória e não guarda nada do pedido', () => {
    markDesktopPending(1_000);
    expect(desktopPending(1_000 + 4 * 60 * 1000)).toBe(true);
    expect(desktopPending(1_000 + 5 * 60 * 1000)).toBe(false);
    expect(desktopPending(1_000)).toBe(false); // vencida, a marca some
    markDesktopPending();
    expect(window.sessionStorage.length + window.localStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    clearDesktopPending();
    expect(desktopPending()).toBe(false);
  });
});
