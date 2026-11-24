import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { activateAutomation, confirmStepUp, LAB, newVersionWithPackage, signUpAndEnroll, type Person } from './support/lab';
import { comando, EXTRAS, GUARDADO, LABDIR, ROBOS, sql } from './support/ambiente';

/**
 * AMBIENTE-PYTHON-001 — PREPARO do laboratório da validação de ponta a ponta (não é o teste: só monta o cenário, pela tela,
 * como uma pessoa faria). Laboratório DESCARTÁVEL frontlab-amb001 (API 3f0e3cf com a 076, chave do ambiente por execução
 * ligada SÓ nele), Web desta branch em 5197 e a CÓPIA DE LABORATÓRIO do Client empacotado (condutor por dentro do processo,
 * botões reais). Duas pessoas SINTÉTICAS (operadora e administradora), guardadas só na pasta de segredos do laboratório.
 *
 * Procedimento administrativo por SQL, registrado: a designação da organização interna e o cadastro da operadora (como nos
 * outros roteiros). Nenhum limite é zerado.
 *
 *   FRONT_LAB_ID=frontlab-amb001 FRONT_PORTA=5197 npx playwright test -c playwright.real.config.ts ambiente-001-preparo
 */
const TAG = Date.now().toString(36);
const SEG = join(homedir(), '.nekkora', 'front-lab', LAB, 'segredos.env');
const MAQUINA = 'Estação gerenciada';
const day = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
async function settle(page: Page) {
  for (let i = 0; i < 4; i++) {
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const retry = page.getByRole('button', { name: 'Tentar novamente' });
    if ((await retry.count()) === 0) return;
    await page.waitForTimeout(20_000);
    await retry.first().click().catch(() => undefined);
    await page.waitForTimeout(1_500);
  }
}
async function go(page: Page, url: string) {
  await page.waitForTimeout(3_000);
  await page.goto(url);
  await settle(page);
}
/** R7 (60 por sessão, repõe 2/s) não é afrouxado: antes de cada confirmação reforçada, espera a reposição. */
async function confirmar(page: Page, person: Person, label: string) {
  await page.waitForTimeout(31_000);
  await confirmStepUp(page, person, label);
}
async function createOrganization(page: Page, person: Person, name: string) {
  await go(page, '/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmar(page, person, 'Criar organização');
  await settle(page);
  await expect(page.getByRole('button', { name: `Entrar em ${name}` })).toBeVisible();
}
async function enter(page: Page, name: string): Promise<string> {
  await go(page, '/organizacoes');
  await page.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await settle(page);
  return /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];
}
function designarOperadoraSql(user: string, org: string): string {
  const o = 'preparo AMBIENTE-PYTHON-001';
  return [
    `INSERT INTO nekkora_internal_organization_designations (organization_id, designated_by, designation_ticket, designation_reason) SELECT '${org}', '${o}', 'LAB-AMB001', 'organizacao interna do laboratorio' WHERE NOT EXISTS (SELECT 1 FROM nekkora_internal_organization_designations WHERE withdrawn_at IS NULL)`,
    `INSERT INTO license_operators (operator_user_id, organization_id, registered_by, registration_ticket, registration_justification) VALUES ('${user}', '${org}', '${o}', 'LAB-AMB001', 'operadora sintetica do laboratorio')`,
  ].join('; ');
}

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('AMBIENTE-PYTHON-001: preparo do laboratório', async ({ browser }) => {
  test.setTimeout(3_600_000);
  expect(existsSync(GUARDADO), `o cenário já foi preparado (${GUARDADO}); não repita`).toBe(false);
  const naraPage = await (await browser.newContext()).newPage();
  const anaPage = await (await browser.newContext()).newPage();

  // 1. a operadora: organização interna (designada por procedimento) e a Platform com a variável dela (e a chave do ambiente)
  const nara = await signUpAndEnroll(naraPage, 'amb-op');
  const suporte = `Nekkora Suporte ${TAG}`;
  await createOrganization(naraPage, nara, suporte);
  const orgN = await enter(naraPage, suporte);
  const naraUser = sql(`SELECT user_id FROM users WHERE organization_id = '${orgN}' AND email = '${nara.email}'`);
  sql(designarOperadoraSql(naraUser, orgN));
  const env = readFileSync(SEG, 'utf8');
  writeFileSync(SEG, `${env.replace(/^LAB_LICENCAS_ORGANIZACAO_OPERADORA=.*\n/m, '')}LAB_LICENCAS_ORGANIZACAO_OPERADORA=${orgN}\n`);
  compose(LAB, ['up', '-d', '--no-deps', '--wait', 'platform'], { stdio: ['ignore', 'ignore', 'inherit'] }, EXTRAS);
  await expect
    .poll(async () => (await naraPage.request.get('/api/v1/csrf').catch(() => null))?.status() ?? 0, { timeout: 180_000, intervals: [2_000] })
    .toBe(200);

  // 2. a administradora e a organização cliente
  const ana = await signUpAndEnroll(anaPage, 'amb-adm');
  const guardar = (x: Person) => ({ email: x.email, password: x.password, name: x.name, secret: (x.auth as unknown as { secret: string }).secret });
  const oficinaName = `Oficina gerenciada ${TAG}`;
  await createOrganization(anaPage, ana, oficinaName);
  const oficina = await enter(anaPage, oficinaName);
  mkdirSync(resolve(GUARDADO, '..'), { recursive: true });
  writeFileSync(GUARDADO, JSON.stringify({ nara: guardar(nara), ana: guardar(ana), orgN, oficina, oficinaName }));

  // 3. a operadora, pela tela: licenças de 30 dias (uma por robô) e a exigência ligada
  await go(naraPage, `/o/${orgN}/operador-de-licencas`);
  await naraPage.getByLabel('Identificador da organização').fill(oficina);
  await naraPage.getByRole('button', { name: 'Abrir' }).click();
  await naraPage.getByRole('button', { name: 'Conceder licenças' }).click();
  const grant = naraPage.getByRole('alertdialog');
  await grant.getByLabel('Quantidade').fill(String(ROBOS.length));
  await grant.getByLabel('Início da validade').fill(day(0));
  await grant.getByLabel('Fim da validade').fill(day(30));
  await grant.getByLabel('Justificativa').fill('laboratorio AMBIENTE-PYTHON-001: uma licenca por robo');
  await confirmar(naraPage, nara, 'Conceder');
  await settle(naraPage);
  await expect(naraPage.getByText(/Licenças concedidas\./)).toBeVisible();
  await naraPage.getByRole('button', { name: 'Ligar a exigência de licença' }).click();
  const enforce = naraPage.getByRole('alertdialog');
  await enforce.getByLabel('Justificativa').fill('laboratorio AMBIENTE-PYTHON-001: modelo por licenca');
  await enforce.getByRole('checkbox', { name: /Conferi a prévia/ }).check();
  await confirmar(naraPage, nara, 'Ligar a exigência');
  await settle(naraPage);

  // 4. ambiente e os robôs sintéticos publicados, cada um com "Só as do pacote"
  await go(anaPage, `/o/${oficina}/workspaces`);
  await anaPage.getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
  await anaPage.getByRole('alertdialog').getByLabel(/^Nome/).fill('Fiscal');
  await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
  await expect(anaPage).toHaveURL(new RegExp(`/o/${oficina}/workspaces/[0-9a-f-]{36}$`));
  await settle(anaPage);
  const workspaceUrl = anaPage.url();
  const workspaceId = /workspaces\/([0-9a-f-]{36})/.exec(workspaceUrl)![1];
  const automacoes: Record<string, { automation: string; version: string }> = {};
  for (const r of ROBOS) {
    await go(anaPage, workspaceUrl);
    await anaPage.getByRole('button', { name: 'Criar automação' }).click();
    await settle(anaPage);
    await anaPage.getByLabel(/^Nome da automação/).fill(r.nome);
    await anaPage.getByRole('radio', { name: /Só o nome, como rascunho/ }).check();
    await anaPage.getByRole('button', { name: 'Salvar rascunho' }).click();
    await settle(anaPage);
    await expect(anaPage.getByRole('heading', { name: r.nome })).toBeVisible();
    const automationUrl = anaPage.url();
    const url = await newVersionWithPackage(anaPage, join(LABDIR, 'robos', r.zip));
    await anaPage.getByRole('button', { name: 'Publicar versão' }).click();
    await confirmar(anaPage, ana, 'Publicar');
    await settle(anaPage);
    const id = /versoes\/([0-9a-f-]{36})/.exec(url)![1];
    await expect.poll(() => sql(`SELECT status FROM automation_versions WHERE automation_version_id = '${id}'`), { timeout: 60_000 }).toBe('2');
    await go(anaPage, automationUrl);
    const deps = anaPage.locator('section').filter({ has: anaPage.getByRole('heading', { name: 'Dependências de execução' }) });
    await deps.getByRole('button', { name: /Declarar dependências|Declarar de novo/ }).click();
    await deps.getByRole('radio', { name: /Só as do pacote/ }).check();
    await deps.getByRole('button', { name: 'Declarar', exact: true }).click();
    await expect(deps.getByText(/Dependências declaradas \(revisão \d+\)/)).toBeVisible({ timeout: 30_000 });
    automacoes[r.nome] = { automation: /automacoes\/([0-9a-f-]{36})/.exec(automationUrl)![1], version: id };
  }

  // 5. a máquina: cadastrada, habilitada pelo Client empacotado (o código vai pelo condutor) e autorizada no ambiente
  await go(anaPage, `/o/${oficina}/workers`);
  await anaPage.getByRole('heading', { name: 'Máquinas', level: 1 }).waitFor();
  await anaPage.getByRole('button', { name: 'Cadastrar máquina' }).click();
  await anaPage.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill(MAQUINA);
  await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Cadastrar máquina' }).click();
  await settle(anaPage);
  await go(anaPage, `/o/${oficina}/workers`);
  await anaPage.getByRole('button', { name: `Vincular Agent a ${MAQUINA}` }).click();
  await anaPage.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill('PC do laboratorio');
  await anaPage.getByRole('alertdialog').getByLabel('Habilitar esta máquina para execução remota').check();
  await confirmar(anaPage, ana, 'Gerar código');
  const codigo = (await anaPage.getByLabel('Código de uso único').innerText()).trim();
  const l = await comando('habilitar', codigo);
  expect(l.estado, JSON.stringify(l)).toBe('RECEIVING');
  await anaPage.getByRole('button', { name: 'Concluir' }).click();
  await go(anaPage, `/o/${oficina}/workers`);
  await anaPage.getByRole('button', { name: `Autorizar ${MAQUINA} num ambiente de trabalho` }).click();
  await anaPage.getByRole('alertdialog').getByLabel('Ambiente de trabalho').selectOption(workspaceId);
  await confirmar(anaPage, ana, 'Autorizar');
  await settle(anaPage);
  await comando('python');

  // 6. cada robô ativado na máquina (uma licença cada)
  for (const r of ROBOS) {
    await activateAutomation(anaPage, ana, oficina, { workspace: 'Fiscal', automation: r.nome, workers: [MAQUINA] });
    await settle(anaPage);
  }
  const agente = sql(`SELECT agent_id FROM agent_remote_enablements WHERE organization_id = '${oficina}' ORDER BY enabled_at DESC LIMIT 1`);
  writeFileSync(GUARDADO, JSON.stringify({ nara: guardar(nara), ana: guardar(ana), orgN, oficina, oficinaName, workspaceId, agente, maquina: MAQUINA, automacoes }));
  console.log(JSON.stringify({ oficina, workspaceId, agente, automacoes }, null, 1));
});
