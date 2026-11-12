import { expect, test, type Page } from '@playwright/test';
import { responseViolations, type OperationId } from '../src/api/validate';
import { Authenticator } from '../mock/totp';
import { signIn } from './support/app';

/**
 * PLATFORM-AGENT-V2-004, T14 — alinhamento do par "nome do workspace + Retirar" em Workers, medido no navegador real
 * (Chromium), não no DOM isolado. A conta, a sessão, o MFA e as permissões vêm da API SIMULADA; só as listas de
 * workspaces e de Workers são fixtures (page.route), conferidas contra o contrato antes de servir. Defeito reproduzido:
 * a coluna do nome tinha sempre 28ch (minmax), então um nome curto ("Teste1") ficava na ponta direita de um espaço vazio
 * e o par saía do centro da célula. As medidas usam a extensão do TEXTO (Range), não a caixa da coluna.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const LONG = 'Contas a pagar e conciliação bancária das filiais do Nordeste e do Centro-Oeste';
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

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

function conforme(operationId: OperationId, body: unknown) {
  expect(responseViolations(operationId, { status: 200, contentType: 'application/json', body }), `fixture de ${operationId}`).toEqual([]);
  return body;
}

const ws = (n: number, name: string) => ({
  workspaceId: id(n),
  name,
  description: null,
  status: 'active',
  client: null,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
});
const WORKSPACES = [ws(11, 'Teste1'), ws(12, 'Financeiro'), ws(13, 'Compras'), ws(14, LONG)];
const T = '2026-11-12T12:00:00Z';
const WORKERS = [
  // a captura da usuária: um Worker com máquina vinculada e um único workspace curto
  {
    workerId: id(1), name: 'Teste', status: 'ACTIVE', agentId: id(50), workspaceIds: [id(11)], agentName: 'DESKTOP-01', agentStatus: 'ACTIVE',
    agentVersion: '0.1.0', installationId: id(60), lastHeartbeatAt: T, connectivity: 'CONNECTED', credentialExpiresAt: '2027-02-10T12:00:00Z', createdAt: T,
  },
  { workerId: id(2), name: 'Vários curtos', status: 'ACTIVE', agentId: null, workspaceIds: [id(12), id(13)] },
  { workerId: id(3), name: 'Nome longo', status: 'ACTIVE', agentId: null, workspaceIds: [id(14)] },
  { workerId: id(4), name: 'Mistura', status: 'ACTIVE', agentId: null, workspaceIds: [id(11), id(14), id(12)] },
];

async function open(page: Page, withRemoval: boolean) {
  const org = (await control<{ org: string }>('organizations', {})).org;
  const admin = await control<RoleAccount>('accounts', { org, mfa: true, orgRoles: ['ORG_ADMIN'], displayName: 'Admin T14' });
  await page.route(`**/api/v1/o/${org}/workspaces*`, (r) =>
    r.fulfill({ json: conforme('listWorkspaces', { items: WORKSPACES, nextCursor: null }) }),
  );
  await page.route(`**/api/v1/o/${org}/workers`, (r) =>
    r.request().method() === 'GET' ? r.fulfill({ json: conforme('listWorkers', { items: WORKERS }) }) : r.fallback(),
  );
  if (!withRemoval) {
    // perfil sem worker_workspace.authorize: a resposta real do mock, só sem essa permissão
    await page.route(`**/api/v1/o/${org}/me/permissions`, async (r) => {
      const body = await (await r.fetch()).json();
      body.organization.permissions = body.organization.permissions.filter((p: string) => p !== 'worker_workspace.authorize');
      await r.fulfill({ json: conforme('getMyPermissions', body) });
    });
  }
  const auth = new Authenticator(admin.totpSecret);
  await signIn(page, { org, userId: admin.userId, email: admin.email });
  await expect(page).toHaveURL(`/o/${org}/mfa`);
  await page.getByLabel(/Código de autenticação/).fill(await auth.next());
  await expect(page.getByRole('heading', { name: 'Olá, Admin T14' })).toBeVisible();
  await page.goto(`/o/${org}/workers`);
  await expect(page.getByRole('region', { name: 'Lista de Workers' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retirar autorização de Teste1 do Worker Teste' })).toBeVisible();
  // fontes carregadas: a largura do texto é a final
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

interface Pair {
  worker: string;
  name: string;
  textLeft: number;
  textRight: number;
  textMid: number;
  btnLeft: number;
  btnRight: number;
  btnMid: number;
  cellLeft: number;
  cellRight: number;
  label: string;
}

/** Extensão do texto do nome (Range: só onde há glifos), do botão e da célula/valor que contém o par. */
function measure(page: Page): Promise<Pair[]> {
  return page.$$eval('.pw-workers__ws-item', (items) =>
    items.map((li) => {
      const span = li.querySelector('.pw-workers__ws-name')!;
      const range = document.createRange();
      range.selectNodeContents(span);
      const rects = [...range.getClientRects()];
      const text = { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)), top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
      const btn = li.querySelector('button')!.getBoundingClientRect();
      const host = (li.closest('td') ?? li.closest('dd'))!;
      const cs = getComputedStyle(host);
      const box = host.getBoundingClientRect();
      const row = li.closest('tr') ?? li.closest('li.pw-rtable__card');
      const worker = (row?.querySelector('.pw-break, .pw-rtable__title')?.textContent ?? '').trim();
      return {
        worker,
        name: span.textContent ?? '',
        textLeft: text.left,
        textRight: text.right,
        textMid: (text.top + text.bottom) / 2,
        btnLeft: btn.left,
        btnRight: btn.right,
        btnMid: (btn.top + btn.bottom) / 2,
        cellLeft: box.left + parseFloat(cs.paddingLeft),
        cellRight: box.right - parseFloat(cs.paddingRight),
        label: li.querySelector('button')!.getAttribute('aria-label') ?? '',
      };
    }),
  );
}

async function check(page: Page, mode: 'table' | 'cards', shot: string) {
  const region = page.getByRole('region', { name: 'Lista de Workers' });
  if (mode === 'table') await expect(region.getByRole('table')).toBeVisible();
  else await expect(region.locator('.pw-rtable__cards')).toBeVisible();
  const pairs = await measure(page);
  expect(pairs.map((p) => `${p.worker}: ${p.name}`)).toEqual([
    'Teste: Teste1', 'Vários curtos: Financeiro', 'Vários curtos: Compras', `Nome longo: ${LONG}`, 'Mistura: Teste1', `Mistura: ${LONG}`, 'Mistura: Financeiro',
  ]);
  for (const p of pairs) {
    const tag = `${p.worker} / ${p.name.slice(0, 20)}`;
    // par horizontal: o botão à direita do texto, sem sobrepor, e perto dele (gap da grade + padding do botão)
    expect(p.btnLeft - p.textRight, `distância nome→Retirar (${tag})`).toBeGreaterThanOrEqual(0);
    expect(p.btnLeft - p.textRight, `distância nome→Retirar (${tag})`).toBeLessThanOrEqual(mode === 'table' ? 40 : 40);
    // alinhamento vertical central: meio do texto (inclusive de várias linhas) = meio do botão
    expect(Math.abs(p.textMid - p.btnMid), `centro vertical (${tag})`).toBeLessThanOrEqual(1.5);
    // dentro da célula/valor, sem sair dela
    expect(p.textLeft, `cabe na célula (${tag})`).toBeGreaterThanOrEqual(p.cellLeft - 0.5);
    expect(p.btnRight, `cabe na célula (${tag})`).toBeLessThanOrEqual(p.cellRight + 0.5);
    // nome acessível identifica o workspace e o Worker do item
    expect(p.label).toBe(`Retirar autorização de ${p.name} do Worker ${p.worker}`);
  }
  if (mode === 'table') {
    // o grupo fica centralizado na célula: com um workspace, o par inteiro (texto + botão)
    const single = pairs.filter((p) => p.worker === 'Teste' || p.worker === 'Nome longo');
    for (const p of single) {
      const groupMid = (p.textLeft + p.btnRight) / 2;
      const cellMid = (p.cellLeft + p.cellRight) / 2;
      expect(Math.abs(groupMid - cellMid), `grupo centralizado (${p.worker})`).toBeLessThanOrEqual(3);
    }
    // vários workspaces: botões alinhados entre si e cada nome encostado no próprio botão
    for (const w of ['Vários curtos', 'Mistura']) {
      const ps = pairs.filter((p) => p.worker === w);
      for (const p of ps) expect(Math.abs(p.btnLeft - ps[0].btnLeft), `botões alinhados (${w})`).toBeLessThanOrEqual(0.5);
    }
  } else {
    // cartões: sem rolagem horizontal
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'rolagem horizontal nos cartões').toBeLessThanOrEqual(0);
  }
  await page.screenshot({ path: test.info().outputPath(`${shot}.png`), fullPage: true });
}

async function keyboardOpensRightDialog(page: Page) {
  const target = page.getByRole('button', { name: `Retirar autorização de ${LONG} do Worker Mistura` });
  // chega por Tab a partir do item anterior da mesma lista (ordem de leitura), sem clique
  await page.getByRole('button', { name: 'Retirar autorização de Teste1 do Worker Mistura' }).focus();
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(`Retirar Mistura de ${LONG}?`);
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toHaveCount(0);
}

for (const withRemoval of [true, false]) {
  const profile = withRemoval ? 'com permissão de retirada' : 'sem permissão de retirada';
  test.describe(`T14 Workers: nome do workspace + Retirar (${profile})`, () => {
    test('tabela no desktop (1280 px)', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await open(page, withRemoval);
      await check(page, 'table', `t14-desktop-${withRemoval ? 'com' : 'sem'}`);
      await keyboardOpensRightDialog(page);
    });

    test('cartões em janela estreita (600 px)', async ({ page }) => {
      await page.setViewportSize({ width: 600, height: 900 });
      await open(page, withRemoval);
      await check(page, 'cards', `t14-estreita-${withRemoval ? 'com' : 'sem'}`);
      await keyboardOpensRightDialog(page);
    });
  });
}

test.describe('T14 Workers: zoom de 200%', () => {
  // 200% numa janela de 1280 px: 640 px CSS com 2 px físicos por px CSS (o mesmo que o navegador faz no zoom)
  test.use({ viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 });
  test('cartões, sem sobreposição nem rolagem horizontal', async ({ page }) => {
    await open(page, true);
    await check(page, 'cards', 't14-zoom200');
    await keyboardOpensRightDialog(page);
  });
});
