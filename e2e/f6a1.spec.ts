import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { DEV_ORG } from '../mock/contract';
import { stableUuid } from '../mock/product';
import { Authenticator } from '../mock/totp';
import { signIn, SESSION_EXPIRED } from './support/app';

/**
 * F6a-1 no navegador, contra a API SIMULADA (mock/): Membros, Clientes e Concessões, só leitura. Cada teste cria a
 * própria conta pelo controle do mock (/__mock/accounts). A API real fica para a validação posterior.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
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

async function enter(page: Page, acc: RoleAccount, heading = 'Olá, Pessoa E2E') {
  await signIn(page, { org: acc.org, userId: acc.userId, email: acc.email });
  await expect(page).toHaveURL(`/o/${acc.org}/mfa`);
  await page.getByLabel(/Código de autenticação/).fill(await new Authenticator(acc.totpSecret).next());
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

function recordRequests(page: Page) {
  const urls: { url: string; status?: number }[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/v1/')) urls.push({ url: new URL(r.url()).pathname + new URL(r.url()).search, status: r.status() });
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

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navegação principal' });
const rows = (page: Page, name: string) => page.getByRole('region', { name }).locator('tbody tr');
const adminCalls = (urls: { url: string; status?: number }[]) => urls.filter((u) => /\/(members|clients|client-grants)(\?|$)/.test(u.url));

test('ORG_ADMIN: menu Administração → Membros (paginação e filtro na URL, recarga mantém) → Clientes → Concessões do cliente; axe', async ({ page }) => {
  const urls = recordRequests(page);
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);

  await nav(page).getByRole('link', { name: 'Membros' }).click();
  await expect(page).toHaveURL(org('/administracao/membros'));
  await expect(page.getByRole('heading', { level: 1, name: 'Membros' })).toBeVisible();
  await expect(rows(page, 'Lista de membros')).toHaveCount(25);
  await audit(page, 'f6a1-membros');
  // outros testes da mesma execução também criam contas nesta organização: carrega até o fim, página por página
  for (let i = 0; i < 20 && (await page.getByRole('button', { name: 'Carregar mais' }).count()) > 0; i++) {
    const before = await rows(page, 'Lista de membros').count();
    await page.getByRole('button', { name: 'Carregar mais' }).click();
    await expect.poll(() => rows(page, 'Lista de membros').count()).toBeGreaterThan(before);
  }
  await expect(page.getByText('Fim da lista')).toBeVisible();
  expect(await rows(page, 'Lista de membros').count()).toBeGreaterThan(25);

  await page.getByRole('checkbox', { name: 'Revogado' }).check();
  await expect(page).toHaveURL(org('/administracao/membros?estado=revoked'));
  await expect(rows(page, 'Lista de membros')).toHaveCount(1);
  await expect(rows(page, 'Lista de membros').first()).toContainText('Gil Desligado');
  await page.reload();
  await expect(rows(page, 'Lista de membros')).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: 'Revogado' })).toBeChecked();

  await nav(page).getByRole('link', { name: 'Clientes' }).click();
  await expect(rows(page, 'Lista de clientes')).toHaveCount(4);
  await audit(page, 'f6a1-clientes');
  await page.getByRole('link', { name: 'Ver concessões de Banco Exemplo S.A.' }).click();
  await expect(page).toHaveURL(org(`/administracao/concessoes?cliente=${stableUuid('dev:client:banco')}`));
  await expect(rows(page, 'Lista de concessões')).toHaveCount(3);
  await expect(page.getByRole('combobox', { name: 'Cliente' })).toHaveValue(stableUuid('dev:client:banco'));
  await audit(page, 'f6a1-concessoes');

  // nenhuma resposta fora de 200 nas leituras administrativas do fluxo normal
  expect(adminCalls(urls).filter((u) => u.status !== 200)).toEqual([]);
});

test('papel só de workspace: sem o grupo Administração; endereço direto → 403 da API e estado próprio, sem dados', async ({ page }) => {
  const urls = recordRequests(page);
  const acc = await account({ workspaceRoles: [['financeiro', ['WORKSPACE_ADMIN']]] });
  await enter(page, acc);
  await expect(nav(page).getByRole('link', { name: 'Workspaces' })).toBeVisible();
  await expect(nav(page).getByText('Administração')).toHaveCount(0);
  for (const [path, area] of [
    ['/administracao/membros', 'os membros desta organização'],
    ['/administracao/clientes', 'os clientes desta organização'],
    ['/administracao/concessoes', 'as concessões desta organização'],
  ]) {
    await page.goto(org(path));
    await expect(page.getByText(`Você não tem permissão para ver ${area}.`)).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  }
  await audit(page, 'f6a1-sem-permissao');
  const lists = adminCalls(urls).filter((u) => !u.url.includes('limit=100'));
  expect(lists.length).toBeGreaterThanOrEqual(3);
  expect(lists.every((u) => u.status === 403)).toBe(true);
});

test('conta externa: encaminhamento próprio, nenhuma rota administrativa chamada', async ({ page }) => {
  const urls = recordRequests(page);
  const acc = await account({ accountType: 'external' });
  await enter(page, acc, 'Olá, Pessoa E2E');
  await page.goto(org('/administracao/membros'));
  await expect(page.getByRole('heading', { name: 'Olá, Pessoa E2E' })).toBeVisible();
  await page.waitForTimeout(300);
  expect(adminCalls(urls)).toEqual([]);
  await expect(page.getByRole('region', { name: 'Lista de membros' })).toHaveCount(0);
});

test('R1: perda de permissão entre páginas → "Carregar mais" → 403: acesso negado sem a lista anterior; volta só por nova leitura autorizada', async ({ page }) => {
  const urls = recordRequests(page);
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);
  await page.goto(org('/administracao/membros'));
  await expect(rows(page, 'Lista de membros')).toHaveCount(25);
  await control('product/revoke-organization-roles', { userId: acc.userId });
  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect(page.getByText('Você não tem permissão para ver os membros desta organização.')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Filtros de membros' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Carregar mais' })).toHaveCount(0);
  await expect(page.getByText(/A lista exibida continua válida/)).toHaveCount(0);
  expect(urls.filter((u) => u.url.includes('/members?') && u.url.includes('cursor=')).map((u) => u.status)).toEqual([403]);
  await page.getByRole('button', { name: 'Verificar novamente' }).click();
  await expect(page.getByText('Você não tem permissão para ver os membros desta organização.')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await audit(page, 'f6a1-r1-acesso-perdido');
});

test('cursor recusado depois da rotação da chave: lista mantida e recomeço por ação; sessão expirada volta ao login', async ({ page }) => {
  const acc = await account({ orgRoles: ['ORG_ADMIN'] });
  await enter(page, acc);
  await page.goto(org('/administracao/membros'));
  await expect(rows(page, 'Lista de membros')).toHaveCount(25);
  await control('cursor-key/rotate', {});
  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect(page.getByText(/A lista mudou desde a última página/)).toBeVisible();
  await expect(rows(page, 'Lista de membros')).toHaveCount(25);
  await page.getByRole('button', { name: 'Recomeçar a lista' }).click();
  await expect(rows(page, 'Lista de membros')).toHaveCount(25);
  await expect(page.getByRole('button', { name: 'Carregar mais' })).toBeVisible();

  await control('revoke-sessions', { userId: acc.userId });
  await page.getByRole('button', { name: 'Atualizar' }).click();
  await expect(page).toHaveURL(`/o/${acc.org}/login`);
  await expect(page.getByText(SESSION_EXPIRED)).toBeVisible();
});
