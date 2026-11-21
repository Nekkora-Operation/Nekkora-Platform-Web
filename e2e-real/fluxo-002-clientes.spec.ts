import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { Authenticator } from '../mock/totp';
import { confirmStepUp, LAB, signInWithTotp, signUpAndEnroll, syntheticEmail, waitToken, type Person } from './support/lab';

/**
 * PLATFORM-FLUXO-002 (070) — CLIENTES E ACESSOS pela Web de produção contra a API e o Portal reais do laboratório, com pessoas
 * sintéticas. Usa a organização do acompanhamento (~/.nekkora/front-lab/<lab>/acompanhamento.json): a administradora (Ana),
 * o leitor do Fiscal (Bruno) e a pessoa de outra organização (Nara). Cadastra DUAS pessoas: a cliente (Carla, que aceita o
 * convite de Cliente) e uma segunda administradora (Dora, para a aprovação por OUTRA pessoa). O convite da titular que estiver
 * na organização não é tocado.
 *
 * Massa: execuções REAIS do laboratório (execução remota de "Robô de notas" na Estação Client, com registros e um arquivo de
 * resultado; execuções do Agent de "Rotina local" e "Relatório CSV" na Estação Agent). UMA execução da Platform de "Robô de
 * notas" na Estação Agent é INSERIDA no banco (declarada), para haver a mesma automação em duas máquinas: valida leitura e
 * apresentação, não a produção da execução.
 *
 *   FRONT_LAB_ID=frontlab-fluxo002 FRONT_PORTA=5196 npx playwright test -c playwright.real.config.ts fluxo-002-clientes
 */
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-fluxo-002-clientes`);
const ESTADO = join(homedir(), '.nekkora', 'front-lab', LAB, 'acompanhamento.json');
const TAG = Date.now().toString(36);
const axeSource = readFileSync(resolve('node_modules/axe-core/axe.min.js'), 'utf8');

type Guardada = { email: string; password: string; name: string; secret: string };
const reviver = (g: Guardada): Person => ({ email: g.email, password: g.password, name: g.name, auth: new Authenticator(g.secret), recoveryCodes: [] });

const sql = (q: string) => (compose(LAB, ['exec', '-T', 'postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'nekkora', '-d', 'nekkora', '-c', q]) as string).trim();
const log = (k: string, v: unknown) => {
  mkdirSync(EVID, { recursive: true });
  const line = `${new Date().toISOString()} ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
  appendFileSync(join(EVID, 'roteiro.txt'), `${line}\n`);
  console.log(line);
};
const shot = async (page: Page, name: string) => {
  mkdirSync(EVID, { recursive: true });
  await page.screenshot({ path: join(EVID, `${name}.png`), fullPage: true });
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
  await page.waitForTimeout(2_500);
  await page.goto(url);
  await settle(page);
}
async function signedIn(browser: Browser, person: Person, orgName: RegExp, viewport?: { width: number; height: number }): Promise<Page> {
  const page = await (await browser.newContext(viewport ? { viewport } : {})).newPage();
  try {
    await signInWithTotp(page, person);
  } catch (e) {
    if (!page.url().includes('/entrar/verificacao')) throw e;
    await page.waitForTimeout(31_000);
    await page.getByLabel('Código de autenticação').fill(await person.auth.next());
    await expect(page).toHaveURL(/\/organizacoes$/);
  }
  await settle(page);
  const entrar = page.getByRole('button', { name: orgName }).first();
  for (let vez = 0; vez < 4 && !(await entrar.isVisible().catch(() => false)); vez++) {
    await entrar.waitFor({ timeout: 20_000 }).catch(() => undefined);
    if (await entrar.isVisible()) break;
    await go(page, '/organizacoes');
  }
  await entrar.click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await settle(page);
  return page;
}
async function apiGet(page: Page, path: string): Promise<{ status: number; body: any }> {
  return page.evaluate(async (path) => {
    const r = await fetch(path);
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 200);
    }
    return { status: r.status, body };
  }, path);
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
  expect(overflow, `rolagem horizontal da página em ${name}`).toBeLessThanOrEqual(0);
}
const rows = (page: Page) => page.getByRole('region', { name: 'Lista de pessoas e convites' }).locator('tbody tr');
const rowOf = (page: Page, text: string) => rows(page).filter({ hasText: text });

/** Preenche o convite de Cliente (sem enviar). */
async function fillClientInvite(page: Page, email: string, client: string, workspace: string, machine: string | null, automation: string, logs: boolean, results: boolean) {
  await page.getByRole('radio', { name: /^Cliente/ }).check();
  await page.getByLabel(/^E-mail da pessoa/).fill(email);
  await page.getByRole('combobox', { name: /^Cliente/ }).selectOption({ label: client });
  await page.getByRole('combobox', { name: /^Ambiente de trabalho/ }).selectOption({ label: workspace });
  if (machine) await page.getByRole('combobox', { name: /^Máquina/ }).selectOption({ label: machine });
  await page.getByRole('combobox', { name: /^Automação/ }).selectOption({ label: automation });
  if (logs) await page.getByRole('checkbox', { name: 'Consultar os registros' }).check();
  if (results) await page.getByRole('checkbox', { name: 'Baixar os arquivos de resultado' }).check();
}

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('Clientes e acessos: convite de Cliente, aceite pela identidade, escopo por automação e máquina, registros e resultados, recusas, segunda pessoa, revogação e suspensão com a sessão aberta, auditoria, perfis internos, links antigos, teclado, tela estreita e temas', async ({ browser }) => {
  test.setTimeout(3_000_000);
  expect(existsSync(ESTADO), 'o roteiro do acompanhamento guardou a organização e as pessoas').toBe(true);
  rmSync(EVID, { recursive: true, force: true });
  const s = JSON.parse(readFileSync(ESTADO, 'utf8')) as { ana: Guardada; bruno: Guardada; nara: Guardada; org: string; orgName: string; fiscal: string };
  const { org } = s;
  const ana = reviver(s.ana);
  const orgName = new RegExp(`^Entrar em ${s.orgName}(?![0-9a-z])`);
  const pessoas = `/o/${org}/administracao/pessoas`;
  log('laboratorio', readFileSync(resolve(`tools/lab/saidas/${LAB}/laboratorio.txt`), 'utf8').replace(/\n/g, ' | '));
  expect(sql("SELECT max(substr(obj_description('public'::regnamespace), 1, 80))") || 'ok').toBeTruthy();

  // ------------------------------------------------ massa: o que existe (real) e a execução inserida (declarada)
  const id = (q: string) => sql(q).split('\n')[0];
  const autom = (nome: string) => id(`SELECT automation_id FROM automations WHERE organization_id = '${org}' AND name = '${nome}'`);
  const maquina = (nome: string) => id(`SELECT worker_id FROM workers WHERE organization_id = '${org}' AND name = '${nome}'`);
  const robo = autom('Robô de notas');
  const rotina = autom('Rotina local');
  const csv = autom('Relatório CSV');
  const client = maquina('Estação Client');
  const agent = maquina('Estação Agent');
  const remota = id(`SELECT remote_execution_id FROM remote_executions WHERE organization_id = '${org}' AND automation_id = '${robo}' ORDER BY requested_at LIMIT 1`);
  const tentativa = id(`SELECT attempt_id FROM remote_attempts WHERE remote_execution_id = '${remota}' ORDER BY attempt_number DESC LIMIT 1`);
  const runCsv = id(`SELECT agent_run_id FROM agent_runs WHERE organization_id = '${org}' AND automation_id = '${csv}' LIMIT 1`);
  const inserida = sql(
    `SET session_replication_role = replica; INSERT INTO executions (organization_id, workspace_id, automation_id, automation_version_id, request_key, request_fingerprint, requested_by_membership_id, command_snapshot, status, status_reason, origin, created_at, started_at, finished_at, worker_id, worker_agent_assignment_id, worker_workspace_assignment_id, reserved_at) SELECT a.organization_id, a.workspace_id, a.automation_id, v.automation_version_id, 'clientes-${TAG}', repeat('c', 64), m.membership_id, v.command_json, 4, 1, 1, now() - interval '2 hours', now() - interval '2 hours', now() - interval '119 minutes', '${agent}', gen_random_uuid(), gen_random_uuid(), now() - interval '2 hours' FROM automations a JOIN automation_versions v ON v.automation_id = a.automation_id AND v.status = 2 JOIN organization_memberships m ON m.organization_id = a.organization_id JOIN users u ON u.user_id = m.user_id AND u.email_normalized = '${ana.email.toLowerCase()}' WHERE a.automation_id = '${robo}' ORDER BY v.created_at DESC LIMIT 1 RETURNING execution_id`,
  ).split('\n').find((l) => /^[0-9a-f-]{36}$/.test(l))!;
  log('massa', {
    real: { remota_robo_na_estacao_client: remota, registros: sql(`SELECT count(*) FROM remote_attempt_log_lines WHERE attempt_id = '${tentativa}'`), resultado: sql(`SELECT file_name FROM remote_attempt_results WHERE attempt_id = '${tentativa}'`), execucoes_do_agent_rotina_e_csv_na_estacao_agent: sql(`SELECT count(*) FROM agent_runs WHERE organization_id = '${org}' AND automation_id IN ('${rotina}', '${csv}')`) },
    inserida_no_banco: { execucao_da_platform_do_robo_na_estacao_agent: inserida, observacao: 'valida leitura e apresentacao, nao a producao da execucao' },
  });

  const page = await signedIn(browser, ana, orgName);
  await go(page, pessoas);
  await expect(page.getByRole('heading', { level: 1, name: 'Pessoas e acessos' })).toBeVisible();

  // ------------------------------------------------ cadastro de cliente (pelo modal do próprio convite)
  const cliente = `Contábil ${TAG}`;
  await page.getByRole('radio', { name: /^Cliente/ }).check();
  await page.getByRole('button', { name: 'Cadastrar cliente' }).click();
  await page.getByRole('alertdialog', { name: 'Cadastrar cliente' }).getByLabel('Nome do cliente').fill(cliente);
  await page.getByRole('alertdialog', { name: 'Cadastrar cliente' }).getByRole('button', { name: 'Cadastrar' }).click();
  await expect(page.getByRole('combobox', { name: /^Cliente/ })).toHaveValue(/[0-9a-f-]{36}/);
  const clienteId = id(`SELECT client_id FROM clients WHERE organization_id = '${org}' AND name = '${cliente}'`);
  log('1a_cliente_cadastrado', { cliente, clienteId });

  // ------------------------------------------------ membro interno: recusado, com a explicação (antes e no servidor)
  await fillClientInvite(page, s.bruno.email, cliente, 'Fiscal', null, 'Robô de notas', false, false);
  await expect(page.getByText(/já é membro interno desta organização/)).toBeVisible();
  await page.getByRole('button', { name: 'Convidar' }).click();
  await confirmStepUp(page, ana, 'Enviar convite de cliente');
  await expect(page.getByRole('alertdialog').getByText(/já é membro interno da organização. Um convite de Cliente não reduziria/)).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
  log('9a_membro_interno_recusado', 'aviso na tela e recusa do servidor (client_invitation_internal_member); nada aplicado');

  // ------------------------------------------------ 1. convite de Cliente (Robô de notas, só a Estação Client, com registros)
  const carlaEmail = syntheticEmail(`cli-carla-${TAG}`);
  await go(page, pessoas);
  await fillClientInvite(page, carlaEmail, cliente, 'Fiscal', 'Estação Client', 'Robô de notas', true, false);
  await expect(page.getByText('Você está convidando esta pessoa para acompanhar a automação Robô de notas, no ambiente de trabalho Fiscal, com acesso às execuções da máquina Estação Client.')).toBeVisible();
  await shot(page, '1-convite-cliente-resumo');
  await page.getByRole('button', { name: 'Convidar' }).click();
  const conf = page.getByRole('alertdialog', { name: new RegExp(`Convidar ${carlaEmail} como cliente`) });
  for (const t of [cliente, 'Robô de notas', 'Fiscal', 'Estação Client', 'Execuções, registros']) await expect(conf).toContainText(t);
  await shot(page, '1-convite-cliente-confirmacao');
  await confirmStepUp(page, ana, 'Enviar convite de cliente');
  await expect(page.getByText('Convite de cliente enviado. O acesso só começa quando a pessoa aceitar.')).toBeVisible();
  await expect(rowOf(page, carlaEmail)).toContainText('Convite de cliente pendente');
  await expect(rowOf(page, carlaEmail)).toContainText(`Cliente · ${cliente}`);
  expect(sql(`SELECT count(*) FROM client_automation_grants WHERE client_id = '${clienteId}'`), 'o envio não concede nada').toBe('0');

  // a cliente: cadastro normal (sem senha implícita) e aceite pela identidade
  const pagC = await (await browser.newContext()).newPage();
  const carla = await signUpAndEnroll(pagC, `cli-carla-${TAG}`, carlaEmail);
  // antes do aceite: o Portal não mostra nada
  expect((await apiGet(pagC, '/portal/api/v1/me/client-organizations')).body.items).toEqual([]);
  expect((await apiGet(pagC, `/portal/api/v1/o/${org}/shared-automations`)).status).toBe(403);
  const token = await waitToken('ORG_INVITATION', carlaEmail);
  await go(pagC, `/o/${org}/convite#token=${token}`);
  await pagC.getByRole('button', { name: 'Aceitar convite' }).click();
  await confirmStepUp(pagC, carla, 'Aceitar');
  await expect(pagC.getByRole('heading', { name: 'Convite aceito' })).toBeVisible();
  await pagC.getByRole('button', { name: 'Ver o que foi compartilhado' }).click();
  await expect(pagC).toHaveURL(new RegExp(`/cliente/o/${org}$`));
  const cards = pagC.getByRole('list', { name: 'Automações compartilhadas' });
  await expect(cards.getByRole('listitem')).toHaveCount(1);
  await expect(cards).toContainText('Robô de notas');
  await expect(cards).toContainText('Estação Client');
  await shot(pagC, '1-area-do-cliente-cards');
  const cm = id(`SELECT client_membership_id FROM client_memberships m JOIN users u ON u.user_id = m.user_id WHERE m.organization_id = '${org}' AND u.email_normalized = '${carlaEmail}'`);
  log('1_convite_e_aceite', {
    convite: 'resumo e confirmacao com cliente, automacao, ambiente, maquina e permissoes; envio sem conceder nada',
    aceite: 'cadastro normal + aceite pela identidade; area do cliente com so Robo de notas na Estacao Client',
    conta: sql(`SELECT account_type || ':' || (SELECT link_channel FROM identity_users iu WHERE iu.user_id = u.user_id) FROM users u WHERE organization_id = '${org}' AND email_normalized = '${carlaEmail}'`),
    concessao: sql(`SELECT basis || ':' || status FROM client_automation_grants WHERE client_membership_id = '${cm}'`),
  });

  // ------------------------------------------------ 3. mesma automação em duas máquinas: só a da Estação Client
  await cards.getByRole('link', { name: 'Ver Robô de notas' }).click();
  const execs = pagC.getByRole('list', { name: 'Execuções' });
  await expect(execs.getByRole('listitem')).toHaveCount(2);
  await expect(execs).not.toContainText('Estação Agent');
  const execApi = await apiGet(pagC, `/portal/api/v1/o/${org}/shared-automations/${robo}/executions`);
  expect(execApi.body.items.map((e: { id: string }) => e.id)).not.toContain(inserida);
  expect((await apiGet(pagC, `/portal/api/v1/o/${org}/shared-executions/platform/${inserida}`)).status).toBe(404);
  log('3_mesma_automacao_em_duas_maquinas', { visiveis: execApi.body.items.length, execucao_na_estacao_agent: 'fora (lista e endereco direto: 404)' });

  // ------------------------------------------------ 4. registros sim, resultados não (permissões separadas)
  await go(pagC, `/cliente/o/${org}/execucoes/remote/${remota}`);
  await expect(pagC.getByRole('region', { name: 'Registros da execução' }).or(pagC.getByLabel('Registros da execução'))).toBeVisible();
  await expect(pagC.getByText('Os arquivos de resultado não foram compartilhados com você.')).toBeVisible();
  expect((await apiGet(pagC, `/portal/api/v1/o/${org}/shared-executions/remote/${remota}/attempts/${tentativa}/results`)).status).toBe(403);
  await shot(pagC, '4-execucao-registros-sem-resultados');

  // ------------------------------------------------ 5. fora do escopo por endereço e API, e outra organização
  const fora = {
    automacao_nao_compartilhada: (await apiGet(pagC, `/portal/api/v1/o/${org}/shared-automations/${csv}/executions`)).status,
    execucao_de_outra_automacao: (await apiGet(pagC, `/portal/api/v1/o/${org}/shared-executions/local_agent/${runCsv}`)).status,
    rotas_internas_da_platform: (await apiGet(pagC, `/api/v1/o/${org}/people`)).status,
    execucoes_internas: (await apiGet(pagC, `/api/v1/o/${org}/activity?tab=history`)).status,
    outra_organizacao: (await apiGet(pagC, `/portal/api/v1/o/${sql(`SELECT organization_id FROM users WHERE email_normalized = '${s.nara.email.toLowerCase()}' LIMIT 1`)}/shared-automations`)).status,
  };
  expect(fora.automacao_nao_compartilhada).toBe(404);
  expect(fora.execucao_de_outra_automacao).toBe(404);
  expect([401, 403]).toContain(fora.rotas_internas_da_platform);
  expect([401, 403]).toContain(fora.execucoes_internas);
  expect(fora.outra_organizacao).toBe(403);
  await go(pagC, `/cliente/o/${org}/automacoes/${csv}`);
  await expect(pagC.getByText('Não encontrado, ou não compartilhado com você.')).toBeVisible();
  log('5_fora_do_escopo', fora);

  // ------------------------------------------------ segunda administradora (para a aprovação por outra pessoa)
  const doraEmail = syntheticEmail(`cli-dora-${TAG}`);
  await go(page, pessoas);
  await page.getByRole('radio', { name: /^Pessoa da equipe/ }).check();
  await page.getByLabel(/^E-mail da pessoa/).fill(doraEmail);
  await page.getByRole('combobox', { name: /^Perfil/ }).selectOption('ORG_ADMIN');
  await page.getByRole('button', { name: 'Convidar' }).click();
  await confirmStepUp(page, ana, 'Enviar convite');
  const pagD = await (await browser.newContext()).newPage();
  const dora = await signUpAndEnroll(pagD, `cli-dora-${TAG}`, doraEmail);
  await go(pagD, `/o/${org}/convite#token=${await waitToken('ORG_INVITATION', doraEmail)}`);
  await pagD.getByRole('button', { name: 'Aceitar convite' }).click();
  await confirmStepUp(pagD, dora, 'Aceitar');
  await pagD.getByRole('button', { name: 'Entrar na organização' }).click();
  await expect(pagD).toHaveURL(new RegExp(`/o/${org}$`));
  await settle(pagD);

  // ------------------------------------------------ 2. outra automação na MESMA máquina e ambiente (pedido + segunda pessoa)
  await go(page, `${pessoas}?cliente=${cm}`);
  let modal = page.getByRole('alertdialog', { name: /^Gerenciar acessos de / });
  await expect(modal.getByRole('list', { name: 'Automações compartilhadas' })).toBeVisible();
  await modal.getByText('Compartilhar outra automação').click();
  await modal.getByRole('combobox', { name: /^Automação/ }).selectOption({ label: 'Rotina local · Fiscal' });
  await modal.getByRole('combobox', { name: /^Máquina/ }).selectOption({ label: 'Estação Agent' });
  await modal.getByRole('button', { name: 'Salvar acessos' }).click();
  await expect(page.getByText(/O novo compartilhamento aguarda a aprovação de outra pessoa/)).toBeVisible();
  const pedido = id(`SELECT grant_id FROM client_automation_grants WHERE client_membership_id = '${cm}' AND automation_id = '${rotina}' AND status = 1`);
  expect((await apiGet(pagC, `/portal/api/v1/o/${org}/shared-automations/${rotina}/executions`)).status, 'pendente não dá acesso').toBe(404);
  // quem pediu não aprova (servidor)
  await go(page, `/o/${org}/administracao/pessoas/acessos`);
  const linhaPedido = page.getByRole('region', { name: 'Lista de concessões de clientes' }).locator('tbody tr').filter({ hasText: 'Aguardando aprovação' }).filter({ hasText: 'Rotina local' });
  await linhaPedido.getByRole('button', { name: /^Aprovar Rotina local/ }).click();
  await confirmStepUp(page, ana, 'Aprovar');
  await expect(page.getByRole('alertdialog').getByText(/Aprovar exige outra pessoa/)).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
  // Dora aprova
  await go(pagD, `/o/${org}/administracao/pessoas/acessos`);
  await pagD.getByRole('region', { name: 'Lista de concessões de clientes' }).locator('tbody tr').filter({ hasText: 'Rotina local' }).getByRole('button', { name: /^Aprovar Rotina local/ }).click();
  await confirmStepUp(pagD, dora, 'Aprovar');
  await expect(pagD.getByText('Compartilhamento aprovado. A pessoa já vê a automação na próxima consulta.')).toBeVisible();
  const rotinaApi = await apiGet(pagC, `/portal/api/v1/o/${org}/shared-automations/${rotina}/executions`);
  expect(rotinaApi.status).toBe(200);
  expect(rotinaApi.body.items.length).toBeGreaterThan(0);
  const mesma = {
    rotina_local: rotinaApi.body.items.length,
    relatorio_csv_na_mesma_maquina: (await apiGet(pagC, `/portal/api/v1/o/${org}/shared-automations/${csv}/executions`)).status,
    rotina_longa_na_mesma_maquina: (await apiGet(pagC, `/portal/api/v1/o/${org}/shared-automations/${autom('Rotina longa')}/executions`)).status,
  };
  expect(mesma.relatorio_csv_na_mesma_maquina).toBe(404);
  expect(mesma.rotina_longa_na_mesma_maquina).toBe(404);
  log('2_duas_automacoes_na_mesma_maquina', { ...mesma, pedido, aprovacao: 'quem pediu foi recusado; a segunda administradora aprovou com confirmacao' });

  // ------------------------------------------------ 4b. ampliar resultados: pedido novo, aprovado por outra pessoa; download
  await go(page, `${pessoas}?cliente=${cm}`);
  modal = page.getByRole('alertdialog', { name: /^Gerenciar acessos de / });
  await expect(modal.getByRole('list', { name: 'Automações compartilhadas' })).toBeVisible();
  await modal.getByText('Compartilhar outra automação').click();
  await modal.getByRole('combobox', { name: /^Automação/ }).selectOption({ label: 'Robô de notas · Fiscal' });
  await modal.getByRole('combobox', { name: /^Máquina/ }).selectOption({ label: 'Estação Client' });
  await modal.getByRole('checkbox', { name: 'Consultar os registros' }).check();
  await modal.getByRole('checkbox', { name: 'Baixar os arquivos de resultado' }).check();
  await modal.getByRole('button', { name: 'Salvar acessos' }).click();
  await expect(page.getByText(/aguarda a aprovação de outra pessoa/)).toBeVisible();
  await go(pagD, `/o/${org}/administracao/pessoas/acessos`);
  await pagD.getByRole('region', { name: 'Lista de concessões de clientes' }).locator('tbody tr').filter({ hasText: 'Aguardando aprovação' }).filter({ hasText: 'Robô de notas' }).getByRole('button', { name: /^Aprovar Robô de notas/ }).click();
  await confirmStepUp(pagD, dora, 'Aprovar');
  await expect(pagD.getByText(/Compartilhamento aprovado/)).toBeVisible();
  await go(pagC, `/cliente/o/${org}/execucoes/remote/${remota}`);
  const baixar = pagC.getByRole('link', { name: /^Baixar / });
  await expect(baixar).toBeVisible();
  const download = await apiGet(pagC, `/portal/api/v1/o/${org}/shared-executions/remote/${remota}/attempts/${tentativa}/results/1/content`);
  expect(download.status).toBe(200);
  await shot(pagC, '4-execucao-com-resultados');
  // reduzir: registros desligados (uma pessoa, sem pedido); vale na próxima consulta
  await go(page, `${pessoas}?cliente=${cm}`);
  modal = page.getByRole('alertdialog', { name: /^Gerenciar acessos de / });
  await expect(modal.getByRole('list', { name: 'Automações compartilhadas' })).toBeVisible();
  await modal.getByRole('listitem').filter({ hasText: 'Robô de notas' }).getByRole('checkbox', { name: /^Registros/ }).uncheck();
  await modal.getByRole('button', { name: 'Salvar acessos' }).click();
  await expect(page.getByText(/Acessos de .* salvos\./)).toBeVisible();
  const reduzido = (await apiGet(pagC, `/portal/api/v1/o/${org}/shared-executions/remote/${remota}/attempts/${tentativa}/logs`)).status;
  expect(reduzido).toBe(403);
  log('4_registros_e_resultados', { sem_resultados: 403, ampliado_por_pedido_aprovado_por_outra_pessoa: 'download 200', registros_reduzidos: reduzido });

  // ------------------------------------------------ 7. revogar um acesso e suspender o vínculo com a sessão da cliente aberta
  await go(page, `/o/${org}/administracao/pessoas/acessos`);
  await page.getByRole('region', { name: 'Lista de concessões de clientes' }).locator('tbody tr').filter({ hasText: 'Rotina local' }).filter({ hasText: 'Ativa' }).getByRole('button', { name: /^Revogar Rotina local/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revogar' }).click();
  await expect(page.getByText('Acesso revogado. Os demais acessos da pessoa continuam valendo.')).toBeVisible();
  const aposRevogar = {
    rotina_local: (await apiGet(pagC, `/portal/api/v1/o/${org}/shared-automations/${rotina}/executions`)).status,
    robo_de_notas_continua: (await apiGet(pagC, `/portal/api/v1/o/${org}/shared-automations/${robo}/executions`)).status,
  };
  expect(aposRevogar).toEqual({ rotina_local: 404, robo_de_notas_continua: 200 });
  await go(page, `${pessoas}?cliente=${cm}`);
  modal = page.getByRole('alertdialog', { name: /^Gerenciar acessos de / });
  await expect(modal.getByRole('list', { name: 'Automações compartilhadas' })).toBeVisible();
  await modal.getByRole('combobox', { name: 'Vínculo com o cliente' }).selectOption('suspend');
  await modal.getByRole('button', { name: 'Salvar acessos' }).click();
  await expect(page.getByText(/Acessos de .* salvos\./)).toBeVisible();
  const suspensa = (await apiGet(pagC, `/portal/api/v1/o/${org}/shared-automations`)).status;
  expect(suspensa).toBe(403);
  await go(pagC, `/cliente/o/${org}`);
  await expect(pagC.getByText('Você não tem acesso de cliente nesta organização (ou ele foi suspenso).')).toBeVisible();
  await go(page, `${pessoas}?cliente=${cm}`);
  modal = page.getByRole('alertdialog', { name: /^Gerenciar acessos de / });
  await expect(modal.getByRole('list', { name: 'Automações compartilhadas' })).toBeVisible();
  await modal.getByRole('combobox', { name: 'Vínculo com o cliente' }).selectOption('reactivate');
  await confirmStepUp(page, ana, 'Salvar acessos');
  await expect(page.getByText(/Acessos de .* salvos\./)).toBeVisible();
  const reativada = (await apiGet(pagC, `/portal/api/v1/o/${org}/shared-automations`)).body.items.map((a: { name: string }) => a.name);
  expect(reativada).toEqual(['Robô de notas']);
  log('7_revogar_e_suspender_com_sessao_aberta', { ...aposRevogar, suspensa, reativada });

  // ------------------------------------------------ 6. convites: reenviar (link anterior deixa de valer), revogar, vencer; sem duplicar
  const x1 = syntheticEmail(`cli-x1-${TAG}`);
  const x2 = syntheticEmail(`cli-x2-${TAG}`);
  const x3 = syntheticEmail(`cli-x3-${TAG}`);
  for (const e of [x1, x2, x3]) {
    await go(page, pessoas);
    await fillClientInvite(page, e, cliente, 'Fiscal', null, 'Relatório CSV', false, false);
    await page.getByRole('button', { name: 'Convidar' }).click();
    await confirmStepUp(page, ana, 'Enviar convite de cliente');
    await expect(page.getByText('Convite de cliente enviado. O acesso só começa quando a pessoa aceitar.')).toBeVisible();
  }
  const antigo = id(`SELECT invitation_id FROM identity_invitations WHERE organization_id = '${org}' AND email_normalized = '${x1}' AND revoked_at IS NULL`);
  await rowOf(page, x1).getByRole('button', { name: `Reenviar convite para ${x1}` }).click();
  await expect(page.getByRole('alertdialog')).toContainText('O escopo confirmado não muda');
  await confirmStepUp(page, ana, 'Reenviar');
  await expect(page.getByText('Convite reenviado. O link anterior deixou de valer.')).toBeVisible();
  await rowOf(page, x2).getByRole('button', { name: `Revogar convite para ${x2}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revogar convite' }).click();
  await expect(page.getByText('Convite revogado. O link deixou de valer.')).toBeVisible();
  sql(`SET session_replication_role = replica; UPDATE identity_invitations SET created_at = now() - interval '8 days', expires_at = now() - interval '1 minute' WHERE organization_id = '${org}' AND email_normalized = '${x3}' AND revoked_at IS NULL AND accepted_at IS NULL`);
  const convites = {
    reenviado: sql(`SELECT revoke_reason || ':' || (SELECT automation_id = old.automation_id AND worker_id IS NOT DISTINCT FROM old.worker_id FROM identity_invitations n WHERE n.replaces_invitation_id = old.invitation_id) FROM identity_invitations old WHERE invitation_id = '${antigo}'`),
    revogado: sql(`SELECT revoke_reason FROM identity_invitations WHERE organization_id = '${org}' AND email_normalized = '${x2}'`),
    carla_uma_linha: sql(`SELECT count(*) FROM users WHERE organization_id = '${org}' AND email_normalized = '${carlaEmail}'`),
  };
  expect(convites.reenviado).toBe('2:true');
  expect(convites.carla_uma_linha).toBe('1');
  await go(page, `${pessoas}?estado=invitation_expired&estado=invitation_revoked&estado=invitation_accepted`);
  await expect(rowOf(page, x3)).toContainText('Convite de cliente vencido');
  await expect(rowOf(page, x2)).toContainText('Convite de cliente revogado');
  await expect(rowOf(page, carlaEmail)).toContainText('Convite de cliente aceito');
  await go(page, pessoas);
  await expect(rowOf(page, carlaEmail)).toHaveCount(1);
  await expect(rowOf(page, carlaEmail)).toContainText('Cliente ativo');
  await shot(page, '6-pessoas-com-cliente');
  log('6_convites', { ...convites, vencido_e_revogado_e_aceito: 'so pelo filtro', cliente_na_tabela: 'uma linha (Cliente ativo)' });

  // ------------------------------------------------ 8. auditoria: responsável e escopo de cada ato; a exceção marcada
  const hist = await apiGet(page, `/api/v1/o/${org}/access-history?clientId=${clienteId}&limit=100`);
  const atos = hist.body.items.map((e: any) => `${e.type}${e.grantException ? '*' : ''}|${e.byInvitee ? 'convidada' : e.actor?.email}`);
  for (const esperado of ['CLIENTE_CADASTRADO|', 'CONVITE_EMITIDO*|', 'CONVITE_ACEITO|convidada', 'CLIENTE_CONCESSAO_APLICADA_NO_ACEITE*|', 'CLIENTE_CONCESSAO_SOLICITADA|', 'CLIENTE_CONCESSAO_REDUZIDA|', 'CLIENTE_CONCESSAO_REVOGADA|', 'VINCULO_CLIENTE_SUSPENSO|', 'VINCULO_CLIENTE_REATIVADO|', 'CONVITE_REENVIADO*|', 'CONVITE_REVOGADO|'])
    expect(atos.some((a: string) => a.startsWith(esperado.split('|')[0]) && (esperado.endsWith('|') || a.endsWith(esperado.split('|')[1]))), esperado).toBe(true);
  expect(atos.filter((a: string) => a.startsWith('CLIENTE_CONCESSAO_APROVADA')).every((a: string) => a.endsWith(doraEmail))).toBe(true);
  await go(page, `/o/${org}/administracao/pessoas/acessos?aba=historico&cliente=${clienteId}`);
  await expect(page.getByRole('region', { name: 'Histórico de acessos' })).toContainText('Exceção do convite de cliente');
  await shot(page, '8-historico');
  log('8_auditoria', { atos: atos.length, aprovacoes_por: doraEmail, amostra: atos.slice(0, 12) });

  // ------------------------------------------------ 9. perfis internos, modal de acessos e links antigos
  await go(page, pessoas);
  await rowOf(page, s.bruno.email).getByRole('button', { name: /^Gerenciar acessos de / }).click();
  modal = page.getByRole('alertdialog', { name: /^Gerenciar acessos de / });
  await expect(modal.getByRole('list', { name: 'Acessos atuais' })).toBeVisible();
  await modal.getByText('Alcance efetivo desta pessoa').click();
  await expect(modal.getByText(/Acesso de Cliente não se soma a um membro interno/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(rowOf(page, s.bruno.email).getByRole('button', { name: /^Gerenciar acessos de / })).toBeFocused();
  const antigos: Record<string, string> = {};
  for (const [de, para] of [
    [`/o/${org}/administracao/clientes?estado=active`, `/o/${org}/administracao/pessoas/clientes?estado=active`],
    [`/o/${org}/administracao/concessoes?cliente=${clienteId}`, `/o/${org}/administracao/pessoas/acessos?cliente=${clienteId}`],
    [`/o/${org}/administracao/auditoria`, `/o/${org}/administracao/pessoas/acessos?aba=historico`],
    [`/o/${org}/administracao/membros`, `/o/${org}/administracao/pessoas`],
  ]) {
    await go(page, de);
    await expect(page).toHaveURL(para);
    antigos[de.replace(`/o/${org}`, '')] = para.replace(`/o/${org}`, '');
  }
  await expect(page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Clientes' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Concessões' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Auditoria de acessos' })).toHaveCount(0);
  // Gerenciar clientes: detalhes com a pessoa vinculada e a automação compartilhada
  await go(page, `/o/${org}/administracao/pessoas/clientes?cliente=${clienteId}`);
  await expect(page.getByRole('heading', { level: 2, name: cliente })).toBeVisible();
  await expect(page.getByText(carlaEmail)).toBeVisible();
  log('9_perfis_internos_modal_e_links_antigos', { modal_do_membro: 'alcance efetivo explicado; Esc fecha e o foco volta', links_antigos: antigos, menu: 'Clientes, Concessoes e Auditoria fora do menu' });

  // ------------------------------------------------ 10. teclado (abas), temas (axe com contraste) e tela estreita
  await go(page, `/o/${org}/administracao/pessoas/acessos`);
  await page.getByRole('tab', { name: 'Concessões' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Histórico' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Histórico' })).toBeFocused();
  for (const [label, tema] of [
    ['Nekkora Dark', 'dark'],
    ['Nekkora Light', 'light'],
    ['Sakura Dark', 'sakura-dark'],
  ] as const) {
    await go(page, `/o/${org}/conta`);
    await page.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: new RegExp(`^${label}`) }).check();
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-nk-theme'))).toBe(tema);
    await go(page, pessoas);
    await page.getByRole('radio', { name: /^Cliente/ }).check();
    await page.getByRole('combobox', { name: /^Ambiente de trabalho/ }).selectOption({ label: 'Fiscal' });
    await audit(page, `pessoas-cliente-${tema}`);
    await shot(page, `10-pessoas-cliente-${tema}`);
    await go(page, `${pessoas}?cliente=${cm}`);
    await expect(page.getByRole('alertdialog', { name: /^Gerenciar acessos de / }).getByRole('list', { name: 'Automações compartilhadas' })).toBeVisible();
    await audit(page, `modal-cliente-${tema}`);
    await go(page, `/o/${org}/administracao/pessoas/acessos?cliente=${clienteId}`);
    await audit(page, `acessos-${tema}`);
    await go(page, `/o/${org}/administracao/pessoas/acessos?aba=historico&cliente=${clienteId}`);
    await audit(page, `historico-${tema}`);
    await go(page, `/o/${org}/administracao/pessoas/clientes?cliente=${clienteId}`);
    await audit(page, `clientes-${tema}`);
    await shot(page, `10-clientes-${tema}`);
  }
  await go(page, `/o/${org}/conta`);
  await page.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: /^Nekkora Light/ }).check();
  for (const [tema, nome] of [
    ['dark', 'Nekkora Dark'],
    ['light', 'Nekkora Light'],
    ['sakura-dark', 'Sakura Dark'],
  ] as const) {
    await pagC.evaluate((t) => localStorage.setItem('nekkora.tema', t), tema).catch(() => undefined);
    await go(pagC, '/organizacoes');
    const seletor = pagC.getByRole('button', { name: /Tema/ }).first();
    if (await seletor.isVisible().catch(() => false)) {
      await seletor.click();
      await pagC.getByRole('menuitemradio', { name: new RegExp(`^${nome}`) }).or(pagC.getByRole('radio', { name: new RegExp(`^${nome}`) })).first().click().catch(() => undefined);
    }
    await go(pagC, `/cliente/o/${org}`);
    await audit(pagC, `area-cliente-${tema}`);
    await go(pagC, `/cliente/o/${org}/execucoes/remote/${remota}`);
    await audit(pagC, `area-cliente-execucao-${tema}`);
    await shot(pagC, `10-area-cliente-${tema}`);
  }
  const estreita = await signedIn(browser, ana, orgName, { width: 375, height: 800 });
  await go(estreita, pessoas);
  await estreita.getByRole('radio', { name: /^Cliente/ }).check();
  await audit(estreita, 'pessoas-cliente-375');
  await shot(estreita, '10-pessoas-cliente-375');
  await go(estreita, `${pessoas}?cliente=${cm}`);
  await expect(estreita.getByRole('alertdialog', { name: /^Gerenciar acessos de / }).getByRole('list', { name: 'Automações compartilhadas' })).toBeVisible();
  await audit(estreita, 'modal-cliente-375');
  await go(estreita, `/o/${org}/administracao/pessoas/acessos`);
  await audit(estreita, 'acessos-375');
  const cEstreita = await (await browser.newContext({ viewport: { width: 375, height: 800 } })).newPage();
  await signInWithTotp(cEstreita, carla).catch(async () => {
    await cEstreita.waitForTimeout(31_000);
    await cEstreita.getByLabel('Código de autenticação').fill(await carla.auth.next());
  });
  await expect(cEstreita.getByRole('region', { name: 'Compartilhado com você' }).or(cEstreita.getByRole('heading', { name: 'Compartilhado com você' }))).toBeVisible();
  await go(cEstreita, `/cliente/o/${org}/execucoes/remote/${remota}`);
  await audit(cEstreita, 'area-cliente-375');
  await shot(cEstreita, '10-area-cliente-375');
  log('10_teclado_temas_e_tela_estreita', { teclado: 'setas trocam as abas; Esc fecha o modal e devolve o foco', axe_com_contraste: 'pessoas (cliente), modal, acessos, historico, clientes e area do cliente nos tres temas e em 375 px, sem violacoes', rolagem_horizontal: 'nenhuma' });
  log('fim', 'roteiro de Clientes e acessos concluido');
});
