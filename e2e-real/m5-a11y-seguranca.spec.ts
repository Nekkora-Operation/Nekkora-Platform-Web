import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { confirmStepUp, LAB, signUpAndEnroll } from './support/lab';

/**
 * J17 (teclado, foco, zoom 200%, viewports, recarga, links diretos, navegação) e J18 (nenhum segredo em armazenamento,
 * console, analytics, URLs ou cookies legíveis) contra a API REAL, com dados reais da própria jornada (FRONT-V1-002).
 * Pré-condição declarada: limites da organização (010) por fixture. Sem captura de tela aqui (as telas de MFA têm QR,
 * chave e códigos); o axe roda com contraste, na lib 0.2.0 fixada.
 */
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const PKG = `tools/lab/saidas/${LAB}/pacotes/pacote-studio-real.zip`;

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
}

test('J17/J18: telas reais com teclado, zoom 200%, viewports, recarga, links diretos; nenhum segredo exposto', async ({ page, browser }) => {
  test.setTimeout(900_000);
  const consoleText: string[] = [];
  const urls: string[] = [];
  page.on('console', (m) => consoleText.push(m.text()));
  page.on('request', (r) => urls.push(r.url()));

  const ana = await signUpAndEnroll(page, 'j17');
  const name = `Ensaio J17 ${Date.now().toString(36)}`;
  await page.goto('/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, ana, 'Criar organização');
  await page.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  const org = /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];
  execFileSync('node', ['tools/lab/lab.mjs', LAB, 'limites', org, ana.email]);

  await page.goto(`/o/${org}/workspaces`);
  await page.getByRole('button', { name: 'Criar workspace' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome/).fill('Operações');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Operações' })).toBeVisible();
  const workspaceUrl = page.url();
  await page.getByRole('button', { name: 'Criar automação' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome da automação/).fill('Biografias da Wikipédia');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar automação' }).click();
  await page.getByRole('button', { name: 'Nova versão' }).click();
  await expect(page).toHaveURL(/\/versoes\/[0-9a-f-]{36}$/);
  const versionUrl = page.url();
  await page.getByLabel('Arquivo .zip do pacote').setInputFiles(PKG);
  await page.getByRole('button', { name: 'Enviar pacote' }).click();
  await expect(page.getByText('Pacote recebido e conferido pela Platform.')).toBeVisible();

  // código de pareamento: aparece só na tela (J18 confere que não vaza)
  await page.goto(`/o/${org}/agents`);
  await page.getByRole('button', { name: 'Parear novo Agent' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill('LAB-J17');
  await page.getByRole('alertdialog').getByLabel(/^Nome do Worker/).fill('Worker J17');
  await confirmStepUp(page, ana, 'Gerar código');
  const pairing = (await page.getByLabel('Código de uso único').innerText()).trim();
  await page.getByRole('button', { name: 'Concluir' }).click();

  // ---------------- J17: teclado e foco — o primeiro Tab é o atalho para o conteúdo, e ele leva o foco ao conteúdo
  await page.goto(`/o/${org}/workspaces`);
  await expect(page.getByRole('heading', { name: 'Workspaces', level: 1 })).toBeVisible();
  // a navegação leva o foco ao conteúdo; o teste parte do começo do documento, como quem chega pelo teclado
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveText(/Pular para o conteúdo/);
  await page.keyboard.press('Enter');
  await expect(page.locator(':focus')).toHaveAttribute('id', /conteudo/);
  // foco visível no próximo controle alcançado por teclado
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return 'none';
    const s = getComputedStyle(el);
    return `${s.outlineStyle} ${s.outlineWidth} ${s.boxShadow}`;
  });
  expect(outline).not.toMatch(/^none 0px none$/);

  // ---------------- J17: axe (com contraste) e sem rolagem horizontal, em três larguras e com zoom 200%
  const pages = [
    ['organizações', '/organizacoes'],
    ['início da organização', `/o/${org}`],
    ['workspace', workspaceUrl.replace(/^https?:\/\/[^/]+/, '')],
    ['versão', versionUrl.replace(/^https?:\/\/[^/]+/, '')],
    ['agents', `/o/${org}/agents`],
    ['workers', `/o/${org}/workers`],
    ['supervisão', `/o/${org}/supervisao`],
    ['convites', `/o/${org}/administracao/convites`],
    ['concessões', `/o/${org}/administracao/concessoes`],
    ['conta', '/conta'],
  ] as const;
  for (const [viewport, size] of [
    ['desktop', { width: 1280, height: 800 }],
    ['zoom 200% (1280 px a 200%)', { width: 640, height: 400 }],
    ['celular', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    for (const [label, path] of pages) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first(), `título h1 em ${label} — ${viewport}`).toBeVisible();
      await page.waitForLoadState('networkidle');
      await audit(page, `${label} — ${viewport}`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---------------- J17: recarga, link direto em aba nova (mesmo navegador) e voltar/avançar
  // a varredura acima faz ~30 leituras seguidas e encosta no limitador de leituras da API (429 com Retry-After, mostrado
  // na tela como "Muitas tentativas"): espera a janela passar antes das provas de recarga
  await page.waitForTimeout(10_000);
  await page.goto(versionUrl);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Biografias da Wikipédia — versão 1/ })).toBeVisible();
  const tab = await page.context().newPage();
  await tab.goto(versionUrl);
  await expect(tab.getByRole('heading', { name: /Biografias da Wikipédia — versão 1/ })).toBeVisible();
  await tab.close();
  await page.goto(`/o/${org}/agents`);
  await page.goBack();
  await expect(page).toHaveURL(versionUrl);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/o/${org}/agents$`));
  // link direto sem sessão (outro contexto): entrada, sem conteúdo da organização
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(versionUrl);
  await expect(anon.getByText('Biografias da Wikipédia')).toHaveCount(0);
  await expect(anon.getByRole('heading', { level: 1 })).toBeVisible();

  // ---------------- J18: nada sensível em armazenamento, cookies legíveis, console, URLs ou terceiros
  const storage = await page.evaluate(async () => ({
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    cookie: document.cookie,
    idb: 'databases' in indexedDB ? (await indexedDB.databases()).map((d) => d.name).join(',') : '',
  }));
  const secrets = [ana.password, pairing, ...ana.recoveryCodes, 'otpauth://', 'nkp1.', '__Host-'];
  for (const s of secrets) {
    for (const [where, text] of [
      ['localStorage', storage.local],
      ['sessionStorage', storage.session],
      ['document.cookie', storage.cookie],
      ['console', consoleText.join('\n')],
      ['URLs', urls.join('\n')],
    ] as const) {
      expect(text.includes(s), `${where} contém dado sensível`).toBe(false);
    }
  }
  expect(storage.cookie).toBe('');
  expect(storage.session).toBe('{}');
  expect(storage.idb).toBe('');
  // localStorage: só o registro de operações (chave-resumo e estado; nada em claro)
  for (const [k, v] of Object.entries(JSON.parse(storage.local) as Record<string, string>)) {
    expect(k).toMatch(/^nk\.op\.1\.[0-9a-f]{32}$/);
    expect(Object.keys(JSON.parse(v)).sort()).toEqual(['at', 'exp', 's', 'v']);
  }
  expect(urls.filter((u) => !u.startsWith('http://localhost:5173/') && !u.startsWith('data:') && !u.startsWith('blob:'))).toEqual([]);
  expect(urls.filter((u) => /[?&#](token|code|password|senha)=/i.test(u))).toEqual([]);
});
