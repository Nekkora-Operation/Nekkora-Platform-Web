import { expect, type Page } from '@playwright/test';
import { createAccount, PASSWORD, type Account } from './mock';
import { Authenticator } from '../../mock/totp';

export const path = {
  login: (org: string) => `/o/${org}/login`,
  forgot: (org: string) => `/o/${org}/forgot-password`,
  reset: (org: string, token: string) => `/o/${org}/reset-password#token=${token}`,
  verify: (org: string, token: string) => `/o/${org}/verify-email#token=${token}`,
  home: (org: string) => `/o/${org}`,
};

export const SESSION_EXPIRED = 'Sua sessão expirou. Entre novamente para continuar.';
export const INVALID_CREDENTIALS = 'E-mail ou senha incorretos.';

export async function signIn(page: Page, account: Account, password = PASSWORD) {
  await page.goto(path.login(account.org));
  await expect(page.getByRole('heading', { name: 'Bem-vinda de volta' })).toBeVisible();
  await page.getByRole('textbox', { name: /E-mail/ }).fill(account.email);
  await page.getByLabel(/^Senha/).fill(password);
  await page.getByLabel(/^Senha/).press('Enter');
}

/** Primeiro acesso completo: tela de setup → chave manual → confirmação → códigos → área autenticada. */
export async function enrollMfa(page: Page, account: Account, onStep?: (step: 'codes' | 'home') => Promise<void>) {
  await expect(page).toHaveURL(new RegExp(`/o/${account.org}/mfa/setup$`));
  await expect(page.getByRole('heading', { name: 'Proteja sua conta' })).toBeVisible();
  await page.getByRole('button', { name: 'Configurar autenticador' }).click();

  await expect(page.getByRole('heading', { name: 'Configure o autenticador' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR Code para configurar o aplicativo autenticador' })).toBeVisible();
  const label = await page.getByLabel(/^Chave de configuração:/).getAttribute('aria-label');
  const auth = new Authenticator(label!.replace('Chave de configuração:', ''));
  await page.getByRole('button', { name: 'Já adicionei a conta' }).click();

  await expect(page.getByRole('heading', { name: 'Confirme o código' })).toBeVisible();
  await page.getByLabel(/Código do autenticador/).fill(await auth.next());

  await expect(page.getByRole('heading', { name: 'Guarde seus códigos de recuperação' })).toBeVisible();
  const codes = (await page.getByRole('list', { name: 'Códigos de recuperação' }).getByRole('listitem').allInnerTexts()).map(
    (c) => c.trim(),
  );
  expect(codes).toHaveLength(10);
  for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  await onStep?.('codes');
  await expect(page.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  await page.getByLabel('Guardei meus códigos de recuperação em um local seguro.').check();
  await page.getByRole('button', { name: 'Continuar' }).click();

  await expect(page.getByRole('heading', { name: 'Tudo pronto' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar para o Platform' }).click();
  await expect(page.getByRole('heading', { name: 'Olá, Pessoa E2E' })).toBeVisible();
  await onStep?.('home');
  return { auth, codes };
}

/** Conta nova já com MFA configurado e sem sessão (saiu ao final). */
export async function enrolledAccount(page: Page) {
  const account = await createAccount();
  await signIn(page, account);
  const mfa = await enrollMfa(page, account);
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByText('Você saiu da sua conta.')).toBeVisible();
  return { account, ...mfa };
}

/**
 * Vigia de vazamento: nada sensível em console, em URLs de requisição, na barra de endereços, em
 * localStorage/sessionStorage ou em cookies legíveis por script.
 */
export function leakGuard(page: Page) {
  const consoleLines: string[] = [];
  const urls: string[] = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  page.on('pageerror', (e) => consoleLines.push(String(e)));
  page.on('request', (r) => urls.push(r.url()));
  return {
    async assertClean(secrets: string[]) {
      const found = secrets.filter(Boolean).filter((s) => {
        const variants = [s, encodeURIComponent(s)];
        return consoleLines.some((l) => variants.some((v) => l.includes(v))) || urls.some((u) => variants.some((v) => u.includes(v)));
      });
      expect(found, 'segredo em console ou URL de requisição').toEqual([]);
      for (const s of secrets.filter(Boolean)) expect(page.url()).not.toContain(s);
      const storage = await page.evaluate(() => ({
        local: window.localStorage.length,
        session: window.sessionStorage.length,
        cookie: document.cookie,
      }));
      expect(storage).toEqual({ local: 0, session: 0, cookie: '' });
    },
  };
}
