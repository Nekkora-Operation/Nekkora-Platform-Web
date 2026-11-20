import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Authenticator } from '../mock/totp';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { confirmStepUp, LAB, signInWithTotp, signUpAndEnroll, type Person } from './support/lab';

/**
 * PLATFORM-LICENCIAMENTO-001 — TRANSIÇÃO AUDITADA de uma organização que nasceu no modelo anterior e, depois, o percurso
 * "Worker sem licença → contratação simulada → Vincular à automação", pela Web de produção contra a API real do laboratório.
 *
 * A organização-alvo (ALVO_ORG) é de uma pessoa real do aceite: o roteiro NÃO entra nela e não usa a conta dela. Nela, só
 * age a operadora de licenças (Nara), pela TELA do operador, que é o procedimento auditado:
 *   1. prévia e "Ligar a exigência de licença" (ato registrado, com justificativa e confirmação reforçada). A ativação
 *      comercial do modelo anterior NÃO é usada: o estado dela fica como estava;
 *   4. concessão de UMA licença de teste (sem cobrança: a missão não tem cobrança), que nasce sem vínculo.
 * O que depende de quem administra (cadastrar Worker, vincular a licença) é exercitado, pela tela, numa organização GÊMEA,
 * de uma pessoa sintética, no mesmo modelo:
 *   2. Worker cadastrado sem licença nenhuma;
 *   3. licença concedida pela operadora; a conta vai de "1 disponível / 0 utilizada" a "0 disponíveis / 1 utilizada", e a
 *      tela mostra qual automação recebeu a licença. Sem automação, o diálogo diz para criar uma e leva aos workspaces.
 *
 *   ALVO_ORG=<id> FRONT_LAB_ID=<lab> FRONT_PORTA=<porta> npx playwright test -c playwright.real.config.ts licenciamento-001-transicao-e-vinculo
 */
const ALVO = process.env.ALVO_ORG ?? '';
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-licenciamento-001-transicao-e-vinculo`);
const SEG = join(homedir(), '.nekkora', 'front-lab', LAB);
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
const day = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** O que a pessoa criou na organização-alvo: tem de ser igual antes e depois de cada ato da operadora. */
const dados = (org: string) =>
  sql(
    `SELECT 'nome=' || o.name || ' workspaces=' || (SELECT count(*) FROM workspaces w WHERE w.organization_id = o.organization_id) || ' automacoes=' || (SELECT count(*) FROM automations a WHERE a.organization_id = o.organization_id) || ' workers=' || (SELECT count(*) FROM workers k WHERE k.organization_id = o.organization_id) || ' membros=' || (SELECT count(*) FROM organization_memberships m WHERE m.organization_id = o.organization_id) || ' responsavel=' || (SELECT count(*) FROM organization_responsibility r WHERE r.organization_id = o.organization_id) FROM organizations o WHERE o.organization_id = '${org}'`,
  );
const modelo = (org: string) =>
  sql(`SELECT 'modelo=' || e.model || ' ato=' || a.act FROM organization_license_enforcement e JOIN organization_license_acts a ON a.act_id = e.act_id WHERE e.organization_id = '${org}'`) || 'modelo anterior (sem ato)';
const ativacao = (org: string) => sql(`SELECT state FROM ops_activation.organization_states WHERE organization_id = '${org}'`);

async function openTarget(page: Page, orgN: string, target: string) {
  await go(page, `/o/${orgN}/operador-de-licencas`);
  await page.getByLabel('Identificador da organização').fill(target);
  await page.getByRole('button', { name: 'Abrir' }).click();
  await expect(page.getByRole('button', { name: 'Conceder licenças' })).toBeVisible();
  await settle(page);
}
async function grantOne(page: Page, nara: Person, why: string) {
  await page.getByRole('button', { name: 'Conceder licenças' }).click();
  const grant = page.getByRole('alertdialog');
  await grant.getByLabel('Quantidade').fill('1');
  await grant.getByLabel('Início da validade').fill(day(0));
  await grant.getByLabel('Fim da validade').fill(day(30));
  await grant.getByLabel('Justificativa').fill(why);
  await confirmStepUp(page, nara, 'Conceder');
  await settle(page);
  await expect(page.getByText(/Licenças concedidas\. Elas nascem sem vínculo/)).toBeVisible();
}

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('PLATFORM-LICENCIAMENTO-001: transição auditada da organização do aceite, Worker sem licença, concessão e "Vincular à automação"', async ({ browser }) => {
  test.setTimeout(1_200_000);
  expect(ALVO, 'informe ALVO_ORG: a organização do aceite').toMatch(/^[0-9a-f-]{36}$/);
  rmSync(EVID, { recursive: true, force: true });
  log('laboratorio', readFileSync(resolve(`tools/lab/saidas/${LAB}/laboratorio.txt`), 'utf8').replace(/\n/g, ' | '));
  log('chave_da_D7', sql("SELECT new_organizations_licensed || ' | por: ' || updated_by FROM license_rollout"));

  const guardada = JSON.parse(readFileSync(join(SEG, 'pessoas-roteiro-maquina.json'), 'utf8')).nara as { email: string; password: string; name: string; secret: string };
  const nara: Person = { email: guardada.email, password: guardada.password, name: guardada.name, auth: new Authenticator(guardada.secret), recoveryCodes: [] };
  const orgN = /^LAB_LICENCAS_ORGANIZACAO_OPERADORA=(.+)$/m.exec(readFileSync(join(SEG, 'segredos.env'), 'utf8'))![1].trim();
  const orgNName = sql(`SELECT name FROM organizations WHERE organization_id = '${orgN}'`);

  const naraPage = await (await browser.newContext()).newPage();
  await signInWithTotp(naraPage, nara);
  await settle(naraPage);
  await naraPage.getByRole('button', { name: `Entrar em ${orgNName}` }).click();
  await expect(naraPage).toHaveURL(new RegExp(`/o/${orgN}$`));
  await settle(naraPage);

  // ================================================================ 1. organização do aceite: prévia e transição auditada
  const antes = { dados: dados(ALVO), modelo: modelo(ALVO), ativacao: ativacao(ALVO), licencas: sql(`SELECT count(*) FROM organization_licenses WHERE organization_id = '${ALVO}'`) };
  log('1_alvo_antes', antes);
  await openTarget(naraPage, orgN, ALVO);
  if (antes.modelo.startsWith('modelo=2')) {
    await expect(naraPage.getByText('Modelo por licença (exigência ligada)')).toBeVisible();
    log('1_transicao', 'a organizacao ja estava no modelo por licenca: nada a fazer');
  } else {
    await expect(naraPage.getByText('Modelo anterior (exigência desligada)')).toBeVisible();
    const previa = (await naraPage.getByText(/Prévia de agora:/).innerText()).replace(/\s+/g, ' ');
    await shot(naraPage, '1-alvo-previa');
    await naraPage.getByRole('button', { name: 'Ligar a exigência de licença' }).click();
    const enforce = naraPage.getByRole('alertdialog');
    await expect(enforce.getByRole('button', { name: 'Ligar a exigência' })).toBeDisabled();
    await enforce.getByRole('checkbox', { name: /Conferi a prévia/ }).check();
    await enforce.getByLabel('Justificativa').fill('aceite manual no laboratorio: a organizacao nasceu antes da chave D7; transicao para o modelo por licenca a pedido da titular');
    await shot(naraPage, '1-alvo-previa-conferida');
    await confirmStepUp(naraPage, nara, 'Ligar a exigência');
    await settle(naraPage);
    await expect(naraPage.getByText('Exigência de licença ligada.')).toBeVisible();
    await expect(naraPage.getByText('Modelo por licença (exigência ligada)')).toBeVisible();
    await shot(naraPage, '1-alvo-exigencia-ligada');
    log('1_transicao', { pela_tela_do_operador: true, previa });
  }
  const depois = { dados: dados(ALVO), modelo: modelo(ALVO), ativacao: ativacao(ALVO) };
  expect(depois.dados, 'os dados criados pela pessoa não mudam').toBe(antes.dados);
  expect(depois.modelo).toMatch(/^modelo=2 /);
  expect(depois.ativacao, 'a ativação comercial do modelo anterior não foi usada').toBe(antes.ativacao);
  log('1_alvo_depois', depois);

  // ================================================================ 2. gêmea: Worker cadastrado sem licença
  const doraPage = await (await browser.newContext()).newPage();
  const dora = await signUpAndEnroll(doraPage, 'lic-vinc');
  const name = `Gêmea ${TAG}`;
  await go(doraPage, '/organizacoes/nova');
  await doraPage.getByLabel(/^Nome da organização/).fill(name);
  await doraPage.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(doraPage, dora, 'Criar organização');
  await settle(doraPage);
  await doraPage.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(doraPage).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  const org = /\/o\/([0-9a-f-]{36})/.exec(doraPage.url())![1];
  await settle(doraPage);
  expect(modelo(org)).toMatch(/^modelo=2 /);
  await go(doraPage, `/o/${org}/workers`);
  await doraPage.getByRole('heading', { name: 'Workers', level: 1 }).waitFor();
  await doraPage.getByRole('button', { name: 'Criar Worker' }).click();
  const wd = doraPage.getByRole('alertdialog');
  await wd.getByLabel(/^Nome do Worker/).fill('Worker de teste');
  await wd.getByRole('button', { name: 'Criar Worker' }).click();
  await settle(doraPage);
  await expect(doraPage.getByText('Worker Worker de teste criado, sem Agent.', { exact: false })).toBeVisible();
  await shot(doraPage, '2-gemea-worker-sem-licenca');
  await go(doraPage, `/o/${org}/administracao/licencas`);
  await expect(doraPage.getByText('Esta organização ainda não tem licenças.')).toBeVisible();
  await expect(doraPage.getByRole('group', { name: 'Capacidade técnica' })).toContainText(/Workers cadastrados\s*1 de \d+/);
  await shot(doraPage, '2-gemea-sem-licencas-capacidade');
  log('2_worker_sem_licenca', { organizacao: org, modelo: modelo(org), licencas: sql(`SELECT count(*) FROM organization_licenses WHERE organization_id = '${org}'`), worker: 'cadastrado pela tela', capacidade: (await doraPage.getByRole('group', { name: 'Capacidade técnica' }).innerText()).replace(/\s+/g, ' ').slice(0, 60) });

  // ================================================================ 3. gêmea: concessão pela operadora e "Vincular à automação"
  await openTarget(naraPage, orgN, org);
  await grantOne(naraPage, nara, 'aceite no laboratorio: licenca de teste, sem cobranca');
  await go(doraPage, `/o/${org}/administracao/licencas`);
  const count = doraPage.getByRole('group', { name: 'Conta das licenças' });
  await expect(doraPage.getByText('Você tem 1 licença disponível.')).toBeVisible();
  await expect(count).toContainText(/Utilizadas \(com automação\)\s*0/);
  await expect(count).toContainText(/Disponíveis \(sem automação\)\s*1\s*nº 1/);
  await shot(doraPage, '3-gemea-1-disponivel-0-utilizada');
  // ainda sem automação: o diálogo diz o que fazer e leva aos workspaces
  await doraPage.getByRole('button', { name: 'Vincular à automação a licença nº 1' }).click();
  let assign = doraPage.getByRole('alertdialog');
  await expect(assign.getByText('Esta organização ainda não tem automação para receber a licença.')).toBeVisible();
  await shot(doraPage, '3-gemea-sem-automacao');
  await assign.getByRole('link', { name: 'abrir Workspaces' }).click();
  await expect(doraPage).toHaveURL(new RegExp(`/o/${org}/workspaces$`));
  await settle(doraPage);
  await doraPage.getByRole('button', { name: 'Criar workspace' }).click();
  await doraPage.getByRole('alertdialog').getByLabel(/^Nome/).fill('Testes');
  await doraPage.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
  await expect(doraPage).toHaveURL(new RegExp(`/o/${org}/workspaces/[0-9a-f-]{36}$`));
  await settle(doraPage);
  await doraPage.getByRole('button', { name: 'Criar automação' }).click();
  await settle(doraPage);
  await doraPage.getByLabel(/^Nome da automação/).fill('Robô de teste');
  await doraPage.getByRole('radio', { name: /Só o nome, como rascunho/ }).check();
  await doraPage.getByRole('button', { name: 'Salvar rascunho' }).click();
  await settle(doraPage);
  await expect(doraPage.getByRole('heading', { name: 'Robô de teste' })).toBeVisible();
  await go(doraPage, `/o/${org}/administracao/licencas`);
  await doraPage.getByRole('button', { name: 'Vincular à automação a licença nº 1' }).click();
  assign = doraPage.getByRole('alertdialog');
  await assign.getByLabel('Automação que vai usar esta licença').selectOption({ index: 1 });
  await shot(doraPage, '3-gemea-vincular');
  await confirmStepUp(doraPage, dora, 'Vincular licença');
  await settle(doraPage);
  await expect(doraPage.getByText('Licença nº 1 vinculada a Robô de teste.', { exact: false })).toBeVisible();
  await expect(count).toContainText(/Utilizadas \(com automação\)\s*1\s*nº 1: Robô de teste/);
  await expect(count).toContainText(/Disponíveis \(sem automação\)\s*0/);
  await expect(doraPage.getByText(/Você tem \d+ licenças? disponíve/)).toHaveCount(0);
  await expect(doraPage.getByRole('region', { name: 'Lista de licenças' })).toContainText('Robô de teste');
  await shot(doraPage, '3-gemea-0-disponiveis-1-utilizada');
  log('3_vinculo', { pela_tela: true, antes: '1 disponivel / 0 utilizada', depois: '0 disponiveis / 1 utilizada', banco: sql(`SELECT 'licenca ' || l.license_number || ' -> ' || a.name FROM organization_license_assignments s JOIN organization_licenses l ON l.license_id = s.license_id JOIN automations a ON a.automation_id = s.automation_id WHERE s.organization_id = '${org}' AND s.released_at IS NULL`) });

  // ================================================================ 4. organização do aceite: UMA licença de teste, sem vínculo
  await openTarget(naraPage, orgN, ALVO);
  const tinha = Number(sql(`SELECT count(*) FROM organization_licenses WHERE organization_id = '${ALVO}'`));
  if (tinha === 0) {
    await grantOne(naraPage, nara, 'aceite manual no laboratorio: simulacao de contratacao, uma licenca de teste, sem cobranca');
    await expect(naraPage.getByText(/Licenças: 1 contratadas, 0 utilizadas, 1 disponíveis\./)).toBeVisible();
    await shot(naraPage, '4-alvo-licenca-concedida');
  }
  const fim = {
    dados: dados(ALVO),
    modelo: modelo(ALVO),
    ativacao: ativacao(ALVO),
    licencas: sql(`SELECT string_agg('n ' || l.license_number || CASE WHEN s.license_id IS NULL THEN ' sem vinculo' ELSE ' vinculada' END, ', ') FROM organization_licenses l LEFT JOIN organization_license_assignments s ON s.license_id = l.license_id AND s.released_at IS NULL WHERE l.organization_id = '${ALVO}'`),
  };
  expect(fim.dados).toBe(antes.dados);
  expect(fim.ativacao).toBe(antes.ativacao);
  log('4_alvo_fim', { ...fim, ja_tinha_licenca: tinha });

  log('limites_de_frequencia', `nenhum limite foi zerado. "Tentar novamente" usado ${retried} vez(es)`);
  log('fim', 'roteiro da transicao auditada e do vinculo concluido');
});
