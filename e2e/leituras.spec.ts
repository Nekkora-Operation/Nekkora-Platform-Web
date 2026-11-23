import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DEV_ORG } from '../mock/contract';
import { Authenticator } from '../mock/totp';
import { leaveMenu, signIn } from './support/app';

/**
 * A1 (LICENCIAMENTO-002): quantas leituras a Web faz por navegação, no build de produção contra a API simulada. Mede a
 * entrada, cada seção pelo menu (clique, sem recarregar), a volta ao Início e a troca de organização; grava a contagem
 * por rota (LEITURAS_SAIDA=<arquivo>) e confere que nenhuma navegação repete a mesma leitura.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const SAIDA = process.env.LEITURAS_SAIDA;

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

/** Rota sem identificadores: /api/v1/o/<org>/workspaces/<id> -> /api/v1/o/{org}/workspaces/{id}. */
function rota(url: string): string {
  const u = new URL(url);
  return `${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')}${u.search ? '?…' : ''}`;
}

function gravador(page: Page) {
  let atual: string[] = [];
  let exatas: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/portal/')) {
      atual.push(`${r.method()} ${rota(r.url())}`);
      exatas.push(`${r.method()} ${u.pathname}${u.search}`);
    }
  });
  return {
    async passo(nome: string, acao: () => Promise<void>) {
      atual = [];
      exatas = [];
      await acao();
      // a tela termina de carregar: nenhuma leitura nova por 1,5 s
      let n = -1;
      while (n !== atual.length) {
        n = atual.length;
        await page.waitForTimeout(1_500);
      }
      return { nome, chamadas: [...atual], exatas: [...exatas] };
    },
  };
}

function contagem(chamadas: string[]) {
  const m = new Map<string, number>();
  for (const c of chamadas) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
}

test('leituras por navegação (build de produção, API simulada)', async ({ page }) => {
  test.setTimeout(180_000);
  const acc = await control<RoleAccount>('accounts', { org: DEV_ORG, mfa: true, displayName: 'Marina Lopes', orgRoles: ['ORG_ADMIN'] });
  const g = gravador(page);
  const passos = [];

  passos.push(
    await g.passo('entrada (login + MFA + Início)', async () => {
      await signIn(page, { org: acc.org, userId: acc.userId, email: acc.email });
      await page.getByLabel(/Código de autenticação/).fill(await new Authenticator(acc.totpSecret).next());
      await expect(page.getByRole('heading', { level: 1, name: 'Olá, Marina Lopes' })).toBeVisible();
      await leaveMenu(page);
    }),
  );

  const nav = page.getByRole('navigation').first();
  for (const secao of ['Ambientes de trabalho', 'Execuções', 'Máquinas', 'Minha conta', 'Pessoas e acessos', 'Licenças e automações', 'Pedidos de organização', 'Início']) {
    passos.push(
      await g.passo(`menu: ${secao}`, async () => {
        await nav.getByRole('link', { name: secao, exact: true }).click();
        await leaveMenu(page);
      }),
    );
  }

  // ambiente -> automação -> versão (onde ficam "Publicar" e a execução remota)
  const main = page.getByRole('main');
  passos.push(await g.passo('menu: Ambientes de trabalho (de novo)', async () => {
    await nav.getByRole('link', { name: 'Ambientes de trabalho', exact: true }).click();
    await leaveMenu(page);
  }));
  passos.push(await g.passo('abrir um ambiente', async () => {
    await main.locator('a[href*="/workspaces/"]').first().click();
  }));
  passos.push(await g.passo('abrir uma automação', async () => {
    await main.locator('a[href*="/automacoes/"]').first().click();
  }));
  passos.push(await g.passo('abrir uma versão', async () => {
    await main.locator('a[href*="/versoes/"]').first().click();
  }));

  passos.push(
    await g.passo('recarregar o Início (F5)', async () => {
      await page.goto(`${BASE}/o/${acc.org}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Olá, Marina Lopes' })).toBeVisible();
    }),
  );

  const linhas: string[] = [];
  let total = 0;
  const repetidas: string[] = [];
  for (const p of passos) {
    total += p.chamadas.length;
    linhas.push(`## ${p.nome}: ${p.chamadas.length} chamadas`);
    for (const [c, n] of contagem(p.chamadas)) linhas.push(`  ${n} × ${c}`);
    // repetida = o MESMO endereço (caminho e consulta) lido mais de uma vez na mesma navegação
    for (const [c, n] of contagem(p.exatas)) if (n > 1 && c.startsWith('GET ')) repetidas.push(`${p.nome}: ${n} × ${rota(`http://x${c.slice(4)}`)}`);
  }
  linhas.push(`TOTAL: ${total} chamadas em ${passos.length} passos`);
  const texto = linhas.join('\n');
  console.log(texto);
  if (SAIDA) writeFileSync(SAIDA, `${texto}\n`);
  writeFileSync(test.info().outputPath('leituras.txt'), `${texto}\n`);
  expect.soft(repetidas, 'a mesma leitura repetida numa só navegação').toEqual([]);
});
