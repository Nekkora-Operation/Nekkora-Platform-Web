import { expect, test } from '@playwright/test';
import { revokeSessions } from './support/db';
import { enrolledAccount, path, SESSION_EXPIRED, signIn } from './support/app';

test('sessão encerrada pela API (inatividade): o aviso aparece e o login da organização volta', async ({ page }) => {
  await page.clock.install();
  const { account, auth } = await enrolledAccount(page);
  await signIn(page, account);
  await page.getByLabel(/Código de autenticação/).fill(await auth.next());
  await expect(page.getByRole('heading', { name: 'Olá, Pessoa E2E' })).toBeVisible();

  revokeSessions(account.userId); // o servidor encerrou a sessão (30 min sem requisição, conta interna)
  await page.clock.fastForward('30:10');
  await expect(page.getByText(SESSION_EXPIRED)).toBeVisible();
  await expect(page).toHaveURL(path.login(account.org));
});

test('sair: a sessão termina na API — voltar no histórico não reabre a área autenticada', async ({ page, context }) => {
  const { account, auth } = await enrolledAccount(page);
  await signIn(page, account);
  await page.getByLabel(/Código de autenticação/).fill(await auth.next());
  await expect(page.getByRole('heading', { name: 'Olá, Pessoa E2E' })).toBeVisible();

  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByText('Você saiu da sua conta.')).toBeVisible();
  expect((await context.cookies()).filter((c) => c.name === '__Host-nekkora_session')).toEqual([]);

  await page.goto(path.home(account.org));
  await expect(page).toHaveURL(path.login(account.org));
  await expect(page.getByRole('heading', { name: 'Bem-vinda de volta' })).toBeVisible();
});

test('cookies da sessão: HttpOnly, Secure, __Host-, sem "lembrar de mim"', async ({ page, context }) => {
  const { account, auth } = await enrolledAccount(page);
  await signIn(page, account);
  await page.getByLabel(/Código de autenticação/).fill(await auth.next());
  await expect(page.getByRole('heading', { name: 'Olá, Pessoa E2E' })).toBeVisible();
  const session = (await context.cookies()).find((c) => c.name === '__Host-nekkora_session');
  expect(session).toBeDefined();
  expect(session).toMatchObject({ httpOnly: true, secure: true, path: '/' });
  await expect(page.getByText(/lembrar|manter conectad/i)).toHaveCount(0);
});
