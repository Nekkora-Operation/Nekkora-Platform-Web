import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DEV_ORG } from '../mock/contract';
import { Authenticator } from '../mock/totp';
import { leaveMenu, signIn } from './support/app';

/**
 * PLATFORM-INICIO-001 no navegador, contra a API SIMULADA (organização e dados fictícios, determinísticos): o Início como
 * painel. Confere a ordem das áreas, que os números fecham, o período, os cards e a navegação; audita acessibilidade
 * (axe, com contraste) e rolagem horizontal nos temas escuro e claro, em tela larga, estreita e com zoom de 200%.
 *
 * O produto abre no tema claro (PLATFORM-FLUXO-002; a troca de tema pela conta tem o seu próprio roteiro, temas.spec.ts):
 * aqui o escuro é aplicado pelo atributo do documento, só para validar a tela nos dois. Com INICIO_CAPTURAS=<pasta>, as capturas também são gravadas nessa pasta.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const CAPTURAS = process.env.INICIO_CAPTURAS;

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

async function enter(page: Page, body: Record<string, unknown>, name: string) {
  const acc = await control<RoleAccount>('accounts', { org: DEV_ORG, mfa: true, displayName: name, ...body });
  await signIn(page, { org: acc.org, userId: acc.userId, email: acc.email });
  await page.getByLabel(/Código de autenticação/).fill(await new Authenticator(acc.totpSecret).next());
  await expect(page.getByRole('heading', { level: 1, name: `Olá, ${name}` })).toBeVisible();
  await leaveMenu(page);
}

async function audit(page: Page, name: string) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe injetado acima
    const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return r.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
  expect(violations, `axe em ${name}`).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `rolagem horizontal em ${name}`).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  if (CAPTURAS) {
    mkdirSync(CAPTURAS, { recursive: true });
    await page.screenshot({ path: join(CAPTURAS, `${name}.png`), fullPage: true });
  }
}

/** Troca o tema pelo atributo do documento e espera as transições de cor terminarem (o axe mede a cor computada). */
async function theme(page: Page, name: 'light' | 'dark') {
  await page.evaluate((n) => document.documentElement.setAttribute('data-nk-theme', n), name);
  await page.waitForTimeout(800);
}

const metric = async (page: Page, label: string) =>
  Number((await page.getByRole('heading', { level: 3, name: label }).locator('xpath=..').locator('.pw-dash__metric-value').innerText()).replace(/\./g, ''));

const ready = async (page: Page) => {
  await expect(page.getByRole('heading', { level: 3, name: 'Total de execuções' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Automações' })).toBeVisible();
};

test('Início: áreas na ordem, números que fecham, período, cards e navegação; axe nos dois temas, tela estreita e zoom', async ({ page }) => {
  await enter(page, { orgRoles: ['ORG_ADMIN'] }, 'Marina Lopes');
  await ready(page);

  // ordem das áreas
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(['Execuções no período', 'Próximas execuções', 'Automações', 'Seu acesso']);
  // período: últimos 30 dias por padrão, com o intervalo consultado e o fuso à vista
  await expect(page.getByLabel('Período', { exact: true })).toHaveValue('30d');
  const section = page.getByRole('region', { name: 'Execuções no período' });
  await expect(section.locator('time')).toHaveCount(2);
  await expect(section).toContainText(/horários em UTC[+−-]\d{2}:\d{2}/);

  // os números fecham: total = sucessos + erros + as outras situações mostradas
  const total = await metric(page, 'Total de execuções');
  const succeeded = await metric(page, 'Sucessos');
  const failed = await metric(page, 'Erros');
  expect(total).toBeGreaterThan(0);
  const others = page.locator('.pw-dash__others');
  let rest = 0;
  if (await others.count()) {
    const text = await others.innerText();
    expect(text).toContain('não contam como erro');
    for (const m of text.matchAll(/([\d.]+) (?:em andamento|cancelada|canceladas|não iniciada|não iniciadas|com resultado não confirmado)/g)) rest += Number(m[1].replace(/\./g, ''));
  }
  expect(succeeded + failed + rest, 'sucessos + erros + demais situações = total').toBe(total);

  // próximas execuções: a funcionalidade ainda não existe
  await expect(page.getByRole('region', { name: 'Próximas execuções' })).toContainText('Agendamentos ainda não estão disponíveis');

  // cards: nome, workspace, última execução e a ação principal; nenhuma ação de execução
  const cards = page.getByRole('list', { name: 'Automações' }).getByRole('listitem');
  expect(await cards.count()).toBeGreaterThan(0);
  const first = cards.first();
  await expect(first.getByRole('heading', { level: 3 })).toBeVisible();
  await expect(first).toContainText(/Ambiente de trabalho /);
  await expect(first).toContainText('Última execução');
  await expect(first.getByRole('button', { name: /^Ver automação / })).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: /executar|solicitar/i })).toHaveCount(0);

  await audit(page, 'inicio-claro-desktop');
  await theme(page, 'dark');
  await audit(page, 'inicio-escuro-desktop');

  // tela estreita (celular) e zoom de 200% numa janela de 1280 px (640 px úteis): nada cortado, sem rolagem horizontal
  await page.setViewportSize({ width: 360, height: 780 });
  await ready(page);
  await audit(page, 'inicio-escuro-estreita');
  await theme(page, 'light');
  await audit(page, 'inicio-claro-estreita');
  await page.setViewportSize({ width: 640, height: 400 });
  await ready(page);
  await audit(page, 'inicio-claro-zoom-200');
  await page.setViewportSize({ width: 1280, height: 720 });

  // mudar o período consulta de novo (o intervalo mostrado acompanha)
  const before = await section.locator('time').first().getAttribute('datetime');
  const answered = page.waitForResponse((r) => r.url().includes('/execution-summary') && r.status() === 200);
  await page.getByLabel('Período', { exact: true }).selectOption('7d');
  await answered;
  await expect(section.locator('time').first()).not.toHaveAttribute('datetime', before!);
  await expect(page.getByRole('heading', { level: 3, name: 'Total de execuções' })).toBeVisible();
  expect(await metric(page, 'Total de execuções')).toBeLessThanOrEqual(total);

  // a ação principal do card leva ao detalhe da automação
  const name = (await first.getByRole('heading', { level: 3 }).innerText()).trim();
  await first.getByRole('button', { name: `Ver automação ${name}` }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
});

test('Início por permissão: quem lê um só ambiente de trabalho vê só as automações dele; sem ambiente de trabalho, o aviso (sem métricas zeradas)', async ({ page }) => {
  await enter(page, { workspaceRoles: [['atendimento', ['VIEWER']]] }, 'Leitora Atendimento');
  await ready(page);
  const cards = page.getByRole('list', { name: 'Automações' }).getByRole('listitem');
  for (const text of await cards.allInnerTexts()) expect(text).toContain('Ambiente de trabalho Atendimento');
  await audit(page, 'inicio-leitora-de-um-workspace');
});

test('Início sem acesso a workspace: aviso próprio', async ({ page }) => {
  await enter(page, {}, 'Pessoa Sem Ambiente de trabalho');
  await expect(page.getByText('Você ainda não tem acesso a nenhum ambiente de trabalho')).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'Total de execuções' })).toHaveCount(0);
  await audit(page, 'inicio-sem-workspace');
});

test('rodapé do menu: versão do produto e direitos, sem dados técnicos (expandido e no trilho recolhido)', async ({ page }) => {
  await enter(page, { orgRoles: ['ORG_ADMIN'] }, 'Marina Lopes');
  await page.setViewportSize({ width: 1280, height: 1000 }); // o menu inteiro, com o rodapé, cabe na altura
  const menu = page.getByRole('complementary', { name: 'Menu' });
  await menu.hover();
  await page.waitForTimeout(600); // a expansão do menu é animada
  const footer = menu.locator('.nk-shell__sidebar-footer');
  await expect(footer).toBeInViewport();
  await expect(footer).toHaveText(new RegExp(`^Versão\\s*Nekkora Platform \\d+(\\.\\d+)*\\s*© ${new Date().getFullYear()} Nekkora\\. Todos os direitos reservados\\.$`));
  await expect(footer).not.toContainText(/Web |API |branch|candidata|alterações locais|Organização|Marina/);
  if (CAPTURAS) {
    mkdirSync(CAPTURAS, { recursive: true });
    await page.screenshot({ path: join(CAPTURAS, 'menu-expandido-rodape.png') });
  }
  await leaveMenu(page);
  await expect(menu.locator('.nk-shell__sidebar-compact')).toHaveText(new RegExp(`^v\\d+(\\.\\d+)*\\s*© ${new Date().getFullYear()}$`));
});
