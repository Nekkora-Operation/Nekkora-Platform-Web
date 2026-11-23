import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DEV_ORG } from '../mock/contract';
import { Authenticator } from '../mock/totp';
import { leaveMenu, signIn } from './support/app';

/**
 * A2 (LICENCIAMENTO-002): o aviso "Organização bloqueada pela Nekkora" é o primeiro item do conteúdo; com o cabeçalho fixo,
 * o título e o texto precisam ficar visíveis — na entrada, depois de navegar a partir de uma página rolada (o foco vai ao
 * conteúdo) e no "pular para o conteúdo" — em tela larga, no celular e com zoom de 200%. A API simulada não tem o bloqueio:
 * a resposta de /me é a dela, com `organizationHeldByNekkora: true` acrescentado. Capturas da janela (não da página
 * inteira, que desenha o cabeçalho fixo fora do lugar) em BLOQUEIO_CAPTURAS=<pasta>.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const CAPTURAS = process.env.BLOQUEIO_CAPTURAS;
const TITULO = 'Organização bloqueada pela Nekkora';

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

/** O título e a primeira linha do texto do aviso estão abaixo do cabeçalho e dentro da janela. */
async function avisoVisivel(page: Page, nome: string) {
  const aviso = page.getByRole('alert').filter({ hasText: TITULO });
  await expect(aviso).toBeVisible();
  const medir = () =>
    page.evaluate((titulo) => {
      const bar = document.querySelector('.nk-shell__topbar')!.getBoundingClientRect();
      const alert = [...document.querySelectorAll('[role="alert"]')].find((a) => a.textContent?.includes(titulo))!;
      const title = [...alert.querySelectorAll('*')].find((e) => e.childElementCount === 0 && e.textContent?.trim() === titulo)!.getBoundingClientRect();
      const body = [...alert.querySelectorAll('*')].find((e) => e.childElementCount === 0 && e.textContent?.startsWith('Novas operações'))!.getBoundingClientRect();
      // o que está no início e no fim do título, e no início do texto, é o próprio aviso (nem o cabeçalho, nem o menu por cima)
      const covered = (x: number, y: number) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return 'fora da janela';
        if (alert.contains(el)) return null;
        return el.closest('.nk-shell__topbar') ? 'cabeçalho' : el.closest('nav, aside, [role="dialog"]') ? 'menu' : el.tagName.toLowerCase();
      };
      const coveredBy = covered(title.left + 4, title.top + title.height / 2) ?? covered(title.right - 4, title.top + title.height / 2) ?? covered(body.left + 4, body.top + 4);
      return { barBottom: bar.bottom, titleTop: title.top, titleBottom: title.bottom, bodyTop: body.top, vh: window.innerHeight, coveredBy };
    }, TITULO);
  // o menu do celular fecha com animação: espera o aviso ficar descoberto (até 5 s) antes de medir
  await expect.poll(async () => (await medir()).coveredBy, { message: `${nome}: título ou texto coberto`, timeout: 5_000 }).toBeNull();
  const r = await medir();
  expect(r.titleTop, `${nome}: título abaixo do cabeçalho`).toBeGreaterThanOrEqual(r.barBottom);
  expect(r.bodyTop, `${nome}: texto abaixo do cabeçalho`).toBeGreaterThanOrEqual(r.barBottom);
  expect(r.titleBottom, `${nome}: título dentro da janela`).toBeLessThanOrEqual(r.vh);
  if (CAPTURAS) {
    mkdirSync(CAPTURAS, { recursive: true });
    await page.screenshot({ path: join(CAPTURAS, `${nome}.png`) });
  }
  return r;
}

/** Rola até o fim da página atual e navega pelo menu: o foco vai ao conteúdo (a rolagem que escondia o título). */
async function navegarRolado(page: Page, secao: string) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  // no celular e com zoom (até 900 px) o menu abre pelo botão "Abrir menu"
  const abrir = page.getByRole('button', { name: 'Abrir menu' });
  if (await abrir.isVisible()) await abrir.click();
  await page.getByRole('navigation').first().getByRole('link', { name: secao, exact: true }).click();
  await leaveMenu(page);
}

test('aviso do bloqueio visível com o cabeçalho fixo: entrada, navegação rolada e "pular para o conteúdo"; desktop, celular e zoom 200%', async ({ page }) => {
  test.setTimeout(180_000);
  await page.route('**/api/v1/o/*/me', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, organizationHeldByNekkora: true } });
  });
  const acc = await control<RoleAccount>('accounts', { org: DEV_ORG, mfa: true, displayName: 'Marina Lopes', orgRoles: ['ORG_ADMIN'] });
  await signIn(page, { org: acc.org, userId: acc.userId, email: acc.email });
  await page.getByLabel(/Código de autenticação/).fill(await new Authenticator(acc.totpSecret).next());
  await expect(page.getByRole('heading', { level: 1, name: 'Olá, Marina Lopes' })).toBeVisible();
  await leaveMenu(page);

  const telas: [string, { width: number; height: number }][] = [
    ['desktop', { width: 1280, height: 720 }],
    ['celular', { width: 360, height: 780 }],
    ['zoom-200', { width: 640, height: 400 }],
  ];
  const medidas: Record<string, unknown> = {};
  for (const [nome, tamanho] of telas) {
    await page.setViewportSize(tamanho);
    await page.goto(`${BASE}/o/${acc.org}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Olá, Marina Lopes' })).toBeVisible();
    medidas[`${nome}-entrada`] = await avisoVisivel(page, `${nome}-entrada`);

    // navegação pelo menu a partir da página rolada (o caso da captura L002-13): o foco vai ao conteúdo
    await navegarRolado(page, 'Ambientes de trabalho');
    medidas[`${nome}-navegacao-rolada`] = await avisoVisivel(page, `${nome}-navegacao-rolada`);
    await navegarRolado(page, 'Início');
    medidas[`${nome}-volta-ao-inicio-rolada`] = await avisoVisivel(page, `${nome}-volta-ao-inicio-rolada`);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.keyboard.press('Home');
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.getByRole('link', { name: 'Pular para o conteúdo' }).focus();
    await page.keyboard.press('Enter');
    medidas[`${nome}-pular-para-o-conteudo`] = await avisoVisivel(page, `${nome}-pular-para-o-conteudo`);
  }
  console.log(JSON.stringify(medidas, null, 1));
});
