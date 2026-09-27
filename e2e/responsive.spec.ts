import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { createAccount, createOrganization } from './support/db';
import { enrollMfa, path, signIn } from './support/app';

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function audit(page: Page, name: string) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe injetado acima
    const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return r.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
  expect(violations, `axe em ${name}`).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `rolagem horizontal em ${name}`).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

test('telas públicas: acessibilidade (axe, com contraste) e sem rolagem horizontal', async ({ page }) => {
  const org = createOrganization();
  await page.goto(path.login(org));
  await expect(page.getByRole('heading', { name: 'Bem-vinda de volta' })).toBeVisible();
  await audit(page, 'login');

  await page.getByRole('textbox', { name: /E-mail/ }).fill('ninguem@e2e.test');
  await page.getByLabel(/^Senha/).fill('senha-qualquer-123');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toContainText('E-mail ou senha incorretos.');
  await audit(page, 'login-erro');

  await page.goto(path.forgot(org));
  await expect(page.getByRole('heading', { name: 'Esqueceu sua senha?' })).toBeVisible();
  await audit(page, 'esqueci-senha');

  await page.goto(path.reset(org, 'z'.repeat(43)));
  await expect(page.getByRole('heading', { name: 'Crie uma nova senha' })).toBeVisible();
  await audit(page, 'nova-senha');

  await page.goto('/login');
  await audit(page, 'sem-organizacao');
});

test('primeiro acesso e MFA: acessibilidade e layout', async ({ page }) => {
  const account = createAccount(createOrganization());
  await signIn(page, account);
  await expect(page.getByRole('heading', { name: 'Proteja sua conta' })).toBeVisible();
  await audit(page, 'mfa-intro');
  await page.getByRole('button', { name: 'Configurar autenticador' }).click();
  await expect(page.getByRole('heading', { name: 'Configure o autenticador' })).toBeVisible();
  await audit(page, 'mfa-qr');
  await page.getByRole('button', { name: 'Já adicionei a conta' }).click();
  await expect(page.getByRole('heading', { name: 'Confirme o código' })).toBeVisible();
  await audit(page, 'mfa-confirmar');
});

test('códigos de recuperação, área autenticada e verificação MFA: acessibilidade e layout', async ({ page }) => {
  const account = createAccount(createOrganization());
  await signIn(page, account);
  const { auth } = await enrollMfa(page, account, (step) => audit(page, step === 'codes' ? 'mfa-codigos' : 'area-autenticada'));
  await page.getByRole('button', { name: 'Sair' }).click();
  await signIn(page, account);
  await expect(page.getByRole('heading', { name: 'Confirme sua identidade' })).toBeVisible();
  await audit(page, 'mfa-verificar');
  await page.getByLabel(/Código de autenticação/).fill(auth.wrong());
  await expect(page.getByText('Código inválido ou expirado. Confira e tente novamente.').first()).toBeVisible();
  await audit(page, 'mfa-verificar-erro');
  await page.getByRole('button', { name: 'Usar código de recuperação' }).click();
  await expect(page.getByRole('heading', { name: 'Usar código de recuperação' })).toBeVisible();
  await audit(page, 'mfa-recuperacao');
});

test('teclado: Tab percorre o login com foco visível e Enter envia', async ({ page }) => {
  const org = createOrganization();
  await page.goto(path.login(org));
  await expect(page.getByRole('textbox', { name: /E-mail/ })).toBeFocused();
  await page.keyboard.type('ninguem@e2e.test');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(/^Senha/)).toBeFocused();
  await page.keyboard.type('senha-qualquer-123');
  await page.keyboard.press('Tab');
  const toggle = page.getByRole('button', { name: 'Mostrar senha' });
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel(/^Senha/)).toHaveAttribute('type', 'text');
  await expect(page.getByLabel(/^Senha/)).toHaveValue('senha-qualquer-123');
  const hide = page.getByRole('button', { name: 'Ocultar senha' });
  await expect(hide).toBeFocused();
  const outline = await hide.evaluate((el) => getComputedStyle(el).outlineStyle + getComputedStyle(el).boxShadow);
  expect(outline).not.toBe('nonenone');
  await page.getByLabel(/^Senha/).press('Enter');
  await expect(page.getByRole('alert')).toContainText('E-mail ou senha incorretos.');
});
