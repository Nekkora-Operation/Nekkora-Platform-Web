import { expect, type Page } from '@playwright/test';
// módulo .mjs da ferramenta do laboratório (sem tipos)
// @ts-expect-error sem declaração de tipos
import { countMessages, latestToken } from '../../tools/lab/lab.mjs';
import { Authenticator } from '../../mock/totp';

export const LAB = process.env.FRONT_LAB_ID ?? 'frontlab-001';
/** Senha sintética das contas de ensaio (só existe no laboratório descartável). */
export const PASSWORD = 'Ensaio-Front-V1-001-senha';

/** E-mail sintético único por execução (domínio .test, nunca entregue: a caixa é de homologação). */
export const syntheticEmail = (journey: string) =>
  `${journey}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@ensaio.nekkora.test`;

export const messages = (kind: string, email: string): number => countMessages(LAB, kind, email) as number;

/** Espera a mensagem produzida pelo fluxo real chegar à caixa (o envio sai fora do caminho da resposta). */
export async function waitToken(kind: string, email: string, { after = 0, timeoutMs = 20_000 } = {}): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (messages(kind, email) > after) {
      const t = latestToken(LAB, kind, email) as string | null;
      if (t) return t;
    }
    if (Date.now() > deadline) throw new Error(`mensagem ${kind} não chegou à caixa`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export interface Person {
  email: string;
  password: string;
  name: string;
  auth: Authenticator;
  recoveryCodes: string[];
}

/** Lê a chave manual exibida no cadastro do autenticador e devolve o gerador TOTP (só em memória do teste). */
export async function readAuthenticator(page: Page): Promise<Authenticator> {
  const label = await page.getByLabel(/^Chave de configuração:/).getAttribute('aria-label');
  return new Authenticator(label!.replace('Chave de configuração:', '').trim().replace(/\s+/g, ''));
}

/** Códigos de recuperação exibidos uma vez (guardados só na memória do teste). */
export async function readRecoveryCodes(page: Page): Promise<string[]> {
  const list = page.getByRole('list', { name: 'Códigos de recuperação' });
  await expect(list.getByRole('listitem').first()).toBeVisible();
  const codes = (await list.getByRole('listitem').allInnerTexts()).map((c) => c.trim());
  expect(codes.length).toBeGreaterThan(0);
  return codes;
}

export async function identitySignIn(page: Page, email: string, password = PASSWORD) {
  await expect(page.getByRole('heading', { name: 'Entrar na Nekkora' })).toBeVisible();
  await page.getByRole('textbox', { name: /E-mail/ }).fill(email);
  await page.getByLabel(/^Senha/).fill(password);
  await page.getByLabel(/^Senha/).press('Enter');
}

/** Cadastro completo pelo navegador: pedido → mensagem da caixa → confirmação → entrada → primeiro fator. */
export async function signUpAndEnroll(page: Page, journey: string): Promise<Person> {
  const email = syntheticEmail(journey);
  const name = `Pessoa ${journey.toUpperCase()}`;
  await page.goto('/cadastro');
  await page.getByRole('textbox', { name: /E-mail/ }).fill(email);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();

  const token = await waitToken('IDENTITY_SIGNUP_CONFIRMATION', email);
  await page.goto(`/cadastro/confirmar#token=${token}`);
  await expect(page.getByRole('heading', { name: 'Conclua seu cadastro' })).toBeVisible();
  expect(page.url()).not.toContain(token);
  await page.getByLabel(/^Nome\*?$/).fill(name);
  await page.getByLabel(/^Senha\*?$/).fill(PASSWORD);
  await page.getByLabel(/^Confirmar senha\*?$/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Concluir cadastro' }).click();
  await expect(page.getByRole('heading', { name: 'Cadastro concluído' })).toBeVisible();
  await page.getByRole('button', { name: 'Entrar' }).click();

  await identitySignIn(page, email);
  await expect(page).toHaveURL(/\/entrar\/configurar-autenticador$/);
  await page.getByRole('button', { name: 'Configurar autenticador' }).click();
  await expect(page.getByRole('heading', { name: 'Configure o autenticador' })).toBeVisible();
  const auth = await readAuthenticator(page);
  await page.getByRole('button', { name: 'Já adicionei a conta' }).click();
  await page.getByLabel(/Código do autenticador/).fill(await auth.next());
  await expect(page.getByRole('heading', { name: 'Guarde seus códigos de recuperação' })).toBeVisible();
  const recoveryCodes = await readRecoveryCodes(page);
  await page.getByLabel('Guardei meus códigos de recuperação em um local seguro.').check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Tudo pronto' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page).toHaveURL(/\/organizacoes$/);
  return { email, password: PASSWORD, name, auth, recoveryCodes };
}

/** Entrada completa com TOTP (pessoa já cadastrada). */
export async function signInWithTotp(page: Page, person: Person) {
  await page.goto('/entrar');
  await identitySignIn(page, person.email, person.password);
  await expect(page).toHaveURL(/\/entrar\/verificacao$/);
  await page.getByLabel('Código de autenticação').fill(await person.auth.next());
  await expect(page).toHaveURL(/\/organizacoes$/);
}

/** Confirma um diálogo de step-up com o próximo código do autenticador. */
export async function confirmStepUp(page: Page, person: Person, confirmLabel: string) {
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('Código do seu aplicativo autenticador').fill(await person.auth.next());
  await dialog.getByRole('button', { name: confirmLabel }).click();
}
