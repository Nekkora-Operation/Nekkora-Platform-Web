import { expect, test } from '@playwright/test';
import { createAccount, createOrganization, PASSWORD } from './support/mock';
import { enrolledAccount, enrollMfa, INVALID_CREDENTIALS, leakGuard, path, signIn } from './support/app';

test('DoD 1 — primeiro acesso: login → MFA obrigatório → códigos → área autenticada; depois login com TOTP', async ({ page }) => {
  const guard = leakGuard(page);
  const account = await createAccount();

  await signIn(page, account);
  const { auth, codes } = await enrollMfa(page, account);
  // F4: o e-mail aparece também no rodapé do menu da área interna; a conferência é no conteúdo principal
  await expect(page.getByRole('main').getByText(account.email)).toBeVisible();
  await expect(page).toHaveURL(path.home(account.org));

  await test.step('sair e entrar de novo: senha → código do autenticador', async () => {
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page.getByText('Você saiu da sua conta.')).toBeVisible();
    await expect(page).toHaveURL(path.login(account.org));

    await signIn(page, account);
    await expect(page).toHaveURL(`/o/${account.org}/mfa`);
    await expect(page.getByRole('heading', { name: 'Confirme sua identidade' })).toBeVisible();

    await page.getByLabel(/Código de autenticação/).fill(auth.wrong());
    await expect(page.getByText('Código inválido ou expirado. Confira e tente novamente.').first()).toBeVisible();

    await page.getByLabel(/Código de autenticação/).fill(await auth.next());
    await expect(page.getByRole('heading', { name: 'Olá, Pessoa E2E' })).toBeVisible();
  });

  await guard.assertClean([PASSWORD, ...codes]);
});

test('login com código de recuperação: aceito uma vez, com aviso; o mesmo código não serve de novo', async ({ page }) => {
  const guard = leakGuard(page);
  const { account, codes } = await enrolledAccount(page);

  await signIn(page, account);
  await page.getByRole('button', { name: 'Usar código de recuperação' }).click();
  await expect(page.getByRole('heading', { name: 'Usar código de recuperação' })).toBeVisible();
  await page.getByLabel(/Código de recuperação/).fill(codes[0].toLowerCase());
  await page.getByLabel(/Código de recuperação/).press('Enter');
  await expect(page.getByRole('heading', { name: 'Olá, Pessoa E2E' })).toBeVisible();
  await expect(page.getByText('Você entrou com um código de recuperação')).toBeVisible();

  await page.getByRole('button', { name: 'Sair' }).click();
  await signIn(page, account);
  await page.getByRole('button', { name: 'Usar código de recuperação' }).click();
  await page.getByLabel(/Código de recuperação/).fill(codes[0]);
  await page.getByLabel(/Código de recuperação/).press('Enter');
  await expect(page.getByText('Código inválido ou expirado. Confira e tente novamente.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Voltar para código do autenticador' }).click();
  await expect(page.getByRole('heading', { name: 'Confirme sua identidade' })).toBeVisible();

  await guard.assertClean([PASSWORD, ...codes]);
});

test('credenciais inválidas: a mesma mensagem genérica para senha errada, e-mail inexistente e conta não elegível', async ({ page }) => {
  const org = await createOrganization();
  const ok = await createAccount(org);
  const unverified = await createAccount(org, { verified: false });
  const cases = [
    { ...ok, password: 'senha-errada-123' },
    { ...ok, email: 'ninguem@e2e.test', password: PASSWORD },
    { ...unverified, password: PASSWORD },
  ];
  for (const c of cases) {
    await signIn(page, c, c.password);
    await expect(page.getByRole('alert').filter({ hasText: INVALID_CREDENTIALS })).toBeVisible();
    await expect(page.getByText(/não encontrad|não existe|não verificad|bloquead/i)).toHaveCount(0);
    await expect(page).toHaveURL(path.login(org));
  }
});
