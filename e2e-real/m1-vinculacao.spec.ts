import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { Authenticator } from '../mock/totp';
import { confirmStepUp, LAB, signUpAndEnroll, syntheticEmail } from './support/lab';

/**
 * Vinculação de conta antiga contra a API REAL (FRONT-V1-002).
 *
 * Pré-condição DECLARADA: `lab.mjs conta-antiga` cria, só no laboratório, uma organização com uma conta interna antiga
 * (sem identidade) que tem apenas senha. Todo o resto é fluxo real: o autenticador da conta antiga é cadastrado pela
 * entrada da organização; a identidade nasce pelo cadastro com o MESMO e-mail; a vinculação exige as DUAS provas — a da
 * conta antiga (senha + TOTP dela) e a da identidade (step-up).
 */
const OLD_PASSWORD = 'Conta-Antiga-Ensaio-Front-002';

test('vinculação: prova da conta antiga + prova da identidade; depois a entrada é só pela identidade', async ({ browser }) => {
  test.setTimeout(300_000);
  const email = syntheticEmail('vinc');
  const org = execFileSync('node', ['tools/lab/lab.mjs', LAB, 'conta-antiga', email], { input: `${OLD_PASSWORD}\n`, encoding: 'utf8' }).trim();
  expect(org).toMatch(/^[0-9a-f-]{36}$/);

  // conta antiga: primeiro acesso pela entrada da organização (fluxo real) e cadastro do autenticador DELA
  const oldCtx = await browser.newContext();
  const old = await oldCtx.newPage();
  await old.goto(`/o/${org}/login`);
  await old.getByRole('textbox', { name: /E-mail/ }).fill(email);
  await old.getByLabel(/^Senha/).fill(OLD_PASSWORD);
  await old.getByLabel(/^Senha/).press('Enter');
  await expect(old).toHaveURL(new RegExp(`/o/${org}/mfa/setup$`));
  await old.getByRole('button', { name: 'Configurar autenticador' }).click();
  const label = await old.getByLabel(/^Chave de configuração:/).getAttribute('aria-label');
  const oldAuth = new Authenticator(label!.replace('Chave de configuração:', '').trim().replace(/\s+/g, ''));
  await old.getByRole('button', { name: 'Já adicionei a conta' }).click();
  await old.getByLabel(/Código do autenticador/).fill(await oldAuth.next());
  await old.getByLabel('Guardei meus códigos de recuperação em um local seguro.').check();
  await old.getByRole('button', { name: 'Continuar' }).click();
  await old.getByRole('button', { name: /^Continuar para o Platform/ }).click();
  await expect(old).toHaveURL(new RegExp(`/o/${org}$`));
  await old.getByRole('button', { name: 'Sair' }).click();
  await oldCtx.close();

  // identidade com o MESMO e-mail (cadastro real); a organização antiga ainda não aparece
  const page = await (await browser.newContext()).newPage();
  const person = await signUpAndEnroll(page, 'vinc', email);
  await expect(page.getByText('Organização antiga', { exact: false })).toHaveCount(0);

  // prova errada da conta antiga: recusa genérica, nada vinculado
  await page.goto('/vincular-conta');
  await page.getByLabel(/^Identificador da organização/).fill(org);
  await page.getByLabel(/^Senha da conta antiga/).fill(`${OLD_PASSWORD}-errada`);
  await page.getByLabel('Código do autenticador da conta antiga').fill(await oldAuth.next());
  await page.getByRole('button', { name: 'Conferir conta antiga' }).click();
  await expect(page.getByText('Não foi possível confirmar a conta antiga com esses dados.', { exact: false })).toBeVisible();

  // prova 1 (conta antiga) e prova 2 (identidade, step-up)
  await page.getByLabel(/^Senha da conta antiga/).fill(OLD_PASSWORD);
  await page.getByLabel('Código do autenticador da conta antiga').fill(await oldAuth.next());
  await page.getByRole('button', { name: 'Conferir conta antiga' }).click();
  await expect(page.getByText('Conta antiga conferida. Nada foi vinculado ainda.')).toBeVisible();
  await page.getByRole('button', { name: 'Vincular à minha identidade' }).click();
  await confirmStepUp(page, person, 'Vincular');
  await expect(page.getByText('Conta vinculada.')).toBeVisible();
  await page.getByRole('button', { name: 'Ver minhas organizações' }).click();
  await expect(page.getByRole('heading', { name: /Organização antiga/ })).toBeVisible();

  // a entrada local antiga deixa de valer: a mesma recusa genérica do login
  const after = await (await browser.newContext()).newPage();
  await after.goto(`/o/${org}/login`);
  await after.getByRole('textbox', { name: /E-mail/ }).fill(email);
  await after.getByLabel(/^Senha/).fill(OLD_PASSWORD);
  await after.getByLabel(/^Senha/).press('Enter');
  await expect(after.getByText('E-mail ou senha incorretos.')).toBeVisible();
  console.log(`vinculacao org=${org}`);
});
