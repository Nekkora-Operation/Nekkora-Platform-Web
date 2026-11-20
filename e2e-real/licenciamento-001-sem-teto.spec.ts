import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { confirmStepUp, LAB, signUpAndEnroll, type Person } from './support/lab';

/**
 * PLATFORM-LICENCIAMENTO-001 — CRIAÇÃO DE ORGANIZAÇÕES SEM O TETO FIXO DE DEZ, pela Web de produção, contra a API real do
 * laboratório descartável. Três regras diferentes, cada uma vista na tela com a sua mensagem:
 *
 *   1. NÃO há teto fixo de organizações criadas: com dez organizações, a 11ª e a 12ª nascem pela tela;
 *   2. limite de FREQUÊNCIA (até três criações por dia por pessoa): a tentativa seguinte é recusada, e a tela diz QUANDO será
 *      possível tentar de novo e que isso não é o limite de vazias;
 *   3. limite de três organizações VAZIAS: com três vazias, a tela não oferece a criação e diz por quê.
 *
 * Nenhum limite é zerado. PREPARO ADMINISTRATIVO por SQL, dito na evidência: como a rota só deixa criar três por dia, as
 * organizações 2 a 10 nascem pela função do banco (a mesma que a rota chama, com a sessão e a confirmação reforçada da pessoa),
 * e cada organização de preparo ganha uma automação para não ser vazia. A terceira vazia também nasce pela função.
 *
 *   FRONT_LAB_ID=<lab> FRONT_PORTA=<porta> npx playwright test -c playwright.real.config.ts licenciamento-001-sem-teto
 */
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-licenciamento-001-sem-teto`);
const TAG = Date.now().toString(36);

const sql = (q: string) => (compose(LAB, ['exec', '-T', 'postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'nekkora', '-d', 'nekkora', '-c', q]) as string).trim();
const log = (k: string, v: unknown) => {
  mkdirSync(EVID, { recursive: true });
  const line = `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
  appendFileSync(join(EVID, 'roteiro.txt'), `${line}\n`);
  console.log(line);
};
const shot = async (page: Page, name: string) => {
  mkdirSync(EVID, { recursive: true });
  await page.screenshot({ path: join(EVID, `${name}.png`), fullPage: true });
};

let retried = 0;
async function settle(page: Page) {
  for (let i = 0; i < 4; i++) {
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const retry = page.getByRole('button', { name: 'Tentar novamente' });
    if ((await retry.count()) === 0) return;
    retried++;
    await page.waitForTimeout(20_000);
    await retry.first().click().catch(() => undefined);
    await page.waitForTimeout(1_500);
  }
}
async function go(page: Page, url: string) {
  await page.waitForTimeout(4_000);
  await page.goto(url);
  await settle(page);
}
/** Preenche a criação e confirma. Não espera o resultado: quem chama confere. */
async function pedirCriacao(page: Page, person: Person, name: string) {
  await go(page, '/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, person, 'Criar organização');
  await settle(page);
}
async function criarPelaTela(page: Page, person: Person, name: string) {
  await pedirCriacao(page, person, name);
  await expect(page).toHaveURL(/\/organizacoes$/);
  await expect(page.getByRole('button', { name: `Entrar em ${name}` })).toBeVisible();
}

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('PLATFORM-LICENCIAMENTO-001: criação sem o teto de dez; limite de frequência e limite de vazias, cada um com a sua mensagem', async ({ browser }) => {
  test.setTimeout(1_500_000);
  rmSync(EVID, { recursive: true, force: true });
  log('laboratorio', readFileSync(resolve(`tools/lab/saidas/${LAB}/laboratorio.txt`), 'utf8').replace(/\n/g, ' | '));
  log('limites_no_laboratorio', sql("SELECT 'limite de vazias=' || empty_organizations_limit FROM organization_creation_settings"));
  const page = await (await browser.newContext()).newPage();
  const carla = await signUpAndEnroll(page, 'lic-teto');
  const identity = sql(`SELECT identity_id FROM identities WHERE email = '${carla.email}'`);
  const criadas = () => sql(`SELECT count(*) FROM identity_users WHERE identity_id = '${identity}' AND link_channel = 'cadastro_web'`);
  const vazias = () => sql(`SELECT cardinality(public.identity_empty_organizations('${identity}'))`);
  const tornarNaoVazia = (org: string) =>
    sql(`WITH w AS (INSERT INTO ambientes de trabalho (workspace_id, organization_id, client_id, name, status) VALUES (gen_random_uuid(), '${org}', NULL, 'Fiscal', 1) RETURNING workspace_id)
         INSERT INTO automations (automation_id, organization_id, workspace_id, name, description, status, created_by_membership_id)
         SELECT gen_random_uuid(), '${org}', w.workspace_id, 'Notas', NULL, 1, (SELECT membership_id FROM organization_memberships WHERE organization_id = '${org}' LIMIT 1) FROM w`);

  // ================================================================ 1. a primeira organização, pela tela (1ª criação do dia)
  await criarPelaTela(page, carla, `Primeira ${TAG}`);
  const primeira = sql(`SELECT o.organization_id FROM organizations o JOIN organization_responsibility r ON r.organization_id = o.organization_id WHERE r.responsible_identity_id = '${identity}' AND o.name = 'Primeira ${TAG}'`);
  tornarNaoVazia(primeira);
  log('1_primeira', { pela_tela: true, criadas: criadas() });

  // ================================================================ 2. PREPARO por SQL: as organizações 2 a 10, nenhuma vazia
  const token = (await page.context().cookies()).find((c) => c.name === '__Host-nekkora_id')?.value ?? '';
  expect(token, 'sessão de identidade da pessoa').not.toBe('');
  for (let i = 2; i <= 10; i++) {
    const org = sql(`SELECT public.identity_create_organization('${token}', 'Previa ${i} ${TAG}', NULL)`);
    expect(org, `organização de preparo ${i}: a função do banco criou`).toMatch(/^[0-9a-f-]{36}$/);
    tornarNaoVazia(org);
  }
  expect(criadas()).toBe('10');
  expect(vazias()).toBe('0');
  log('2_preparo', { procedimento: 'funcao do banco identity_create_organization com a sessao da pessoa; uma automacao em cada', criadas: criadas(), vazias: vazias() });

  // ================================================================ 3. SEM TETO: com dez criadas, a 11ª e a 12ª nascem PELA TELA
  await go(page, '/organizacoes');
  await expect(page.getByRole('button', { name: /^Entrar em Previa 10 / })).toBeVisible();
  await shot(page, '3-dez-organizacoes');
  await criarPelaTela(page, carla, `Onze ${TAG}`);
  expect(criadas()).toBe('11');
  await criarPelaTela(page, carla, `Doze ${TAG}`);
  expect(criadas()).toBe('12');
  await shot(page, '3-doze-organizacoes');
  log('3_sem_teto', { pela_tela: true, decima_primeira: 'criada', decima_segunda: 'criada', criadas: criadas(), vazias: vazias() });

  // ================================================================ 4. LIMITE DE FREQUÊNCIA: a quarta criação do dia é recusada, com QUANDO tentar de novo
  expect(vazias(), 'duas vazias: o limite de vazias ainda NÃO foi atingido').toBe('2');
  await pedirCriacao(page, carla, `Treze ${TAG}`);
  const freq = page.getByText(/Cada pessoa pode criar até três organizações por dia\./).first();
  await expect(freq).toBeVisible();
  const texto = (await freq.textContent()) ?? '';
  expect(texto).toMatch(/poderá criar outra (hoje|amanhã|em \d\d\/\d\d), a partir das \d\d:\d\d\./);
  expect(texto).toContain('não tem relação com o limite de organizações vazias');
  expect(texto).toContain('Nada foi criado.');
  expect(criadas(), 'nada criado').toBe('12');
  await shot(page, '4-limite-de-frequencia');
  log('4_limite_de_frequencia', { pela_tela: true, mensagem: texto, criadas: criadas() });

  // ================================================================ 5. LIMITE DE VAZIAS: a terceira vazia (preparo por SQL) e a tela deixa de oferecer a criação
  const terceira = sql(`SELECT public.identity_create_organization('${token}', 'Treze ${TAG}', NULL)`);
  expect(terceira, 'a 13ª nasce (não há teto); é a terceira vazia').toMatch(/^[0-9a-f-]{36}$/);
  expect(criadas()).toBe('13');
  expect(vazias()).toBe('3');
  expect(sql(`SELECT coalesce(public.identity_create_organization('${token}', 'Catorze ${TAG}', NULL)::text, 'recusada')`), 'o banco recusa a quarta vazia').toBe('recusada');
  expect(sql(`SELECT public.identity_org_limit_reason('${identity}')`)).toBe('EMPTY_LIMIT');
  // a lista de organizações é onde a tela oferece (ou não) a criação
  await go(page, '/organizacoes');
  await expect(page.getByText('Você atingiu o limite de organizações vazias.')).toBeVisible();
  const acaoDeCriar = (await page.getByRole('link', { name: /^Criar organização/ }).count()) + (await page.getByRole('button', { name: /^Criar organização/ }).count());
  await shot(page, '5-limite-de-vazias');
  expect(criadas()).toBe('13');
  log('5_limite_de_vazias', { tela: '"Voce atingiu o limite de organizacoes vazias." na lista de organizacoes', acao_de_criar_na_tela: acaoDeCriar, banco: 'quarta vazia recusada (EMPTY_LIMIT)', criadas: criadas(), vazias: vazias() });

  log('limites_de_frequencia', `nenhum limite foi zerado. "Tentar novamente" usado ${retried} vez(es)`);
  log('fim', 'roteiro da criacao sem teto concluido');
});
