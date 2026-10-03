import { expect, test } from '@playwright/test';
import { countPasswordResetTokens, createAccount, createOrganization, issuePasswordResetToken } from './support/mock';
import { leakGuard, path, signIn } from './support/app';

const NEW_PASSWORD = 'Nova-Senha-E2E-muito-longa';
const GENERIC = 'Se existir uma conta elegível para esse endereço, enviaremos as instruções para redefinição da senha.';

test('DoD 2 — esqueci a senha → e-mail (simulado) → link → nova senha → login', async ({ page }) => {
  const guard = leakGuard(page);
  const account = await createAccount();
  const before = await countPasswordResetTokens(account.userId);

  await page.goto(path.login(account.org));
  await page.getByRole('link', { name: 'Esqueci minha senha' }).click();
  await expect(page).toHaveURL(path.forgot(account.org));
  await expect(page.getByRole('heading', { name: 'Esqueceu sua senha?' })).toBeVisible();
  await page.getByRole('textbox', { name: /E-mail/ }).fill(account.email);
  await page.getByRole('button', { name: 'Enviar instruções' }).click();
  await expect(page.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();
  await expect(page.getByText(GENERIC)).toBeVisible();
  // a API real emitiu o token (o sender local não entrega e-mail: o link abaixo simula a mensagem)
  await expect.poll(() => countPasswordResetTokens(account.userId)).toBe(before + 1);

  const token = await issuePasswordResetToken(account.userId);
  await page.goto(path.reset(account.org, token));
  await expect(page).toHaveURL(`/o/${account.org}/reset-password`); // token removido da barra de endereços
  await page.getByLabel(/^Nova senha/).fill(NEW_PASSWORD);
  await page.getByLabel(/^Confirmar nova senha/).fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByRole('heading', { name: 'Senha alterada' })).toBeVisible();
  await expect(page.getByText('Agora você pode entrar usando sua nova senha.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Voltar para o login' }).click();
  await expect(page).toHaveURL(path.login(account.org));
  await signIn(page, account, NEW_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Proteja sua conta' })).toBeVisible(); // senha aceita → MFA

  await test.step('o mesmo link não funciona de novo', async () => {
    await page.goto(path.reset(account.org, token));
    await page.getByLabel(/^Nova senha/).fill('Outra-Senha-E2E-12345');
    await page.getByLabel(/^Confirmar nova senha/).fill('Outra-Senha-E2E-12345');
    await page.getByRole('button', { name: 'Salvar nova senha' }).click();
    await expect(page.getByRole('heading', { name: 'Este link não é mais válido' })).toBeVisible();
  });

  await guard.assertClean([token, NEW_PASSWORD]);
});

test('esqueci a senha: resposta idêntica para e-mail inexistente', async ({ page }) => {
  const org = await createOrganization();
  await page.goto(path.forgot(org));
  await page.getByRole('textbox', { name: /E-mail/ }).fill('ninguem@e2e.test');
  await page.getByRole('button', { name: 'Enviar instruções' }).click();
  await expect(page.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();
  await expect(page.getByText(GENERIC)).toBeVisible();
});

for (const kind of ['inválido', 'expirado'] as const) {
  test(`link de redefinição ${kind}: "Este link não é mais válido" e caminho para novo link`, async ({ page }) => {
    const account = await createAccount();
    const token = kind === 'expirado' ? await issuePasswordResetToken(account.userId, { expired: true }) : 'x'.repeat(43);
    await page.goto(path.reset(account.org, token));
    await page.getByLabel(/^Nova senha/).fill(NEW_PASSWORD);
    await page.getByLabel(/^Confirmar nova senha/).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Salvar nova senha' }).click();
    await expect(page.getByRole('heading', { name: 'Este link não é mais válido' })).toBeVisible();
    await page.getByRole('button', { name: 'Solicitar novo link' }).click();
    await expect(page).toHaveURL(path.forgot(account.org));
  });
}
