import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { Authenticator } from '../mock/totp';
import { activateMfa, confirmStepUp, identitySignIn, LAB, messages, PASSWORD, signInWithTotp, signUpAndEnroll, syntheticEmail, waitToken, type Person } from './support/lab';

/**
 * PLATFORM-FLUXO-002 (070/071) — COMPARTILHAMENTO POR PESSOA pela Web de produção contra a API e o Portal reais do laboratório, com
 * pessoas sintéticas. Usa a organização do acompanhamento (~/.nekkora/front-lab/<lab>/acompanhamento.json): a administradora (Ana)
 * e o leitor do Fiscal (Bruno). Cadastra três pessoas: Eva (recebe o dashboard pelo convite e faz o primeiro acesso pelo link),
 * Wes (membro com WORKSPACE_ADMIN do Fiscal, que PEDE o compartilhamento) e Pedro (recebe os arquivos de retorno pelo pedido
 * aprovado). O convite da titular que estiver na organização não é tocado.
 *
 * Massa: a execução remota REAL de "Robô de notas" na Estação Client (com arquivo de retorno). UMA execução da Platform de
 * "Robô de notas" na Estação Agent é INSERIDA no banco (declarada), para a mesma automação em duas máquinas: valida leitura e
 * apresentação, não a produção da execução.
 *
 *   FRONT_LAB_ID=frontlab-fluxo002 FRONT_PORTA=5196 npx playwright test -c playwright.real.config.ts fluxo-002-clientes
 */
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-fluxo-002-compartilhamento`);
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


/** Preenche o compartilhamento por pessoa (sem enviar). `machine` fica em "Opções adicionais". */
async function fillShare(page: Page, name: string, email: string, workspace: string, automation: string, machine: string | null, dashboard: boolean, files: boolean) {
  await page.getByRole('radio', { name: /^Pessoa externa/ }).check();
  await page.getByLabel(/^Nome da pessoa/).fill(name);
  await page.getByLabel(/^E-mail da pessoa/).fill(email);
  await page.getByRole('combobox', { name: /^Ambiente de trabalho/ }).selectOption({ label: workspace });
  if (machine) {
    await page.getByText('Opções adicionais', { exact: true }).click();
    await page.getByRole('combobox', { name: /^Máquina/ }).selectOption({ label: machine });
  }
  await page.getByRole('combobox', { name: /^Automação/ }).selectOption({ label: automation });
  const d = page.getByRole('checkbox', { name: /^Dashboard de execução/ });
  if ((await d.isChecked()) !== dashboard) await d.click();
  const f = page.getByRole('checkbox', { name: /^Arquivos de retorno/ });
  if ((await f.isChecked()) !== files) await f.click();
}

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('Compartilhamento por pessoa: dashboard e arquivos de retorno, sem registros técnicos; primeiro acesso sem repetir nome e e-mail; pedido de membro aprovado antes do convite; escopo por automação e máquina nos totais, buscas e downloads; revogação com a sessão aberta; auditoria; temas e tela estreita', async ({ browser }) => {
  test.setTimeout(3_000_000);
  expect(existsSync(ESTADO), 'o roteiro do acompanhamento guardou a organização e as pessoas').toBe(true);
  rmSync(EVID, { recursive: true, force: true });
  const s = JSON.parse(readFileSync(ESTADO, 'utf8')) as { ana: Guardada; bruno: Guardada; nara: Guardada; org: string; orgName: string; fiscal: string };
  const { org } = s;
  const ana = reviver(s.ana);
  const orgName = new RegExp(`^Entrar em ${s.orgName}(?![0-9a-z])`);
  const pessoas = `/o/${org}/administracao/pessoas`;
  log('laboratorio', readFileSync(resolve(`tools/lab/saidas/${LAB}/laboratorio.txt`), 'utf8').replace(/\n/g, ' | '));

  // ------------------------------------------------ 0. a 071 nas concessões e convites que existiam (com registros técnicos)
  const migracao = {
    tabela_da_071: sql("SELECT to_regclass('public.client_share_requests') IS NOT NULL"),
    eventos_25: sql(`SELECT count(*) FROM access_events WHERE organization_id = '${org}' AND event_type = 25`),
    abertas_com_logs: sql(`SELECT count(*) FROM client_automation_grants WHERE organization_id = '${org}' AND status IN (1, 2) AND can_read_logs`),
    revogadas_com_logs_historico: sql(`SELECT count(*) FROM client_automation_grants WHERE organization_id = '${org}' AND status = 4 AND can_read_logs`),
    eventos_antigos_com_logs: sql(`SELECT count(*) FROM access_events WHERE organization_id = '${org}' AND can_read_logs AND event_type <> 25`),
    convites_abertos_com_logs: sql(`SELECT count(*) FROM identity_invitations WHERE organization_id = '${org}' AND accepted_at IS NULL AND revoked_at IS NULL AND can_read_logs`),
    funcoes_de_logs_no_portal: sql("SELECT count(*) FROM pg_proc WHERE proname IN ('portal_client_list_logs', 'portal_client_get_execution', 'portal_client_attempt')"),
  };
  expect(migracao.abertas_com_logs).toBe('0');
  expect(migracao.convites_abertos_com_logs).toBe('0');
  expect(migracao.funcoes_de_logs_no_portal).toBe('0');
  log('0_tratamento_dos_logs_existentes', migracao);

  // ------------------------------------------------ massa: execuções reais e UMA inserida (declarada)
  const id = (q: string) => sql(q).split('\n')[0];
  const autom = (nome: string) => id(`SELECT automation_id FROM automations WHERE organization_id = '${org}' AND name = '${nome}'`);
  const maquina = (nome: string) => id(`SELECT worker_id FROM workers WHERE organization_id = '${org}' AND name = '${nome}'`);
  const robo = autom('Robô de notas');
  const csv = autom('Relatório CSV');
  const client = maquina('Estação Client');
  const agent = maquina('Estação Agent');
  const remota = id(`SELECT remote_execution_id FROM remote_executions WHERE organization_id = '${org}' AND automation_id = '${robo}' ORDER BY requested_at LIMIT 1`);
  const tentativa = id(`SELECT attempt_id FROM remote_attempts WHERE remote_execution_id = '${remota}' ORDER BY attempt_number DESC LIMIT 1`);
  const arquivo = id(`SELECT file_name FROM remote_attempt_results WHERE attempt_id = '${tentativa}' ORDER BY result_number LIMIT 1`);
  const inserida = sql(
    `SET session_replication_role = replica; INSERT INTO executions (organization_id, workspace_id, automation_id, automation_version_id, request_key, request_fingerprint, requested_by_membership_id, command_snapshot, status, status_reason, origin, created_at, started_at, finished_at, worker_id, worker_agent_assignment_id, worker_workspace_assignment_id, reserved_at) SELECT a.organization_id, a.workspace_id, a.automation_id, v.automation_version_id, 'compart-${TAG}', repeat('c', 64), m.membership_id, v.command_json, 4, 1, 1, now() - interval '2 hours', now() - interval '2 hours', now() - interval '119 minutes', '${agent}', gen_random_uuid(), gen_random_uuid(), now() - interval '2 hours' FROM automations a JOIN automation_versions v ON v.automation_id = a.automation_id AND v.status = 2 JOIN organization_memberships m ON m.organization_id = a.organization_id JOIN users u ON u.user_id = m.user_id AND u.email_normalized = '${ana.email.toLowerCase()}' WHERE a.automation_id = '${robo}' ORDER BY v.created_at DESC LIMIT 1 RETURNING execution_id`,
  ).split('\n').find((l) => /^[0-9a-f-]{36}$/.test(l))!;
  // dois estados que NUNCA são "Concluída", na Estação Client (inseridos, declarados): Python externo que terminou com código 0
  // sem sinal de sucesso (AGT-EXT-001) e uma execução remota encerrada sem confirmação (resultado desconhecido)
  const semSinal = sql(
    `SET session_replication_role = replica; INSERT INTO agent_runs (organization_id, workspace_id, automation_id, automation_version_id, authorization_id, agent_id, worker_id, worker_agent_assignment_id, agent_execution_id, package_fingerprint, authorization_state_at_registration, supervisor_state, supervisor_code, registered_at, agent_started_at, agent_ended_at) SELECT a.organization_id, a.workspace_id, a.automation_id, v.automation_version_id, gen_random_uuid(), gen_random_uuid(), '${client}', gen_random_uuid(), 'ex-' || md5(random()::text), repeat('a', 64), 1, 4, 'AGT-EXT-001', now() - interval '90 minutes', now() - interval '90 minutes', now() - interval '89 minutes' FROM automations a JOIN automation_versions v ON v.automation_id = a.automation_id AND v.status = 2 WHERE a.automation_id = '${robo}' ORDER BY v.created_at DESC LIMIT 1 RETURNING agent_run_id`,
  ).split('\n').find((l) => /^[0-9a-f-]{36}$/.test(l))!;
  const desconhecida = sql(
    `SET session_replication_role = replica; WITH x AS (INSERT INTO remote_executions (organization_id, workspace_id, automation_id, automation_version_id, package_fingerprint, package_fingerprint_rule, requirements_revision, effective_dependencies, request_key, requested_by_membership_id, requested_at) SELECT a.organization_id, a.workspace_id, a.automation_id, v.automation_version_id, repeat('ab', 32), 'nekkora-agent/external-python-fingerprint/1', 1, '[]'::jsonb, gen_random_uuid(), m.membership_id, now() - interval '80 minutes' FROM automations a JOIN automation_versions v ON v.automation_id = a.automation_id AND v.status = 2 JOIN organization_memberships m ON m.organization_id = a.organization_id JOIN users u ON u.user_id = m.user_id AND u.email_normalized = '${ana.email.toLowerCase()}' WHERE a.automation_id = '${robo}' ORDER BY v.created_at DESC LIMIT 1 RETURNING remote_execution_id, organization_id, requested_by_membership_id) INSERT INTO remote_attempts (organization_id, remote_execution_id, attempt_number, agent_id, worker_id, authorization_id, created_by_membership_id, created_at, offer_valid_until, state, token_hash, ended_at) SELECT organization_id, remote_execution_id, 1, gen_random_uuid(), '${client}', gen_random_uuid(), requested_by_membership_id, now() - interval '80 minutes', now() - interval '65 minutes', 13, repeat('d', 64), now() - interval '70 minutes' FROM x RETURNING remote_execution_id`,
  ).split('\n').find((l) => /^[0-9a-f-]{36}$/.test(l))!;
  log('massa', {
    real: { remota_robo_na_estacao_client: remota, arquivo_de_retorno: arquivo },
    inserida_no_banco: {
      execucao_da_platform_do_robo_na_estacao_agent: inserida,
      agent_terminou_sem_sinal_de_erro_na_estacao_client: semSinal,
      remota_com_resultado_desconhecido_na_estacao_client: desconhecida,
      observacao: 'valida leitura e apresentacao, nao a producao da execucao',
    },
  });

  const page = await signedIn(browser, ana, orgName);
  await go(page, pessoas);
  await expect(page.getByRole('heading', { level: 1, name: 'Pessoas e acessos' })).toBeVisible();

  // ------------------------------------------------ 0b. abas Pessoas, Compartilhamentos e Histórico (padrão de Execuções), sem abas internas
  const abas = page.getByRole('tablist', { name: 'Pessoas e acessos' });
  await expect(abas.getByRole('tab')).toHaveText(['Pessoas', 'Compartilhamentos', 'Histórico']);
  await expect(abas.getByRole('tab', { name: 'Pessoas' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel').getByRole('tablist')).toHaveCount(0);
  const tabela = page.getByRole('region', { name: 'Lista de pessoas e convites' });
  await expect(tabela).toContainText('Convite');
  await expect(tabela).toContainText(s.bruno.email);
  await abas.getByRole('tab', { name: 'Pessoas' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/[?&]aba=compartilhamentos/);
  await expect(abas.getByRole('tab', { name: 'Compartilhamentos' })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Lista de concessões de clientes' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/[?&]aba=historico/);
  await page.reload();
  await settle(page);
  await expect(page.getByRole('tab', { name: 'Histórico' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Histórico de acessos' })).toBeVisible();
  await page.getByRole('tab', { name: 'Histórico' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Pessoas' })).toHaveAttribute('aria-selected', 'true');
  await go(page, `/o/${org}/administracao/pessoas/acessos?aba=historico`);
  await expect(page).toHaveURL(/\/administracao\/pessoas\?.*aba=historico/);
  await go(page, `/o/${org}/administracao/auditoria`);
  await expect(page.getByRole('tab', { name: 'Histórico' })).toHaveAttribute('aria-selected', 'true');
  await shot(page, '0b-abas');
  log('0b_abas', { abas: ['Pessoas', 'Compartilhamentos', 'Historico'], teclado: 'setas percorrem as tres', recarga: 'aba mantida', enderecos_antigos: 'acessos e auditoria abrem a aba certa', abas_internas: 0, tabela: 'membros e convites juntos' });
  await go(page, pessoas);

  // ------------------------------------------------ 1. formulário: nome e e-mail, automação, conteúdos; sem registros técnicos; sem cadastro de cliente
  await fillShare(page, 'Bruno', s.bruno.email, 'Fiscal', 'Robô de notas', null, true, false);
  await expect(page.getByText(/já é membro interno desta organização/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /registros/i })).toHaveCount(0);
  await expect(page.getByText('Relatórios personalizados: ainda não disponíveis.')).toBeVisible();
  await page.getByRole('button', { name: 'Convidar' }).click();
  await confirmStepUp(page, ana, 'Compartilhar e enviar convite');
  await expect(page.getByRole('alertdialog').getByText(/já é membro interno da organização/)).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
  const eva = { name: `Eva Cliente ${TAG}`, email: syntheticEmail(`cmp-eva-${TAG}`) };
  await go(page, pessoas);
  await fillShare(page, eva.name, eva.email, 'Fiscal', 'Robô de notas', 'Estação Client', true, false);
  await expect(page.getByText(`Você está compartilhando a automação Robô de notas (ambiente de trabalho Fiscal) com ${eva.name}, considerando execuções da máquina Estação Client.`)).toBeVisible();
  await shot(page, '1-compartilhar-formulario');
  await page.getByRole('button', { name: 'Convidar' }).click();
  const conf = page.getByRole('alertdialog', { name: `Compartilhar Robô de notas com ${eva.name}?` });
  for (const t of [eva.email, 'Robô de notas', 'Fiscal', 'Estação Client', 'Só o dashboard de execução', 'Criado ou reutilizado com o nome da pessoa']) await expect(conf).toContainText(t);
  await shot(page, '1-compartilhar-confirmacao');
  await confirmStepUp(page, ana, 'Compartilhar e enviar convite');
  await expect(page.getByText('Compartilhamento enviado por convite. O acesso só começa quando a pessoa aceitar.')).toBeVisible();
  const evaCliente = sql(`SELECT c.name || '|' || c.client_id FROM identity_invitations i JOIN clients c ON c.client_id = i.client_id WHERE i.organization_id = '${org}' AND i.email_normalized = '${eva.email}'`);
  expect(evaCliente.split('|')[0], 'cliente interno criado com o nome da pessoa, sem etapa').toBe(eva.name);
  const evaClienteId = evaCliente.split('|')[1];
  log('1_formulario', { membro_interno: 'aviso + recusa do servidor', registros_tecnicos: 'sem opcao', relatorios: 'marcados como ainda nao disponiveis', cliente_interno: evaCliente });

  // ------------------------------------------------ 2. primeiro acesso pelo link: sem repetir nome e e-mail
  const pagE = await (await browser.newContext()).newPage();
  const convite = await waitToken('ORG_INVITATION', eva.email);
  await go(pagE, `/o/${org}/convite#token=${convite}`);
  await expect(pagE.getByText(new RegExp(`${eva.name}, .* compartilhou com você o acompanhamento de uma automação. O convite é para ${eva.email.replace(/[.+]/g, '\\$&')}`))).toBeVisible();
  await shot(pagE, '2-convite-sem-sessao');
  await pagE.getByRole('button', { name: 'Criar meu acesso' }).click();
  await expect(pagE.getByRole('heading', { name: 'Criar seu acesso' })).toBeVisible();
  await expect(pagE.getByRole('textbox', { name: /E-mail/ })).toHaveValue(eva.email);
  await expect(pagE.getByRole('textbox', { name: /E-mail/ })).toHaveAttribute('readonly', '');
  await pagE.getByRole('button', { name: 'Enviar o link de confirmação' }).click();
  await expect(pagE.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();
  const cadastro = await waitToken('IDENTITY_SIGNUP_CONFIRMATION', eva.email);
  await go(pagE, `/cadastro/confirmar#token=${cadastro}`);
  await expect(pagE.getByText('Seu nome veio do convite. Só falta escolher a senha.')).toBeVisible();
  await expect(pagE.getByLabel(/^Nome\*?$/)).toHaveValue(eva.name);
  await shot(pagE, '2-confirmacao-nome-do-convite');
  await pagE.getByLabel(/^Senha\*?$/).fill(PASSWORD);
  await pagE.getByLabel(/^Confirmar senha\*?$/).fill(PASSWORD);
  await pagE.getByRole('button', { name: 'Concluir cadastro' }).click();
  await expect(pagE.getByRole('heading', { name: 'Cadastro concluído' })).toBeVisible();
  await pagE.getByRole('button', { name: 'Entrar' }).click();
  await identitySignIn(pagE, eva.email);
  await pagE.waitForURL(/\/(organizacoes|conta\/proteger)$/);
  const { auth } = await activateMfa(pagE, PASSWORD);
  const evaP: Person = { email: eva.email, password: PASSWORD, name: eva.name, auth, recoveryCodes: [] };
  await go(pagE, `/o/${org}/convite#token=${convite}`);
  await pagE.getByRole('button', { name: 'Aceitar convite' }).click();
  await confirmStepUp(pagE, evaP, 'Aceitar');
  await expect(pagE.getByRole('heading', { name: 'Convite aceito' })).toBeVisible();
  await pagE.getByRole('button', { name: 'Ver o que foi compartilhado' }).click();
  log('2_primeiro_acesso', {
    convite_sem_sessao: 'nome e e-mail do convite na tela',
    cadastro: 'e-mail preenchido e travado; nome preenchido na confirmacao; so a senha digitada; MFA ativado pela oferta',
    nome_da_identidade: sql(`SELECT display_name FROM identities WHERE email_normalized = '${eva.email}'`),
  });

  // ------------------------------------------------ 3. área da Eva: só dashboard; nada de máquina, ambiente ou registros; escopo nos totais
  await expect(pagE).toHaveURL(new RegExp(`/cliente/o/${org}$`));
  const cards = pagE.getByRole('list', { name: 'Automações compartilhadas' });
  await expect(cards.getByRole('listitem')).toHaveCount(1);
  await expect(cards).toContainText('Robô de notas');
  await expect(pagE.locator('main')).not.toContainText(/Estação|Fiscal|registro/i);
  await shot(pagE, '3-area-dashboard');
  await cards.getByRole('link', { name: 'Ver o dashboard de Robô de notas' }).click();
  await expect(pagE.getByRole('group', { name: 'Indicadores do período' })).toBeVisible();
  const execucoesLista = pagE.getByRole('list', { name: 'Execuções' });
  await expect(execucoesLista).toContainText('Terminou sem confirmação de sucesso');
  await expect(execucoesLista).toContainText('Resultado desconhecido');
  await shot(pagE, '3-dashboard-da-automacao');
  const resumo = await apiGet(pagE, `/portal/api/v1/o/${org}/shared-automations/${robo}/summary`);
  // as quatro origens (mesma regra do Portal), só desta organização, desta automação e da Estação Client, nos últimos 30 dias
  const esperado = sql(`SELECT (SELECT count(*) FROM executions WHERE organization_id = '${org}' AND automation_id = '${robo}' AND worker_id = '${client}' AND created_at >= now() - interval '30 days') + (SELECT count(*) FROM agent_runs WHERE organization_id = '${org}' AND automation_id = '${robo}' AND worker_id = '${client}' AND platform_execution_id IS NULL AND registered_at >= now() - interval '30 days') + (SELECT count(*) FROM run_requests WHERE organization_id = '${org}' AND automation_id = '${robo}' AND worker_id = '${client}' AND state <> 6 AND agent_run_id IS NULL AND requested_at >= now() - interval '30 days') + (SELECT count(*) FROM remote_executions x WHERE x.organization_id = '${org}' AND x.automation_id = '${robo}' AND x.requested_at >= now() - interval '30 days' AND (SELECT z.worker_id FROM remote_attempts z WHERE z.remote_execution_id = x.remote_execution_id ORDER BY z.attempt_number DESC LIMIT 1) = '${client}')`);
  const execs = await apiGet(pagE, `/portal/api/v1/o/${org}/shared-automations/${robo}/executions`);
  const escopo = {
    resumo_total: resumo.body.total,
    esperado_so_estacao_client: Number(esperado),
    inserida_na_estacao_agent_fora: !execs.body.items.some((e: { id: string }) => e.id === inserida),
    campos_da_execucao: Object.keys(execs.body.items[0] ?? {}),
    arquivos_sem_permissao: (await apiGet(pagE, `/portal/api/v1/o/${org}/shared-files?automationId=${robo}`)).status,
    download_sem_permissao: (await apiGet(pagE, `/portal/api/v1/o/${org}/shared-files/${tentativa}/1/content`)).status,
    rota_antiga_de_registros: (await apiGet(pagE, `/portal/api/v1/o/${org}/shared-executions/remote/${remota}/attempts/${tentativa}/logs`)).status,
    rota_antiga_de_detalhe: (await apiGet(pagE, `/portal/api/v1/o/${org}/shared-executions/remote/${remota}`)).status,
    automacao_nao_compartilhada: (await apiGet(pagE, `/portal/api/v1/o/${org}/shared-automations/${csv}/summary`)).status,
    rotas_internas_da_platform: (await apiGet(pagE, `/api/v1/o/${org}/people`)).status,
  };
  expect(escopo.resumo_total).toBe(escopo.esperado_so_estacao_client);
  const estados = { concluidas: resumo.body.succeeded, sem_confirmacao_de_sucesso: resumo.body.noErrorSignaled, resultado_desconhecido: resumo.body.unconfirmed };
  expect(estados.sem_confirmacao_de_sucesso).toBeGreaterThanOrEqual(1);
  expect(estados.resultado_desconhecido).toBeGreaterThanOrEqual(1);
  const concluidasNoBanco = Number(sql(`SELECT (SELECT count(*) FROM executions WHERE organization_id = '${org}' AND automation_id = '${robo}' AND worker_id = '${client}' AND status = 4 AND created_at >= now() - interval '30 days') + (SELECT count(*) FROM remote_executions x WHERE x.organization_id = '${org}' AND x.automation_id = '${robo}' AND x.requested_at >= now() - interval '30 days' AND (SELECT z.state FROM remote_attempts z WHERE z.remote_execution_id = x.remote_execution_id ORDER BY z.attempt_number DESC LIMIT 1) = 7 AND (SELECT z.worker_id FROM remote_attempts z WHERE z.remote_execution_id = x.remote_execution_id ORDER BY z.attempt_number DESC LIMIT 1) = '${client}')`));
  expect(estados.concluidas, 'concluidas = so sucesso confirmado').toBe(concluidasNoBanco);
  log('4b_estados_do_dashboard', { ...estados, concluidas_no_banco: concluidasNoBanco });
  expect(escopo.inserida_na_estacao_agent_fora).toBe(true);
  expect(escopo.campos_da_execucao).not.toContain('machine');
  expect(escopo.arquivos_sem_permissao).toBe(403);
  expect(escopo.download_sem_permissao).toBe(403);
  expect(escopo.rota_antiga_de_registros).toBe(404);
  expect(escopo.rota_antiga_de_detalhe).toBe(404);
  expect(escopo.automacao_nao_compartilhada).toBe(404);
  expect([401, 403]).toContain(escopo.rotas_internas_da_platform);
  log('3_area_do_cliente_so_dashboard', escopo);

  // ------------------------------------------------ 4. membro com WORKSPACE_ADMIN pede; nada sai antes da aprovação; a administradora aprova
  const wes = syntheticEmail(`cmp-wes-${TAG}`);
  await go(page, pessoas);
  await page.getByRole('radio', { name: /^Pessoa da equipe/ }).check();
  await page.getByLabel(/^E-mail da pessoa/).fill(wes);
  await page.getByRole('combobox', { name: /^Perfil/ }).selectOption('WORKSPACE_ADMIN');
  await page.getByRole('combobox', { name: /^Ambiente de trabalho do perfil/ }).selectOption({ label: 'Fiscal' });
  await page.getByRole('button', { name: 'Convidar' }).click();
  await confirmStepUp(page, ana, 'Enviar convite');
  const pagW = await (await browser.newContext()).newPage();
  const wesP = await signUpAndEnroll(pagW, `cmp-wes-${TAG}`, wes);
  await go(pagW, `/o/${org}/convite#token=${await waitToken('ORG_INVITATION', wes)}`);
  await pagW.getByRole('button', { name: 'Aceitar convite' }).click();
  await confirmStepUp(pagW, wesP, 'Aceitar');
  await pagW.getByRole('button', { name: 'Entrar na organização' }).click();
  await expect(pagW).toHaveURL(new RegExp(`/o/${org}$`));
  await settle(pagW);
  await go(pagW, `/o/${org}/automacoes/${robo}`);
  await pagW.getByRole('button', { name: 'Pedir compartilhamento' }).click();
  const pedro = { name: `Pedro Arquivos ${TAG}`, email: syntheticEmail(`cmp-pedro-${TAG}`) };
  await pagW.getByLabel(/^Nome da pessoa/).fill(pedro.name);
  await pagW.getByLabel(/^E-mail da pessoa/).fill(pedro.email);
  await pagW.getByRole('checkbox', { name: /^Dashboard de execução/ }).uncheck();
  await pagW.getByRole('checkbox', { name: /^Arquivos de retorno/ }).check();
  await shot(pagW, '4-membro-pede');
  await pagW.getByRole('button', { name: 'Revisar pedido' }).click();
  await pagW.getByRole('alertdialog').getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(pagW.getByText('Pedido enviado para aprovação. Nada foi enviado à pessoa ainda.')).toBeVisible();
  await expect(pagW.getByRole('region', { name: 'Pedidos de compartilhamento de Robô de notas' })).toContainText('Aguardando aprovação');
  expect(messages('ORG_INVITATION', pedro.email), 'nada enviado antes da aprovação').toBe(0);
  const convidarDireto = await pagW.evaluate(async (o) => (await fetch(`/api/v1/o/${o}/client-invitations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, org);
  await go(page, `/o/${org}/administracao/pessoas?aba=compartilhamentos`);
  const painel = page.getByRole('list', { name: 'Pedidos de compartilhamento aguardando decisão' });
  await expect(painel).toContainText(pedro.name);
  await shot(page, '4-pedido-para-aprovar');
  await painel.getByRole('button', { name: `Aprovar o compartilhamento com ${pedro.name}` }).click();
  await confirmStepUp(page, ana, 'Aprovar e enviar convite');
  await expect(page.getByText('Pedido aprovado. O convite foi enviado; o acesso só começa quando a pessoa aceitar.')).toBeVisible();
  const pagP = await (await browser.newContext()).newPage();
  const pedroP = await signUpAndEnroll(pagP, `cmp-pedro-${TAG}`, pedro.email);
  await go(pagP, `/o/${org}/convite#token=${await waitToken('ORG_INVITATION', pedro.email)}`);
  await pagP.getByRole('button', { name: 'Aceitar convite' }).click();
  await confirmStepUp(pagP, pedroP, 'Aceitar');
  await pagP.getByRole('button', { name: 'Ver o que foi compartilhado' }).click();
  log('4_pedido_de_membro', {
    antes_da_aprovacao: 'nenhum e-mail para a pessoa',
    convite_direto_pelo_membro: convidarDireto,
    pedido: sql(`SELECT status || ':' || (decided_by_membership_id <> requested_by_membership_id) FROM client_share_requests WHERE organization_id = '${org}' AND email_normalized = '${pedro.email}'`),
    excecao_no_convite: sql(`SELECT grant_exception FROM access_events e JOIN identity_invitations i ON i.invitation_id = e.invitation_id WHERE i.email_normalized = '${pedro.email}' AND e.event_type = 1`),
  });

  // ------------------------------------------------ 5. Pedro: só arquivos de retorno (ver e baixar); sem dashboard
  await expect(pagP.getByRole('list', { name: 'Automações compartilhadas' })).toContainText('O dashboard desta automação não foi compartilhado com você.');
  await pagP.getByRole('link', { name: 'Ver arquivos de retorno' }).click();
  const lista = pagP.getByRole('list', { name: 'Arquivos de retorno' });
  await expect(lista).toContainText(arquivo);
  await expect(lista).toContainText('Robô de notas · execução de');
  await pagP.getByRole('button', { name: `Visualizar ${arquivo}` }).first().click();
  await expect(pagP.getByLabel(`Conteúdo de ${arquivo}`)).toBeVisible();
  await shot(pagP, '5-arquivos-de-retorno');
  const pedroApi = {
    lista: (await apiGet(pagP, `/portal/api/v1/o/${org}/shared-files`)).body.items.length,
    busca_inexistente: (await apiGet(pagP, `/portal/api/v1/o/${org}/shared-files?q=nao-existe-${TAG}`)).body.items.length,
    download: (await apiGet(pagP, `/portal/api/v1/o/${org}/shared-files/${tentativa}/1/content`)).status,
    dashboard: (await apiGet(pagP, `/portal/api/v1/o/${org}/shared-automations/${robo}/summary`)).status,
  };
  expect(pedroApi.lista).toBeGreaterThan(0);
  expect(pedroApi.busca_inexistente).toBe(0);
  expect(pedroApi.download).toBe(200);
  expect(pedroApi.dashboard).toBe(403);
  log('5_arquivos_de_retorno', pedroApi);

  // ------------------------------------------------ 5b. temas na área do cliente: escolha em Segurança da conta, persistência ao recarregar
  const temasCliente: Record<string, string> = {};
  for (const [label, tema] of [
    ['Nekkora Dark', 'dark'],
    ['Sakura Dark', 'sakura-dark'],
    ['Nekkora Light', 'light'],
  ] as const) {
    await go(pagE, '/conta');
    await expect(pagE.getByRole('group', { name: 'Tema' })).toHaveCount(1);
    await pagE.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: new RegExp(`^${label}`) }).check();
    await expect.poll(() => pagE.evaluate(() => document.documentElement.getAttribute('data-nk-theme'))).toBe(tema);
    await go(pagE, `/cliente/o/${org}`);
    await pagE.reload();
    await settle(pagE);
    const aplicado = await pagE.evaluate(() => document.documentElement.getAttribute('data-nk-theme'));
    expect(aplicado, `tema ${tema} mantido depois de recarregar a área do cliente`).toBe(tema);
    await audit(pagE, `area-cliente-cards-${tema}`);
    await shot(pagE, `5b-area-cliente-${tema}`);
    await go(pagE, `/cliente/o/${org}/automacoes/${robo}`);
    await expect(pagE.getByRole('group', { name: 'Indicadores do período' })).toBeVisible();
    await audit(pagE, `area-cliente-dashboard-${tema}`);
    await go(pagP, '/conta');
    await pagP.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: new RegExp(`^${label}`) }).check();
    await go(pagP, `/cliente/o/${org}/arquivos`);
    await pagP.reload();
    await settle(pagP);
    expect(await pagP.evaluate(() => document.documentElement.getAttribute('data-nk-theme'))).toBe(tema);
    await audit(pagP, `area-cliente-arquivos-${tema}`);
    temasCliente[tema] = 'selecionado em Seguranca da conta; mantido apos recarregar; axe sem violacoes (cards, dashboard, arquivos)';
  }
  log('5b_temas_da_area_do_cliente', temasCliente);

  // ------------------------------------------------ 6. revogar com a sessão aberta; histórico preservado
  await go(page, `/o/${org}/administracao/pessoas?aba=compartilhamentos&cliente=${evaClienteId}`);
  await page.getByRole('region', { name: 'Lista de concessões de clientes' }).locator('tbody tr').filter({ hasText: 'Ativa' }).getByRole('button', { name: /^Revogar Robô de notas/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revogar' }).click();
  await expect(page.getByText('Acesso revogado. Os demais acessos da pessoa continuam valendo.')).toBeVisible();
  const revogada = (await apiGet(pagE, `/portal/api/v1/o/${org}/shared-automations/${robo}/summary`)).status;
  expect(revogada).toBe(404);
  const hist = await apiGet(page, `/api/v1/o/${org}/access-history?limit=100`);
  const atos = hist.body.items.map((e: any) => `${e.type}${e.grantException ? '*' : ''}`);
  for (const t of ['COMPARTILHAMENTO_SOLICITADO', 'COMPARTILHAMENTO_APROVADO', 'CONVITE_EMITIDO*', 'CLIENTE_CONCESSAO_APLICADA_NO_ACEITE*', 'CLIENTE_CONCESSAO_REVOGADA'])
    expect(atos, t).toContain(t);
  await go(page, `/o/${org}/administracao/pessoas?aba=historico`);
  await expect(page.getByRole('region', { name: 'Histórico de acessos' })).toContainText('Pedido de compartilhamento aprovado');
  await shot(page, '6-historico');
  log('6_revogacao_e_historico', { revogada_na_proxima_consulta: revogada, atos: atos.slice(0, 15) });

  // ------------------------------------------------ 7. acessibilidade: axe com contraste nos três temas e em 375 px
  for (const [label, tema] of [
    ['Nekkora Dark', 'dark'],
    ['Nekkora Light', 'light'],
    ['Sakura Dark', 'sakura-dark'],
  ] as const) {
    await go(page, `/o/${org}/conta`);
    await page.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: new RegExp(`^${label}`) }).check();
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-nk-theme'))).toBe(tema);
    await go(page, pessoas);
    await page.getByRole('radio', { name: /^Pessoa externa/ }).check();
    await page.getByRole('combobox', { name: /^Ambiente de trabalho/ }).selectOption({ label: 'Fiscal' });
    await page.getByText('Opções adicionais', { exact: true }).click();
    await audit(page, `pessoas-compartilhar-${tema}`);
    await shot(page, `7-pessoas-compartilhar-${tema}`);
    await go(page, `/o/${org}/administracao/pessoas?aba=compartilhamentos`);
    await audit(page, `acessos-${tema}`);
    await go(page, `/o/${org}/administracao/pessoas?aba=historico`);
    await audit(page, `historico-${tema}`);
  }
  await go(page, `/o/${org}/conta`);
  await page.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: /^Nekkora Light/ }).check();
  await go(pagW, `/o/${org}/automacoes/${robo}`);
  await audit(pagW, 'automacao-pedido-de-membro');
  await go(pagP, `/cliente/o/${org}`);
  await audit(pagP, 'area-cliente-cards');
  await go(pagP, `/cliente/o/${org}/arquivos`);
  await audit(pagP, 'area-cliente-arquivos');
  // a cliente com dashboard (antes de revogar já foi conferido; aqui a área vazia de Eva, tema claro)
  await go(pagE, `/cliente/o/${org}`);
  await audit(pagE, 'area-cliente-sem-nada');
  const estreita = await (await browser.newContext({ viewport: { width: 375, height: 800 } })).newPage();
  await signInWithTotp(estreita, pedroP).catch(async () => {
    await estreita.waitForTimeout(31_000);
    await estreita.getByLabel('Código de autenticação').fill(await pedroP.auth.next());
  });
  await go(estreita, `/cliente/o/${org}/arquivos`);
  await audit(estreita, 'area-cliente-arquivos-375');
  await shot(estreita, '7-arquivos-375');
  const adminEstreita = await signedIn(browser, ana, orgName, { width: 375, height: 800 });
  await go(adminEstreita, pessoas);
  await adminEstreita.getByRole('radio', { name: /^Pessoa externa/ }).check();
  await audit(adminEstreita, 'pessoas-compartilhar-375');
  log('7_acessibilidade', { axe_com_contraste: 'formulario, acessos e historico nos tres temas; pedido do membro; area do cliente (cards, arquivos, vazia) no tema claro; 375 px', rolagem_horizontal: 'nenhuma' });
  log('fim', 'roteiro de compartilhamento por pessoa concluido');
});
