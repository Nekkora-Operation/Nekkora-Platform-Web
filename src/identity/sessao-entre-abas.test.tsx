import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../api/csrf';
import { stepUpMethods } from '../api/stepUpMethod';
import { sessionMemory } from '../app/notices';
import { resetLinkTokenCapture } from '../auth/linkToken';
import { lbl, location } from '../test/helpers';
import { renderApp } from '../test/render';
import { RouteApi } from '../test/routeApi';
import { pendingInvitation } from './AcceptInvitationPage';

/**
 * Sessão entre abas e recarga na tela de entrada; fim de sessão sem resto em memória.
 * - /entrar com sessão que JÁ vale (recarga depois da entrada, outra aba entrou) vai direto ao destino;
 * - sem sessão, o formulário continua; com aviso (saiu, expirou, sessão trocada) nada é desfeito sozinho;
 * - a saída (nesta aba ou em outra) zera o que pertencia à pessoa: tokens, método de confirmação, convite aberto.
 */
let api: RouteApi;
let channels: BroadcastChannel[] = [];
const otherTab = () => {
  const c = new BroadcastChannel('nekkora-sessao');
  channels.push(c);
  return c;
};

beforeEach(() => {
  csrfStore.clear();
  sessionMemory.reset();
  resetLinkTokenCapture();
  pendingInvitation.clear();
  stepUpMethods.clear();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  api = new RouteApi().install();
  api.on('GET', '/api/v1/csrf', 'getPreAuthCsrf', { status: 200, body: { csrfToken: 'pre' } });
  api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', { status: 200, body: { organizations: [], canCreateOrganization: false } });
});
afterEach(() => {
  channels.forEach((c) => c.close());
  channels = [];
});

const semSessao = () => api.on('GET', '/api/v1/me/session', 'identitySessionState', { status: 401, body: { error: 'unauthenticated' } });
const comSessao = (restricted = false, stepUpMethod: 'totp' | 'password' = 'totp') =>
  api.on('GET', '/api/v1/me/session', 'identitySessionState', {
    status: 200,
    body: { restricted, csrfToken: 'id-csrf', mfaEnabled: stepUpMethod === 'totp', stepUpMethod },
  });

describe('tela de entrada observa a sessão', () => {
  it('recarregar /entrar com a sessão válida leva direto às organizações, sem pedir senha', async () => {
    comSessao();
    renderApp('/entrar');
    await waitFor(() => expect(location()).toBe('/organizacoes'));
    expect(api.sent('POST', '/api/v1/auth/login')).toHaveLength(0);
  });

  it('sessão restrita (entrou com código de recuperação) vai à troca do fator', async () => {
    comSessao(true);
    renderApp('/entrar');
    await waitFor(() => expect(location()).toBe('/conta/fator'));
  });

  it('sem sessão o formulário continua disponível', async () => {
    semSessao();
    renderApp('/entrar');
    expect(screen.getByLabelText(lbl('E-mail'))).toBeInTheDocument();
    await waitFor(() => expect(api.sent('GET', '/api/v1/me/session').length).toBeGreaterThan(0));
    expect(location()).toBe('/entrar');
  });

  it('falha de rede na conferência não tira o formulário', async () => {
    api.on('GET', '/api/v1/me/session', 'identitySessionState', 'network');
    renderApp('/entrar');
    await waitFor(() => expect(api.sent('GET', '/api/v1/me/session').length).toBeGreaterThan(0));
    expect(location()).toBe('/entrar');
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();
  });

  it('outra aba entrou: a aba parada na entrada segue para a área (aviso do canal, sem token)', async () => {
    semSessao();
    renderApp('/entrar');
    await waitFor(() => expect(api.sent('GET', '/api/v1/me/session').length).toBeGreaterThan(0));
    comSessao();
    otherTab().postMessage({ tipo: 'sessao-alterada' });
    await waitFor(() => expect(location()).toBe('/organizacoes'));
  });

  it('sem aviso do canal (navegador sem BroadcastChannel): voltar o foco à aba confere de novo', async () => {
    semSessao();
    renderApp('/entrar');
    await waitFor(() => expect(api.sent('GET', '/api/v1/me/session').length).toBeGreaterThan(0));
    comSessao();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(location()).toBe('/organizacoes'));
  });

  it('outra aba só entrou numa organização: a entrada não reage (a identidade não mudou)', async () => {
    semSessao();
    renderApp('/entrar');
    await waitFor(() => expect(api.sent('GET', '/api/v1/me/session').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    const antes = api.sent('GET', '/api/v1/me/session').length;
    otherTab().postMessage({ tipo: 'sessao-alterada', alcance: 'organizacao' });
    await new Promise((r) => setTimeout(r, 50));
    expect(api.sent('GET', '/api/v1/me/session')).toHaveLength(antes);
    expect(location()).toBe('/entrar');
  });
});

describe('sem reentrada automática', () => {
  it('aba que saiu da área porque a sessão foi TROCADA em outra aba não vira a outra conta sozinha (F6a-2-R2)', async () => {
    comSessao();
    renderApp('/organizacoes');
    await screen.findByText('Você ainda não participa de nenhuma organização.');
    otherTab().postMessage({ tipo: 'sessao-alterada' }); // outra aba entrou com outra conta
    expect(await screen.findByText(/Sua sessão foi encerrada ou alterada em outra aba/)).toBeInTheDocument();
    expect(location()).toBe('/entrar');
    const conferencias = api.sent('GET', '/api/v1/me/session').length;
    otherTab().postMessage({ tipo: 'sessao-alterada' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(location()).toBe('/entrar');
    expect(api.sent('GET', '/api/v1/me/session')).toHaveLength(conferencias);
    expect(screen.getByLabelText(lbl('E-mail'))).toBeInTheDocument();
  });

  it('a entrada por organização não confere a sessão sozinha (o cookie de organização é um por origem)', async () => {
    const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
    renderApp(`/o/${ORG}/login`);
    expect(await screen.findByLabelText(lbl('E-mail'))).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(api.calls.filter((c) => c.method === 'GET' && /\/auth\/csrf$|\/me\/session$/.test(c.path))).toEqual([]);
  });
});

describe('saída sem resto da sessão', () => {
  it('depois de sair, a entrada NÃO volta sozinha à área (nem ao abrir, nem ao voltar o foco)', async () => {
    comSessao(false, 'password');
    api.on('POST', '/api/v1/auth/logout', 'identityLogout', { status: 204 });
    renderApp('/organizacoes');
    await screen.findByText('Você ainda não participa de nenhuma organização.');
    expect(stepUpMethods.get()).toBe('password');
    fireEvent.click(screen.getAllByRole('button', { name: 'Sair' })[0]);
    expect(await screen.findByText('Você saiu da sua conta.')).toBeInTheDocument();
    const conferencias = api.sent('GET', '/api/v1/me/session').length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(location()).toBe('/entrar');
    expect(api.sent('GET', '/api/v1/me/session')).toHaveLength(conferencias);
    // nada da sessão encerrada fica em memória
    expect(csrfStore.identitySession()).toBeUndefined();
    expect(stepUpMethods.get()).toBe('totp');
  });

  it('a saída avisa as outras abas como FIM de sessão (sem token nem identidade)', async () => {
    comSessao();
    api.on('POST', '/api/v1/auth/logout', 'identityLogout', { status: 204 });
    const recebidas: unknown[] = [];
    otherTab().onmessage = (e) => recebidas.push(e.data);
    renderApp('/organizacoes');
    await screen.findByText('Você ainda não participa de nenhuma organização.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Sair' })[0]);
    await screen.findByText('Você saiu da sua conta.');
    await waitFor(() => expect(recebidas).toContainEqual({ tipo: 'sessao-alterada', fim: true }));
    expect(JSON.stringify(recebidas)).not.toMatch(/csrf|id-csrf|@/);
  });

  it('fim de sessão em OUTRA aba apaga o método de confirmação desta; um login em outra aba não apaga', async () => {
    stepUpMethods.set(undefined, 'password');
    otherTab().postMessage({ tipo: 'sessao-alterada' });
    await new Promise((r) => setTimeout(r, 50));
    expect(stepUpMethods.get()).toBe('password');
    otherTab().postMessage({ tipo: 'sessao-alterada', fim: true });
    await waitFor(() => expect(stepUpMethods.get()).toBe('totp'));
    expect(pendingInvitation.peek()).toBeNull();
  });
});
