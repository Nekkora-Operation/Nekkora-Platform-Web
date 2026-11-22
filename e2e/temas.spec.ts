import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DEV_ORG } from '../mock/contract';
import { Authenticator } from '../mock/totp';
import { leaveMenu, signIn } from './support/app';

/**
 * PLATFORM-FLUXO-002 — temas selecionáveis, no navegador, contra a API SIMULADA. A pessoa escolhe o tema em Minha conta, pelo
 * teclado; o tema vale para a aplicação inteira na hora, continua depois de recarregar e depois de sair e entrar de novo
 * (preferência deste navegador). Em cada um dos três temas (Nekkora Light, o padrão; Nekkora Dark; Sakura Dark) audita com
 * axe, COM contraste: navegação, formulário, diálogo, aviso e estado de erro; em tela larga, estreita (360 px) e com zoom de
 * 200% (640 px úteis); e confere que o foco do teclado é visível. Com TEMAS_CAPTURAS=<pasta>, grava as capturas nela.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const CAPTURAS = process.env.TEMAS_CAPTURAS;
// cada volta é uma TROCA real (o padrão, Light, já vem marcado): Dark, depois Light de volta, depois Sakura Dark
const THEMES = [
  { id: 'dark', label: 'Nekkora Dark', slug: 'nekkora-dark' },
  { id: 'light', label: 'Nekkora Light', slug: 'nekkora-light' },
  { id: 'sakura-dark', label: 'Sakura Dark', slug: 'sakura-dark' },
] as const;

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

// um gerador por conta: entrar de novo nunca reaproveita o código já aceito (o simulador recusa o mesmo código na mesma
// janela de 30 s, como a API real); next() espera a janela seguinte quando precisa
const authenticators = new Map<string, Authenticator>();
async function enter(page: Page, acc: RoleAccount, name: string) {
  if (!authenticators.has(acc.userId)) authenticators.set(acc.userId, new Authenticator(acc.totpSecret));
  await signIn(page, { org: acc.org, userId: acc.userId, email: acc.email });
  await page.getByLabel(/Código de autenticação/).fill(await authenticators.get(acc.userId)!.next());
  await expect(page.getByRole('heading', { level: 1, name: `Olá, ${name}` })).toBeVisible();
  await leaveMenu(page);
}

async function audit(page: Page, name: string) {
  // as cores têm transição: o axe mede a cor computada depois dela
  await page.waitForTimeout(600);
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe injetado acima
    const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return r.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
  expect(violations, `axe em ${name}`).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `rolagem horizontal em ${name}`).toBeLessThanOrEqual(0);
  if (CAPTURAS) {
    mkdirSync(CAPTURAS, { recursive: true });
    await page.screenshot({ path: join(CAPTURAS, `${name}.png`), fullPage: true });
  }
}

/** O elemento com o foco tem contorno ou sombra visível (o tema não pode apagar o foco do teclado). */
async function focusVisible(page: Page, name: string) {
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'sem foco';
    // nos campos, a Nekkora-Lib desenha o foco no contorno do controle (.nk-control:focus-within), não no <input>
    const marks = (x: Element) => {
      const cs = getComputedStyle(x);
      return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== '' && cs.boxShadow !== 'none');
    };
    const control = el.closest('.nk-control');
    return marks(el) || (control !== null && marks(control)) ? 'visível' : `invisível em ${el.tagName.toLowerCase()}`;
  });
  expect(ring, `foco do teclado em ${name}`).toBe('visível');
}

const current = (page: Page) => page.evaluate(() => [document.documentElement.getAttribute('data-nk-theme'), localStorage.getItem('nekkora.platform.tema')]);

test('Temas: escolha pela conta com o teclado, aplicação inteira, persistência e acessibilidade nos três temas', async ({ page }) => {
  test.setTimeout(240_000);
  const acc = await control<RoleAccount>('accounts', { org: DEV_ORG, mfa: true, displayName: 'Lia Prado', orgRoles: ['ORG_ADMIN'] });
  // ---- tela de entrada: o ícone de tema, antes de entrar, pelo teclado; a escolha vale depois de entrar
  await page.goto('/entrar');
  const icon = page.getByRole('button', { name: /^Tema: Nekkora Light/ });
  await icon.focus();
  await focusVisible(page, 'ícone de tema na entrada');
  await page.keyboard.press('Enter');
  await expect.poll(() => current(page)).toEqual(['dark', 'dark']);
  await audit(page, 'entrada-nekkora-dark');
  await page.keyboard.press('Enter');
  await expect.poll(() => current(page)).toEqual(['sakura-dark', 'sakura-dark']);
  await audit(page, 'entrada-sakura-dark');
  await page.keyboard.press('Enter');
  await expect.poll(() => current(page)).toEqual(['light', 'light']);
  await audit(page, 'entrada-nekkora-light');
  await enter(page, acc, 'Lia Prado');

  // a escolha feita na entrada (de volta ao Light) continua depois de entrar
  expect(await current(page)).toEqual(['light', 'light']);

  for (const t of THEMES) {
    // ---- escolha em Minha conta, pelo teclado (as setas trocam a opção do grupo)
    await page.goto(`/o/${acc.org}/conta`);
    const group = page.getByRole('group', { name: 'Tema' });
    await expect(group).toBeVisible();
    const radio = group.getByRole('radio', { name: new RegExp(`^${t.label}`) });
    await group.getByRole('radio', { checked: true }).focus();
    // pelo teclado: a seta leva à próxima opção do grupo até a desejada, e a escolha vale ao chegar nela
    for (let i = 0; i < 3 && !(await radio.isChecked()); i++) await page.keyboard.press('ArrowDown');
    await expect(radio).toBeChecked();
    await expect.poll(() => current(page)).toEqual([t.id, t.id]);
    await focusVisible(page, `${t.slug}: opção de tema`);
    await audit(page, `${t.slug}-conta-desktop`);

    // ---- vale para a aplicação inteira: navegação e Início
    await page.goto(`/o/${acc.org}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Olá, Lia Prado' })).toBeVisible();
    expect((await current(page))[0], 'recarregar mantém o tema').toBe(t.id);
    await page.getByRole('link', { name: 'Ambientes de trabalho' }).first().focus();
    await focusVisible(page, `${t.slug}: menu`);
    await audit(page, `${t.slug}-inicio-desktop`);

    // ---- formulário num diálogo
    await page.goto(`/o/${acc.org}/workspaces`);
    await page.getByRole('button', { name: /^Criar (ambiente de trabalho|ambiente de trabalho)$/i }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^Nome/).focus();
    await focusVisible(page, `${t.slug}: campo do diálogo`);
    await audit(page, `${t.slug}-dialogo`);
    await page.keyboard.press('Escape');

    // ---- estado de erro com aviso e ação (o simulador não atende licenças: a tela mostra a falha de carregamento) e
    //      estado de "não encontrado" (automação inexistente)
    await page.goto(`/o/${acc.org}/administracao/licencas`);
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
    await page.getByRole('button', { name: 'Tentar novamente' }).focus();
    await focusVisible(page, `${t.slug}: botão do estado de erro`);
    await audit(page, `${t.slug}-erro-de-carregamento`);
    await page.goto(`/o/${acc.org}/automacoes/00000000-0000-4000-8000-000000000000`);
    await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
    await audit(page, `${t.slug}-nao-encontrado`);

    // ---- tela estreita e zoom de 200%
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`/o/${acc.org}/conta`);
    await expect(page.getByRole('group', { name: 'Tema' })).toBeVisible();
    await audit(page, `${t.slug}-conta-estreita`);
    await page.setViewportSize({ width: 640, height: 400 });
    await page.goto(`/o/${acc.org}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Olá, Lia Prado' })).toBeVisible();
    await audit(page, `${t.slug}-inicio-zoom-200`);
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  // ---- cabeçalho da área da organização: o mesmo ícone, pelo teclado; tela larga e estreita sem rolagem lateral
  await page.goto(`/o/${acc.org}`);
  const headerIcon = page.getByRole('button', { name: /^Tema: Sakura Dark\. Mudar para Nekkora Light/ });
  await headerIcon.focus();
  await focusVisible(page, 'ícone de tema no cabeçalho');
  await page.keyboard.press('Enter');
  await expect.poll(() => current(page)).toEqual(['light', 'light']);
  await audit(page, 'cabecalho-nekkora-light');
  await page.getByRole('button', { name: /^Tema: Nekkora Light\. Mudar para Nekkora Dark/ }).click();
  await page.getByRole('button', { name: /^Tema: Nekkora Dark\. Mudar para Sakura Dark/ }).click();
  await expect.poll(() => current(page)).toEqual(['sakura-dark', 'sakura-dark']);
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.getByRole('button', { name: /^Tema: Sakura Dark/ })).toBeVisible();
  await audit(page, 'cabecalho-sakura-dark-estreita');
  await page.setViewportSize({ width: 1280, height: 720 });

  // ---- sair e entrar de novo: a escolha continua (Sakura Dark, a última)
  await page.context().clearCookies();
  await enter(page, acc, 'Lia Prado');
  expect(await current(page)).toEqual(['sakura-dark', 'sakura-dark']);
});
