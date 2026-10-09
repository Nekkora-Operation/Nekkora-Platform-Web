import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { Authenticator } from '../mock/totp';
import { signIn } from './support/app';

/**
 * F6a-3 no navegador, contra a API SIMULADA: revogar concessões. Cada teste usa uma organização NOVA criada pelo
 * controle do mock, com duas concessões (ativa e pendente) de contas externas próprias. Falhas de TRANSPORTE são
 * injetadas pelo Playwright (page.route), separadas das respostas do contrato, que vêm do mock.
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

const WHERE = '(cliente Cliente Vizinho, workspace Workspace da organização vizinha)';
const A = `Externa Um ${WHERE}`;
const B = `Externa Dois ${WHERE}`;

async function login(page: Page, org: string, who: RoleAccount, name: string) {
  await signIn(page, { org, userId: who.userId, email: who.email });
  await expect(page).toHaveURL(`/o/${org}/mfa`);
  await page.getByLabel(/Código de autenticação/).fill(await new Authenticator(who.totpSecret).next());
  await expect(page.getByRole('heading', { name: `Olá, ${name}` })).toBeVisible();
}

/** Organização nova: administradora, uma conta interna (para membros) e duas concessões (ativa e pendente). */
async function setup(page: Page) {
  const org = (await control<{ org: string }>('organizations', {})).org;
  const admin = await control<RoleAccount>('accounts', { org, mfa: true, orgRoles: ['ORG_ADMIN'], displayName: 'Admin F6a3' });
  await control<RoleAccount>('accounts', { org, mfa: true, displayName: 'Alvo F6a3' });
  const um = await control<RoleAccount>('accounts', { org, accountType: 'external', displayName: 'Externa Um' });
  const dois = await control<RoleAccount>('accounts', { org, accountType: 'external', displayName: 'Externa Dois' });
  const { grants } = await control<{ grants: string[] }>('grants', {
    org,
    grants: [
      { k: 'a', externalUserId: um.userId, status: 'active' },
      { k: 'b', externalUserId: dois.userId, status: 'pending' },
    ],
  });
  await login(page, org, admin, 'Admin F6a3');
  await page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Concessões' }).click();
  await expect(page.getByRole('button', { name: `Revogar a concessão de ${A}` })).toBeVisible();
  return { org, admin, grants };
}

function posts(page: Page) {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/client-grants\/[^/]+\/revoke$/.test(new URL(r.url()).pathname)) urls.push(new URL(r.url()).pathname);
  });
  return urls;
}

async function audit(page: Page, name: string) {
  // espera as animações terminarem — durante a entrada do diálogo (opacidade 0) o axe ignora o conteúdo
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe injetado acima
    const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return r.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
  expect(violations, `axe em ${name}`).toEqual([]);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

const panel = (page: Page) => page.getByRole('region', { name: 'Ações sem resultado confirmado' });
const announce = (page: Page) => page.getByRole('status', { name: 'Resultado das ações' });
const anchor = (page: Page, id: string) => page.locator(`[data-concessao-linha="${id}"]`);

test('teclado: revogar com a confirmação identificando cliente e workspace; foco na linha; axe no diálogo e depois', async ({ page }) => {
  const sent = posts(page);
  const { grants } = await setup(page);
  await page.getByRole('button', { name: `Revogar a concessão de ${A}` }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'Revogar a concessão de Externa Um?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Cliente Vizinho');
  await expect(dialog).toContainText('Workspace da organização vizinha');
  await expect(dialog).toContainText('Só esta concessão muda');
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await audit(page, 'f6a3-dialogo-revogar');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Revogar' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(announce(page)).toHaveText(`Concessão de ${A} revogada.`);
  await expect(anchor(page, grants[0])).toBeFocused();
  await expect(page.getByRole('row', { name: /Externa Um/ })).toContainText('Revogada');
  await expect(page.getByRole('button', { name: `Revogar a concessão de ${A}` })).toHaveCount(0);
  await audit(page, 'f6a3-depois-revogar');
  expect(sent).toEqual([expect.stringContaining(`/client-grants/${grants[0]}/revoke`)]);
});

test('Esc antes de confirmar: nenhum POST; o foco volta ao botão de origem', async ({ page }) => {
  const sent = posts(page);
  await setup(page);
  await page.getByRole('button', { name: `Revogar a concessão de ${A}` }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Revogar a concessão de ${A}` })).toBeFocused();
  await page.waitForTimeout(200);
  expect(sent).toEqual([]);
});

test('filtro sem "Revogada": a linha revogada sai da vista; o foco vai à lista; a outra concessão continua', async ({ page }) => {
  const { org } = await setup(page);
  await page.getByRole('checkbox', { name: 'Ativa' }).check();
  await page.getByRole('checkbox', { name: 'Pendente' }).check();
  await expect(page).toHaveURL(`/o/${org}/administracao/concessoes?estado=active&estado=pending`);
  await page.getByRole('button', { name: `Revogar a concessão de ${A}` }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(announce(page)).toHaveText(`Concessão de ${A} revogada.`);
  await expect(page.getByRole('row', { name: /Externa Um/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Revogar a concessão de ${B}` })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Lista de concessões' })).toBeFocused();
  await audit(page, 'f6a3-filtro-linha-saiu');
});

test('transporte: rede cai DEPOIS de aplicar → incerto; conferir informa "revogada" sem confirmar; navegar e voltar mantém o aviso', async ({ page }) => {
  const sent = posts(page);
  const { org } = await setup(page);
  await page.route('**/client-grants/*/revoke', async (route) => {
    await route.fetch(); // o mock aplica a revogação
    await route.abort('connectionreset'); // a resposta se perde
  });
  await page.getByRole('button', { name: `Revogar a concessão de ${A}` }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Revogar' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar o resultado.');
  await expect(dialog.getByRole('button', { name: 'Revogar' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel(page)).toContainText(`Revogação da concessão de ${A}: resultado não confirmado.`);
  await expect(panel(page)).toBeFocused();
  await audit(page, 'f6a3-resultado-incerto');

  await panel(page).getByRole('button', { name: /^Conferir estado atual/ }).click();
  await expect(panel(page)).toContainText('concessão revogada');
  await expect(panel(page)).toContainText('não confirma o resultado do pedido');

  const nav = page.getByRole('navigation', { name: 'Navegação principal' });
  await nav.getByRole('link', { name: 'Clientes' }).click();
  await expect(page).toHaveURL(`/o/${org}/administracao/clientes`);
  await nav.getByRole('link', { name: 'Concessões' }).click();
  await expect(panel(page)).toContainText(`Revogação da concessão de ${A}: resultado não confirmado.`);
  expect(sent.length).toBe(1);
});

test('transporte: 502 com corpo HTML → incerto; nova tentativa só por confirmação explícita; o sucesso encerra o aviso', async ({ page }) => {
  const sent = posts(page);
  await setup(page);
  let fail = true;
  await page.route('**/client-grants/*/revoke', async (route) => {
    if (fail) return route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad Gateway</body></html>' });
    return route.continue();
  });
  await page.getByRole('button', { name: `Revogar a concessão de ${A}` }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Revogar' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar o resultado.');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await page.waitForTimeout(200);
  expect(sent.length).toBe(1);

  fail = false;
  await panel(page).getByRole('button', { name: /^Tentar de novo/ }).click();
  const retry = page.getByRole('alertdialog', { name: 'Tentar de novo: revogar a concessão de Externa Um?' });
  await expect(retry).toContainText('O resultado anterior não foi confirmado.');
  await audit(page, 'f6a3-nova-tentativa');
  await retry.getByRole('button', { name: 'Revogar de novo' }).click();
  await expect(retry).toHaveCount(0);
  await expect(announce(page)).toHaveText(`Concessão de ${A} revogada.`);
  await expect(panel(page)).toHaveCount(0);
  expect(sent.length).toBe(2);
});

test('membros e concessões não colidem: cada tela mostra só a sua incerteza', async ({ page }) => {
  await setup(page);
  await page.route('**/client-grants/*/revoke', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }));
  await page.route('**/users/*/suspend', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }));
  await page.getByRole('button', { name: `Revogar a concessão de ${A}` }).click();
  let dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Revogar' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar o resultado.');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();

  const nav = page.getByRole('navigation', { name: 'Navegação principal' });
  await nav.getByRole('link', { name: 'Membros' }).click();
  await expect(page.getByRole('button', { name: 'Suspender Alvo F6a3' })).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Suspender Alvo F6a3' }).click();
  dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Suspender' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar o resultado.');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel(page)).toContainText('Suspensão de Alvo F6a3: resultado não confirmado.');
  await expect(panel(page)).not.toContainText('Revogação');

  await nav.getByRole('link', { name: 'Concessões' }).click();
  await expect(panel(page)).toContainText(`Revogação da concessão de ${A}: resultado não confirmado.`);
  await expect(panel(page)).not.toContainText('Alvo F6a3');
});

test('R1: filtro "Ativa", revogar TODAS as carregadas pelo teclado: continuação disponível sem busca automática; o cursor encontra outra concessão; axe', async ({ page }) => {
  // organização própria: 26 ativas (25 da mesma conta + a mais antiga de outra conta, só na segunda página)
  const org = (await control<{ org: string }>('organizations', {})).org;
  const admin = await control<RoleAccount>('accounts', { org, mfa: true, orgRoles: ['ORG_ADMIN'], displayName: 'Admin F6a3' });
  const um = await control<RoleAccount>('accounts', { org, accountType: 'external', displayName: 'Externa Um' });
  const fim = await control<RoleAccount>('accounts', { org, accountType: 'external', displayName: 'Externa Final' });
  await control('grants', {
    org,
    grants: [
      ...Array.from({ length: 25 }, (_, i) => ({ k: `p${i}`, externalUserId: um.userId, status: 'active' })),
      { k: 'final', externalUserId: fim.userId, status: 'active' }, // índice maior = mais antiga = última
    ],
  });
  const reads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/client-grants')) reads.push(r.url());
  });
  await login(page, org, admin, 'Admin F6a3');
  await page.goto(`/o/${org}/administracao/concessoes?estado=active`);
  const revogar = page.getByRole('button', { name: `Revogar a concessão de ${A}` });
  await expect(revogar).toHaveCount(25);
  await expect(page.getByRole('button', { name: 'Carregar mais' })).toBeVisible();

  for (let i = 0; i < 25; i++) {
    await revogar.first().focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(revogar).toHaveCount(24 - i);
  }

  const region = page.getByRole('region', { name: 'Lista de concessões' });
  await expect(region).toContainText('Nenhuma concessão com esses filtros entre as carregadas até agora.');
  await expect(page.getByText('Nenhuma concessão com esses filtros.', { exact: true })).toHaveCount(0);
  await expect(region).toBeFocused();
  await expect(page.getByText(/Exibindo 0 concessões/)).toBeVisible();
  const before = reads.length;
  await page.waitForTimeout(300);
  expect(reads.length).toBe(before); // nenhuma página buscada sozinha
  await expect(page).toHaveURL(`/o/${org}/administracao/concessoes?estado=active`);
  await audit(page, 'f6a3-r1-vazio-entre-carregadas');

  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Carregar mais' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: `Revogar a concessão de Externa Final ${WHERE}` })).toBeVisible();
  expect(reads.length).toBe(before + 1);
  expect(reads[before]).toContain('cursor=');
  expect(reads[before]).toContain('status=active');
  await expect(page.getByText(/Exibindo 1 concessão · lista completa/)).toBeVisible();
  await audit(page, 'f6a3-r1-depois-continuar');
});

test('R2: zerar as visíveis → continuação RECUSADA: aviso e recomeço continuam; nada lido sozinho; recomeçar lê a 1a página sem cursor e com o filtro; axe', async ({ page }) => {
  const org = (await control<{ org: string }>('organizations', {})).org;
  const admin = await control<RoleAccount>('accounts', { org, mfa: true, orgRoles: ['ORG_ADMIN'], displayName: 'Admin F6a3' });
  const um = await control<RoleAccount>('accounts', { org, accountType: 'external', displayName: 'Externa Um' });
  const fim = await control<RoleAccount>('accounts', { org, accountType: 'external', displayName: 'Externa Final' });
  await control('grants', {
    org,
    grants: [
      ...Array.from({ length: 25 }, (_, i) => ({ k: `p${i}`, externalUserId: um.userId, status: 'active' })),
      { k: 'final', externalUserId: fim.userId, status: 'active' },
    ],
  });
  const reads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/client-grants')) reads.push(r.url());
  });
  await login(page, org, admin, 'Admin F6a3');
  await page.goto(`/o/${org}/administracao/concessoes?estado=active`);
  const revogar = page.getByRole('button', { name: `Revogar a concessão de ${A}` });
  await expect(revogar).toHaveCount(25);
  for (let i = 0; i < 25; i++) {
    await revogar.first().focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(revogar).toHaveCount(24 - i);
  }
  const region = page.getByRole('region', { name: 'Lista de concessões' });
  await expect(region).toContainText('A lista continua');

  // a continuação é recusada pela API (400 do contrato: cursor inválido ou expirado)
  const rejected: string[] = [];
  await page.route(/\/client-grants\?.*cursor=/, async (route) => {
    rejected.push(route.request().url());
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_request' }) });
  });
  const before = reads.length;
  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect(page.getByText('A lista mudou desde a última página (ou a continuação expirou).')).toBeVisible();
  await expect(region).toContainText('Nenhuma concessão com esses filtros entre as carregadas até agora.');
  await expect(region).toContainText('Não foi possível continuar a lista. Recomece para ver as demais.');
  await expect(page.getByText('Nenhuma concessão com esses filtros.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Carregar mais' })).toHaveCount(0);
  const restart = page.getByRole('button', { name: 'Recomeçar a lista' });
  await expect(restart).toBeVisible();
  await page.waitForTimeout(300);
  expect(reads.length).toBe(before + 1); // só a continuação pedida; o cursor recusado não é reenviado
  expect(rejected.length).toBe(1);
  await expect(page).toHaveURL(`/o/${org}/administracao/concessoes?estado=active`);
  await audit(page, 'f6a3-r2-continuacao-recusada');

  await page.unroute(/\/client-grants\?.*cursor=/);
  await restart.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: `Revogar a concessão de Externa Final ${WHERE}` })).toBeVisible();
  expect(reads.length).toBe(before + 2);
  expect(reads[before + 1]).not.toContain('cursor=');
  expect(reads[before + 1]).toContain('status=active');
  await expect(page).toHaveURL(`/o/${org}/administracao/concessoes?estado=active`);
  await expect(page.getByText(/Exibindo 1 concessão · lista completa/)).toBeVisible();
  await expect(page.getByText(/A lista mudou desde a última página/)).toHaveCount(0);
  await audit(page, 'f6a3-r2-depois-recomecar');
});

test('duas abas no mesmo navegador — outra aba entra com outra conta: a aba antiga sai da área e a conferência pendente para', async ({ page, context }) => {
  const { org } = await setup(page);
  const outra = await control<RoleAccount>('accounts', { org, mfa: true, orgRoles: ['ORG_ADMIN'], displayName: 'Outra Admin' });
  await page.route('**/client-grants/*/revoke', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }));
  await page.getByRole('button', { name: `Revogar a concessão de ${A}` }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Revogar' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar o resultado.');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel(page)).toBeVisible();

  let release!: () => void;
  const until = new Promise<void>((r) => (release = r));
  const checks: string[] = [];
  await page.route(/\/client-grants\?.*limit=100/, async (route) => {
    checks.push(route.request().url());
    await until;
    await route.continue();
  });
  await panel(page).getByRole('button', { name: /^Conferir estado atual/ }).click();
  await expect.poll(() => checks.length).toBe(1);

  const other = await context.newPage();
  await login(other, org, outra, 'Outra Admin');

  await expect(page).toHaveURL(`/o/${org}/login`);
  await expect(page.getByText('Sua sessão foi encerrada ou alterada em outra aba. Entre novamente para continuar.')).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Revogar|Conferir|Tentar de novo/ })).toHaveCount(0);
  release();
  await page.waitForTimeout(300);
  expect(checks.length).toBe(1);

  await other.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Concessões' }).click();
  await expect(other.getByRole('button', { name: `Revogar a concessão de ${A}` })).toBeVisible();
  await expect(panel(other)).toHaveCount(0);
});
