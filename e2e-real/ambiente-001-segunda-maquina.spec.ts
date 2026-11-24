import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { Authenticator } from '../mock/totp';
import { activateAutomation, confirmStepUp, signInWithTotp, type Person } from './support/lab';
import { abrirExe, comando, GUARDADO, sql } from './support/ambiente';

/**
 * AMBIENTE-PYTHON-001 — SEGUNDA MÁQUINA do laboratório (a mesma cópia do Client, com outra pasta de dados: exe-dados2). A
 * primeira ficou, como o produto manda, em "ocupação incerta" depois da queda com a automação rodando (cenário 6): só a própria
 * máquina, com prova, a libera. Cadastra, habilita pelo executável, autoriza no ambiente e ativa nela os robôs dos cenários 7 a 10.
 */
const WORKER = 'Estação gerenciada 2';
const MAQUINA = 'PC do laboratorio 2';
const ROBOS = ['Robô navegador', 'Robô sem navegador', 'Robô preparado', 'Robô dependências'];
test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

test('AMBIENTE-PYTHON-001: segunda máquina', async ({ browser }) => {
  test.setTimeout(2_400_000);
  const g = JSON.parse(readFileSync(GUARDADO, 'utf8'));
  const ana: Person = { email: g.ana.email, password: g.ana.password, name: g.ana.name, auth: new Authenticator(g.ana.secret), recoveryCodes: [] };
  const page = await (await browser.newContext()).newPage();
  const aberto = await abrirExe();
  expect(aberto.estado).toBe('NOT_ENABLED');
  await signInWithTotp(page, ana);
  await page.getByRole('button', { name: `Entrar em ${g.oficinaName}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await page.goto(`/o/${g.oficina}/workers`);
  await page.getByRole('heading', { name: 'Máquinas', level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Cadastrar máquina' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill(WORKER);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cadastrar máquina' }).click();
  await settle(page);
  await page.waitForTimeout(3_000);
  await page.goto(`/o/${g.oficina}/workers`);
  await settle(page);
  await page.getByRole('button', { name: `Vincular Agent a ${WORKER}` }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill(MAQUINA);
  await page.getByRole('alertdialog').getByLabel('Habilitar esta máquina para execução remota').check();
  await page.waitForTimeout(31_000);
  await confirmStepUp(page, ana, 'Gerar código');
  const codigo = (await page.getByLabel('Código de uso único').innerText()).trim();
  const l = await comando('habilitar', codigo);
  expect(l.estado, JSON.stringify(l)).toBe('RECEIVING');
  await page.getByRole('button', { name: 'Concluir' }).click();
  await page.waitForTimeout(3_000);
  await page.goto(`/o/${g.oficina}/workers`);
  await settle(page);
  await page.getByRole('button', { name: `Autorizar ${WORKER} num ambiente de trabalho` }).click();
  await page.getByRole('alertdialog').getByLabel('Ambiente de trabalho').selectOption(g.workspaceId);
  await page.waitForTimeout(31_000);
  await confirmStepUp(page, ana, 'Autorizar');
  await settle(page);
  await comando('python');
  for (const nome of ROBOS) {
    await page.waitForTimeout(31_000);
    await activateAutomation(page, ana, g.oficina, { workspace: 'Fiscal', automation: nome, workers: [WORKER] });
  }
  const worker2 = sql(`SELECT worker_id FROM workers WHERE organization_id = '${g.oficina}' AND name = '${WORKER}'`);
  const agente2 = sql(`SELECT agent_id FROM agent_remote_enablements WHERE worker_id = '${worker2}' ORDER BY enabled_at DESC LIMIT 1`);
  writeFileSync(GUARDADO, JSON.stringify({ ...JSON.parse(readFileSync(GUARDADO, 'utf8')), agente2, maquina2: MAQUINA }));
  console.log(JSON.stringify({ agente2 }));
});
