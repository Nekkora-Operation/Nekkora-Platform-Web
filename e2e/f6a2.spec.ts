import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { Authenticator } from '../mock/totp';
import { signIn } from './support/app';

/**
 * F6a-2 no navegador, contra a API SIMULADA: suspender e reativar membros. Cada teste usa uma organização NOVA criada
 * pelo controle do mock (lista curta e isolada). Falhas de TRANSPORTE são injetadas pelo Playwright (page.route),
 * separadas das respostas do contrato, que vêm do mock.
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

/** Organização nova com uma administradora e uma conta-alvo. */
async function setup(page: Page) {
  const org = (await control<{ org: string }>('organizations', {})).org;
  const admin = await control<RoleAccount>('accounts', { org, mfa: true, orgRoles: ['ORG_ADMIN'], displayName: 'Admin F6a2' });
  const alvo = await control<RoleAccount>('accounts', { org, mfa: true, displayName: 'Alvo F6a2' });
  await signIn(page, { org, userId: admin.userId, email: admin.email });
  await expect(page).toHaveURL(`/o/${org}/mfa`);
  await page.getByLabel(/Código de autenticação/).fill(await new Authenticator(admin.totpSecret).next());
  await expect(page.getByRole('heading', { name: 'Olá, Admin F6a2' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Membros' }).click();
  await expect(page.getByRole('button', { name: 'Suspender Alvo F6a2' })).toBeVisible();
  return { org, admin, alvo };
}

function posts(page: Page) {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/users\/[^/]+\/(suspend|reactivate)$/.test(new URL(r.url()).pathname)) urls.push(new URL(r.url()).pathname);
  });
  return urls;
}

async function audit(page: Page, name: string) {
  // R1: espera as animações terminarem — durante a entrada do diálogo (opacidade 0) o axe ignora o conteúdo e o
  // contraste passaria por engano (falso positivo observado na F6a-2)
  // animação cancelada (o elemento foi renderizado de novo) rejeita `finished` com AbortError: ela já não existe, nada a esperar
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
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

test('teclado: suspender e reativar; foco no botão novo da linha; própria conta sem ação; axe no diálogo e depois', async ({ page }) => {
  const sent = posts(page);
  await setup(page);
  await expect(page.getByRole('row', { name: /Admin F6a2/ })).toContainText('Sua conta');

  await page.getByRole('button', { name: 'Suspender Alvo F6a2' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'Suspender Alvo F6a2?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await audit(page, 'f6a2-dialogo-suspender');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Suspender' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(announce(page)).toHaveText('Conta de Alvo F6a2 suspensa.');
  await expect(page.getByRole('button', { name: 'Reativar Alvo F6a2' })).toBeFocused();
  await audit(page, 'f6a2-depois-suspender');

  await page.keyboard.press('Enter');
  const reativar = page.getByRole('alertdialog', { name: 'Reativar Alvo F6a2?' });
  await expect(reativar).toContainText('não restaura sessões encerradas nem concessões revogadas');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(reativar).toHaveCount(0);
  await expect(announce(page)).toHaveText('Conta de Alvo F6a2 reativada.');
  await expect(page.getByRole('button', { name: 'Suspender Alvo F6a2' })).toBeFocused();
  expect(sent.length).toBe(2);
});

test('Esc antes de confirmar: nenhum POST; o foco volta ao botão de origem', async ({ page }) => {
  const sent = posts(page);
  await setup(page);
  await page.getByRole('button', { name: 'Suspender Alvo F6a2' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Suspender Alvo F6a2' })).toBeFocused();
  await page.waitForTimeout(200);
  expect(sent).toEqual([]);
});

test('transporte: rede cai DEPOIS de o servidor aplicar → incerto; conferir informa "suspensa" sem confirmar; navegar e voltar mantém o aviso', async ({ page }) => {
  const sent = posts(page);
  const { org } = await setup(page);
  await page.route('**/users/*/suspend', async (route) => {
    await route.fetch(); // o mock aplica a suspensão
    await route.abort('connectionreset'); // a resposta se perde
  });
  await page.getByRole('button', { name: 'Suspender Alvo F6a2' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Suspender' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar o resultado.');
  await expect(dialog.getByRole('button', { name: 'Suspender' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel(page)).toContainText('Suspensão de Alvo F6a2: resultado não confirmado.');
  await expect(panel(page)).toBeFocused();
  await audit(page, 'f6a2-resultado-incerto');

  await panel(page).getByRole('button', { name: /^Conferir estado atual/ }).click();
  await expect(panel(page)).toContainText('conta suspensa');
  await expect(panel(page)).toContainText('não confirma o resultado do pedido');

  const nav = page.getByRole('navigation', { name: 'Navegação principal' });
  await nav.getByRole('link', { name: 'Clientes' }).click();
  await expect(page).toHaveURL(`/o/${org}/administracao/clientes`);
  await nav.getByRole('link', { name: 'Membros' }).click();
  await expect(panel(page)).toContainText('Suspensão de Alvo F6a2: resultado não confirmado.');
  expect(sent.length).toBe(1);
});

test('transporte: 502 de gateway com corpo HTML → incerto (nunca sucesso nem recusa); nova tentativa só por confirmação explícita', async ({ page }) => {
  const sent = posts(page);
  await setup(page);
  let fail = true;
  await page.route('**/users/*/suspend', async (route) => {
    if (fail) return route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad Gateway</body></html>' });
    return route.continue();
  });
  await page.getByRole('button', { name: 'Suspender Alvo F6a2' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Suspender' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar o resultado.');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await page.waitForTimeout(200);
  expect(sent.length).toBe(1);

  fail = false;
  await panel(page).getByRole('button', { name: /^Tentar de novo/ }).click();
  const retry = page.getByRole('alertdialog', { name: 'Tentar de novo: suspender Alvo F6a2?' });
  await expect(retry).toContainText('O resultado anterior não foi confirmado.');
  await retry.getByRole('button', { name: 'Suspender de novo' }).click();
  await expect(retry).toHaveCount(0);
  await expect(announce(page)).toHaveText('Conta de Alvo F6a2 suspensa.');
  await expect(panel(page)).toHaveCount(0);
  expect(sent.length).toBe(2);
});

test('R1: logout e outra conta da mesma organização na mesma aba: a incerteza da sessão anterior não aparece', async ({ page }) => {
  const { org } = await setup(page);
  const outra = await control<RoleAccount>('accounts', { org, mfa: true, orgRoles: ['ORG_ADMIN'], displayName: 'Outra Admin' });
  await page.route('**/users/*/suspend', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }));
  await page.getByRole('button', { name: 'Suspender Alvo F6a2' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Suspender' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar o resultado.');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel(page)).toContainText('Suspensão de Alvo F6a2: resultado não confirmado.');

  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByText('Você saiu da sua conta.')).toBeVisible();
  await signIn(page, { org, userId: outra.userId, email: outra.email });
  await expect(page).toHaveURL(`/o/${org}/mfa`);
  await page.getByLabel(/Código de autenticação/).fill(await new Authenticator(outra.totpSecret).next());
  await expect(page.getByRole('heading', { name: 'Olá, Outra Admin' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Membros' }).click();
  await expect(page.getByRole('button', { name: 'Suspender Alvo F6a2' })).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText('Resultado não confirmado')).toHaveCount(0);
});

test('R2: duas abas no mesmo navegador — outra aba entra com outra conta: a aba antiga sai da área, sem aviso nem ações, e a conferência pendente para', async ({ page, context }) => {
  const { org } = await setup(page);
  const outra = await control<RoleAccount>('accounts', { org, mfa: true, orgRoles: ['ORG_ADMIN'], displayName: 'Outra Admin' });
  await page.route('**/users/*/suspend', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }));
  await page.getByRole('button', { name: 'Suspender Alvo F6a2' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Suspender' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar o resultado.');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel(page)).toBeVisible();

  // conferência pendente na aba antiga
  let release!: () => void;
  const until = new Promise<void>((r) => (release = r));
  const checks: string[] = [];
  await page.route(/\/members\?.*limit=100/, async (route) => {
    checks.push(route.request().url());
    await until;
    await route.continue();
  });
  await panel(page).getByRole('button', { name: /^Conferir estado atual/ }).click();
  await expect.poll(() => checks.length).toBe(1);

  // outra aba do MESMO contexto (mesmos cookies) entra com outra administradora
  const other = await context.newPage();
  await signIn(other, { org, userId: outra.userId, email: outra.email });
  await expect(other).toHaveURL(`/o/${org}/mfa`);
  await other.getByLabel(/Código de autenticação/).fill(await new Authenticator(outra.totpSecret).next());
  await expect(other.getByRole('heading', { name: 'Olá, Outra Admin' })).toBeVisible();

  // a aba antiga invalidou tudo antes de qualquer nova ação
  await expect(page).toHaveURL(`/o/${org}/login`);
  await expect(page.getByText('Sua sessão foi encerrada ou alterada em outra aba. Entre novamente para continuar.')).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Suspender|Reativar|Conferir|Tentar de novo/ })).toHaveCount(0);
  release();
  await page.waitForTimeout(300);
  expect(checks.length).toBe(1);

  // a outra aba segue normal, sem nada da sessão anterior
  await other.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Membros' }).click();
  await expect(other.getByRole('button', { name: 'Suspender Alvo F6a2' })).toBeVisible();
  await expect(panel(other)).toHaveCount(0);
});
