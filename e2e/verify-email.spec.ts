import { expect, test } from '@playwright/test';
import { createAccount, createOrganization, issueEmailVerificationToken } from './support/db';
import { INVALID_CREDENTIALS, leakGuard, path, signIn } from './support/app';

test('DoD 3 — link de verificação → e-mail confirmado → login', async ({ page }) => {
  const guard = leakGuard(page);
  const account = createAccount(createOrganization(), { verified: false });

  await signIn(page, account); // antes de confirmar: conta não elegível, resposta genérica
  await expect(page.getByRole('alert').filter({ hasText: INVALID_CREDENTIALS })).toBeVisible();

  const token = issueEmailVerificationToken(account);
  await page.goto(path.verify(account.org, token));
  await expect(page.getByText('E-mail confirmado', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/o/${account.org}/verify-email`);

  await page.getByRole('button', { name: 'Ir para o login' }).click();
  await expect(page).toHaveURL(path.login(account.org));
  await signIn(page, account);
  await expect(page.getByRole('heading', { name: 'Proteja sua conta' })).toBeVisible();

  await guard.assertClean([token]);
});

for (const kind of ['inválido', 'expirado', 'já usado'] as const) {
  test(`link de verificação ${kind}`, async ({ page }) => {
    const account = createAccount(createOrganization(), { verified: false });
    let token = 'y'.repeat(43);
    if (kind === 'expirado') token = issueEmailVerificationToken(account, { expired: true });
    if (kind === 'já usado') {
      token = issueEmailVerificationToken(account);
      await page.goto(path.verify(account.org, token));
      await expect(page.getByText('E-mail confirmado', { exact: true })).toBeVisible();
      await page.goto('about:blank'); // o link do e-mail abre uma carga nova, não uma troca de fragmento
    }
    await page.goto(path.verify(account.org, token));
    await expect(page.getByText('Este link não é mais válido', { exact: true })).toBeVisible();
  });
}

test('reenviar verificação: fora do ar até a API expor o endpoint (divergência D2)', async ({ page }) => {
  const org = createOrganization();
  await page.goto(path.login(org));
  await expect(page.getByRole('link', { name: /Reenviar verificação/ })).toHaveCount(0);
  await page.goto(`/o/${org}/resend-verification`);
  await expect(page.getByRole('heading', { name: 'Reenviar verificação' })).toHaveCount(0);
});
