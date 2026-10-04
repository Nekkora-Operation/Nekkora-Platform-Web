import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { devices, expect, test, type Page } from '@playwright/test';
import { DEV_ORG, OTHER_ORG } from '../mock/contract';
import { stableUuid } from '../mock/product';
import { Authenticator } from '../mock/totp';
import { path, signIn, SESSION_EXPIRED } from './support/app';

/**
 * F5 no navegador, contra a API SIMULADA (mock/): detalhe e eventos da execução, workspaces, automações e versões. Cada
 * teste cria a própria conta pelo controle do mock (/__mock/accounts). A API real continua pendente.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const SCHEDULED = stableUuid('dev:exec:empate:0');
const ws = (k: string) => stableUuid(`dev:ws:${k}`);
const auto = (k: string) => stableUuid(`dev:auto:${k}`);
const org = (p = '') => `/o/${DEV_ORG}${p}`;

interface RoleAccount {
  org: string;
  userId: string;
  email: string;
  totpSecret: string;
}

async function control<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/__mock/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`controle do mock falhou: ${route} (${res.status})`);
  return (await res.json()) as T;
}

const account = (body: Record<string, unknown>) => control<RoleAccount>('accounts', { org: DEV_ORG, mfa: true, ...body });

async function enter(page: Page, acc: RoleAccount, name = 'Pessoa E2E') {
  await signIn(page, { org: acc.org, userId: acc.userId, email: acc.email });
  await expect(page).toHaveURL(`/o/${acc.org}/mfa`);
  await page.getByLabel(/Código de autenticação/).fill(await new Authenticator(acc.totpSecret).next());
  await expect(page.getByRole('heading', { name: `Olá, ${name}` })).toBeVisible();
}

function recordRequests(page: Page) {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/')) urls.push(new URL(r.url()).pathname + new URL(r.url()).search);
  });
  return urls;
}

async function audit(page: Page, name: string) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe injetado acima
    const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return r.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
  expect(violations, `axe em ${name}`).toEqual([]);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

/** Navegação dentro do app (sem recarregar): o BrowserRouter escuta o popstate. */
async function goInApp(page: Page, to: string) {
  await page.evaluate((url) => {
    history.pushState({}, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }, to);
}

const region = (page: Page, name: string) => page.getByRole('region', { name });
const regionRows = (page: Page, name: string) => region(page, name).locator('tbody tr');
const notFound = (page: Page, title: string) => page.getByRole('heading', { level: 1, name: title });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Navegação principal' });

test('lista → detalhe pelo teclado → eventos → voltar com os filtros; recarga mantém o período; nova aba; axe', async ({ page, context }) => {
  const urls = recordRequests(page);
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);
  await nav(page).getByRole('link', { name: 'Execuções' }).click();
  await expect(page.getByRole('table').locator('tbody tr').first()).toBeVisible();
  await page.getByLabel('Período').selectOption('7d');
  await page.getByLabel('Concluída').check();
  await expect(page).toHaveURL(/estado=succeeded/);
  await expect(page).toHaveURL(/periodo=7d&desde=/);
  const listUrl = page.url();
  const from = () => new URL(urls.filter((u) => u.includes('/executions?')).at(-1)!, BASE).searchParams.get('from');
  await expect(page.getByRole('table').locator('tbody tr').first()).toBeVisible();
  const from1 = from();

  await test.step('recarga: mesmo endereço, mesmos limites do período', async () => {
    await page.reload();
    await expect(page.getByRole('table').locator('tbody tr').first()).toBeVisible();
    expect(page.url()).toBe(listUrl);
    expect(from()).toBe(from1);
    await expect(page.getByLabel('Concluída')).toBeChecked();
  });

  const link = page.getByRole('link', { name: /^Execução de .*, criada em / }).first();
  const href = (await link.getAttribute('href'))!;
  expect(href).toMatch(new RegExp(`^${org('/execucoes/')}[0-9a-f-]{36}$`));

  await test.step('nova aba: o mesmo endereço abre o detalhe direto', async () => {
    const tab = await context.newPage();
    await tab.goto(href);
    await expect(tab.getByRole('heading', { level: 1, name: /^Execução de / })).toBeVisible();
    await tab.close();
  });

  await test.step('teclado: Enter no link abre o detalhe e o foco vai ao conteúdo', async () => {
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(href);
    await expect(page.getByRole('heading', { level: 1, name: /^Execução de / })).toBeVisible();
    await expect(page.getByRole('main')).toBeFocused();
    await expect(regionRows(page, 'Eventos da execução').first()).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Execuções' })).toHaveAttribute('aria-current', 'page');
    await audit(page, 'execucao-detalhe');
  });

  await test.step('voltar: a lista reabre com os mesmos filtros e limites', async () => {
    await page.getByRole('link', { name: 'Voltar para execuções' }).click();
    await expect(page.getByRole('table').locator('tbody tr').first()).toBeVisible();
    expect(page.url()).toBe(listUrl);
    expect(from()).toBe(from1);
    await expect(page.getByLabel('Concluída')).toBeChecked();
  });
});

test('workspace → automações → automação → versões → execuções da automação; axe nas telas', async ({ page }) => {
  const urls = recordRequests(page);
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);
  await nav(page).getByRole('link', { name: 'Workspaces' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Workspaces' })).toBeVisible();
  await expect(regionRows(page, 'Lista de workspaces')).toHaveCount(9);
  await expect(page.getByRole('main')).toBeFocused();
  await audit(page, 'workspaces');

  await page.getByRole('link', { name: 'Operações' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Operações' })).toBeVisible();
  await expect(regionRows(page, 'Automações do workspace')).toHaveCount(3);
  await audit(page, 'workspace-detalhe');

  await page.getByRole('link', { name: 'Backup dos arquivos de operação' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Backup dos arquivos de operação' })).toBeVisible();
  await expect(regionRows(page, 'Versões da automação')).toHaveCount(3);
  await expect(regionRows(page, 'Versões da automação').first()).toContainText('versão 3');
  await expect(nav(page).getByRole('link', { name: 'Workspaces' })).toHaveAttribute('aria-current', 'page');
  await audit(page, 'automacao-detalhe');

  await page.getByRole('link', { name: 'Ver execuções desta automação' }).click();
  await expect(page.getByText('Somente a automação Backup dos arquivos de operação.')).toBeVisible();
  await expect.poll(() => urls.some((u) => u.includes('/executions?') && u.includes(`automationId=${auto('backup')}`))).toBe(true);
  await expect(page.getByRole('table').locator('tbody tr').first()).toBeVisible();
  for (const t of await page.getByRole('table').locator('tbody tr').allInnerTexts()) expect(t).toContain('Backup dos arquivos de operação');

  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Backup dos arquivos de operação' })).toBeVisible();
  await page.getByRole('link', { name: 'Voltar para Operações' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Operações' })).toBeVisible();
});

test('acesso direto: inexistente, de outra organização, malformado e sem acesso dão o mesmo não encontrado', async ({ page }) => {
  const op = await account({ workspaceRoles: [['operacoes', ['OPERATOR']]], displayName: 'Operador E2E' });
  await enter(page, op, 'Operador E2E');
  const vizinha = stableUuid('vizinha:exec:vizinha:0');
  for (const id of [stableUuid('nao-existe'), vizinha, 'nao-e-um-uuid']) {
    await page.goto(org(`/execucoes/${id}`));
    await expect(notFound(page, 'Execução não encontrada.')).toBeVisible();
  }
  await page.goto(org(`/workspaces/${ws('financeiro')}`));
  await expect(notFound(page, 'Workspace não encontrado.')).toBeVisible();
  await expect(page.getByText('Financeiro — Conciliação')).toHaveCount(0);
  await page.goto(org(`/automacoes/${auto('conciliacao')}`));
  await expect(notFound(page, 'Automação não encontrada.')).toBeVisible();
  await audit(page, 'nao-encontrado');
  await page.goto(org(`/execucoes/${SCHEDULED}`));
  await expect(page.getByRole('heading', { level: 1, name: 'Execução de Backup dos arquivos de operação' })).toBeVisible();
  await expect(page.getByText('Nenhum (execução agendada)')).toBeVisible();
});

test('conta externa: nenhuma tela de leitura monta e nenhuma leitura interna é feita', async ({ page }) => {
  const urls = recordRequests(page);
  const acc = await account({ accountType: 'external', displayName: 'Portal E2E' });
  await enter(page, acc, 'Portal E2E');
  for (const p of [`/execucoes/${SCHEDULED}`, '/workspaces', `/workspaces/${ws('operacoes')}`, `/automacoes/${auto('backup')}`]) {
    await page.goto(org(p));
    await expect(page).toHaveURL(path.home(DEV_ORG));
    await expect(page.getByRole('heading', { name: 'Olá, Portal E2E' })).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
  }
  await page.waitForTimeout(300);
  expect(urls.filter((u) => /\/me\/permissions|\/workspaces|\/executions|\/automations/.test(u))).toEqual([]);
});

test('revogação + Atualizar: não encontrado sem os dados anteriores; sessão expirada volta ao login', async ({ page }) => {
  const acc = await account({ workspaceRoles: [['financeiro', ['WORKSPACE_ADMIN']], ['operacoes', ['VIEWER']]], displayName: 'Gestora E2E' });
  await enter(page, acc, 'Gestora E2E');
  await page.goto(org(`/workspaces/${ws('financeiro')}`));
  await expect(page.getByRole('heading', { level: 1, name: 'Financeiro — Conciliação' })).toBeVisible();
  await control('product/revoke-workspace-role', { userId: acc.userId, workspace: 'financeiro' });
  await page.getByRole('button', { name: 'Atualizar' }).click();
  await expect(notFound(page, 'Workspace não encontrado.')).toBeVisible();
  await expect(page.getByText(/Conciliação bancária/)).toHaveCount(0);

  await page.goto(org(`/execucoes/${SCHEDULED}`));
  await expect(page.getByRole('heading', { level: 1, name: 'Execução de Backup dos arquivos de operação' })).toBeVisible();
  await control('revoke-sessions', { userId: acc.userId });
  await page.getByRole('button', { name: 'Atualizar' }).click();
  await expect(page).toHaveURL(path.login(DEV_ORG));
  await expect(page.getByText(SESSION_EXPIRED)).toBeVisible();
});

test('troca rápida com respostas fora de ordem: só a execução atual aparece', async ({ page }) => {
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);
  const slow = stableUuid('dev:exec:empate:1');
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await page.route(`**/api/v1/o/*/executions/${slow}`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.automation.name = 'RESPOSTA ATRASADA';
    await hold;
    await route.fulfill({ response: res, json: body });
  });
  await goInApp(page, org(`/execucoes/${slow}`));
  await expect(page.getByText('Carregando execução…')).toBeVisible();
  await goInApp(page, org(`/execucoes/${SCHEDULED}`));
  await expect(page.getByRole('heading', { level: 1, name: 'Execução de Backup dos arquivos de operação' })).toBeVisible();
  release();
  await page.waitForTimeout(400);
  await expect(page.getByText('RESPOSTA ATRASADA')).toHaveCount(0);
  await expect(page).toHaveURL(org(`/execucoes/${SCHEDULED}`));
});

test('eventos: falha de rede só repete por ação; resposta fora do contrato não é exibida', async ({ page }) => {
  const urls = recordRequests(page);
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);
  await page.route('**/api/v1/o/*/executions/*/events*', (route) => route.abort('internetdisconnected'));
  await goInApp(page, org(`/execucoes/${SCHEDULED}`));
  await expect(page.getByRole('heading', { level: 1, name: 'Execução de Backup dos arquivos de operação' })).toBeVisible();
  await expect(page.getByText('Não foi possível conectar.')).toBeVisible();
  const n = urls.filter((u) => u.includes('/events')).length;
  await page.waitForTimeout(400);
  expect(urls.filter((u) => u.includes('/events'))).toHaveLength(n);
  await page.unroute('**/api/v1/o/*/executions/*/events*');
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(regionRows(page, 'Eventos da execução')).toHaveCount(2);

  await page.route(`**/api/v1/o/*/executions/${SCHEDULED}`, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), origin: 'webhook' } });
  });
  await page.getByRole('button', { name: 'Atualizar' }).click();
  await expect(page.getByText('A resposta do servidor veio fora do formato esperado.')).toBeVisible();
  await expect(page.getByText(/Backup dos arquivos de operação/)).toHaveCount(0);
});

test('isolamento: sessão da outra organização não abre o detalhe da organização de desenvolvimento', async ({ page }) => {
  const acc = await account({ org: OTHER_ORG, orgRoles: ['ORG_ADMIN'], displayName: 'Vizinha E2E' });
  await enter(page, acc, 'Vizinha E2E');
  await page.goto(org(`/execucoes/${SCHEDULED}`));
  await expect(page).toHaveURL(path.login(DEV_ORG));
  await expect(page.getByText(/Backup dos arquivos de operação/)).toHaveCount(0);
});

const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7'];

test.describe('celular', () => {
  test.use(pixel7);

  test('menu → Workspaces → automação e detalhe da execução: foco no conteúdo, sem rolagem horizontal; axe e capturas', async ({ page }) => {
    const acc = await account({ orgRoles: ['ORG_ADMIN'] });
    await enter(page, acc);
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    const dialog = page.getByRole('dialog', { name: 'Menu' });
    await dialog.getByRole('link', { name: 'Workspaces' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Workspaces' })).toBeVisible();
    await expect(page.getByRole('main')).toBeFocused();
    const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noHorizontalScroll()).toBe(true);
    await audit(page, 'workspaces-celular');

    await page.goto(org(`/automacoes/${auto('rastreio')}`));
    await expect(page.getByRole('heading', { level: 1, name: 'Atualização de rastreio de entregas' })).toBeVisible();
    await expect(regionRows(page, 'Versões da automação').first()).toBeVisible();
    expect(await noHorizontalScroll()).toBe(true);
    await audit(page, 'automacao-celular');

    await page.goto(org(`/execucoes/${SCHEDULED}`));
    await expect(regionRows(page, 'Eventos da execução').first()).toBeVisible();
    expect(await noHorizontalScroll()).toBe(true);
    await audit(page, 'execucao-celular');
  });
});

test('F5-R1: 404 na consulta subordinada derruba a página inteira; detalhe 500 + lista 401 vai ao login uma vez', async ({ page }) => {
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);

  await test.step('eventos respondem 404 depois do detalhe exibido: não encontrada, sem os dados', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    await page.route('**/api/v1/o/*/executions/*/events*', async (route) => {
      await hold;
      await route.fulfill({ status: 404, json: { error: 'not_found' } });
    });
    await goInApp(page, org(`/execucoes/${SCHEDULED}`));
    await expect(page.getByRole('heading', { level: 1, name: 'Execução de Backup dos arquivos de operação' })).toBeVisible();
    release();
    await expect(notFound(page, 'Execução não encontrada.')).toBeVisible();
    await expect(page.getByText(/Backup dos arquivos de operação|continua válida/)).toHaveCount(0);
    await page.unroute('**/api/v1/o/*/executions/*/events*');
  });

  await test.step('detalhe 500 primeiro, versões 401 depois: sessão expirada tratada uma única vez', async () => {
    const logins: string[] = [];
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame() && f.url().endsWith('/login')) logins.push(f.url());
    });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    await page.route(`**/api/v1/o/*/automations/${auto('backup')}`, (route) => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
    await page.route(`**/api/v1/o/*/automations/${auto('backup')}/versions*`, async (route) => {
      await hold;
      await route.fulfill({ status: 401, json: { error: 'unauthenticated' } });
    });
    await goInApp(page, org(`/automacoes/${auto('backup')}`));
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible(); // o 500 do detalhe já está na tela
    release();
    await expect(page).toHaveURL(path.login(DEV_ORG));
    await expect(page.getByText(SESSION_EXPIRED)).toBeVisible();
    await page.waitForTimeout(300);
    expect(logins).toHaveLength(1);
  });
});
