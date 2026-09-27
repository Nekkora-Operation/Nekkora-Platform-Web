import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { csrfStore } from './api/csrf';
import { sessionMemory } from './app/notices';
import { ENROLL_OK, TOTP_OK } from './test/fakeApi';
import { fillLogin, lbl, location, openLink, ORG, setupFake, user } from './test/helpers';
import { renderApp } from './test/render';

const fake = setupFake();
const LOGIN = `/o/${ORG}/login`;
const TOKEN = 'A'.repeat(43);
const OTHER_TOKEN = 'B'.repeat(43);

describe('Login', () => {
  it('login inválido: mensagem genérica, campos preservados, sem sair do login', async () => {
    renderApp(LOGIN);
    await fillLogin('ana@empresa.com', 'errada-errada');
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.');
    expect(screen.getByLabelText(lbl('E-mail'))).toHaveValue('ana@empresa.com');
    expect(location()).toBe(LOGIN);
  });

  it('mesma mensagem para e-mail inexistente, senha errada e conta não elegível (sem enumeração)', async () => {
    fake.api().users.get('novo@empresa.com')!.eligible = false;
    const texts: string[] = [];
    for (const [email, pwd] of [
      ['nao-existe@empresa.com', 'qualquer-senha-123'],
      ['ana@empresa.com', 'senha-errada-123'],
      ['novo@empresa.com', 'senha-muito-segura'],
    ]) {
      const view = renderApp(LOGIN);
      await fillLogin(email, pwd);
      texts.push((await screen.findByRole('alert')).textContent ?? '');
      view.unmount();
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toBe('E-mail ou senha incorretos.');
  });

  it('login válido nunca vai direto para a área interna: a API v1 sempre exige MFA', async () => {
    renderApp(LOGIN);
    await fillLogin('ana@empresa.com', 'senha-muito-segura');
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/mfa`));
    expect(screen.getByRole('heading', { name: 'Confirme sua identidade' })).toBeInTheDocument();
  });

  it('envio duplicado gera uma única requisição e mostra "Entrando…"', async () => {
    fake.api().delay = 60;
    renderApp(LOGIN);
    const u = user();
    await u.type(screen.getByLabelText(lbl('E-mail')), 'ana@empresa.com');
    await u.type(screen.getByLabelText(lbl('Senha')), 'senha-muito-segura');
    const form = screen.getByRole('button', { name: 'Entrar' }).closest('form')!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(await screen.findByRole('button', { name: /Entrando/ })).toBeDisabled();
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/mfa`));
    expect(fake.api().requests.filter((r) => r.path.endsWith('/auth/login'))).toHaveLength(1);
  });

  it('não oferece cadastro, login Microsoft nem "manter conectado"', () => {
    renderApp(LOGIN);
    const text = document.body.textContent ?? '';
    for (const forbidden of ['Criar conta', 'Cadastre', 'Microsoft', 'Manter conectado', 'Lembrar', 'Escolher organização']) {
      expect(text).not.toContain(forbidden);
    }
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('API indisponível: erro de conexão e 503 com código de referência', async () => {
    fake.api().failures = ['network'];
    const view = renderApp(LOGIN);
    await fillLogin('ana@empresa.com', 'senha-muito-segura');
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível conectar.');
    view.unmount();
    fake.api().failures = [503];
    renderApp(LOGIN);
    await fillLogin('ana@empresa.com', 'senha-muito-segura');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Serviço temporariamente indisponível.');
    expect(alert).toHaveTextContent('Código de referência: 0b4e7c2a-1f3d-4d8e-9a6b-5c2e1f0a9d31');
  });

  it('limite de tentativas mostra o tempo de espera do Retry-After', async () => {
    fake.api().failures = [429];
    renderApp(LOGIN);
    await fillLogin('ana@empresa.com', 'senha-muito-segura');
    expect(await screen.findByRole('alert')).toHaveTextContent('Muitas tentativas.Tente novamente em 2 minutos.');
  });

  it('token CSRF de pré-autenticação vencido é renovado uma vez (403 → novo token → sucesso)', async () => {
    csrfStore.setPre('token-vencido');
    renderApp(LOGIN);
    await fillLogin('ana@empresa.com', 'senha-muito-segura');
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/mfa`));
    const logins = fake.api().requests.filter((r) => r.path.endsWith('/auth/login'));
    expect(logins).toHaveLength(2);
    expect(logins[0].csrf).toBe('token-vencido');
  });
});

describe('MFA', () => {
  async function toMfa() {
    renderApp(LOGIN);
    await fillLogin('ana@empresa.com', 'senha-muito-segura');
    await screen.findByRole('heading', { name: 'Confirme sua identidade' });
  }

  it('MFA inválido e depois válido → área autenticada', async () => {
    await toMfa();
    const u = user();
    await u.type(screen.getByLabelText(lbl('Código de autenticação')), '000000');
    expect(await screen.findByText(/Código inválido ou expirado/)).toBeInTheDocument();
    await u.type(screen.getByLabelText(lbl('Código de autenticação')), TOTP_OK);
    expect(await screen.findByRole('heading', { name: 'Olá, Ana Souza' })).toBeInTheDocument();
    expect(location()).toBe(`/o/${ORG}`);
  });

  it('código de recuperação é um fluxo distinto e leva à área autenticada com aviso', async () => {
    await toMfa();
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Usar código de recuperação' }));
    expect(await screen.findByRole('heading', { name: 'Usar código de recuperação' })).toBeInTheDocument();
    expect(screen.queryByLabelText(lbl('Código de autenticação'))).toBeNull();
    await u.type(screen.getByLabelText(lbl('Código de recuperação')), 'abcdefghijklmnop');
    expect(screen.getByLabelText(lbl('Código de recuperação'))).toHaveValue('ABCD-EFGH-IJKL-MNOP');
    await u.click(screen.getByRole('button', { name: 'Usar código de recuperação' }));
    expect(await screen.findByRole('heading', { name: 'Olá, Ana Souza' })).toBeInTheDocument();
    expect(screen.getByText('Você entrou com um código de recuperação')).toBeInTheDocument();
    const verify = fake.api().requests.find((r) => r.path.endsWith('/auth/mfa/verify'))!;
    expect(verify.body).toEqual({ recoveryCode: 'ABCD-EFGH-IJKL-MNOP' });
  });

  it('volta do código de recuperação para o autenticador', async () => {
    await toMfa();
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Usar código de recuperação' }));
    await u.click(await screen.findByRole('button', { name: 'Voltar para código do autenticador' }));
    expect(await screen.findByLabelText(lbl('Código de autenticação'))).toBeInTheDocument();
  });

  it('após 5 códigos errados a verificação é encerrada e exige novo login', async () => {
    await toMfa();
    const u = user();
    for (let i = 0; i < 4; i++) {
      await u.type(screen.getByLabelText(lbl('Código de autenticação')), '111111');
      await screen.findByText(/Código inválido ou expirado/);
    }
    expect(screen.getByText(/Restam poucas tentativas/)).toBeInTheDocument();
    await u.type(screen.getByLabelText(lbl('Código de autenticação')), '111111');
    expect(await screen.findByRole('heading', { name: 'Verificação encerrada' })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Voltar para o login' }));
    expect(location()).toBe(LOGIN);
  });

  it('abrir /mfa sem desafio em memória (recarregou, outra aba) não continua', () => {
    renderApp(`/o/${ORG}/mfa`);
    expect(screen.getByRole('heading', { name: 'Verificação encerrada' })).toBeInTheDocument();
    expect(fake.api().requests).toHaveLength(0);
  });
});

describe('MFA obrigatório no primeiro acesso', () => {
  it('introdução → QR/chave → confirmação → códigos → reconhecimento → conclusão', async () => {
    renderApp(LOGIN);
    await fillLogin('novo@empresa.com', 'senha-muito-segura');
    expect(await screen.findByRole('heading', { name: 'Proteja sua conta' })).toBeInTheDocument();
    expect(location()).toBe(`/o/${ORG}/mfa/setup`);
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Configurar autenticador' }));
    expect(await screen.findByRole('img', { name: /QR Code para configurar/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/Chave de configuração/)).toHaveTextContent('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    await u.click(screen.getByRole('button', { name: 'Já adicionei a conta' }));
    await u.type(await screen.findByLabelText(lbl('Código do autenticador')), '999999');
    expect(await screen.findByText(/Código inválido ou expirado/)).toBeInTheDocument();
    await u.type(screen.getByLabelText(lbl('Código do autenticador')), ENROLL_OK);
    expect(await screen.findByRole('heading', { name: 'Guarde seus códigos de recuperação' })).toBeInTheDocument();
    const codes = screen.getByRole('list', { name: 'Códigos de recuperação' });
    expect(codes.querySelectorAll('li')).toHaveLength(10);
    const next = screen.getByRole('button', { name: 'Continuar' });
    expect(next).toBeDisabled();
    await u.click(screen.getByRole('checkbox', { name: 'Guardei meus códigos de recuperação em um local seguro.' }));
    await u.click(next);
    expect(await screen.findByRole('heading', { name: 'Tudo pronto' })).toBeInTheDocument();
    expect(screen.queryByText(/AAAA-BBBB/)).toBeNull(); // códigos fora da tela depois do reconhecimento
    await u.click(screen.getByRole('button', { name: 'Continuar para o Platform' }));
    expect(await screen.findByRole('heading', { name: 'Olá, Ana Souza' })).toBeInTheDocument();
  });
});

describe('Esqueci minha senha', () => {
  it('resposta genérica idêntica exista ou não a conta', async () => {
    const texts: string[] = [];
    for (const email of ['ana@empresa.com', 'ninguem@empresa.com']) {
      const view = renderApp(`/o/${ORG}/forgot-password`);
      const u = user();
      await u.type(screen.getByLabelText(lbl('E-mail')), email);
      await u.click(screen.getByRole('button', { name: 'Enviar instruções' }));
      await screen.findByRole('heading', { name: 'Confira seu e-mail' });
      texts.push(screen.getByRole('main').textContent ?? '');
      view.unmount();
    }
    expect(texts[0]).toBe(texts[1]);
    expect(texts[0]).toContain('Se existir uma conta elegível para esse endereço, enviaremos as instruções para redefinição da senha.');
  });
});

describe('Redefinição de senha (deep link)', () => {
  const RESET = `/o/${ORG}/reset-password`;

  it('reset válido → senha alterada → login; token some da URL e é usado uma vez', async () => {
    fake.api().resetTokens.add(TOKEN);
    openLink(RESET, TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    renderApp(RESET);
    const u = user();
    await u.type(screen.getByLabelText(lbl('Nova senha')), 'uma frase longa e segura');
    await u.type(screen.getByLabelText(lbl('Confirmar nova senha')), 'uma frase longa e segura');
    await u.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(await screen.findByRole('heading', { name: 'Senha alterada' })).toBeInTheDocument();
    expect(fake.api().requests.filter((r) => r.path.endsWith('/password-reset/confirm'))).toHaveLength(1);
    await u.click(screen.getByRole('button', { name: 'Voltar para o login' }));
    expect(location()).toBe(LOGIN);
  });

  it('não envia senha fora da política nem confirmação diferente', async () => {
    fake.api().resetTokens.add(TOKEN);
    openLink(RESET, TOKEN);
    renderApp(RESET);
    const u = user();
    await u.type(screen.getByLabelText(lbl('Nova senha')), 'curta');
    await u.type(screen.getByLabelText(lbl('Confirmar nova senha')), 'outra');
    await u.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(screen.getByText(/A senha precisa ter entre 12 e 128 caracteres/)).toBeInTheDocument();
    expect(screen.getByText(/As senhas não coincidem/)).toBeInTheDocument();
    expect(fake.api().requests.filter((r) => r.path.endsWith('/password-reset/confirm'))).toHaveLength(0);
  });

  it.each([
    ['inválido', OTHER_TOKEN],
    ['expirado (a API responde igual)', 'C'.repeat(43)],
  ])('reset %s → "Este link não é mais válido" → solicitar novo link', async (_, token) => {
    openLink(RESET, token);
    renderApp(RESET);
    const u = user();
    await u.type(screen.getByLabelText(lbl('Nova senha')), 'uma frase longa e segura');
    await u.type(screen.getByLabelText(lbl('Confirmar nova senha')), 'uma frase longa e segura');
    await u.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(await screen.findByRole('heading', { name: 'Este link não é mais válido' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(token);
    await u.click(screen.getByRole('button', { name: 'Solicitar novo link' }));
    expect(location()).toBe(`/o/${ORG}/forgot-password`);
  });

  it('link sem token: estado inválido sem chamar a API', () => {
    renderApp(RESET);
    expect(screen.getByRole('heading', { name: 'Este link não é mais válido' })).toBeInTheDocument();
    expect(fake.api().requests).toHaveLength(0);
  });
});

describe('Confirmação de e-mail (deep link)', () => {
  const VERIFY = `/o/${ORG}/verify-email`;

  it('válido → confirmado (uma única chamada mesmo com StrictMode)', async () => {
    fake.api().verifyTokens.add(TOKEN);
    openLink(VERIFY, TOKEN);
    renderApp(VERIFY);
    expect(screen.getByText('Validando link…')).toBeInTheDocument();
    expect(await screen.findByText('E-mail confirmado')).toBeInTheDocument();
    expect(fake.api().requests.filter((r) => r.path.endsWith('/email-verification/confirm'))).toHaveLength(1);
    await user().click(screen.getByRole('button', { name: 'Ir para o login' }));
    expect(location()).toBe(LOGIN);
  });

  it.each([['inválido', OTHER_TOKEN], ['expirado', 'C'.repeat(43)], ['malformado', 'abc']])(
    'link %s → validado pela API → "não é mais válido"',
    async (_, token) => {
      openLink(VERIFY, token);
      renderApp(VERIFY);
      expect(await screen.findByText('Este link não é mais válido')).toBeInTheDocument();
      expect(fake.api().requests.some((r) => r.path.endsWith('/email-verification/confirm'))).toBe(true);
    },
  );

  it('erro temporário oferece tentar de novo com o mesmo link', async () => {
    fake.api().verifyTokens.add(TOKEN);
    fake.api().failures = [503];
    openLink(VERIFY, TOKEN);
    renderApp(VERIFY);
    expect(await screen.findByText('Serviço temporariamente indisponível.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('E-mail confirmado')).toBeInTheDocument();
  });
});

describe('Organização', () => {
  it('sem organização na URL: estado controlado, sem seletor nem campo de empresa', () => {
    renderApp('/login');
    expect(screen.getByRole('heading', { name: 'Não foi possível identificar a organização.' })).toBeInTheDocument();
    expect(screen.getByText('Utilize o endereço de acesso fornecido pela sua empresa.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('link', { name: /Voltar para Nekkora/ })).toBeInTheDocument();
  });

  it('organização com endereço inválido: "Organização não encontrada", sem redirecionar', () => {
    renderApp('/o/empresa-inexistente/login');
    expect(screen.getByRole('heading', { name: 'Organização não encontrada' })).toBeInTheDocument();
    expect(location()).toBe('/o/empresa-inexistente/login');
    expect(fake.api().requests).toHaveLength(0);
  });

  it('organização preservada: login → esqueci → login', async () => {
    renderApp(LOGIN);
    const u = user();
    await u.click(screen.getByRole('link', { name: 'Esqueci minha senha' }));
    expect(location()).toBe(`/o/${ORG}/forgot-password`);
    await u.click(screen.getByRole('link', { name: /Voltar para o login/ }));
    expect(location()).toBe(LOGIN);
  });

  it('rota desconhecida dentro da organização volta ao login dela', async () => {
    renderApp(`/o/${ORG}/qualquer-coisa`);
    await user().click(screen.getByRole('button', { name: 'Ir para o login' }));
    expect(location()).toBe(LOGIN);
  });
});

describe('Sessão', () => {
  it('sessão expirada: volta ao login da organização com aviso e limpa o estado local', async () => {
    sessionMemory.markActive();
    csrfStore.setSession(ORG, 'ses-antigo');
    renderApp(`/o/${ORG}`);
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
    expect(location()).toBe(LOGIN);
    expect(csrfStore.session(ORG)).toBeUndefined();
  });

  it('inatividade: passado o prazo do contrato sem chamadas, confirma com a API e aplica a expiração', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    try {
      renderApp(LOGIN);
      await fillLogin('ana@empresa.com', 'senha-muito-segura');
      await user().type(await screen.findByLabelText(lbl('Código de autenticação')), TOTP_OK);
      await screen.findByRole('heading', { name: 'Olá, Ana Souza' });

      // sessão ainda válida no servidor: a verificação só reagenda, sem sair da área autenticada
      await act(() => vi.advanceTimersByTimeAsync(30 * 60_000 + 5_000));
      expect(location()).toBe(`/o/${ORG}`);

      fake.api().expireSession(); // a API encerrou a sessão por inatividade
      await act(() => vi.advanceTimersByTimeAsync(30 * 60_000 + 5_000));
      expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeInTheDocument();
      expect(location()).toBe(LOGIN);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sem sessão e sem histórico nesta aba: vai ao login sem aviso', async () => {
    renderApp(`/o/${ORG}`);
    await screen.findByRole('heading', { name: 'Bem-vinda de volta' });
    expect(screen.queryByText(/sessão expirou/)).toBeNull();
  });

  it('sair encerra a sessão na API e volta ao login', async () => {
    renderApp(LOGIN);
    await fillLogin('ana@empresa.com', 'senha-muito-segura');
    await user().type(await screen.findByLabelText(lbl('Código de autenticação')), TOTP_OK);
    await screen.findByRole('heading', { name: 'Olá, Ana Souza' });
    await user().click(screen.getByRole('button', { name: 'Sair' }));
    expect(await screen.findByText('Você saiu da sua conta.')).toBeInTheDocument();
    expect(fake.api().hasSession()).toBe(false);
    expect(location()).toBe(LOGIN);
  });
});
