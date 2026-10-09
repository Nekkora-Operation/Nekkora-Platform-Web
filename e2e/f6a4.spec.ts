import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { Authenticator } from '../mock/totp';
import { signIn } from './support/app';

/**
 * F6a-4 no navegador, contra a API SIMULADA: redefinir o MFA de um membro com step-up TOTP no próprio diálogo. Cada
 * teste usa uma organização NOVA criada pelo controle do mock (administradora + conta-alvo com MFA). O autenticador da
 * administradora é o mesmo do login (códigos de uso único: o step-up usa um passo novo). Falhas de TRANSPORTE são
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

const ALVO = 'Alvo F6a4';

async function login(page: Page, org: string, who: RoleAccount, name: string) {
  const auth = new Authenticator(who.totpSecret);
  await signIn(page, { org, userId: who.userId, email: who.email });
  await expect(page).toHaveURL(`/o/${org}/mfa`);
  await page.getByLabel(/Código de autenticação/).fill(await auth.next());
  await expect(page.getByRole('heading', { name: `Olá, ${name}` })).toBeVisible();
  return auth;
}

/** Organização nova com uma administradora e uma conta-alvo com MFA; abre Membros. */
async function setup(page: Page) {
  const org = (await control<{ org: string }>('organizations', {})).org;
  const admin = await control<RoleAccount>('accounts', { org, mfa: true, orgRoles: ['ORG_ADMIN'], displayName: 'Admin F6a4' });
  const alvo = await control<RoleAccount>('accounts', { org, mfa: true, displayName: ALVO });
  const auth = await login(page, org, admin, 'Admin F6a4');
  await page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Membros' }).click();
  await expect(page.getByRole('button', { name: `Redefinir MFA de ${ALVO}` })).toBeVisible();
  return { org, admin, alvo, auth };
}

function posts(page: Page) {
  const sent: string[] = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === 'POST' && p.endsWith('/auth/mfa/step-up')) sent.push('step-up');
    if (r.method() === 'POST' && p.endsWith('/mfa/reset')) sent.push('reset');
  });
  return sent;
}

async function audit(page: Page, name: string) {
  // espera as animações terminarem — durante a entrada do diálogo (opacidade 0) o axe ignora o conteúdo. allSettled:
  // uma animação CANCELADA (substituída por outra, ex.: ao abrir a nova tentativa) rejeita `finished` com AbortError;
  // ela também conta como encerrada, e as que continuam são esperadas na segunda volta
  for (let i = 0; i < 2; i++) await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
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

/** Preenche o diálogo SÓ pelo teclado: motivo (Espaço no rádio), código digitado e Tab até o botão de confirmar. */
async function fillByKeyboard(page: Page, totpCode: string, confirmName = 'Redefinir MFA') {
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('radio', { name: 'Dispositivo perdido' }).focus();
  await page.keyboard.press('Space');
  await expect(dialog.getByRole('radio', { name: 'Dispositivo perdido' })).toBeChecked();
  const field = dialog.getByLabel(/Código do seu aplicativo autenticador/);
  await field.focus();
  await page.keyboard.type(totpCode);
  const confirm = dialog.getByRole('button', { name: confirmName });
  for (let i = 0; i < 6 && !(await confirm.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
}

test('teclado: redefinir com step-up; anúncio; MFA não configurado; foco na outra ação da linha; axe no diálogo e depois', async ({ page }) => {
  const sent = posts(page);
  const { auth } = await setup(page);
  await page.getByRole('button', { name: `Redefinir MFA de ${ALVO}` }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: `Redefinir o MFA de ${ALVO}?` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await expect(dialog).toContainText('as sessões abertas dela são encerradas agora');
  await expect(dialog).toContainText('Códigos de recuperação não são aceitos aqui.');
  await expect(dialog.getByRole('button', { name: 'Redefinir MFA' })).toBeDisabled();
  await audit(page, 'f6a4-dialogo-redefinir');
  await fillByKeyboard(page, await auth.next());
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(announce(page)).toHaveText(`MFA de ${ALVO} redefinido.`);
  await expect(page.getByRole('row', { name: new RegExp(ALVO) })).toContainText('Não configurado');
  await expect(page.getByRole('button', { name: `Redefinir MFA de ${ALVO}` })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Suspender ${ALVO}` })).toBeFocused();
  await audit(page, 'f6a4-depois-redefinir');
  expect(sent).toEqual(['step-up', 'reset']);
});

test('step-up recusado (403): mensagem neutra, sem atribuir ao código; redefinição não enviada; Esc fecha e devolve o foco', async ({ page }) => {
  const sent = posts(page);
  const { auth } = await setup(page);
  await page.getByRole('button', { name: `Redefinir MFA de ${ALVO}` }).focus();
  await page.keyboard.press('Enter');
  await fillByKeyboard(page, auth.wrong());
  await page.keyboard.press('Enter');
  const alert = page.getByRole('alertdialog').getByRole('alert');
  await expect(alert).toHaveText(`Não foi possível confirmar sua identidade. Nada foi alterado na conta de ${ALVO}.`);
  await expect(page.getByRole('alertdialog').getByLabel(/Código do seu aplicativo autenticador/)).toHaveValue('');
  await audit(page, 'f6a4-step-up-recusado');
  await page.waitForTimeout(200);
  expect(sent).toEqual(['step-up']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Redefinir MFA de ${ALVO}` })).toBeFocused();
  await expect(panel(page)).toHaveCount(0);
});

test('step-up sem resposta (502): recusa, não incerteza; redefinição não enviada', async ({ page }) => {
  const sent = posts(page);
  const { auth } = await setup(page);
  await page.route('**/auth/mfa/step-up', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }));
  await page.getByRole('button', { name: `Redefinir MFA de ${ALVO}` }).click();
  await fillByKeyboard(page, await auth.next());
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog').getByRole('alert')).toHaveText(`Não foi possível confirmar sua identidade agora. Nada foi alterado na conta de ${ALVO}.`);
  await page.waitForTimeout(200);
  expect(sent).toEqual(['step-up']);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel(page)).toHaveCount(0);
});

test('transporte: redefinição aplicada e resposta perdida → incerto; conferir informa "MFA não configurado" sem confirmar; nova tentativa com aviso; navegar e voltar mantém', async ({ page }) => {
  const sent = posts(page);
  const { org, auth } = await setup(page);
  await page.route('**/mfa/reset', async (route) => {
    await route.fetch(); // o mock aplica a redefinição
    await route.abort('connectionreset'); // a resposta se perde
  });
  await page.getByRole('button', { name: `Redefinir MFA de ${ALVO}` }).click();
  await fillByKeyboard(page, await auth.next());
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar o resultado. A redefinição pode ter sido aplicada ou não.');
  await expect(dialog.getByRole('button', { name: 'Redefinir MFA' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel(page)).toContainText(`Redefinição de MFA de ${ALVO}: resultado não confirmado.`);
  await expect(panel(page)).toBeFocused();
  await audit(page, 'f6a4-resultado-incerto');

  await panel(page).getByRole('button', { name: /^Conferir estado atual/ }).click();
  await expect(panel(page)).toContainText('MFA não configurado');
  await expect(panel(page)).toContainText('não confirma o resultado do pedido');

  const nav = page.getByRole('navigation', { name: 'Navegação principal' });
  await nav.getByRole('link', { name: 'Clientes' }).click();
  await expect(page).toHaveURL(`/o/${org}/administracao/clientes`);
  await nav.getByRole('link', { name: 'Membros' }).click();
  await expect(panel(page)).toContainText(`Redefinição de MFA de ${ALVO}: resultado não confirmado.`);

  await panel(page).getByRole('button', { name: /^Tentar de novo/ }).click();
  const retry = page.getByRole('alertdialog', { name: `Tentar de novo: redefinir o MFA de ${ALVO}?` });
  await expect(retry).toContainText('novos avisos por e-mail e novo encerramento das sessões');
  await audit(page, 'f6a4-nova-tentativa');
  await retry.getByRole('button', { name: 'Cancelar' }).click();
  await expect(retry).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(sent).toEqual(['step-up', 'reset']);
});

test('duas abas no mesmo navegador — outra aba entra com outra conta: a aba antiga sai da área, sem aviso nem ações', async ({ page, context }) => {
  const { org, auth } = await setup(page);
  const outra = await control<RoleAccount>('accounts', { org, mfa: true, orgRoles: ['ORG_ADMIN'], displayName: 'Outra Admin' });
  await page.route('**/mfa/reset', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }));
  await page.getByRole('button', { name: `Redefinir MFA de ${ALVO}` }).click();
  await fillByKeyboard(page, await auth.next());
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar o resultado.');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel(page)).toBeVisible();

  const other = await context.newPage();
  await login(other, org, outra, 'Outra Admin');
  await expect(page).toHaveURL(`/o/${org}/login`);
  await expect(page.getByText('Sua sessão foi encerrada ou alterada em outra aba. Entre novamente para continuar.')).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Redefinir|Conferir|Tentar de novo/ })).toHaveCount(0);

  await other.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Membros' }).click();
  await expect(other.getByRole('button', { name: `Redefinir MFA de ${ALVO}` })).toBeVisible();
  await expect(panel(other)).toHaveCount(0);
});
