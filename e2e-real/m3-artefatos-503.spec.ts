import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { confirmStepUp, LAB, signUpAndEnroll } from './support/lab';

/**
 * 503 de artefatos contra a API REAL (FRONT-V1-002). Pré-condição do LABORATÓRIO (declarada, registrada em fixtures.txt):
 * o serviço platform é recriado sem NEKKORA_ARTEFATOS_DIR (ArtifactStore.NONE) e volta ao normal no fim, mesmo com falha.
 * Prova: mensagem certa, nenhuma confirmação falsa de envio e a versão continua sem pacote.
 */
const PKG = `tools/lab/saidas/${LAB}/pacotes/pacote-studio-real.zip`;
const lab = (...args: string[]) => execFileSync('node', ['tools/lab/lab.mjs', LAB, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

test.afterAll(() => {
  lab('artefatos', 'on');
});

test('503 de artefatos: armazenamento não configurado, nada gravado, nenhuma confirmação falsa', async ({ page }) => {
  test.setTimeout(400_000);
  const ana = await signUpAndEnroll(page, 'a503');
  const name = `Ensaio 503 ${Date.now().toString(36)}`;
  await page.goto('/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, ana, 'Criar organização');
  await page.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  const org = /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];

  await page.goto(`/o/${org}/workspaces`);
  await page.getByRole('button', { name: 'Criar workspace' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome/).fill('Operações');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
  await page.getByRole('button', { name: 'Criar automação' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome da automação/).fill('Biografias da Wikipédia');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar automação' }).click();
  await page.getByRole('button', { name: 'Nova versão' }).click();
  await expect(page).toHaveURL(/\/versoes\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Esta versão ainda não tem pacote.')).toBeVisible();

  // laboratório sem armazenamento (recria só o platform; sessões e dados ficam no banco/Redis)
  lab('artefatos', 'off');
  await page.reload();
  await expect(page.getByText('Esta versão ainda não tem pacote.')).toBeVisible();
  const uploads: number[] = [];
  page.on('response', (r) => {
    if (r.request().method() === 'PUT' || (r.request().method() === 'POST' && /artifact|pacote/.test(r.url()))) uploads.push(r.status());
  });
  await page.getByLabel('Arquivo .zip do pacote').setInputFiles(PKG);
  await page.getByRole('button', { name: 'Enviar pacote' }).click();
  await expect(page.getByText(/O armazenamento de pacotes não está disponível neste ambiente/)).toBeVisible();
  await expect(page.getByText('Pacote recebido e conferido pela Platform.')).toHaveCount(0);
  expect(uploads).toEqual([503]);
  await page.reload();
  await expect(page.getByText('Esta versão ainda não tem pacote.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publicar versão' })).toHaveCount(0);
});
