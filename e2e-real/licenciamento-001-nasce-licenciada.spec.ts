import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { confirmStepUp, LAB, signUpAndEnroll } from './support/lab';

/**
 * PLATFORM-LICENCIAMENTO-001 — A ORGANIZAÇÃO CRIADA PELO ADMINISTRADOR NASCE OPERACIONAL PARA CONFIGURAÇÃO, pela Web de
 * produção, contra a API real do laboratório descartável, com a chave da D7 JÁ LIGADA pelo preparo do laboratório
 * (`tools/lab/licencas-novas.sh <id> ligar "<quem autorizou>"`). O roteiro NÃO liga a chave e não ativa nada.
 *
 *   1. antes de criar, a tela diz que a organização nasce pronta para configurar e que executar e monitorar depende de
 *      licença; não diz "aguardando ativação" nem fala em aprovação da Nekkora para começar;
 *   2. criada, a lista separa a SITUAÇÃO ("Situação: ativa") da DISPONIBILIDADE DE EXECUÇÃO ("Execução: por licença");
 *   3. dentro dela, o Início não fala em ativação; a tela de licenças diz que ainda não há licença;
 *   4. a preparação não é bloqueada: um Worker é cadastrado sem ativação e sem licença.
 *
 *   FRONT_LAB_ID=<lab> FRONT_PORTA=<porta> npx playwright test -c playwright.real.config.ts licenciamento-001-nasce-licenciada
 */
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-licenciamento-001-nasce-licenciada`);
const TAG = Date.now().toString(36);

const sql = (q: string) => (compose(LAB, ['exec', '-T', 'postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'nekkora', '-d', 'nekkora', '-c', q]) as string).trim();
const log = (k: string, v: unknown) => {
  mkdirSync(EVID, { recursive: true });
  const line = `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
  appendFileSync(join(EVID, 'roteiro.txt'), `${line}\n`);
  console.log(line);
};
const shot = async (page: Page, name: string) => {
  mkdirSync(EVID, { recursive: true });
  await page.screenshot({ path: join(EVID, `${name}.png`), fullPage: true });
};

let retried = 0;
async function settle(page: Page) {
  for (let i = 0; i < 4; i++) {
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const retry = page.getByRole('button', { name: 'Tentar novamente' });
    if ((await retry.count()) === 0) return;
    retried++;
    await page.waitForTimeout(20_000);
    await retry.first().click().catch(() => undefined);
    await page.waitForTimeout(1_500);
  }
}
async function go(page: Page, url: string) {
  await page.waitForTimeout(4_000);
  await page.goto(url);
  await settle(page);
}

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('PLATFORM-LICENCIAMENTO-001: a organização criada pelo administrador nasce pronta para configurar, sem "aguardando ativação"', async ({ browser }) => {
  test.setTimeout(900_000);
  rmSync(EVID, { recursive: true, force: true });
  log('laboratorio', readFileSync(resolve(`tools/lab/saidas/${LAB}/laboratorio.txt`), 'utf8').replace(/\n/g, ' | '));
  const chave = sql("SELECT new_organizations_licensed || ' | por: ' || updated_by FROM license_rollout");
  log('chave_da_D7', chave);
  expect(chave, 'a chave da D7 é ligada pelo PREPARO do laboratório (licencas-novas.sh), não por este roteiro').toMatch(/^true \| /);

  const page = await (await browser.newContext()).newPage();
  const dora = await signUpAndEnroll(page, 'lic-nasce');
  const name = `Nascente ${TAG}`;

  // ================================================================ 1. antes de criar: o que a tela promete
  await go(page, '/organizacoes/nova');
  await expect(page.getByText('A organização nasce pronta para configurar.')).toBeVisible();
  await expect(page.getByText(/sem depender de aprovação da Nekkora\. Para executar e monitorar uma automação, vincule a ela uma licença vigente\./).first()).toBeVisible();
  await expect(page.getByText(/aguardando ativação/i)).toHaveCount(0);
  await expect(page.getByText(/nenhuma máquina pode ser registrada/)).toHaveCount(0);
  await shot(page, '1-antes-de-criar');
  log('1_antes_de_criar', { pela_tela: true, diz: 'nasce pronta para configurar; executar e monitorar depende de licenca', aguardando_ativacao_na_tela: 0 });

  // ================================================================ 2. criar pela tela; a lista separa situação e execução
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('alertdialog').getByText(/Ela nasce pronta para configurar, sem depender de aprovação da Nekkora\./)).toBeVisible();
  await confirmStepUp(page, dora, 'Criar organização');
  await settle(page);
  await expect(page).toHaveURL(/\/organizacoes$/);
  const item = page.getByRole('list', { name: 'Organizações', exact: true }).getByRole('listitem').filter({ hasText: name });
  await expect(item.getByText('Execução: por licença', { exact: true })).toBeVisible();
  await expect(item.getByText(/aguardando ativação/i)).toHaveCount(0);
  const responsavel = page.getByRole('list', { name: 'Organizações sob sua responsabilidade' }).getByRole('listitem').filter({ hasText: name });
  await expect(responsavel.getByText('Situação: ativa', { exact: true })).toBeVisible();
  await expect(page.getByText('Ativa', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/aguardando ativação/i)).toHaveCount(0);
  await shot(page, '2-lista-situacao-e-execucao');
  const org = sql(`SELECT o.organization_id FROM organizations o JOIN organization_responsibility r ON r.organization_id = o.organization_id JOIN identities i ON i.identity_id = r.responsible_identity_id WHERE i.email = '${dora.email}' AND o.name = '${name}'`);
  expect(org).toMatch(/^[0-9a-f-]{36}$/);
  const modelo = sql(`SELECT 'modelo=' || e.model || ' ato=' || a.act || ' autorizado_por=' || (a.detail->>'rolloutAuthorizedBy') FROM organization_license_enforcement e JOIN organization_license_acts a ON a.act_id = e.act_id WHERE e.organization_id = '${org}'`);
  expect(modelo).toMatch(/^modelo=2 ato=8 /);
  log('2_criada', { pela_tela: true, lista: '"Execucao: por licenca"', sob_sua_responsabilidade: '"Situacao: ativa"', banco: modelo });

  // ================================================================ 3. dentro dela: o Início não fala em ativação; licenças dizem a verdade
  await page.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await settle(page);
  await expect(page.getByText('Execução: por licença', { exact: true })).toBeVisible();
  await expect(page.getByText(/aguardando ativação/i)).toHaveCount(0);
  await expect(page.getByText(/Para executar e monitorar uma automação, vincule a ela uma licença vigente\./).first()).toBeVisible();
  await shot(page, '3-inicio');
  await go(page, `/o/${org}/administracao/licencas`);
  await expect(page.getByText('Esta organização exige licença.')).toBeVisible();
  await expect(page.getByText('Esta organização ainda não tem licenças.')).toBeVisible();
  await shot(page, '3-licencas');
  log('3_dentro', { inicio: 'sem "aguardando ativacao"; diz que executar e monitorar depende de licenca', licencas: 'exige licenca; ainda nao tem licencas' });

  // ================================================================ 4. a preparação não é bloqueada: Worker sem ativação e sem licença
  await go(page, `/o/${org}/workers`);
  await page.getByRole('heading', { name: 'Máquinas', level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Cadastrar máquina' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel(/^Nome da máquina/).fill('Máquina da nascente');
  await dialog.getByRole('button', { name: 'Cadastrar máquina' }).click();
  await settle(page);
  await expect(page.getByText('Máquina Máquina da nascente cadastrada, sem computador vinculado.', { exact: false })).toBeVisible();
  await shot(page, '4-worker-criado');
  const ativacao = sql(`SELECT state FROM ops_activation.organization_states WHERE organization_id = '${org}'`);
  expect(ativacao, 'nada foi ativado: o ciclo de ativação do modelo anterior não foi tocado').toBe('1');
  log('4_preparacao', { worker: 'cadastrado pela tela, sem ativacao e sem licenca', ativacao_do_modelo_anterior: 'intocada (nada foi ativado)', licencas_concedidas: sql(`SELECT count(*) FROM organization_licenses WHERE organization_id = '${org}'`) });

  log('limites_de_frequencia', `nenhum limite foi zerado. "Tentar novamente" usado ${retried} vez(es)`);
  log('fim', 'roteiro da organizacao que nasce pronta para configurar concluido');
});
