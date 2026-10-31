import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { DEV_ORG } from '../mock/contract';
import { Authenticator } from '../mock/totp';
import { signIn } from './support/app';

/**
 * FRONT-V1-004: duas abas da mesma pessoa tentam enviar a MESMA operação protegida (criar workspace) ao mesmo tempo,
 * contra a API simulada. Conta os POST que saíram das duas abas juntas.
 * - Com Web Locks (navegadores atuais): sai exatamente um envio por rodada; a outra aba fica em "envio em andamento".
 * - Sem Web Locks (removido antes de a página carregar): nenhum envio sai; as duas abas avisam por quê.
 * O disparo é agendado nas duas abas para o mesmo instante do relógio (setTimeout até um horário comum), não por dois
 * cliques em sequência do Playwright.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const ROUNDS = Number(process.env.CORRIDA_RODADAS ?? 10);
const NO_LOCKS_NOTICE = /não oferece bloqueio entre abas/;

interface RoleAccount {
  org: string;
  userId: string;
  email: string;
  totpSecret: string;
}

async function account(): Promise<RoleAccount> {
  const res = await fetch(`${BASE}/__mock/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org: DEV_ORG, mfa: true, orgRoles: ['ORG_ADMIN'] }),
  });
  if (!res.ok) throw new Error(`controle do mock falhou (${res.status})`);
  return (await res.json()) as RoleAccount;
}

async function enter(page: Page, acc: RoleAccount) {
  await signIn(page, { org: acc.org, userId: acc.userId, email: acc.email });
  await expect(page).toHaveURL(`/o/${acc.org}/mfa`);
  await page.getByLabel(/Código de autenticação/).fill(await new Authenticator(acc.totpSecret).next());
  await expect(page.getByRole('heading', { name: 'Olá, Pessoa E2E' })).toBeVisible();
}

/** POST de criação de workspace saídos de QUALQUER aba do contexto. */
function countCreates(context: BrowserContext) {
  const sent: string[] = [];
  context.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/v1\/o\/[^/]+\/workspaces$/.test(new URL(r.url()).pathname)) sent.push(r.url());
  });
  return sent;
}

async function openCreate(page: Page, name: string) {
  await page.goto(`/o/${DEV_ORG}/workspaces`);
  await page.getByRole('button', { name: 'Criar workspace' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel(/^Nome/).fill(name);
  return dialog;
}

/** Agenda o clique em "Criar workspace" do diálogo para o instante `at` (Date.now() comum às duas abas). */
async function clickAt(page: Page, at: number) {
  await page.evaluate((when) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === 'Criar workspace');
    if (!button) throw new Error('botão de confirmação não encontrado');
    setTimeout(() => button.click(), Math.max(0, when - Date.now()));
  }, at);
}

test.describe('FRONT-V1-004: mesma operação em duas abas ao mesmo tempo', () => {
  test('com Web Locks: um único envio por rodada', async ({ browser }) => {
    const context = await browser.newContext();
    const sent = countCreates(context);
    const acc = await account();
    const a = await context.newPage();
    await enter(a, acc);
    const b = await context.newPage();
    const results: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const before = sent.length;
      const name = `Corrida ${i} ${Date.now()}`;
      const [da, db] = [await openCreate(a, name), await openCreate(b, name)];
      await expect(da.getByRole('button', { name: 'Criar workspace' })).toBeEnabled();
      await expect(db.getByRole('button', { name: 'Criar workspace' })).toBeEnabled();
      const at = Date.now() + 400;
      await Promise.all([clickAt(a, at), clickAt(b, at)]);
      // uma aba conclui (navega ao workspace criado); a outra fica barrada pelo envio em andamento ou pela confirmação
      await expect.poll(() => sent.length - before, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
      await a.waitForTimeout(1_000);
      results.push(sent.length - before);
    }
    test.info().annotations.push({ type: 'envios por rodada (com Web Locks)', description: results.join(',') });
    expect(results.every((n) => n === 1), `envios por rodada: ${results.join(',')}`).toBe(true);
    await context.close();
  });

  test('sem Web Locks: nenhum envio, e as duas abas dizem por quê', async ({ browser }) => {
    const context = await browser.newContext();
    // ambiente sem Web Locks: a API some antes de qualquer script da página
    await context.addInitScript(() => {
      delete (Navigator.prototype as unknown as Record<string, unknown>).locks;
    });
    const sent = countCreates(context);
    const acc = await account();
    const a = await context.newPage();
    await enter(a, acc);
    expect(await a.evaluate(() => 'locks' in navigator)).toBe(false);
    const b = await context.newPage();
    const results: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const before = sent.length;
      const name = `Corrida sem locks ${i} ${Date.now()}`;
      const [da, db] = [await openCreate(a, name), await openCreate(b, name)];
      await expect(da.getByText(NO_LOCKS_NOTICE)).toBeVisible();
      await expect(db.getByText(NO_LOCKS_NOTICE)).toBeVisible();
      await expect(da.getByRole('button', { name: 'Criar workspace' })).toBeDisabled();
      await expect(db.getByRole('button', { name: 'Criar workspace' })).toBeDisabled();
      const at = Date.now() + 400;
      await Promise.all([clickAt(a, at), clickAt(b, at)]);
      await a.waitForTimeout(1_000);
      results.push(sent.length - before);
    }
    test.info().annotations.push({ type: 'envios por rodada (sem Web Locks)', description: results.join(',') });
    expect(results.every((n) => n === 0), `envios por rodada: ${results.join(',')}`).toBe(true);
    await context.close();
  });
});
