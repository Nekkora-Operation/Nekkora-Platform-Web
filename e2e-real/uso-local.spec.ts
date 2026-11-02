import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { Authenticator } from '../mock/totp';
import { LAB, readAuthenticator, readRecoveryCodes } from './support/lab';

/**
 * PLATFORM-LOCAL-001 — o percurso do guia docs/USO-LOCAL.md, pela interface, com a API real e a caixa local.
 * Nenhuma semeadura, SQL ou chamada direta à API: o link vem de `tools/lab/local.sh link`, como no guia.
 *
 *   USO_LOCAL_ESTADO=<arquivo fora do Git> FRONT_LAB_ID=<id> npx playwright test -c playwright.real.config.ts uso-local -g "passos 1"
 *   (parar e subir o ambiente)  ... -g "passo 5"
 *
 * O arquivo de estado (e-mail, senha e chave do autenticador da conta DESCARTÁVEL) fica fora do repositório, com o
 * laboratório; nada disso aparece na saída.
 */
const estado = process.env.USO_LOCAL_ESTADO ?? '';
test.skip(!estado, 'defina USO_LOCAL_ESTADO');

interface Conta { email: string; senha: string; chave: string; nome: string; organizacao: string }
const ler = (): Conta => JSON.parse(readFileSync(estado, 'utf8'));

async function cookiesDaSessao(page: Page) {
  const cookies = (await page.context().cookies()).filter((c) => c.name.startsWith('__Host-'));
  expect(cookies.length).toBeGreaterThan(0);
  for (const c of cookies) {
    expect(c.secure, c.name).toBe(true);
    expect(c.httpOnly, c.name).toBe(true);
    expect(c.path, c.name).toBe('/');
    expect(c.domain, c.name).toBe('localhost');
  }
  // CSRF: um pedido de escrita sem o token é recusado pela API real (o frontend envia o token só da memória)
  const status = await page.evaluate(async () => (await fetch('/api/v1/auth/logout', { method: 'POST' })).status);
  expect(status).toBe(403);
}

async function entrar(page: Page, conta: Conta, auth: Authenticator) {
  await page.goto('/entrar');
  await expect(page.getByRole('heading', { name: 'Entrar na Nekkora' })).toBeVisible();
  await page.getByRole('textbox', { name: /E-mail/ }).fill(conta.email);
  await page.getByLabel(/^Senha/).fill(conta.senha);
  await page.getByLabel(/^Senha/).press('Enter');
  await expect(page).toHaveURL(/\/entrar\/verificacao$/);
  await page.getByLabel('Código de autenticação').fill(await auth.next());
  await expect(page).toHaveURL(/\/organizacoes$/);
}

async function entrarNaOrganizacaoESair(page: Page, conta: Conta) {
  const cartoes = page.getByRole('listitem').filter({ hasText: conta.organizacao });
  await expect(cartoes).toHaveCount(1);
  await expect(cartoes.getByText('Aguardando ativação')).toBeVisible();
  await cartoes.getByRole('button', { name: `Entrar em ${conta.organizacao}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await expect(page.getByText(conta.organizacao).first()).toBeVisible();
  await cookiesDaSessao(page);
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/entrar$/);
  await expect(page.getByText('Você saiu da sua conta.')).toBeVisible();
}

test('passos 1 a 4: cadastro, confirmação pela caixa local, MFA, organização, entrar e sair', async ({ page }) => {
  const id = Date.now().toString(36);
  const email = `uso-local-${id}@ensaio.nekkora.test`;
  const senha = `Uso-Local-${id}-${Math.random().toString(36).slice(2, 10)}`;
  const nome = `Pessoa de ensaio ${id}`;
  const organizacao = `Organização de ensaio ${id}`;

  // 1. cadastro: a interface orienta a confirmar e a mensagem aparece na caixa local
  await page.goto('/cadastro');
  await page.getByRole('textbox', { name: /E-mail/ }).fill(email);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();
  let link = '';
  for (let i = 0; i < 40 && !link; i++) {
    try {
      link = execFileSync('bash', ['tools/lab/local.sh', 'link', email], { env: { ...process.env, LOCAL_ID: LAB }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      await page.waitForTimeout(500);
    }
  }
  expect(link).toMatch(/^http:\/\/localhost:5173\/cadastro\/confirmar#token=/);

  // 2. link → conclusão do cadastro → entrada → primeiro MFA → área da identidade
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Conclua seu cadastro' })).toBeVisible();
  await page.getByLabel(/^Nome\*?$/).fill(nome);
  await page.getByLabel(/^Senha\*?$/).fill(senha);
  await page.getByLabel(/^Confirmar senha\*?$/).fill(senha);
  await page.getByRole('button', { name: 'Concluir cadastro' }).click();
  await expect(page.getByRole('heading', { name: 'Cadastro concluído' })).toBeVisible();
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('textbox', { name: /E-mail/ }).fill(email);
  await page.getByLabel(/^Senha/).fill(senha);
  await page.getByLabel(/^Senha/).press('Enter');
  await expect(page).toHaveURL(/\/entrar\/configurar-autenticador$/);
  await page.getByRole('button', { name: 'Configurar autenticador' }).click();
  await expect(page.getByRole('heading', { name: 'Configure o autenticador' })).toBeVisible();
  await expect(page.getByRole('img', { name: /QR/i }).first()).toBeVisible();
  const auth = await readAuthenticator(page);
  await page.getByRole('button', { name: 'Já adicionei a conta' }).click();
  await page.getByLabel(/Código do autenticador/).fill(await auth.next());
  await expect(page.getByRole('heading', { name: 'Guarde seus códigos de recuperação' })).toBeVisible();
  await readRecoveryCodes(page);
  await page.getByLabel('Guardei meus códigos de recuperação em um local seguro.').check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Tudo pronto' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page).toHaveURL(/\/organizacoes$/);
  await expect(page.getByText('Você ainda não participa de nenhuma organização.')).toBeVisible();
  const chave = (auth as unknown as { secret: string }).secret; // a chave manual exibida na tela, só no arquivo de estado
  writeFileSync(estado, JSON.stringify({ email, senha, chave, nome, organizacao }), { mode: 0o600 });

  // 3. organização com confirmação de segurança (step-up)
  await page.getByRole('button', { name: /^Criar (minha primeira )?organização$/ }).first().click();
  await expect(page).toHaveURL(/\/organizacoes\/nova$/);
  await page.getByLabel('Nome da organização').fill(organizacao);
  await page.getByRole('button', { name: 'Continuar' }).click();
  const dialogo = page.getByRole('alertdialog');
  await expect(dialogo).toContainText(`Criar a organização "${organizacao}"?`);
  await dialogo.getByLabel('Código do seu aplicativo autenticador').fill(await auth.next());
  await dialogo.getByRole('button', { name: 'Criar organização' }).click();
  await expect(page).toHaveURL(/\/organizacoes$/);

  // 4. entrar na organização por ação própria, reconhecer qual está aberta e sair
  await entrarNaOrganizacaoESair(page, ler());
});

test('passo 5: depois de parar e subir o ambiente, a mesma conta entra com MFA e a organização continua lá', async ({ page }) => {
  test.skip(!existsSync(estado), 'rode antes os passos 1 a 4');
  const conta = ler();
  const auth = new Authenticator(conta.chave);
  await entrar(page, conta, auth);
  await entrarNaOrganizacaoESair(page, conta);
});
