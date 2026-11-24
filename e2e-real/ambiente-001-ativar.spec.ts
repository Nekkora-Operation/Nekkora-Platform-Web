import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { Authenticator } from '../mock/totp';
import { activateAutomation, signInWithTotp, type Person } from './support/lab';
import { GUARDADO } from './support/ambiente';

/**
 * AMBIENTE-PYTHON-001 — ativa robôs do laboratório numa máquina já cadastrada (AMB_ROBOS="Robô a,Robô b", AMB_WORKER).
 * Usado para levar à segunda máquina um robô que só estava ativo na primeira.
 */
test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('AMBIENTE-PYTHON-001: ativar robôs numa máquina', async ({ browser }) => {
  test.setTimeout(900_000);
  const g = JSON.parse(readFileSync(GUARDADO, 'utf8'));
  const ana: Person = { email: g.ana.email, password: g.ana.password, name: g.ana.name, auth: new Authenticator(g.ana.secret), recoveryCodes: [] };
  const worker = process.env.AMB_WORKER ?? 'Estação gerenciada 2';
  const robos = (process.env.AMB_ROBOS ?? '').split(',').filter(Boolean);
  expect(robos.length).toBeGreaterThan(0);
  const page = await (await browser.newContext()).newPage();
  await signInWithTotp(page, ana);
  await page.getByRole('button', { name: `Entrar em ${g.oficinaName}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  for (const nome of robos) {
    await page.waitForTimeout(31_000);
    await activateAutomation(page, ana, g.oficina, { workspace: 'Fiscal', automation: nome, workers: [worker] });
  }
});
