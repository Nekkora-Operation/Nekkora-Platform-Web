import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { devices, expect, test, type Page } from '@playwright/test';
import { DEV_ORG, OTHER_ORG } from '../mock/contract';
import { Authenticator } from '../mock/totp';
import { path, signIn, SESSION_EXPIRED } from './support/app';

/**
 * F4 no navegador, contra a API SIMULADA (mock/): área interna, navegação e lista de execuções. Cada teste cria a
 * própria conta com papéis e MFA pelo controle do mock (/__mock/accounts). A API real continua pendente (F1.5/F8).
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

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

/** Registra as requisições de leitura da API para conferir o que foi (ou não) chamado. */
function recordRequests(page: Page) {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/')) urls.push(new URL(r.url()).pathname + new URL(r.url()).search);
  });
  return urls;
}

const rows = (page: Page) => page.getByRole('table').locator('tbody tr');
const executionsRequests = (urls: string[]) => urls.filter((u) => u.includes('/executions'));

async function openExecutions(page: Page) {
  await page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Execuções' }).click();
  await expect(page).toHaveURL(/\/execucoes(\?.*)?$/);
  await expect(rows(page).first()).toBeVisible();
}

async function periodAll(page: Page) {
  await page.getByLabel('Período').selectOption('all');
  await expect(page.getByText(/Período: Todo o histórico visível\./)).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
}

async function audit(page: Page, name: string) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe injetado acima
    const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return r.violations.map(
      (v: { id: string; nodes: { target: string[]; any: { data?: { fgColor?: string; bgColor?: string; contrastRatio?: number } }[] }[] }) =>
        `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')}${n.any[0]?.data?.contrastRatio ? ` (${n.any[0].data.fgColor} sobre ${n.any[0].data.bgColor}, ${n.any[0].data.contrastRatio})` : ''}`).join(', ')}`,
    );
  });
  expect(violations, `axe em ${name}`).toEqual([]);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

test('ORG_ADMIN: acesso global, P02 nunca chamada, período padrão indicado; axe na lista', async ({ page }) => {
  const urls = recordRequests(page);
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);
  await expect(page.getByText('Administração da organização (todos os workspaces)')).toBeVisible();
  await openExecutions(page);
  await expect(page.getByLabel('Workspace').locator('option')).toHaveCount(10);
  await expect(page.getByText(/Período: Últimos 30 dias \(padrão\)\./)).toBeVisible();
  await expect(rows(page)).toHaveCount(25);
  expect(urls.some((u) => u.includes('/me/permissions/workspaces'))).toBe(false);
  expect(urls.filter((u) => /\/me\/permissions$/.test(u))).toHaveLength(1);
  const from = new URL(executionsRequests(urls)[0], BASE).searchParams.get('from');
  expect(from).toMatch(/Z$/);
  await audit(page, 'execucoes-desktop');
});

test('acesso limitado (VIEWER em Atendimento) e conta sem workspaces', async ({ page }) => {
  const viewer = await account({ workspaceRoles: [['atendimento', ['VIEWER']]], displayName: 'Leitor E2E' });
  await enter(page, viewer, 'Leitor E2E');
  await openExecutions(page);
  await expect(page.getByLabel('Workspace').locator('option')).toHaveText(['Todos os workspaces visíveis', 'Atendimento']);
  for (const text of await rows(page).allInnerTexts()) expect(text).toContain('Atendimento');
  await page.getByRole('button', { name: 'Sair' }).first().click();

  const none = await account({ displayName: 'Sem Acesso E2E' });
  await enter(page, none, 'Sem Acesso E2E');
  await expect(page.getByText('Nenhum workspace visível para você.')).toBeVisible();
  await page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Execuções' }).click();
  await expect(page.getByText('Você ainda não tem acesso a nenhum workspace.')).toBeVisible();
});

test('conta externa: início próprio, rota interna volta a ele, sem P01/P02/leituras internas', async ({ page }) => {
  const urls = recordRequests(page);
  const ext = await account({ accountType: 'external', displayName: 'Externa E2E' });
  await enter(page, ext, 'Externa E2E');
  await page.goto(`/o/${DEV_ORG}/execucoes`);
  await expect(page).toHaveURL(path.home(DEV_ORG));
  await expect(page.getByRole('heading', { name: 'Olá, Externa E2E' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toHaveCount(0);
  expect(urls.filter((u) => /\/me\/permissions|\/workspaces|\/executions/.test(u))).toEqual([]);
});

test('isolamento entre organizações', async ({ page }) => {
  const vizinha = await account({ org: OTHER_ORG, orgRoles: ['ORG_ADMIN'], displayName: 'Vizinha E2E' });
  await enter(page, vizinha, 'Vizinha E2E');
  await openExecutions(page);
  await expect(page.getByLabel('Workspace').locator('option')).toHaveText(['Todos os workspaces visíveis', 'Workspace da organização vizinha']);
  await page.goto(`/o/${DEV_ORG}/execucoes`);
  await expect(page).toHaveURL(path.login(DEV_ORG));
});

test('filtros, carregar mais, revogação entre páginas e cursor recusado', async ({ page }) => {
  const urls = recordRequests(page);
  const op = await account({ workspaceRoles: [['operacoes', ['OPERATOR']], ['logistica', ['OPERATOR']]], displayName: 'Operador E2E' });
  await enter(page, op, 'Operador E2E');
  await openExecutions(page);
  await periodAll(page);

  await test.step('estado vira parâmetro e filtra as linhas', async () => {
    await page.getByLabel('Concluída').check();
    await expect.poll(() => new URL(executionsRequests(urls).at(-1)!, BASE).searchParams.getAll('status')).toEqual(['succeeded']);
    await expect(rows(page).first()).toBeVisible();
    for (const t of await rows(page).allInnerTexts()) expect(t).toContain('Concluída');
    await page.getByLabel('Concluída').uncheck();
    await expect(rows(page)).toHaveCount(25);
  });

  await test.step('revogação de Logística antes da página seguinte', async () => {
    await control('product/revoke-workspace-role', { userId: op.userId, workspace: 'logistica' });
    await page.getByRole('button', { name: 'Carregar mais' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Exibindo' })).not.toHaveText(/Exibindo 25 /);
    const added = (await rows(page).allInnerTexts()).slice(25);
    expect(added.length).toBeGreaterThan(0);
    for (const t of added) expect(t).not.toContain('Logística');
  });

  await test.step('chave do cursor rotacionada: itens mantidos e recomeço oferecido, sem repetir sozinho', async () => {
    const shown = await rows(page).count();
    await control('cursor-key/rotate', {});
    const before = executionsRequests(urls).length;
    await page.getByRole('button', { name: 'Carregar mais' }).click();
    await expect(page.getByText('A lista mudou desde a última página (ou a continuação expirou).')).toBeVisible();
    await expect(rows(page)).toHaveCount(shown);
    await page.waitForTimeout(300);
    expect(executionsRequests(urls)).toHaveLength(before + 1);
    await page.getByRole('button', { name: 'Recomeçar a lista' }).click();
    await expect(page.getByText(/A lista mudou/)).toHaveCount(0);
    await expect(rows(page).first()).toBeVisible();
  });
});

test('resposta fora do contrato e falha de rede ao carregar mais: nada acrescentado, sem repetição automática', async ({ page }) => {
  const urls = recordRequests(page);
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);
  await openExecutions(page);

  await page.route('**/api/v1/o/*/executions?*cursor=*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.items[0].status = 'finished'; // fora do enum do contrato
    await route.fulfill({ response: res, json: body });
  });
  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect(page.getByText(/A resposta do servidor veio fora do formato esperado\. A lista exibida continua válida\./)).toBeVisible();
  await expect(rows(page)).toHaveCount(25);
  const afterInvalid = executionsRequests(urls).length;
  await page.waitForTimeout(400);
  expect(executionsRequests(urls)).toHaveLength(afterInvalid);
  await page.unroute('**/api/v1/o/*/executions?*cursor=*');

  await page.route('**/api/v1/o/*/executions?*cursor=*', (route) => route.abort('internetdisconnected'));
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByText(/Não foi possível conectar\. A lista exibida continua válida\./)).toBeVisible();
  await expect(rows(page)).toHaveCount(25);
  await page.unroute('**/api/v1/o/*/executions?*cursor=*');
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(rows(page)).toHaveCount(50);
});

test('sessão expirada durante a lista: volta ao login com o aviso', async ({ page }) => {
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);
  await openExecutions(page);
  await control('revoke-sessions', { userId: acc.userId });
  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect(page).toHaveURL(path.login(DEV_ORG));
  await expect(page.getByText(SESSION_EXPIRED)).toBeVisible();
});

test('teclado no desktop: pular para o conteúdo e filtros alcançáveis', async ({ page }) => {
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);
  await openExecutions(page);
  await page.reload(); // começa a navegação por teclado do topo do documento
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Workspace')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Período')).toBeFocused();
});

// perfil do Pixel 7 sem `defaultBrowserType` (o navegador continua o Chromium do projeto)
const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7'];

test.describe('celular', () => {
  test.use(pixel7);

  test('menu móvel integrado: abre, Tab circula, escolher Execuções leva ao conteúdo; axe e captura', async ({ page }) => {
    const acc = await account({ orgRoles: ['ORG_ADMIN'] });
    await enter(page, acc);
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    const dialog = page.getByRole('dialog', { name: 'Menu' });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath('menu-movel-aberto.png') });
    const execLink = dialog.getByRole('link', { name: 'Execuções' });
    await execLink.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/execucoes(\?.*)?$/);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('main')).toBeFocused();
    await expect(rows(page).first()).toBeVisible();
    await audit(page, 'execucoes-celular');
  });
});
