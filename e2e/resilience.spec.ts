import { expect, test } from '@playwright/test';
import { createAccount, createOrganization } from './support/db';
import { signIn } from './support/app';

test('API indisponível: mensagem temporária, sem detalhes internos, e o formulário continua utilizável', async ({ page }) => {
  const account = createAccount(createOrganization());
  await page.route('**/api/v1/**', (route) => route.abort('connectionrefused'));
  await signIn(page, account);
  await expect(page.getByRole('alert')).toContainText('Não foi possível conectar.');
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: /E-mail/ })).toHaveValue(account.email);
});

test('503 do serviço: "temporariamente indisponível" com código de referência seguro', async ({ page }) => {
  const account = createAccount(createOrganization());
  await page.route('**/auth/login', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'X-Request-Id': '0b8f4c9e-2d1a-4f3b-9c7e-5a6d8e9f0a1b' },
      body: JSON.stringify({ error: 'service_unavailable', trace: 'java.lang.IllegalStateException at ...' }),
    }),
  );
  await signIn(page, account);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Serviço temporariamente indisponível.');
  await expect(alert).toContainText('0b8f4c9e-2d1a-4f3b-9c7e-5a6d8e9f0a1b');
  await expect(page.getByText(/IllegalStateException|java\.|trace/)).toHaveCount(0);
});

test('submit duplicado: um único POST de login, botão em "Entrando…"', async ({ page }) => {
  const account = createAccount(createOrganization());
  let posts = 0;
  await page.route('**/auth/login', async (route) => {
    posts++;
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.goto(`/o/${account.org}/login`);
  await page.getByRole('textbox', { name: /E-mail/ }).fill(account.email);
  await page.getByLabel(/^Senha/).fill('qualquer-senha-errada');
  const button = page.getByRole('button', { name: 'Entrar' });
  await button.click();
  await page.getByLabel(/^Senha/).press('Enter');
  await expect(page.getByRole('button', { name: /Entrando/ })).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(posts).toBe(1);
});
