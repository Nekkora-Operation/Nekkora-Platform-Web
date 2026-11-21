import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { compose } from '../tools/lab/lab.mjs';
import { Authenticator } from '../mock/totp';
import { activateMfa, confirmPassword, confirmStepUp, identitySignIn, LAB, signInWithTotp, signOut, syntheticEmail, waitToken, type Person } from './support/lab';

/**
 * PLATFORM-SENHA-001 — validação de senha pela Web de produção contra a API real do laboratório, com pessoas sintéticas.
 * Usa a organização do acompanhamento (~/.nekkora/front-lab/<lab>/acompanhamento.json): a administradora Ana, cuja senha foi
 * criada ANTES da política (25 caracteres) — prova de que a senha existente continua entrando. Cadastra DUAS pessoas (o
 * limite de cadastro por IP é preservado): Lia (cadastro comum, troca e recuperação) e Ivo (primeiro acesso pelo convite de
 * cliente). O convite da titular que estiver na organização não é tocado.
 *
 *   FRONT_LAB_ID=frontlab-fluxo002 FRONT_PORTA=5196 npx playwright test -c playwright.real.config.ts senha-001
 */
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-senha-001`);
const ESTADO = join(homedir(), '.nekkora', 'front-lab', LAB, 'acompanhamento.json');
const TAG = Date.now().toString(36);
const axeSource = readFileSync(resolve('node_modules/axe-core/axe.min.js'), 'utf8');

const sql = (q: string) => (compose(LAB, ['exec', '-T', 'postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'nekkora', '-d', 'nekkora', '-c', q]) as string).trim();
const log = (k: string, v: unknown) => {
  mkdirSync(EVID, { recursive: true });
  const line = `${new Date().toISOString()} ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
  appendFileSync(join(EVID, 'roteiro.txt'), `${line}\n`);
  console.log(line);
};
const shot = async (page: Page, name: string) => {
  mkdirSync(EVID, { recursive: true });
  await page.screenshot({ path: join(EVID, `${name}.png`), fullPage: true });
};
async function audit(page: Page, name: string) {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-expect-error axe injetado
    const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return r.violations.map((x: { id: string; nodes: { target: string[] }[] }) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
  expect(v, `axe ${name}`).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `rolagem ${name}`).toBeLessThanOrEqual(0);
}

const REQS = ['length', 'uppercase', 'lowercase', 'digit', 'symbol'] as const;
/** Uma senha por requisito ausente (o único que falta). */
const FORA: [string, (typeof REQS)[number]][] = [
  ['Nk#2026ok', 'length'],
  ['Nekkora#2026ok-maisum', 'length'],
  ['nekkora#2026ok', 'uppercase'],
  ['NEKKORA#2026OK', 'lowercase'],
  ['Nekkora#Teste!', 'digit'],
  ['Nekkora2026ok7', 'symbol'],
];

async function requirements(page: Page): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const r of REQS) out[r] = (await page.locator(`[data-requisito="${r}"]`).first().getAttribute('data-atendido')) === 'true';
  return out;
}

/** Cada requisito ausente aparece pendente sozinho, em texto (atendido/pendente) e com ícone. */
async function checkEachRequirement(page: Page, field: RegExp) {
  for (const [senha, falta] of FORA) {
    await page.getByLabel(field).fill(senha);
    const r = await requirements(page);
    expect(Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k), senha).toEqual([falta]);
    await expect(page.locator(`[data-requisito="${falta}"]`).first()).toContainText('pendente');
    await expect(page.locator(`[data-requisito="${falta}"] svg`).first()).toBeVisible();
  }
}

function countPosts(page: Page, path: string) {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === path) sent.push(path);
  });
  return sent;
}

async function directPost(browser: Browser, path: string, body: unknown): Promise<number> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/entrar');
  const status = await page.evaluate(
    async ({ path, body }) => {
      const csrf = (await (await fetch('/api/v1/csrf', { credentials: 'include' })).json()).csrfToken as string;
      const r = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
      return r.status;
    },
    { path, body },
  );
  await page.context().close();
  return status;
}

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('PLATFORM-SENHA-001: cadastro, convite de cliente, troca, recuperação e senha existente', async ({ browser }) => {
  test.setTimeout(900_000);
  const s = JSON.parse(readFileSync(ESTADO, 'utf8'));
  const ana: Person = { email: s.ana.email, password: s.ana.password, name: s.ana.name, auth: new Authenticator(s.ana.secret), recoveryCodes: [] };
  const org = s.org as string;

  // ------------------------------------------------ 0. senha existente (criada antes da política) continua entrando
  const anaPage = await (await browser.newContext()).newPage();
  await signInWithTotp(anaPage, ana);
  log('0_senha_existente', { pessoa: 'Ana', comprimento: Array.from(ana.password).length, entrou: true, mfa: 'exigido e aceito' });

  // ------------------------------------------------ 1. cadastro comum (Lia)
  const lia = { name: `Lia Senha ${TAG}`, email: syntheticEmail(`senha-lia-${TAG}`), password: 'Lia#Senha-2026x' };
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/cadastro');
  await page.getByRole('textbox', { name: /E-mail/ }).fill(lia.email);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();
  const tokenLia = await waitToken('IDENTITY_SIGNUP_CONFIRMATION', lia.email);
  await page.goto(`/cadastro/confirmar#token=${tokenLia}`);
  await page.getByLabel(/^Nome\*?$/).fill(lia.name);
  const confirmPosts = countPosts(page, '/api/v1/signup/confirm');
  await expect(page.getByText('A senha precisa ter:')).toBeVisible();
  expect(Object.values(await requirements(page)).every((v) => !v), 'nada atendido antes de digitar').toBe(true);
  await checkEachRequirement(page, /^Senha\*?$/);

  // fora da regra: não envia; mensagem diz o que falta
  await page.getByLabel(/^Senha\*?$/).fill('Nekkora2026ok7');
  await page.getByLabel(/^Confirmar senha\*?$/).fill('Nekkora2026ok7');
  await page.getByRole('button', { name: 'Concluir cadastro' }).click();
  await expect(page.getByText('A senha ainda não atende aos requisitos: um símbolo (por exemplo ! @ # - _).')).toBeVisible();
  // confirmação divergente: não envia
  await page.getByLabel(/^Senha\*?$/).fill(lia.password);
  await page.getByLabel(/^Confirmar senha\*?$/).fill('Lia#Senha-2026y');
  await expect(page.getByText('As senhas não coincidem.')).toBeVisible();
  await page.getByRole('button', { name: 'Concluir cadastro' }).click();
  expect(confirmPosts, 'nada enviado com senha fora da regra ou confirmação divergente').toEqual([]);

  // cumpre as regras, mas a força estimada não é "forte"
  await page.getByLabel(/^Senha\*?$/).fill('Qwerty@12345');
  await expect(page.locator('.pw-password__summary')).toHaveText(/Senha atende aos requisitos\./);
  const forca = page.locator('.pw-password__strength');
  await expect(forca).toContainText(/Força estimada: (muito fraca|fraca)/);
  await expect(forca).not.toContainText('Força estimada: forte');
  await expect(forca).toContainText('Atende aos requisitos, mas é fácil de adivinhar.');
  await shot(page, '1-cadastro-cumpre-regras-mas-fraca');

  // mostrar/ocultar
  const campo = page.getByLabel(/^Senha\*?$/);
  await expect(campo).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Mostrar senha' }).first().click();
  await expect(campo).toHaveAttribute('type', 'text');
  await shot(page, '1-cadastro-senha-visivel');
  await page.getByRole('button', { name: 'Ocultar senha' }).first().click();
  await expect(campo).toHaveAttribute('type', 'password');

  // colar (área de transferência real): nada cortado nem aparado; campo sem maxlength
  await expect(campo).not.toHaveAttribute('maxlength', /.*/);
  await page.evaluate(() => navigator.clipboard.writeText('  Colada#Senha2026-longa  '));
  await campo.fill('');
  await campo.focus();
  await page.keyboard.press('Control+V');
  await expect(campo).toHaveValue('  Colada#Senha2026-longa  ');
  expect((await requirements(page)).length, 'colada com 26: comprimento pendente, sem corte').toBe(false);
  log('1_colar', { colada: 26, valor_no_campo: 'igual ao colado', comprimento: 'pendente' });

  // tela estreita: requisitos e força abaixo do campo, sem rolagem horizontal; axe
  await campo.fill('Lia#Se');
  await page.setViewportSize({ width: 375, height: 900 });
  await audit(page, 'cadastro-375');
  await shot(page, '1-cadastro-375');
  await page.setViewportSize({ width: 1280, height: 900 });

  await campo.fill(lia.password);
  await page.getByLabel(/^Confirmar senha\*?$/).fill(lia.password);
  await expect(page.getByText('As senhas coincidem.')).toBeVisible();
  await audit(page, 'cadastro-valida');
  await shot(page, '1-cadastro-valida');
  await page.getByRole('button', { name: 'Concluir cadastro' }).click();
  await expect(page.getByRole('heading', { name: 'Cadastro concluído' })).toBeVisible();
  expect(confirmPosts.length, 'um único envio, com a senha válida').toBe(1);
  log('1_cadastro_comum', { fora_da_regra: FORA.map(([, f]) => f), divergencia: 'recusada na tela', enviada: 'válida (15)' });

  // ------------------------------------------------ 2. troca de senha (Segurança da conta), nos três temas
  await page.getByRole('button', { name: 'Entrar' }).click();
  await identitySignIn(page, lia.email, lia.password);
  await page.waitForURL(/\/(organizacoes|conta\/proteger)$/);
  await page.goto('/conta');
  const changePosts = countPosts(page, '/api/v1/auth/password');
  await page.getByLabel(/^Senha atual/).fill(lia.password);
  await checkEachRequirement(page, /^Senha nova\*?$/);
  for (const [label, tema] of [
    ['Nekkora Light', 'light'],
    ['Nekkora Dark', 'dark'],
    ['Sakura Dark', 'sakura-dark'],
  ] as const) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: new RegExp(`^${label}`) }).check();
    await page.reload();
    await expect(page.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: new RegExp(`^${label}`) })).toBeChecked();
    await page.getByLabel(/^Senha nova\*?$/).fill('Lia#Tro');
    await audit(page, `troca-${tema}`);
    await page.getByRole('heading', { name: 'Senha', exact: true }).scrollIntoViewIfNeeded();
    await shot(page, `2-troca-${tema}-larga`);
    await page.setViewportSize({ width: 375, height: 900 });
    await audit(page, `troca-${tema}-375`);
    await shot(page, `2-troca-${tema}-375`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('group', { name: 'Tema' }).getByRole('radio', { name: /^Nekkora Light/ }).check();
  await page.reload();
  await page.getByLabel(/^Senha atual/).fill(lia.password);
  await page.getByLabel(/^Senha nova\*?$/).fill('lia#troca-2026');
  await page.getByLabel(/^Confirmar senha nova/).fill('lia#troca-2026');
  await page.getByRole('button', { name: 'Trocar senha' }).click();
  await expect(page.getByText('A senha ainda não atende aos requisitos: uma letra maiúscula.')).toBeVisible();
  const nova = 'Lia#Troca-2026';
  await page.getByLabel(/^Senha nova\*?$/).fill(nova);
  await page.getByLabel(/^Confirmar senha nova/).fill('Lia#Troca-2027');
  await page.getByRole('button', { name: 'Trocar senha' }).click();
  await expect(page.getByText('As senhas não coincidem.')).toBeVisible();
  expect(changePosts, 'nada enviado fora da regra ou com divergência').toEqual([]);
  await page.getByLabel(/^Confirmar senha nova/).fill(nova);
  await page.getByRole('button', { name: 'Trocar senha' }).click();
  await confirmPassword(page, lia.password, 'Trocar senha');
  await expect(page.getByText(/^Senha alterada\./)).toBeVisible();
  log('2_troca', { fora_da_regra: 'recusada na tela', divergencia: 'recusada na tela', temas: ['light', 'dark', 'sakura-dark'], persistencia: 'após recarregar', estreita: 375 });
  await signOut(page);
  await identitySignIn(page, lia.email, lia.password);
  await expect(page.getByText('E-mail ou senha incorretos.')).toBeVisible();

  // ------------------------------------------------ 3. recuperação: chamada direta fora da regra recusada sem consumir o link
  await page.getByRole('link', { name: 'Esqueci minha senha' }).click();
  await page.getByRole('textbox', { name: /E-mail/ }).fill(lia.email);
  await page.getByRole('button', { name: 'Enviar instruções' }).click();
  await expect(page.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();
  const tokenRec = await waitToken('PASSWORD_RECOVERY', lia.email);
  const diretas: Record<string, number> = {};
  for (const [senha, falta] of FORA) diretas[falta + (senha.length > 20 ? '-21' : '')] = await directPost(browser, '/api/v1/auth/password-reset/confirm', { token: tokenRec, newPassword: senha });
  expect(Object.values(diretas).every((st) => st === 400), JSON.stringify(diretas)).toBe(true);
  log('3_recuperacao_chamadas_diretas', diretas);
  await page.goto('about:blank');
  await page.goto(`/recuperar-senha#token=${tokenRec}`);
  await expect(page.getByRole('heading', { name: 'Crie uma nova senha' })).toBeVisible();
  await checkEachRequirement(page, /^Nova senha\*?$/);
  const recuperada = 'Lia#Recup-2026';
  await page.getByLabel(/^Nova senha\*?$/).fill(recuperada);
  await page.getByLabel(/^Confirmar nova senha/).fill(recuperada);
  await audit(page, 'recuperacao');
  await shot(page, '3-recuperacao');
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByRole('heading', { name: 'Senha alterada' })).toBeVisible();
  await page.getByRole('button', { name: 'Voltar para o login' }).click();
  await identitySignIn(page, lia.email, nova);
  await expect(page.getByText('E-mail ou senha incorretos.')).toBeVisible();
  await identitySignIn(page, lia.email, recuperada);
  await page.waitForURL(/\/(organizacoes|conta\/proteger)$/);
  log('3_recuperacao', { link_apos_recusas: 'continuou valendo', nova_senha: 'entra', anterior: 'recusada' });

  // ------------------------------------------------ 4. primeiro acesso pelo convite de cliente (Ivo)
  const ivo = { name: `Ivo Cliente ${TAG}`, email: syntheticEmail(`senha-ivo-${TAG}`), password: 'Ivo#Cliente-26' };
  await anaPage.goto(`/o/${org}/administracao/pessoas`);
  await anaPage.getByRole('radio', { name: /^Pessoa externa/ }).check();
  await anaPage.getByLabel(/^Nome da pessoa/).fill(ivo.name);
  await anaPage.getByLabel(/^E-mail da pessoa/).fill(ivo.email);
  await anaPage.getByRole('combobox', { name: /^Ambiente de trabalho/ }).selectOption({ label: 'Fiscal' });
  await anaPage.getByRole('combobox', { name: /^Automação/ }).selectOption({ label: 'Robô de notas' });
  await anaPage.getByRole('button', { name: 'Convidar' }).click();
  await confirmStepUp(anaPage, ana, 'Compartilhar e enviar convite');
  await expect(anaPage.getByText('Compartilhamento enviado por convite. O acesso só começa quando a pessoa aceitar.')).toBeVisible();
  const ivoPage = await (await browser.newContext({ viewport: { width: 375, height: 900 } })).newPage();
  const convite = await waitToken('ORG_INVITATION', ivo.email);
  await ivoPage.goto(`/o/${org}/convite#token=${convite}`);
  await ivoPage.getByRole('button', { name: 'Criar meu acesso' }).click();
  await ivoPage.getByRole('button', { name: 'Enviar o link de confirmação' }).click();
  await expect(ivoPage.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();
  const tokenIvo = await waitToken('IDENTITY_SIGNUP_CONFIRMATION', ivo.email);
  await ivoPage.goto(`/cadastro/confirmar#token=${tokenIvo}`);
  await expect(ivoPage.getByLabel(/^Nome\*?$/)).toHaveValue(ivo.name);
  await checkEachRequirement(ivoPage, /^Senha\*?$/);
  await ivoPage.getByLabel(/^Senha\*?$/).fill(ivo.password);
  await ivoPage.getByLabel(/^Confirmar senha\*?$/).fill(ivo.password);
  await audit(ivoPage, 'convite-cliente-375');
  await shot(ivoPage, '4-convite-cliente-375');
  await ivoPage.getByRole('button', { name: 'Concluir cadastro' }).click();
  await expect(ivoPage.getByRole('heading', { name: 'Cadastro concluído' })).toBeVisible();
  await ivoPage.getByRole('button', { name: 'Entrar' }).click();
  await identitySignIn(ivoPage, ivo.email, ivo.password);
  await ivoPage.waitForURL(/\/(organizacoes|conta\/proteger)$/);
  const { auth } = await activateMfa(ivoPage, ivo.password);
  void auth;
  await ivoPage.goto(`/o/${org}/convite#token=${convite}`);
  await ivoPage.getByRole('button', { name: 'Aceitar convite' }).click();
  await ivoPage.waitForURL(new RegExp(`/cliente/o/${org}`));
  log('4_convite_cliente', {
    nome: 'veio do convite',
    requisitos: 'iguais ao cadastro comum',
    convite_valido_apos_cadastro: true,
    aceito: sql(`SELECT count(*) FROM identity_invitations WHERE organization_id = '${org}' AND email_normalized = '${ivo.email}' AND accepted_at IS NOT NULL`),
  });

  // ------------------------------------------------ 5. log da API sem as senhas usadas
  const apiLog = compose(LAB, ['logs', '--since', '30m', 'platform']) as string;
  const vazou = [lia.password, nova, recuperada, ivo.password, ...FORA.map(([p]) => p)].filter((p) => apiLog.includes(p));
  expect(vazou, 'nenhuma senha no log da API').toEqual([]);
  log('5_log_da_api', { senhas_procuradas: 4 + FORA.length, encontradas: vazou.length });
});
