import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENROLL_OK, TOTP_OK } from './test/fakeApi';
import { fillLogin, lbl, location, openLink, ORG, setupFake, user } from './test/helpers';
import { renderApp } from './test/render';

const fake = setupFake();
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir'] as const;

describe('§49 — nada sensível em log, storage ou URL', () => {
  let spies: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(() => {
    spies = METHODS.map((m) => vi.spyOn(console, m));
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));

  const SECRETS = {
    password: 'senha-muito-segura',
    newPassword: 'uma frase longa e segura',
    totp: TOTP_OK,
    enroll: ENROLL_OK,
    recovery: 'ABCD-EFGH-IJKL-MNOP',
    resetToken: 'R'.repeat(43),
    verifyToken: 'V'.repeat(43),
  };

  function assertNoLeaks() {
    for (const spy of spies) {
      expect(spy, 'nenhuma chamada de console durante os fluxos').not.toHaveBeenCalled();
    }
    const storage = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(localStorage.length + sessionStorage.length).toBe(0);
    for (const s of Object.values(SECRETS)) {
      expect(storage).not.toContain(s);
      expect(window.location.href).not.toContain(s);
      expect(document.cookie).not.toContain(s);
    }
  }

  it('login + MFA (TOTP) + erros', async () => {
    renderApp(`/o/${ORG}/login`);
    await fillLogin('ana@empresa.com', 'senha-errada-123');
    await screen.findByRole('alert');
    await user().clear(screen.getByLabelText(lbl('Senha')));
    await user().type(screen.getByLabelText(lbl('Senha')), SECRETS.password);
    await user().click(screen.getByRole('button', { name: 'Entrar' }));
    await user().type(await screen.findByLabelText(lbl('Código de autenticação')), '000000');
    await screen.findByText(/Código inválido/);
    await user().type(screen.getByLabelText(lbl('Código de autenticação')), SECRETS.totp);
    await screen.findByRole('heading', { name: 'Olá, Ana Souza' });
    assertNoLeaks();
  });

  it('código de recuperação', async () => {
    renderApp(`/o/${ORG}/login`);
    await fillLogin('ana@empresa.com', SECRETS.password);
    await user().click(await screen.findByRole('button', { name: 'Usar código de recuperação' }));
    await user().type(await screen.findByLabelText(lbl('Código de recuperação')), SECRETS.recovery);
    await user().click(screen.getByRole('button', { name: 'Usar código de recuperação' }));
    await screen.findByRole('heading', { name: 'Olá, Ana Souza' });
    assertNoLeaks();
  });

  it('configuração de MFA e códigos de recuperação', async () => {
    renderApp(`/o/${ORG}/login`);
    await fillLogin('novo@empresa.com', SECRETS.password);
    await user().click(await screen.findByRole('button', { name: 'Configurar autenticador' }));
    await user().click(await screen.findByRole('button', { name: 'Já adicionei a conta' }));
    await user().type(await screen.findByLabelText(lbl('Código do autenticador')), SECRETS.enroll);
    await screen.findByRole('heading', { name: 'Guarde seus códigos de recuperação' });
    assertNoLeaks();
  });

  it('redefinição e verificação por link: token fora da URL, da tela e dos logs', async () => {
    fake.api().resetTokens.add(SECRETS.resetToken);
    openLink(`/o/${ORG}/reset-password`, SECRETS.resetToken);
    const view = renderApp(`/o/${ORG}/reset-password`);
    await user().type(screen.getByLabelText(lbl('Nova senha')), SECRETS.newPassword);
    await user().type(screen.getByLabelText(lbl('Confirmar nova senha')), SECRETS.newPassword);
    await user().click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    await screen.findByRole('heading', { name: 'Senha alterada' });
    expect(document.body.textContent).not.toContain(SECRETS.resetToken);
    view.unmount();

    fake.api().verifyTokens.add(SECRETS.verifyToken);
    openLink(`/o/${ORG}/verify-email`, SECRETS.verifyToken);
    renderApp(`/o/${ORG}/verify-email`);
    await screen.findByText('E-mail confirmado');
    expect(document.body.textContent).not.toContain(SECRETS.verifyToken);
    assertNoLeaks();
  });

  it('erros da API nunca exibem payload bruto, token ou stack', async () => {
    fake.api().failures = [500];
    renderApp(`/o/${ORG}/login`);
    await fillLogin('ana@empresa.com', SECRETS.password);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Algo deu errado do nosso lado.');
    expect(alert.textContent).not.toMatch(/internal_error|\{|Exception|at \w+\(/);
    assertNoLeaks();
  });
});

describe('§39/§40 — varredura estática do código de produção', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return f === 'test' ? [] : sources(p);
      return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
    });
  }

  it('sem console, localStorage, sessionStorage, document.cookie ou analytics', () => {
    const offenders: string[] = [];
    // única exceção (FRONT-V1-002): o registro de operações incertas guarda só resumos e estados (ver pendingOps.test.ts)
    const allowed = new Set([join(process.cwd(), 'src', 'api', 'pendingOps.ts')]);
    for (const file of sources(join(process.cwd(), 'src')).filter((f) => !allowed.has(f))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (/\bconsole\.|localStorage|sessionStorage|document\.cookie|gtag\(|analytics\./.test(line)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('sem cadastro público, Microsoft/SSO ou "lembrar de mim" no código', () => {
    const all = sources(join(process.cwd(), 'src'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)) // comentários que documentam a proibição não contam
      .join('\n');
    expect(all).not.toMatch(/Criar conta|Cadastre-se|Sign up|Começar grátis|Microsoft|Entra ID|Azure AD|Manter conectado|remember ?me/i);
  });
});

describe('§26 — reenvio de verificação (atrás de flag até existir no contrato)', () => {
  it('flag desligada: sem link no login e rota inexistente', async () => {
    renderApp(`/o/${ORG}/login`);
    expect(screen.queryByRole('link', { name: 'Reenviar verificação de e-mail' })).toBeNull();
    const view = renderApp(`/o/${ORG}/resend-verification`);
    expect(await view.findByRole('heading', { name: 'Página não encontrada' })).toBeInTheDocument();
  });
});

describe('Navegação preserva a organização', () => {
  it('login → esqueci → login e login → mfa sempre sob /o/{org}', async () => {
    renderApp(`/o/${ORG}/login`);
    await user().click(screen.getByRole('link', { name: 'Esqueci minha senha' }));
    expect(location()).toMatch(new RegExp(`^/o/${ORG}/`));
    await user().click(screen.getByRole('link', { name: /Voltar para o login/ }));
    await fillLogin('ana@empresa.com', 'senha-muito-segura');
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/mfa`));
    for (const r of fake.api().requests) expect(r.path === '/api/v1/csrf' || r.path.startsWith(`/api/v1/o/${ORG}/`)).toBe(true);
  });
});
