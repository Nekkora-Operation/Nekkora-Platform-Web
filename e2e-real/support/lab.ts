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
export async function signUpAndEnroll(page: Page, journey: string, email = syntheticEmail(journey)): Promise<Person> {
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
  // API ate a 028: o primeiro login exige o cadastro do autenticador. API 029+ (segundo fator opcional): o login ja entra
  // e o autenticador e ATIVADO pela pessoa em Seguranca da conta, com a senha reconfirmada
  await page.waitForURL(/\/(entrar\/configurar-autenticador|organizacoes)$/);
  if (/\/organizacoes$/.test(page.url())) {
    const { auth, recoveryCodes } = await activateMfa(page, PASSWORD);
    return { email, password: PASSWORD, name, auth, recoveryCodes };
  }
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

/** Pessoa sem autenticação em duas etapas (API 029): só e-mail, senha e nome. */
export interface PersonWithoutMfa {
  email: string;
  password: string;
  name: string;
}

/** Cadastro pelo navegador SEM ativar a autenticação em duas etapas (API 029): termina nas organizações. */
export async function signUpWithoutMfa(page: Page, journey: string, email = syntheticEmail(journey)): Promise<PersonWithoutMfa> {
  const name = `Pessoa ${journey.toUpperCase()}`;
  await page.goto('/cadastro');
  await page.getByRole('textbox', { name: /E-mail/ }).fill(email);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();
  const token = await waitToken('IDENTITY_SIGNUP_CONFIRMATION', email);
  await page.goto(`/cadastro/confirmar#token=${token}`);
  await page.getByLabel(/^Nome\*?$/).fill(name);
  await page.getByLabel(/^Senha\*?$/).fill(PASSWORD);
  await page.getByLabel(/^Confirmar senha\*?$/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Concluir cadastro' }).click();
  await expect(page.getByRole('heading', { name: 'Cadastro concluído' })).toBeVisible();
  await page.getByRole('button', { name: 'Entrar' }).click();
  await identitySignIn(page, email);
  await expect(page).toHaveURL(/\/organizacoes$/);
  return { email, password: PASSWORD, name };
}

/** Ativação voluntária pela tela (API 029), a partir de qualquer página da identidade: senha, QR, código, códigos. */
export async function activateMfa(page: Page, password: string): Promise<{ auth: Authenticator; recoveryCodes: string[] }> {
  await page.goto('/conta');
  await page.getByRole('button', { name: 'Ativar autenticação em duas etapas' }).click();
  await page.getByRole('button', { name: 'Começar' }).click();
  await confirmPassword(page, password, 'Continuar');
  await expect(page.getByLabel('QR Code para configurar o aplicativo autenticador')).toBeVisible();
  const auth = await readAuthenticator(page);
  await page.getByRole('button', { name: 'Já adicionei a conta' }).click();
  await page.getByLabel(/Código do aplicativo autenticador/).fill(await auth.next());
  await expect(page.getByText('Guarde estes códigos agora.')).toBeVisible();
  const recoveryCodes = await readRecoveryCodes(page);
  await page.getByLabel('Guardei meus códigos de recuperação em um local seguro.').check();
  await page.getByRole('button', { name: 'Concluir' }).click();
  await expect(page.getByText('Autenticação em duas etapas ativada.')).toBeVisible();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page).toHaveURL(/\/organizacoes$/);
  return { auth, recoveryCodes };
}

/** Confirma um diálogo de ação sensível com a SENHA (sessão sem autenticação em duas etapas, API 029). */
export async function confirmPassword(page: Page, password: string, confirmLabel: string) {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByLabel('Código do seu aplicativo autenticador')).toHaveCount(0);
  await dialog.getByLabel(/^Sua senha/).fill(password);
  await dialog.getByRole('button', { name: confirmLabel }).click();
}

/** Entrada completa com TOTP (pessoa já cadastrada). */
export async function signInWithTotp(page: Page, person: Person) {
  await page.goto('/entrar');
  await identitySignIn(page, person.email, person.password);
  await expect(page).toHaveURL(/\/entrar\/verificacao$/);
  await page.getByLabel('Código de autenticação').fill(await person.auth.next());
  await expect(page).toHaveURL(/\/organizacoes$/);
}

/**
 * Confirma um diálogo de ato sensível com o próximo código do autenticador. Identidade: o código vem antes do ato.
 * Organização (PLATFORM-V2-001, T01): o ato vai primeiro; o código só é pedido se a API responder step_up_required (fora
 * da hora de uma confirmação anterior). Devolve se o código foi pedido.
 */
/**
 * PLATFORM-AGENT-V2-002, T09: na página da automação, "Nova versão" só abre o formulário (nada é gravado); a versão nasce
 * quando a Platform aceita o ZIP, e a tela leva ao rascunho criado. Devolve o endereço da página da versão.
 */
export async function newVersionWithPackage(page: Page, zipPath: string): Promise<string> {
  await page.getByRole('button', { name: 'Nova versão' }).click();
  await expect(page).toHaveURL(/\/automacoes\/[0-9a-f-]{36}\/nova-versao$/);
  await page.getByLabel('Arquivo .zip do pacote').setInputFiles(zipPath);
  await page.getByRole('button', { name: 'Enviar o pacote e criar o rascunho' }).click();
  await expect(page).toHaveURL(/\/versoes\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Rascunho criado com o pacote conferido pela Platform.')).toBeVisible();
  return page.url();
}

export async function confirmStepUp(page: Page, person: Person, confirmLabel: string): Promise<boolean> {
  const dialog = page.getByRole('alertdialog');
  const code = dialog.getByLabel('Código do seu aplicativo autenticador');
  const confirm = dialog.getByRole('button', { name: confirmLabel });
  if (await code.isVisible()) {
    await code.fill(await person.auth.next());
    await confirm.click();
    return true;
  }
  await confirm.click();
  await Promise.race([dialog.waitFor({ state: 'hidden' }), code.waitFor({ state: 'visible' }), dialog.getByRole('alert').first().waitFor({ state: 'visible' })]);
  if (!(await code.isVisible())) return false;
  await code.fill(await person.auth.next());
  await confirm.click();
  return true;
}
