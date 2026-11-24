import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { Authenticator } from '../mock/totp';
import { activateAutomation, signInWithTotp, type Person } from './support/lab';
import { GUARDADO, ROBOS, sql } from './support/ambiente';

/**
 * AMBIENTE-PYTHON-001 — RETOMADA do preparo: ativa na máquina, pela tela, os robôs que ainda não têm licença vinculada e grava
 * o cenário (ids lidos do banco do laboratório). Só depois de ambiente-001-preparo ter montado pessoas, robôs e máquina.
 */
const MAQUINA = 'Estação gerenciada';
test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('AMBIENTE-PYTHON-001: retomada do preparo', async ({ browser }) => {
  test.setTimeout(1_800_000);
  const g = JSON.parse(readFileSync(GUARDADO, 'utf8'));
  const ana: Person = { email: g.ana.email, password: g.ana.password, name: g.ana.name, auth: new Authenticator(g.ana.secret), recoveryCodes: [] };
  const page = await (await browser.newContext()).newPage();
  await signInWithTotp(page, ana);
  await page.getByRole('button', { name: `Entrar em ${g.oficinaName}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  for (const r of ROBOS) {
    const ativo = sql(`SELECT count(*) FROM organization_license_assignments g JOIN automations a ON a.automation_id = g.automation_id WHERE a.organization_id = '${g.oficina}' AND a.name = '${r.nome}' AND g.released_at IS NULL`);
    if (ativo !== '0') continue;
    await page.waitForTimeout(31_000);
    await activateAutomation(page, ana, g.oficina, { workspace: 'Fiscal', automation: r.nome, workers: [MAQUINA] });
  }
  const automacoes: Record<string, { automation: string; version: string }> = {};
  for (const r of ROBOS) {
    const [automation, version] = sql(
      `SELECT a.automation_id, v.automation_version_id FROM automations a JOIN automation_versions v ON v.automation_id = a.automation_id AND v.status = 2 WHERE a.organization_id = '${g.oficina}' AND a.name = '${r.nome}' ORDER BY v.version_number LIMIT 1`,
    ).split('|');
    automacoes[r.nome] = { automation, version };
    expect(sql(`SELECT count(*) FROM organization_license_assignments WHERE automation_id = '${automation}' AND released_at IS NULL`)).toBe('1');
  }
  const workspaceId = sql(`SELECT workspace_id FROM workspaces WHERE organization_id = '${g.oficina}' AND name = 'Fiscal'`);
  const agente = sql(`SELECT agent_id FROM agent_remote_enablements WHERE organization_id = '${g.oficina}' ORDER BY enabled_at DESC LIMIT 1`);
  writeFileSync(GUARDADO, JSON.stringify({ ...g, workspaceId, agente, maquina: MAQUINA, automacoes }));
  console.log(JSON.stringify({ workspaceId, agente, automacoes }, null, 1));
});
