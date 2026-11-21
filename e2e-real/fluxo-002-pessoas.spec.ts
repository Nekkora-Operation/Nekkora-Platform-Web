import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { Authenticator } from '../mock/totp';
import { confirmStepUp, LAB, signInWithTotp, signUpAndEnroll, syntheticEmail, waitToken, type Person } from './support/lab';

/**
 * PLATFORM-FLUXO-002 — "PESSOAS E ACESSOS" (membros e convites numa página só) pela Web de produção contra a API real do
 * laboratório descartável, com pessoas sintéticas. Usa a organização e as pessoas do roteiro do acompanhamento
 * (~/.nekkora/front-lab/<lab>/acompanhamento.json): a administradora (Ana), o leitor do ambiente Fiscal (Bruno) e a
 * operadora de outra organização (Nara). Cadastra UMA pessoa nova (a que aceita o convite). Convites de outras pessoas
 * que estejam na organização (por exemplo, o do aceite manual) não são tocados.
 *
 * Validado: enviar, reenviar, revogar, vencer (passagem do tempo declarada, no banco) e aceitar o convite; o aceite sem
 * duplicar a pessoa; a ordem (pendentes primeiro, do mais recente; depois membros); o modal "Gerenciar acessos" (salvar e
 * cancelar); permissões (menu, tela e servidor) e isolamento entre organizações; auditoria; endereços antigos (inclusive o
 * modal de um membro depois de recarregar); teclado; tela estreita; e os três temas (axe com contraste).
 *
 *   FRONT_LAB_ID=frontlab-fluxo002 FRONT_PORTA=5196 npx playwright test -c playwright.real.config.ts fluxo-002-pessoas
 */
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-fluxo-002-pessoas`);
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
      body = text;
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

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('Pessoas e acessos: convites (enviar, reenviar, revogar, vencer, aceitar), ordem, modal de acessos, permissões, links antigos, teclado, tela estreita e temas', async ({ browser }) => {
  test.setTimeout(2_400_000);
  expect(existsSync(ESTADO), 'o roteiro do acompanhamento guardou a organização e as pessoas').toBe(true);
  rmSync(EVID, { recursive: true, force: true });
  const s = JSON.parse(readFileSync(ESTADO, 'utf8')) as { ana: Guardada; bruno: Guardada; nara: Guardada; org: string; orgN: string; orgName: string; fiscal: string; compras: string };
  const { org } = s;
  const ana = reviver(s.ana);
  const orgName = new RegExp(`^Entrar em ${s.orgName}(?![0-9a-z])`);
  log('laboratorio', readFileSync(resolve(`tools/lab/saidas/${LAB}/laboratorio.txt`), 'utf8').replace(/\n/g, ' | '));
  const page = await signedIn(browser, ana, orgName);
  const eventos = () => Number(sql(`SELECT count(*) FROM access_events WHERE organization_id = '${org}'`));
  const eventos0 = eventos();
  const pessoas = `/o/${org}/administracao/pessoas`;

  // ------------------------------------------------ menu e página: Pessoas e acessos no lugar de Membros e Convites
  await go(page, `/o/${org}`);
  const nav = page.getByRole('navigation', { name: 'Navegação principal' });
  await expect(nav.getByRole('link', { name: 'Pessoas e acessos' })).toHaveAttribute('href', pessoas);
  await expect(nav.getByRole('link', { name: 'Membros' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Convites' })).toHaveCount(0);
  await nav.getByRole('link', { name: 'Pessoas e acessos' }).click();
  await page.mouse.move(900, 600); // o menu lateral se recolhe (o cursor sai de cima dele)
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Pessoas e acessos' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Novo convite' })).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);

  // ------------------------------------------------ enviar convites (com a confirmação da hora): a tabela é lida de novo e confirma
  const c1 = syntheticEmail(`pes-c1-${TAG}`);
  const c2 = syntheticEmail(`pes-c2-${TAG}`);
  const c3 = syntheticEmail(`pes-c3-${TAG}`);
  const convidar = async (email: string, role: string, ws?: string) => {
    await page.getByLabel(/^E-mail da pessoa/).fill(email);
    await page.getByLabel(/^Perfil \(opcional\)/).selectOption(role);
    if (ws) await page.getByLabel(/^Ambiente de trabalho do perfil/).selectOption(ws);
    await page.getByRole('button', { name: 'Convidar' }).click();
    await confirmStepUp(page, ana, 'Enviar convite');
    await settle(page);
    await expect(page.getByText('Convite enviado. A pessoa recebe o link por e-mail.')).toBeVisible();
    await expect(rowOf(page, email)).toHaveCount(1);
    await page.waitForTimeout(1_100); // instantes de criação distintos (a ordem é pelo instante)
  };
  await convidar(c1, 'VIEWER', s.fiscal);
  await convidar(c2, 'OPERATOR', s.compras);
  await convidar(c3, '');
  // ordem: pendentes primeiro, do mais recente; depois membros
  const textos = await rows(page).allInnerTexts();
  const idx = (e: string) => textos.findIndex((t) => t.includes(e));
  expect(idx(c3)).toBeLessThan(idx(c2));
  expect(idx(c2)).toBeLessThan(idx(c1));
  const primeiroMembro = textos.findIndex((t) => t.includes('Membro ativo'));
  expect(textos.slice(0, primeiroMembro).every((t) => t.includes('Convite pendente'))).toBe(true);
  expect(textos.slice(primeiroMembro).some((t) => t.includes('Convite pendente'))).toBe(false);
  await shot(page, '1-pendentes-primeiro');
  log('1_convites', { enviados: 3, ordem: 'c3, c2, c1 (do mais recente); pendentes antes dos membros' });

  // ------------------------------------------------ reenviar (o link anterior deixa de valer) e revogar
  const tokenAntigo = await waitToken('ORG_INVITATION', c1);
  await rowOf(page, c1).getByRole('button', { name: `Reenviar convite para ${c1}` }).click();
  await confirmStepUp(page, ana, 'Reenviar');
  await settle(page);
  await expect(page.getByText('Convite reenviado. O link anterior deixou de valer.')).toBeVisible();
  await expect(rowOf(page, c1)).toHaveCount(1); // um pendente só, o novo
  await rowOf(page, c2).getByRole('button', { name: `Revogar convite para ${c2}` }).click();
  await confirmStepUp(page, ana, 'Revogar convite');
  await settle(page);
  await expect(page.getByText('Convite revogado. O link deixou de valer.')).toBeVisible();
  await expect(rowOf(page, c2)).toHaveCount(0); // fora da visualização padrão
  // vencer o c3: passagem do tempo (procedimento declarado, no banco do laboratório)
  sql(`SET session_replication_role = replica; UPDATE identity_invitations SET created_at = now() - interval '8 days', expires_at = now() - interval '1 minute' WHERE organization_id = '${org}' AND email_normalized = '${c3}' AND accepted_at IS NULL AND revoked_at IS NULL`);
  await page.reload();
  await settle(page);
  await expect(rowOf(page, c3)).toHaveCount(0);
  // pelo filtro: revogados (o c2 e o c1 substituído pelo reenvio) e vencidos ficam consultáveis
  await page.getByRole('checkbox', { name: 'Convite revogado' }).check();
  await page.getByRole('checkbox', { name: 'Convite vencido' }).check();
  await settle(page);
  await expect(page).toHaveURL(/estado=invitation_expired/);
  await expect(rowOf(page, c2)).toContainText('Convite revogado');
  await expect(rowOf(page, c3)).toContainText('Convite vencido');
  await expect(rowOf(page, c1)).toContainText('substituído por reenvio');
  await shot(page, '2-historico-pelo-filtro');
  log('2_reenviar_revogar_vencer', { reenvio: 'um pendente so para c1; o anterior: substituido por reenvio', revogado: 'fora do padrao; no filtro', vencido: 'fora do padrao; no filtro (passagem do tempo declarada)' });

  // ------------------------------------------------ aceite: a pessoa entra como membro, sem duplicar; o histórico fica no filtro
  const pagC1 = await (await browser.newContext()).newPage();
  const pessoa1 = await signUpAndEnroll(pagC1, `pes-c1-${TAG}`, c1);
  const token = await waitToken('ORG_INVITATION', c1);
  expect(token, 'o reenvio trocou o link').not.toBe(tokenAntigo);
  await go(pagC1, `/o/${org}/convite#token=${token}`);
  await pagC1.getByRole('button', { name: 'Aceitar convite' }).click();
  await confirmStepUp(pagC1, pessoa1, 'Aceitar');
  await settle(pagC1);
  const c1User = sql(`SELECT user_id FROM users WHERE organization_id = '${org}' AND email_normalized = '${c1}'`);
  expect(c1User).toMatch(/^[0-9a-f-]{36}$/);
  await go(page, pessoas);
  await expect(rowOf(page, c1)).toHaveCount(1);
  await expect(rowOf(page, c1)).toContainText('Membro ativo');
  await expect(rowOf(page, c1)).toContainText('Leitura · Fiscal');
  const padrao = await apiGet(page, `/api/v1/o/${org}/people?limit=100`);
  const comC1 = padrao.body.items.filter((i: any) => (i.member?.email ?? i.invitation?.email ?? '').toLowerCase() === c1);
  expect(comC1.map((i: any) => i.kind), 'o mesmo ingresso uma vez só').toEqual(['member']);
  const aceitos = await apiGet(page, `/api/v1/o/${org}/people?situation=invitation_accepted&limit=100`);
  const hist = aceitos.body.items.find((i: any) => i.invitation.email === c1);
  expect(hist.invitation.acceptedUserId).toBe(c1User);
  log('3_aceite', { na_lista: 'membro ativo, uma linha', historico: 'convite aceito no filtro, com a conta criada', papel: 'Leitura · Fiscal (do convite)' });

  // ------------------------------------------------ modal "Gerenciar acessos": cancelar não muda; salvar aplica e atualiza a linha
  await page.getByLabel('Buscar por nome ou e-mail').fill(c1);
  await settle(page);
  await expect(page).toHaveURL(/q=/);
  const papeis = () => sql(`SELECT string_agg(r.code || ':' || coalesce(w.name, '-'), ',' ORDER BY r.code) FROM workspace_role_assignments a JOIN roles r ON r.role_id = a.role_id JOIN workspaces w ON w.workspace_id = a.workspace_id JOIN organization_memberships m ON m.membership_id = a.membership_id WHERE m.user_id = '${c1User}' AND a.status = 1`);
  expect(papeis()).toBe('VIEWER:Fiscal');
  const leiturasAntes = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.name.includes('/people?')).length);
  await rowOf(page, c1).getByRole('button', { name: /^Gerenciar acessos de / }).click();
  let d = page.getByRole('alertdialog', { name: /^Gerenciar acessos de / });
  await expect(d.getByRole('list', { name: 'Acessos atuais' })).toContainText('Fiscal');
  await d.getByLabel('Perfil em Fiscal').selectOption('OPERATOR');
  await d.getByRole('button', { name: 'Cancelar' }).click();
  await expect(d).toHaveCount(0);
  expect(papeis(), 'cancelar não altera os acessos').toBe('VIEWER:Fiscal');
  await rowOf(page, c1).getByRole('button', { name: /^Gerenciar acessos de / }).click();
  d = page.getByRole('alertdialog', { name: /^Gerenciar acessos de / });
  await expect(d.getByRole('list', { name: 'Acessos atuais' })).toContainText('Fiscal');
  await d.getByLabel('Perfil em Fiscal').selectOption('OPERATOR');
  await d.getByLabel('Perfil', { exact: true }).selectOption('VIEWER');
  await d.getByLabel('Ambiente de trabalho', { exact: true }).selectOption(s.compras);
  await d.getByRole('button', { name: 'Acrescentar' }).click();
  await expect(d.getByRole('list', { name: 'Mudanças a salvar' })).toContainText('Atribuir Leitura · Compras');
  await shot(page, '4-modal-rascunho');
  await confirmStepUp(page, ana, 'Salvar acessos');
  await settle(page);
  await expect(page.getByText(/^Acessos de .* salvos\.$/)).toBeVisible();
  expect(papeis()).toBe('OPERATOR:Fiscal,VIEWER:Compras');
  await expect(rowOf(page, c1)).toContainText('Operação · Fiscal');
  await expect(rowOf(page, c1)).toContainText('Leitura · Compras');
  await expect(page).toHaveURL(/q=/); // a busca continua
  const leiturasDepois = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.name.includes('/people?')).length);
  expect(leiturasDepois, 'salvar não relê a lista (posição preservada)').toBe(leiturasAntes);
  await shot(page, '4-linha-atualizada');
  log('4_modal', { cancelar: 'nada alterado (banco)', salvar: 'OPERATOR:Fiscal, VIEWER:Compras (banco e linha)', lista: 'sem releitura; busca no endereco' });

  // ------------------------------------------------ endereços antigos e o modal pelo endereço, depois de recarregar
  await go(page, `/o/${org}/administracao/convites`);
  await expect(page).toHaveURL(new RegExp(`${pessoas}$`));
  await go(page, `/o/${org}/administracao/membros`);
  await expect(page).toHaveURL(new RegExp(`${pessoas}$`));
  await go(page, `/o/${org}/administracao/membros/${c1User}`);
  await expect(page).toHaveURL(new RegExp(`${pessoas}\\?acessos=${c1User}$`));
  await expect(page.getByRole('alertdialog', { name: /^Gerenciar acessos de / })).toBeVisible();
  await page.reload();
  await settle(page);
  await expect(page.getByRole('alertdialog', { name: /^Gerenciar acessos de / })).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
  await expect(page).toHaveURL(new RegExp(`${pessoas}$`));
  log('5_links_antigos', { convites: '-> pessoas', membros: '-> pessoas', acessos_do_membro: '-> pessoas?acessos=<conta> (modal), tambem depois de recarregar' });

  // ------------------------------------------------ teclado: abrir o modal pelo botão, Esc fecha, o foco volta ao botão
  await page.getByLabel('Buscar por nome ou e-mail').fill(c1);
  await settle(page);
  const botao = rowOf(page, c1).getByRole('button', { name: /^Gerenciar acessos de / });
  await botao.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog', { name: /^Gerenciar acessos de / })).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]')), 'o foco fica dentro do modal').toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(botao).toBeFocused();
  log('6_teclado', 'Enter abre, Tab fica no modal, Esc fecha e o foco volta ao botao');

  // ------------------------------------------------ temas (axe com contraste) e tela estreita
  for (const [label, id] of [
    ['Nekkora Dark', 'dark'],
    ['Nekkora Light', 'light'],
    ['Sakura Dark', 'sakura-dark'],
  ] as const) {
    await go(page, `/o/${org}/conta`);
    await page.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: new RegExp(`^${label}`) }).check();
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-nk-theme'))).toBe(id);
    await go(page, pessoas);
    await expect(page.getByRole('heading', { level: 1, name: 'Pessoas e acessos' })).toBeVisible();
    await audit(page, `pessoas-${id}`);
    await shot(page, `7-pessoas-${id}`);
    await go(page, `${pessoas}?acessos=${c1User}`);
    await expect(page.getByRole('alertdialog', { name: /^Gerenciar acessos de / }).getByRole('list', { name: 'Acessos atuais' })).toBeVisible();
    await audit(page, `pessoas-modal-${id}`);
    await shot(page, `7-modal-${id}`);
  }
  await go(page, `/o/${org}/conta`);
  await page.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: /^Nekkora Light/ }).check();
  const estreita = await signedIn(browser, ana, orgName, { width: 375, height: 800 });
  await go(estreita, pessoas);
  await expect(estreita.getByRole('heading', { level: 1, name: 'Pessoas e acessos' })).toBeVisible();
  await audit(estreita, 'pessoas-375');
  await shot(estreita, '8-pessoas-375');
  await go(estreita, `${pessoas}?acessos=${c1User}`);
  await expect(estreita.getByRole('alertdialog', { name: /^Gerenciar acessos de / }).getByRole('list', { name: 'Acessos atuais' })).toBeVisible();
  await audit(estreita, 'pessoas-modal-375');
  await shot(estreita, '8-modal-375');
  log('7_temas_e_tela_estreita', { axe_com_contraste: 'pagina e modal nos tres temas e em 375 px, sem violacoes', rolagem_horizontal: 'nenhuma na pagina' });

  // ------------------------------------------------ permissões, isolamento e auditoria
  const bruno = await signedIn(browser, reviver(s.bruno), orgName);
  await expect(bruno.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Pessoas e acessos' })).toHaveCount(0);
  await go(bruno, pessoas);
  await expect(bruno.getByText('Você não tem permissão para ver as pessoas e os convites desta organização.')).toBeVisible();
  await expect(bruno.getByRole('form', { name: 'Novo convite' })).toHaveCount(0);
  expect((await apiGet(bruno, `/api/v1/o/${org}/people`)).status).toBe(403);
  const nara = await signedIn(browser, reviver(s.nara), /^Entrar em Nekkora Suporte/);
  expect([401, 403, 404]).toContain((await apiGet(nara, `/api/v1/o/${org}/people`)).status);
  const novos = eventos() - eventos0;
  expect(novos, 'convites, reenvio, revogação, aceite e papéis auditados').toBeGreaterThanOrEqual(6);
  log('8_permissoes_isolamento_auditoria', { bruno: 'sem menu; tela 403; servidor 403', outra_organizacao: 'recusado', eventos_de_auditoria_novos: novos });
  log('fim', 'roteiro de Pessoas e acessos concluido');
});
