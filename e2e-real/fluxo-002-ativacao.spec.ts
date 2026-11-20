import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { activateAutomation, confirmStepUp, LAB, signInWithTotp, signUpAndEnroll, waitToken, type Person } from './support/lab';

/**
 * PLATFORM-FLUXO-002 — ATIVAÇÃO UNIFICADA E TEMAS, pela Web de produção contra a API real do laboratório descartável, com a
 * chave da D7 ligada pelo preparo (organizações novas no modelo por licença).
 *
 *   0. a operadora de licenças da Nekkora (procedimento administrativo de laboratório: cadastro em license_operators e a
 *      organização operadora configurada; Platform recriada);
 *   1. a administradora (Ana) cria a organização, o ambiente de trabalho, duas automações com versão publicada e dois Workers;
 *      a operadora concede UMA licença (pela tela);
 *   2. "Ativar automação": ambiente → automação → só o Worker 1 → conferir → "Ativar execução e monitoramento": a licença é
 *      vinculada e o Worker 1 recebe execução e monitoramento; o Worker 2 nada;
 *   3. repetir não consome nem duplica; acrescentar o Worker 2 não consome licença;
 *   4. sem saldo: a segunda automação mostra o impedimento antes da confirmação, e nada é enviado;
 *   5. versão nova: só executa depois do aceite; o monitoramento continua;
 *   6. vencimento (passagem do tempo simulada no banco, declarada) e renovação pela operadora: "Renovar autorizações", sem
 *      duplicar ao repetir; as anteriores ficam no histórico;
 *   7. preservação: uma autorização feita antes pela rota antiga é reaproveitada, sem novo consumo;
 *   8. quem não administra a organização (Bruno, operador do ambiente) não vê a página e o servidor recusa;
 *   9. temas: Sakura Dark escolhido na conta continua depois de sair e entrar; a página nova é auditada (axe, com contraste)
 *      nos três temas.
 *
 *   FRONT_LAB_ID=<lab> FRONT_PORTA=<porta> npx playwright test -c playwright.real.config.ts fluxo-002-ativacao
 */
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-fluxo-002-ativacao`);
const SEG = join(homedir(), '.nekkora', 'front-lab', LAB, 'segredos.env');
const RAPIDO = resolve(process.cwd(), '../exe/robo-licenca-rapido.zip');
const LONGO = resolve(process.cwd(), '../exe/robo-licenca-longo.zip');
const TAG = Date.now().toString(36);
const axeSource = readFileSync(resolve('node_modules/axe-core/axe.min.js'), 'utf8');

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
let waitedForRate = 0;
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
  await page.waitForTimeout(3_000);
  await page.goto(url);
  await settle(page);
}
const day = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
async function api(page: Page, org: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ org, method, path, body }) => {
      const headers: Record<string, string> = {};
      if (method !== 'GET') {
        const c = await (await fetch(`/api/v1/o/${org}/auth/csrf`)).json();
        headers['X-CSRF-Token'] = c.csrfToken;
        headers['Content-Type'] = 'application/json';
      }
      const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: r.status, body: parsed };
    },
    { org, method, path, body },
  );
}
async function waitPlatform(page: Page) {
  await expect.poll(async () => (await page.request.get('/api/v1/csrf').catch(() => null))?.status() ?? 0, { timeout: 180_000, intervals: [2_000] }).toBe(200);
}
async function createOrganization(page: Page, person: Person, name: string) {
  await go(page, '/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, person, 'Criar organização');
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
async function audit(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe injetado acima
    const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return r.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
  expect(violations, `axe em ${name}`).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `rolagem horizontal em ${name}`).toBeLessThanOrEqual(0);
}

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('PLATFORM-FLUXO-002: ativação unificada (um passo, sem saldo, sem consumo duplicado, versão, vencimento e renovação, preservação, permissões) e temas', async ({ browser }) => {
  test.setTimeout(2_400_000);
  rmSync(EVID, { recursive: true, force: true });
  log('laboratorio', readFileSync(resolve(`tools/lab/saidas/${LAB}/laboratorio.txt`), 'utf8').replace(/\n/g, ' | '));
  const chave = sql("SELECT new_organizations_licensed FROM license_rollout");
  expect(chave, 'a chave da D7 é ligada pelo PREPARO do laboratório (licencas-novas.sh)').toBe('t');
  const naraPage = await (await browser.newContext()).newPage();
  const anaContext = await browser.newContext();
  const anaPage = await anaContext.newPage();
  const brunoPage = await (await browser.newContext()).newPage();

  // ================================================================ 0. a operadora (preparo administrativo do laboratório)
  const nara = await signUpAndEnroll(naraPage, 'flx-op');
  await createOrganization(naraPage, nara, `Nekkora Suporte ${TAG}`);
  const orgN = await enter(naraPage, `Nekkora Suporte ${TAG}`);
  const naraUser = sql(`SELECT user_id FROM users WHERE organization_id = '${orgN}' AND email = '${nara.email}'`);
  sql(`INSERT INTO license_operators (operator_user_id, organization_id, registered_by) VALUES ('${naraUser}', '${orgN}', 'roteiro de laboratorio PLATFORM-FLUXO-002')`);
  const env = readFileSync(SEG, 'utf8');
  writeFileSync(SEG, `${env.replace(/^LAB_LICENCAS_ORGANIZACAO_OPERADORA=.*\n/m, '')}LAB_LICENCAS_ORGANIZACAO_OPERADORA=${orgN}\n`);
  compose(LAB, ['up', '-d', '--no-deps', '--wait', 'platform'], { stdio: ['ignore', 'ignore', 'inherit'] }, ['compose.licencas.yml']);
  await waitPlatform(naraPage);
  log('0_operadora', { procedimento: 'license_operators + organizacao operadora; Platform recriada', organizacao: orgN });

  // ================================================================ 1. a organização da Ana: ambiente, duas automações publicadas, dois Workers
  const ana = await signUpAndEnroll(anaPage, 'flx-a');
  const orgName = `Oficina ${TAG}`;
  await createOrganization(anaPage, ana, orgName);
  const org = await enter(anaPage, orgName);
  expect(sql(`SELECT public.license_model('${org}')`), 'nasce no modelo por licença').toBe('2');
  await go(anaPage, `/o/${org}/workspaces`);
  await anaPage.getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
  await anaPage.getByRole('alertdialog').getByLabel(/^Nome/).fill('Fiscal');
  await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
  await expect(anaPage).toHaveURL(new RegExp(`/o/${org}/workspaces/[0-9a-f-]{36}$`));
  const workspaceUrl = anaPage.url();
  const workspaceId = /workspaces\/([0-9a-f-]{36})/.exec(workspaceUrl)![1];
  const automations: Record<string, { url: string; id: string }> = {};
  for (const name of ['Robô de notas', 'Conciliação']) {
    await go(anaPage, workspaceUrl);
    await anaPage.getByRole('button', { name: 'Criar automação' }).click();
    await settle(anaPage);
    await anaPage.getByLabel(/^Nome da automação/).fill(name);
    await anaPage.getByRole('radio', { name: /Só o nome, como rascunho/ }).check();
    await anaPage.getByRole('button', { name: 'Salvar rascunho' }).click();
    await settle(anaPage);
    await expect(anaPage.getByRole('heading', { name })).toBeVisible();
    automations[name] = { url: anaPage.url(), id: /automacoes\/([0-9a-f-]{36})/.exec(anaPage.url())![1] };
  }
  const publish = async (name: string, zip: string): Promise<string> => {
    await go(anaPage, automations[name].url);
    // o limite de atos em rajada (429) não é zerado: diante do aviso, espera-se um minuto e envia-se de novo pelo mesmo botão
    await anaPage.getByRole('button', { name: 'Nova versão' }).click();
    await expect(anaPage).toHaveURL(/\/automacoes\/[0-9a-f-]{36}\/nova-versao$/);
    await anaPage.getByLabel('Arquivo .zip do pacote').setInputFiles(zip);
    for (let i = 0; i < 4; i++) {
      await anaPage.getByRole('button', { name: 'Enviar o pacote e criar o rascunho' }).click();
      const sent = await Promise.race([
        anaPage.waitForURL(/\/versoes\/[0-9a-f-]{36}$/, { timeout: 30_000 }).then(() => true),
        anaPage.getByText('Muitas tentativas em pouco tempo. Aguarde antes de enviar de novo.').waitFor({ timeout: 30_000 }).then(() => false),
      ]);
      if (sent) break;
      waitedForRate++;
      await anaPage.waitForTimeout(65_000);
    }
    await expect(anaPage.getByText('Rascunho criado com o pacote conferido pela Platform.')).toBeVisible();
    const url = anaPage.url();
    await anaPage.getByRole('button', { name: 'Publicar versão' }).click();
    await confirmStepUp(anaPage, ana, 'Publicar');
    await settle(anaPage);
    const id = /versoes\/([0-9a-f-]{36})/.exec(url)![1];
    await expect.poll(() => sql(`SELECT status FROM automation_versions WHERE automation_version_id = '${id}'`), { timeout: 60_000 }).toBe('2');
    return id;
  };
  const v1 = await publish('Robô de notas', RAPIDO);
  await publish('Conciliação', RAPIDO);
  for (const w of ['Estação 1', 'Estação 2']) {
    await go(anaPage, `/o/${org}/workers`);
    await anaPage.getByRole('button', { name: 'Cadastrar máquina' }).click();
    await anaPage.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill(w);
    await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Cadastrar máquina' }).click();
    await settle(anaPage);
    await anaPage.getByRole('button', { name: `Autorizar ${w} num ambiente de trabalho` }).click();
    await anaPage.getByRole('alertdialog').getByLabel('Ambiente de trabalho').selectOption({ label: 'Fiscal' });
    await confirmStepUp(anaPage, ana, 'Autorizar');
    await settle(anaPage);
  }
  const worker = (name: string) => sql(`SELECT worker_id FROM workers WHERE organization_id = '${org}' AND name = '${name}'`);
  const robo = automations['Robô de notas'].id;
  const conciliacao = automations['Conciliação'].id;
  // a operadora concede UMA licença de teste (sem cobrança), pela tela
  await go(naraPage, `/o/${orgN}/operador-de-licencas`);
  await naraPage.getByLabel('Identificador da organização').fill(org);
  await naraPage.getByRole('button', { name: 'Abrir' }).click();
  await naraPage.getByRole('button', { name: 'Conceder licenças' }).click();
  const grant = naraPage.getByRole('alertdialog');
  await grant.getByLabel('Quantidade').fill('1');
  await grant.getByLabel('Início da validade').fill(day(0));
  await grant.getByLabel('Fim da validade').fill(day(10));
  await grant.getByLabel('Justificativa').fill('roteiro FLUXO-002: licenca de teste, sem cobranca');
  await confirmStepUp(naraPage, nara, 'Conceder');
  await settle(naraPage);
  await expect(naraPage.getByText(/Licenças concedidas\. Elas nascem sem vínculo/)).toBeVisible();
  log('1_preparo', { organizacao: org, automacoes: 2, versoes_publicadas: 2, workers: 2, licencas: 1 });

  // ================================================================ 2. um passo: ambiente → automação → só o Worker 1 → conferir → ativar
  await go(anaPage, `/o/${org}/administracao/licencas`);
  await expect(anaPage.getByRole('heading', { level: 1, name: 'Licenças e automações' })).toBeVisible();
  await anaPage.getByRole('button', { name: 'Ativar automação' }).click();
  const d = anaPage.getByRole('alertdialog');
  await d.getByLabel('1. Ambiente de trabalho').selectOption({ label: 'Fiscal' });
  await d.getByLabel('2. Automação').selectOption({ label: 'Robô de notas' });
  await expect(d.getByRole('checkbox', { name: 'Estação 1' })).not.toBeChecked();
  await expect(d.getByRole('checkbox', { name: 'Estação 2' })).not.toBeChecked();
  await d.getByRole('checkbox', { name: 'Estação 1' }).check();
  const review = d.getByRole('region', { name: 'Conferência da ativação' });
  await expect(review).toContainText('será usada a licença nº 1');
  await expect(review).toContainText('Versão publicada atual: versão 1');
  await expect(review).toContainText('Workers: Estação 1');
  await shot(anaPage, '2-conferencia-antes-de-ativar');
  await confirmStepUp(anaPage, ana, 'Ativar execução e monitoramento');
  await settle(anaPage);
  await expect(anaPage.getByText('Uma licença foi vinculada a esta automação.')).toBeVisible();
  const lista = anaPage.getByRole('region', { name: 'Lista de automações atendidas' });
  await expect(lista.getByRole('row').filter({ hasText: 'Robô de notas' })).toContainText('Ativa');
  await shot(anaPage, '2-ativada');
  const auths = (aut: string) => sql(`SELECT count(*) FROM local_run_authorizations WHERE automation_id = '${aut}' AND revoked_at IS NULL AND valid_until > clock_timestamp()`);
  const consumed = () => sql(`SELECT count(*) FROM organization_license_assignments WHERE organization_id = '${org}' AND released_at IS NULL`);
  expect([auths(robo), consumed()]).toEqual(['2', '1']);
  expect(sql(`SELECT count(*) FROM local_run_authorizations WHERE worker_id = '${worker('Estação 2')}'`), 'Máquina não escolhida não recebe nada').toBe('0');
  expect(sql(`SELECT count(*) FROM local_run_authorizations WHERE automation_id = '${robo}' AND valid_until > license_coverage_end('${org}', '${robo}', clock_timestamp())`)).toBe('0');
  log('2_ativacao', { pela_tela: true, licenca: 'nº 1 vinculada', worker_1: 'execucao da versao 1 + monitoramento', worker_2: 'nada', validade: 'ate o fim da cobertura da licenca' });

  // ================================================================ 3. repetir não consome nem duplica; acrescentar Worker não consome
  await activateAutomation(anaPage, ana, org, { workspace: 'Fiscal', automation: 'Robô de notas', workers: ['Estação 1'] }).catch(async () => {
    // a Estação 1 já faz parte da ativação: a tela não a oferece de novo; repetir sem Worker
    await anaPage.keyboard.press('Escape');
    await activateAutomation(anaPage, ana, org, { workspace: 'Fiscal', automation: 'Robô de notas' });
  });
  await settle(anaPage);
  await expect(anaPage.getByText('A automação já tinha licença: nenhuma outra foi consumida.')).toBeVisible();
  expect([auths(robo), consumed()]).toEqual(['2', '1']);
  await lista.getByRole('button', { name: 'Acrescentar máquinas a Robô de notas' }).click();
  await anaPage.getByRole('alertdialog').getByRole('checkbox', { name: 'Estação 2' }).check();
  await confirmStepUp(anaPage, ana, 'Acrescentar máquinas');
  await settle(anaPage);
  await expect(anaPage.getByText('A automação já tinha licença: nenhuma outra foi consumida.')).toBeVisible();
  expect([auths(robo), consumed()]).toEqual(['4', '1']);
  log('3_sem_consumo_duplicado', { repetir: 'nada consumido nem duplicado', acrescentar_worker_2: 'execucao + monitoramento, sem nova licenca' });

  // ================================================================ 4. sem saldo: a segunda automação não é ativada
  await go(anaPage, `/o/${org}/administracao/licencas`);
  await anaPage.getByRole('button', { name: 'Ativar automação' }).click();
  await d.getByLabel('1. Ambiente de trabalho').selectOption({ label: 'Fiscal' });
  await d.getByLabel('2. Automação').selectOption({ label: 'Conciliação' });
  await d.getByRole('checkbox', { name: 'Estação 1' }).check();
  await expect(d.getByText('Não há licença disponível para ativar esta automação.')).toBeVisible();
  await expect(d.getByRole('button', { name: 'Ativar execução e monitoramento' })).toBeDisabled();
  await shot(anaPage, '4-sem-saldo');
  await anaPage.keyboard.press('Escape');
  const direto = await api(anaPage, org, 'POST', `/api/v1/o/${org}/automation-activations`, { automationId: conciliacao, workerIds: [worker('Estação 1')] });
  expect([direto.status, direto.body?.reason], 'o servidor recusa, não só a tela').toEqual([409, 'license_unavailable']);
  expect([auths(conciliacao), consumed()]).toEqual(['0', '1']);
  log('4_sem_saldo', { tela: 'impedimento antes da confirmacao; confirmar desabilitado', servidor: '409 license_unavailable; nada gravado' });

  // ================================================================ 5. versão nova: só executa depois do aceite; o monitoramento continua
  const v2 = await publish('Robô de notas', LONGO);
  await go(anaPage, `/o/${org}/administracao/licencas`);
  const linhaRobo = lista.getByRole('row').filter({ hasText: 'Robô de notas' });
  await expect(linhaRobo).toContainText('Há uma versão publicada mais nova (versão 2). Ela só executa depois de aceita.');
  expect(sql(`SELECT count(*) FROM local_run_authorizations WHERE automation_version_id = '${v2}'`), 'a licença não autoriza a versão nova sozinha').toBe('0');
  await lista.getByRole('button', { name: 'Aceitar a versão nova de Robô de notas' }).click();
  await confirmStepUp(anaPage, ana, 'Aceitar versão');
  await settle(anaPage);
  expect(sql(`SELECT count(*) FROM local_run_authorizations WHERE automation_version_id = '${v2}' AND revoked_at IS NULL`)).toBe('2');
  expect(sql(`SELECT count(*) FROM local_run_authorizations WHERE automation_id = '${robo}' AND source_kind = 3 AND revoked_at IS NULL`), 'monitoramento continua, sem reemitir').toBe('2');
  expect(consumed()).toBe('1');
  await shot(anaPage, '5-versao-2-aceita');
  log('5_versao_nova', { antes_do_aceite: 'sem autorizacao da versao 2', aceite: 'execucao da versao 2 nas 2 máquinas', monitoramento: 'o mesmo', licencas: 1 });

  // ================================================================ 6. vencimento e renovação
  // PASSAGEM DO TEMPO (declarada): o período da licença termina agora
  const license = sql(`SELECT license_id FROM organization_licenses WHERE organization_id = '${org}'`);
  sql(`SET session_replication_role = replica; UPDATE organization_license_periods SET ends_at = clock_timestamp() WHERE license_id = '${license}'`);
  await go(anaPage, `/o/${org}/administracao/licencas`);
  await expect(linhaRobo).toContainText('Licença vencida');
  await expect(lista.getByRole('button', { name: 'Renovar autorizações de Robô de notas' })).toHaveCount(0);
  await shot(anaPage, '6-licenca-vencida');
  const vencida = await api(anaPage, org, 'POST', `/api/v1/o/${org}/automation-activations/${robo}/renewal`, {});
  expect([vencida.status, vencida.body?.reason]).toEqual([409, 'license_expired']);
  // a operadora renova pela tela (novo período a partir de hoje, por 30 dias)
  await go(naraPage, `/o/${orgN}/operador-de-licencas`);
  await naraPage.getByLabel('Identificador da organização').fill(org);
  await naraPage.getByRole('button', { name: 'Abrir' }).click();
  await naraPage.getByRole('button', { name: 'Renovar a licença nº 1' }).click();
  const ren = naraPage.getByRole('alertdialog');
  await ren.getByLabel('Início do novo período').fill(day(0));
  await ren.getByLabel('Fim do novo período').fill(day(30));
  await ren.getByLabel('Justificativa').fill('roteiro FLUXO-002: renovacao da licenca de teste');
  await confirmStepUp(naraPage, nara, 'Renovar');
  await settle(naraPage);
  await go(anaPage, `/o/${org}/administracao/licencas`);
  await expect(linhaRobo).toContainText('A licença foi renovada: renove as autorizações das máquinas');
  const historico = sql(`SELECT count(*) FROM local_run_authorizations WHERE automation_id = '${robo}'`);
  await lista.getByRole('button', { name: 'Renovar autorizações de Robô de notas' }).click();
  await expect(anaPage.getByRole('alertdialog')).toContainText(/para as mesmas máquinas e a versão já aceita \(versão 2\)/);
  await shot(anaPage, '6-renovar-autorizacoes');
  await confirmStepUp(anaPage, ana, 'Renovar autorizações');
  await settle(anaPage);
  await expect(linhaRobo).toContainText('Ativa');
  const renovadas = Number(sql(`SELECT count(*) FROM local_run_authorizations WHERE automation_id = '${robo}'`)) - Number(historico);
  expect(renovadas, 'execução da versão aceita + monitoramento, nas 2 máquinas').toBe(4);
  expect(sql(`SELECT count(*) FROM local_run_authorizations WHERE automation_id = '${robo}' AND renewal_of_authorization_id IS NOT NULL`)).toBe('4');
  expect(sql(`SELECT count(*) FROM local_run_authorizations WHERE automation_version_id = '${v1}' AND renewal_of_authorization_id IS NOT NULL`), 'a versão antiga não é renovada').toBe('0');
  const again = await api(anaPage, org, 'POST', `/api/v1/o/${org}/automation-activations/${robo}/renewal`, {});
  expect([again.status, again.body?.results?.length]).toEqual([200, 0]);
  expect(consumed()).toBe('1');
  log('6_vencimento_e_renovacao', { vencida: 'Licenca vencida; sem acao de renovar; servidor 409 license_expired', renovada_pela_operadora: '30 dias', renovar_autorizacoes: `${renovadas} novas (versao 2 + monitoramento, 2 máquinas)`, repetir: 'nada', historico: 'anteriores preservadas' });

  // ================================================================ 7. preservação: autorização feita antes, pela rota antiga, é reaproveitada
  await go(anaPage, `/o/${org}/administracao/licencas`);
  // a Conciliação ganha a licença só pelo suporte (transferência não é escopo); aqui: a operadora concede uma segunda
  await go(naraPage, `/o/${orgN}/operador-de-licencas`);
  await naraPage.getByLabel('Identificador da organização').fill(org);
  await naraPage.getByRole('button', { name: 'Abrir' }).click();
  await naraPage.getByRole('button', { name: 'Conceder licenças' }).click();
  await grant.getByLabel('Quantidade').fill('1');
  await grant.getByLabel('Início da validade').fill(day(0));
  await grant.getByLabel('Fim da validade').fill(day(30));
  await grant.getByLabel('Justificativa').fill('roteiro FLUXO-002: segunda licenca de teste');
  await confirmStepUp(naraPage, nara, 'Conceder');
  await settle(naraPage);
  const vConc = sql(`SELECT automation_version_id FROM automation_versions WHERE automation_id = '${conciliacao}' AND status = 2`);
  // o vínculo da licença e a autorização de execução feitos ANTES, pelas rotas antigas (que continuam existindo)
  const lic2 = sql(`SELECT license_id FROM organization_licenses WHERE organization_id = '${org}' AND license_number = 2`);
  expect((await api(anaPage, org, 'POST', `/api/v1/o/${org}/licenses/${lic2}/assignment`, { automationId: conciliacao })).status).toBe(200);
  const old = await api(anaPage, org, 'POST', `/api/v1/o/${org}/workspaces/${workspaceId}/local-run-authorizations`, { workerId: worker('Estação 1'), automationVersionId: vConc, validUntil: new Date(Date.now() + 5 * 86_400_000).toISOString() });
  expect(old.status).toBe(201);
  await activateAutomation(anaPage, ana, org, { workspace: 'Fiscal', automation: 'Conciliação', workers: ['Estação 1'] });
  await settle(anaPage);
  await expect(anaPage.getByText('A automação já tinha licença: nenhuma outra foi consumida.')).toBeVisible();
  await expect(anaPage.getByText(/1 autorização\(ões\) emitida\(s\), 1 já estava\(m\) vigente\(s\)\./)).toBeVisible();
  expect(sql(`SELECT revoked_at IS NULL FROM local_run_authorizations WHERE authorization_id = '${old.body.authorizationId}'`)).toBe('t');
  expect(consumed()).toBe('2');
  log('7_preservacao', { antes: 'licenca nº 2 vinculada e execucao autorizada pelas rotas antigas', ativacao: 'monitoramento emitido; execucao existente reaproveitada; nenhuma licenca nova' });

  // ================================================================ 8. quem não administra a organização
  const bruno = await signUpAndEnroll(brunoPage, 'flx-b');
  await go(anaPage, `/o/${org}/administracao/convites`);
  await anaPage.getByLabel(/^E-mail da pessoa/).fill(bruno.email);
  await anaPage.getByLabel(/^Papel/).selectOption('OPERATOR');
  await anaPage.getByLabel(/^Ambiente de trabalho do papel/).selectOption(workspaceId);
  await anaPage.getByRole('button', { name: 'Convidar' }).click();
  await confirmStepUp(anaPage, ana, 'Enviar convite');
  await settle(anaPage);
  const token = await waitToken('ORG_INVITATION', bruno.email);
  await go(brunoPage, `/o/${org}/convite#token=${token}`);
  await brunoPage.getByRole('button', { name: 'Aceitar convite' }).click();
  await confirmStepUp(brunoPage, bruno, 'Aceitar');
  await settle(brunoPage);
  await go(brunoPage, `/o/${org}`);
  await expect(brunoPage.getByRole('link', { name: 'Licenças e automações' })).toHaveCount(0);
  await go(brunoPage, `/o/${org}/administracao/licencas`);
  await expect(brunoPage.getByText('Você não tem permissão para ver as licenças e as automações atendidas.')).toBeVisible();
  const brunoTry = await api(brunoPage, org, 'POST', `/api/v1/o/${org}/automation-activations`, { automationId: conciliacao, workerIds: [worker('Estação 2')] });
  expect(brunoTry.status, 'o servidor recusa quem não administra a organização').toBe(403);
  await shot(brunoPage, '8-sem-autoridade');
  log('8_sem_autoridade', { quem: 'Bruno, operador do ambiente', menu: 'sem Licencas e automacoes', tela: 'sem permissao', servidor: brunoTry.status });

  // ================================================================ 9. temas: Sakura Dark persiste entre sessões; a página nova nos três temas
  for (const [label, id] of [
    ['Nekkora Dark', 'dark'],
    ['Nekkora Light', 'light'],
    ['Sakura Dark', 'sakura-dark'],
  ] as const) {
    await go(anaPage, `/o/${org}/conta`);
    await anaPage.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: new RegExp(`^${label}`) }).check();
    await expect.poll(() => anaPage.evaluate(() => document.documentElement.getAttribute('data-nk-theme'))).toBe(id);
    await go(anaPage, `/o/${org}/administracao/licencas`);
    await expect(anaPage.getByRole('heading', { level: 1, name: 'Licenças e automações' })).toBeVisible();
    await audit(anaPage, `licencas-e-automacoes-${id}`);
    await shot(anaPage, `9-licencas-e-automacoes-${id}`);
  }
  await anaContext.clearCookies();
  await signInWithTotp(anaPage, ana);
  await expect.poll(() => anaPage.evaluate(() => document.documentElement.getAttribute('data-nk-theme'))).toBe('sakura-dark');
  log('9_temas', { escolha: 'Minha conta', persistencia: 'Sakura Dark depois de sair e entrar', axe_com_contraste: 'Licencas e automacoes nos tres temas, sem violacoes' });

  log('limites_de_frequencia', `nenhum limite foi zerado. "Tentar novamente" usado ${retried} vez(es); espera de 1 min por envio em rajada: ${waitedForRate} vez(es)`);
  log('fim', 'roteiro FLUXO-002 concluido');
});
