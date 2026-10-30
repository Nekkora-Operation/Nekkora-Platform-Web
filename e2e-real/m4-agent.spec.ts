import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { confirmStepUp, LAB, signUpAndEnroll, type Person } from './support/lab';

/**
 * M4 (J12) contra a API REAL e o Agent REAL (empacotado, cópia do laboratório: tools/lab/agent.ps1). A execução local
 * (J13–J15), com os atos da pessoa no Agent, está em m4-execucao.spec.ts. O código de pareamento
 * é lido da tela e entregue ao Agent pela entrada padrão do script (nunca em arquivo). Fixture DECLARADA: limites da
 * organização (010) — a ativação operacional não tem ferramenta no laboratório (B2).
 */
const PKG = `tools/lab/saidas/${LAB}/pacotes/pacote-studio-real.zip`;
const agent = (acao: string, input?: string, extra: string[] = []) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tools/lab/agent.ps1', '-Id', LAB, '-Acao', acao, ...extra], {
    input,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (r.status !== 0) throw new Error(`agent.ps1 ${acao} falhou: ${r.stderr || r.stdout}`);
  return r.stdout;
};

const LABDIR = resolve(`tools/lab/saidas/${LAB}`);

async function prepareOrganization(page: Page, person: Person) {
  const name = `Ensaio M4 ${Date.now().toString(36)}`;
  await page.goto('/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, person, 'Criar organização');
  await page.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  const org = /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];
  execFileSync('node', ['tools/lab/lab.mjs', LAB, 'limites', org, person.email]);
  return org;
}

test('J12: código emitido na tela, pareamento do Agent real, presença, Worker no workspace e autorização de execução local', async ({ page }) => {
  test.setTimeout(900_000);
  // Agent do laboratório sem pareamento anterior (dados locais da cópia descartável)
  agent('parar');
  rmSync(`${LABDIR}/agent-dados/plataforma`, { recursive: true, force: true });
  const ana = await signUpAndEnroll(page, 'j12');
  const org = await prepareOrganization(page, ana);

  // versão publicada (o mesmo caminho do M3)
  await page.goto(`/o/${org}/workspaces`);
  await page.getByRole('button', { name: 'Criar workspace' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome/).fill('Operações');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Operações' })).toBeVisible();
  const workspaceId = /workspaces\/([0-9a-f-]{36})/.exec(page.url())![1];
  await page.getByRole('button', { name: 'Criar automação' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome da automação/).fill('Biografias da Wikipédia');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar automação' }).click();
  await page.getByRole('button', { name: 'Nova versão' }).click();
  await expect(page).toHaveURL(/\/versoes\/[0-9a-f-]{36}$/);
  const versionUrl = page.url();
  await page.getByLabel('Arquivo .zip do pacote').setInputFiles(PKG);
  await page.getByRole('button', { name: 'Enviar pacote' }).click();
  await expect(page.getByText('Pacote recebido e conferido pela Platform.')).toBeVisible();
  await page.getByRole('button', { name: 'Publicar versão' }).click();
  await page.getByRole('alertdialog').getByLabel('Conferi o pacote desta versão.').check();
  await confirmStepUp(page, ana, 'Publicar');
  await expect(page.getByText('Publicada (imutável)')).toBeVisible();

  // código de pareamento com Worker novo (step-up); aparece só agora
  await page.goto(`/o/${org}/agents`);
  await expect(page.getByText('Nenhum Agent pareado.')).toBeVisible();
  await page.getByRole('button', { name: 'Parear novo Agent' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel(/^Nome da máquina/).fill('LAB-FRONT-01');
  await dialog.getByLabel(/^Nome do Worker/).fill('Worker do laboratório');
  await confirmStepUp(page, ana, 'Gerar código');
  const code = (await page.getByLabel('Código de uso único').innerText()).trim();
  expect(code).toMatch(/^nkp1\./);

  // a pessoa abre o Agent real e cola o código (teclado enviado à janela do Agent)
  agent('iniciar');
  agent('parear', `${code}\n`);
  await page.getByRole('button', { name: 'Concluir' }).click();

  // o Agent aparece ativo; a conexão depende do heartbeat dele (CONNECTED até 180 s do último sinal)
  const agentsText = async () => {
    await page.getByRole('button', { name: 'Atualizar' }).click();
    await page.getByRole('region', { name: 'Lista de Agents' }).waitFor({ timeout: 15_000 });
    return page.getByRole('region', { name: 'Lista de Agents' }).innerText().catch(() => '');
  };
  let seen = '';
  await page.waitForTimeout(5_000);
  console.log(`AGENTS: ${(await agentsText()).replace(/\s+/g, ' ')}`);
  await expect
    .poll(async () => (seen = await agentsText()), { timeout: 60_000, intervals: [3_000] })
    .toMatch(/LAB-FRONT-01[\s\S]*Ativo/);
  await expect
    .poll(async () => (seen = await agentsText()), { timeout: 240_000, intervals: [10_000] })
    .toMatch(/LAB-FRONT-01[\s\S]*Conectado/);
  // a listagem nunca devolve o código
  await expect(page.getByText(code)).toHaveCount(0);

  // Worker no workspace (step-up)
  await page.goto(`/o/${org}/workers`);
  await page.getByRole('button', { name: 'Autorizar Worker do laboratório num workspace' }).click();
  await page.getByRole('alertdialog').getByLabel('Workspace').selectOption(workspaceId);
  await confirmStepUp(page, ana, 'Autorizar');
  await expect(page.getByText('Worker autorizado no workspace.')).toBeVisible();

  // autorização de execução local (step-up) — não inicia nada
  await page.goto(versionUrl);
  await page.getByLabel(/^Worker autorizado neste workspace/).selectOption({ label: 'Worker do laboratório' });
  await page.getByRole('button', { name: 'Autorizar execução local' }).click();
  await confirmStepUp(page, ana, 'Autorizar execução local');
  await expect(page.getByText(/Execução local autorizada\. Nada foi iniciado/)).toBeVisible();
  await page.waitForTimeout(3_000);
  console.log(`AUTORIZACOES: ${(await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(-700)}`);
  await expect(page.getByRole('table', { name: 'Autorizações de execução local.' })).toContainText('Vigente');

  // sem execução iniciada no Agent, a supervisão está vazia (nada foi despachado)
  await page.goto(`/o/${org}/supervisao`);
  await expect(page.getByText('Nenhuma execução local registrada.')).toBeVisible();

  console.log(`J12 org=${org} workspace=${workspaceId} versao=${versionUrl.split('/').pop()}`);
});
