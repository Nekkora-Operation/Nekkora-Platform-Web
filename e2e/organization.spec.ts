import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createAccount, createOrganization } from './support/mock';
import { INVALID_CREDENTIALS, path, signIn } from './support/app';

test('sem organização na URL: estado controlado, sem seletor nem campo de empresa', async ({ page }) => {
  // caminho desconhecido fora da identidade: sem organização identificável
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Não foi possível identificar a organização.' })).toBeVisible();
  await expect(page.getByText('Utilize o endereço de acesso fornecido pela sua empresa.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);

  // FRONT-V1-001: "/" é a porta da identidade Nekkora. A API simulada (8.7) não tem a entrada geral (404): a raiz
  // orienta a entrar pelo endereço da organização, ainda sem seletor nem campo de empresa
  await page.goto('/');
  await expect(page.getByText('Entre pelo endereço da sua organização.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
});

test('identificador de organização inválido: "Organização não encontrada", sem redirecionar', async ({ page }) => {
  await page.goto('/o/empresa-que-nao-existe/login');
  await expect(page.getByRole('heading', { name: 'Organização não encontrada' })).toBeVisible();
  await expect(page).toHaveURL('/o/empresa-que-nao-existe/login');
});

test('organização inexistente com formato válido: a API não revela nada — resposta genérica de credencial', async ({ page }) => {
  const other = await createAccount();
  await signIn(page, { ...other, org: randomUUID() });
  await expect(page.getByRole('alert').filter({ hasText: INVALID_CREDENTIALS })).toBeVisible();
});

test('conta de outra organização não entra por esta (isolamento, sem redirecionar)', async ({ page }) => {
  const a = await createOrganization();
  const fromB = await createAccount();
  await signIn(page, { ...fromB, org: a });
  await expect(page.getByRole('alert').filter({ hasText: INVALID_CREDENTIALS })).toBeVisible();
  await expect(page).toHaveURL(path.login(a));
});

test('a organização é preservada em toda a navegação pública', async ({ page }) => {
  const org = await createOrganization();
  await page.goto(path.login(org));
  await expect(page.getByText(org.slice(0, 8))).toBeVisible();
  await page.getByRole('link', { name: 'Esqueci minha senha' }).click();
  await expect(page).toHaveURL(path.forgot(org));
  await page.getByRole('link', { name: /Voltar para o login/ }).click();
  await expect(page).toHaveURL(path.login(org));
  await page.goto(`/o/${org}/nao-existe`);
  await page.getByRole('button', { name: 'Ir para o login' }).click();
  await expect(page).toHaveURL(path.login(org));
});

test('login sem opções fora de escopo: cadastro, Microsoft, manter conectado, escolher organização', async ({ page }) => {
  await page.goto(path.login(await createOrganization()));
  await expect(page.getByRole('heading', { name: 'Bem-vinda de volta' })).toBeVisible();
  await expect(page.getByText(/criar conta|cadastre-se|microsoft|manter conectad|lembrar|escolher organiza/i)).toHaveCount(0);
});
