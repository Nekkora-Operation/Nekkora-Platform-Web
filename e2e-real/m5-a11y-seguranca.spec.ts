import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page, type Response } from '@playwright/test';
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
  // FRONT-V1-004: cada tela só é auditada CARREGADA — o título dela, nenhum "Carregando…" e nenhum aviso de erro ou de
  // limite na área principal — e sem NENHUMA resposta 429 da API durante a visita (do carregamento ao fim do axe). Uma
  // visita com 429 não conta como aprovada: espera o Retry-After e repete a visita UMA vez; se repetir, o teste falha.
  const pages: [string, string, string | RegExp][] = [
    ['organizações', '/organizacoes', 'Suas organizações'],
    ['início da organização', `/o/${org}`, /^Olá, /],
    ['workspace', workspaceUrl.replace(/^https?:\/\/[^/]+/, ''), 'Operações'],
    ['versão', versionUrl.replace(/^https?:\/\/[^/]+/, ''), /Biografias da Wikipédia — versão 1/],
    ['agents', `/o/${org}/agents`, 'Agents'],
    ['workers', `/o/${org}/workers`, 'Workers'],
    ['supervisão', `/o/${org}/supervisao`, 'Supervisão'],
    ['convites', `/o/${org}/administracao/convites`, 'Convites'],
    ['concessões', `/o/${org}/administracao/concessoes`, 'Concessões'],
    ['conta', '/conta', 'Segurança da conta'],
  ];
  const report = (line: string) => appendFileSync(`tools/lab/saidas/${LAB}/a11y-telas.txt`, `${new Date().toISOString()} ${line}\n`);
  const NOT_LOADED = /Carregando|Muitas tentativas|Não foi possível (carregar|consultar)|indisponíve(l|is)|Tente de novo em/i;
  const approved: string[] = [];
  for (const [viewport, size] of [
    ['desktop', { width: 1280, height: 800 }],
    ['zoom 200% (1280 px a 200%)', { width: 640, height: 400 }],
    ['celular', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    for (const [label, path, heading] of pages) {
      const name = `${label} — ${viewport}`;
      let done = false;
      for (let visit = 1; visit <= 2 && !done; visit++) {
        const limited: number[] = [];
        const on429 = (r: Response) => {
          if (r.status() === 429 && new URL(r.url()).pathname.startsWith('/api/')) limited.push(Number(r.headers()['retry-after'] ?? '10'));
        };
        page.on('response', on429);
        try {
          // ritmo: a varredura inteira são ~30 telas seguidas, e o limitador de leituras da API responde 429
          await page.waitForTimeout(1_500);
          await page.goto(path);
          const titled = await page
            .getByRole('heading', { level: 1, name: heading })
            .waitFor({ state: 'visible', timeout: 15_000 })
            .then(
              () => true,
              () => false,
            );
          await page.waitForLoadState('networkidle');
          const shown = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ');
          const notLoaded = titled ? NOT_LOADED.exec(shown)?.[0] : `sem o título esperado (${shown.slice(0, 80)})`;
          if (!limited.length && !notLoaded) {
            await audit(page, name);
            if (!limited.length) {
              approved.push(name);
              report(`APROVADA ${name} (visita ${visit}, sem 429)`);
              done = true;
              continue;
            }
          }
          report(`NÃO CONTA ${name} (visita ${visit}): ${limited.length} resposta(s) 429${notLoaded ? `; tela mostrava "${notLoaded}"` : ''}`);
          if (visit === 1) await page.waitForTimeout((Math.max(10, ...limited) + 1) * 1000);
        } finally {
          page.off('response', on429);
        }
      }
      expect(done, `${name}: não foi possível auditar a tela carregada e sem 429`).toBe(true);
    }
  }
  expect(approved).toHaveLength(pages.length * 3);
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
