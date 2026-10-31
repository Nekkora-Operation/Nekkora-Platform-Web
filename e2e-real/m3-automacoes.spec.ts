import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { confirmStepUp, LAB, signUpAndEnroll, type Person } from './support/lab';

/**
 * M3 contra a API REAL: pacote real gerado pelo Studio (fixture versionada da API, `pacote-studio-real`), compactado por
 * tools/lab/empacotar.py. A conferência é do servidor; a impressão esperada é a que a própria API registra no teste dela.
 */
const PKG = `tools/lab/saidas/${LAB}/pacotes`;
const REAL = `${PKG}/pacote-studio-real.zip`;
const STORED = `${PKG}/pacote-studio-real-stored.zip`;
const INVALID = `${PKG}/invalido.zip`;
const REAL_FINGERPRINT = '5664f1a56556e8137dc6e62c435485469e18501d853a8f51268cb377ce1c0b3d';
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function setupOrganization(page: Page, person: Person) {
  const name = `Ensaio M3 ${Date.now().toString(36)}`;
  await page.goto('/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, person, 'Criar organização');
  await page.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  return /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];
}

test('J10/J11: automação, versão, ZIP inválido recusado, pacote real conferido, troca entre conferência e publicação recusada, publicação imutável', async ({ page, context }) => {
  const ana = await signUpAndEnroll(page, 'j10');
  const org = await setupOrganization(page, ana);

  await page.goto(`/o/${org}/workspaces`);
  await page.getByRole('button', { name: 'Criar workspace' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome/).fill('Operações');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Operações' })).toBeVisible();

  await page.getByRole('button', { name: 'Criar automação' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome da automação/).fill('Biografias da Wikipédia');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar automação' }).click();
  await expect(page.getByRole('heading', { name: 'Biografias da Wikipédia' })).toBeVisible();

  await page.getByRole('button', { name: 'Nova versão' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${org}/versoes/[0-9a-f-]{36}$`));
  const versionId = /versoes\/([0-9a-f-]{36})/.exec(page.url())![1];
  await expect(page.getByText('Rascunho', { exact: true })).toBeVisible();
  await expect(page.getByText('Esta versão ainda não tem pacote.')).toBeVisible();

  // J11: ZIP inválido → 422 com motivo de vocabulário fechado
  await page.getByLabel('Arquivo .zip do pacote').setInputFiles(INVALID);
  await page.getByRole('button', { name: 'Enviar pacote' }).click();
  await expect(page.getByText(/O pacote foi recusado pela conferência da Platform: o arquivo não é um ZIP válido/)).toBeVisible();

  // pacote real: conferido pelo servidor (sha256 dos bytes ≠ impressão do pacote)
  await page.getByLabel('Arquivo .zip do pacote').setInputFiles(REAL);
  await page.getByRole('button', { name: 'Enviar pacote' }).click();
  await expect(page.getByText('Pacote recebido e conferido pela Platform.')).toBeVisible();
  await expect(page.getByText(sha256(REAL), { exact: true }).first()).toBeVisible();
  await expect(page.getByText(REAL_FINGERPRINT, { exact: true })).toBeVisible();
  await expect(page.getByText(/declarado no manifesto, não verificado|Não declarado/)).toBeVisible();

  // a pessoa abre a publicação (valores conferidos fixados) …
  await page.getByRole('button', { name: 'Publicar versão' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(sha256(REAL));
  await dialog.getByLabel('Impressão esperada (opcional)').fill(REAL_FINGERPRINT);
  await dialog.getByLabel('Conferi o pacote desta versão.').check();

  // … e, em outra aba, o artefato do rascunho é trocado (mesmo conteúdo, outros bytes)
  const other = await context.newPage();
  await other.goto(`/o/${org}/versoes/${versionId}`);
  await other.getByLabel('Arquivo .zip do pacote').setInputFiles(STORED);
  await other.getByRole('button', { name: 'Enviar pacote' }).click();
  await expect(other.getByText('Pacote recebido e conferido pela Platform.')).toBeVisible();
  await other.close();

  // publicar com a conferência antiga: a API recusa (409) sem aceitar o conteúdo novo
  await confirmStepUp(page, ana, 'Publicar');
  await expect(dialog).toContainText('o pacote mudou depois da sua conferência');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByText(sha256(STORED), { exact: true }).first()).toBeVisible();

  // conferir de novo e publicar
  await page.getByRole('button', { name: 'Publicar versão' }).click();
  await expect(dialog).toContainText(sha256(STORED));
  await dialog.getByLabel('Conferi o pacote desta versão.').check();
  await confirmStepUp(page, ana, 'Publicar');
  await expect(page.getByText('Publicada (imutável)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar pacote' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publicar versão' })).toHaveCount(0);

  // estado persistido, lido da própria API com a sessão do navegador
  const res = await page.request.get(`/api/v1/o/${org}/automation-versions/${versionId}`);
  expect(res.status()).toBe(200);
  const v = await res.json();
  expect(v.status).toBe('PUBLISHED');
  expect(v.artifact.sha256).toBe(sha256(STORED));
  expect(v.artifact.fingerprint).toBe(REAL_FINGERPRINT);
  expect(v.publishedAt).toBeTruthy();
});
