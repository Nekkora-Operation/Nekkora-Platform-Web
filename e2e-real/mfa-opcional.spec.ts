import { expect, test, type Page } from '@playwright/test';
import { activateMfa, confirmPassword, signUpWithoutMfa, waitToken } from './support/lab';

/**
 * PLATFORM-LOCAL-002 contra a API REAL (029, segundo fator opcional) e o roteiro de exploração, com duas pessoas
 * descartáveis em contextos de navegador separados e a caixa de e-mail local. Os aceites, cada um visível na tela:
 *   1. conta nova sem MFA: confirma o e-mail, entra só com a senha e chega à aplicação, sem QR;
 *   4. ação sensível sem a confirmação exigida: a API recusa (403) e nada é criado;
 *   roteiro: criar organização (senha), reconhecer "Aguardando ativação", criar workspace, convidar a segunda pessoa
 *      (senha), a segunda pessoa — também sem MFA — aceita (senha) e a administradora confere o papel dela;
 *   2. ativação voluntária posterior em Segurança da conta;
 *   3. conta já protegida: a entrada seguinte pede o código e o diálogo sensível pede o código, nunca a senha.
 */

/** POST da API pela página, com o CSRF da sessão de identidade e a origem do frontend (como a interface faria). */
async function identityPost(page: Page, path: string, body: unknown): Promise<number> {
  const s = await page.request.get('/api/v1/me/session');
  expect(s.status()).toBe(200);
  const { csrfToken } = (await s.json()) as { csrfToken: string };
  const origin = new URL(page.url()).origin;
  const r = await page.request.post(path, { data: body, headers: { 'X-CSRF-Token': csrfToken, Origin: origin } });
  return r.status();
}

test('MFA opcional: conta sem MFA, ação sensível com senha, convite e papel, ativação posterior e conta protegida', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const guest = await guestCtx.newPage();
  const tag = Date.now().toString(36);

  // 1. conta nova sem MFA: sem QR, direto na entrada geral, com o ponto de partida
  const ana = await signUpWithoutMfa(admin, `mfa${tag}a`);
  await expect(admin.getByRole('button', { name: 'Criar minha primeira organização' })).toBeVisible();
  await expect(admin.getByLabel('QR Code para configurar o aplicativo autenticador')).toHaveCount(0);
  const sessao = await (await admin.request.get('/api/v1/me/session')).json();
  expect(sessao).toMatchObject({ mfaEnabled: false, stepUpMethod: 'password', restricted: false });

  // 4. ação sensível sem a confirmação exigida: 403 da API, nada criado
  expect(await identityPost(admin, '/api/v1/organizations', { name: `Sem confirmação ${tag}` })).toBe(403);
  const vazias = await (await admin.request.get('/api/v1/me/organizations')).json();
  expect(vazias.organizations).toEqual([]);

  // roteiro: criar a organização com a senha reconfirmada
  const orgName = `Exploração ${tag}`;
  await admin.getByRole('button', { name: 'Criar minha primeira organização' }).click();
  await admin.getByLabel(/^Nome da organização/).fill(orgName);
  await admin.getByRole('button', { name: 'Continuar' }).click();
  await confirmPassword(admin, ana.password, 'Criar organização');
  const card = admin.getByRole('listitem').filter({ hasText: orgName });
  await expect(card).toContainText('Aguardando ativação');
  await card.getByRole('button', { name: `Entrar em ${orgName}` }).click();
  await expect(admin).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  const org = /\/o\/([0-9a-f-]{36})/.exec(admin.url())![1];
  await expect(admin.getByLabel(`Organização aberta: ${orgName}`)).toBeVisible();
  await expect(admin.getByText('Organização aguardando ativação')).toBeVisible();
  await expect(admin.getByRole('heading', { name: 'Criar primeiro workspace' })).toBeVisible();
  await expect(admin.getByText(/operação da Nekkora/).first()).toBeVisible();

  // workspace (sem confirmação extra: não é ação que pede step-up)
  await admin.goto(`/o/${org}/workspaces`);
  await admin.getByRole('button', { name: 'Criar workspace' }).click();
  const wsName = `Financeiro ${tag}`;
  await admin.getByRole('alertdialog').getByLabel(/^Nome/).fill(wsName);
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
  await expect(admin).toHaveURL(new RegExp(`/o/${org}/workspaces/[0-9a-f-]{36}$`));
  const workspaceId = /workspaces\/([0-9a-f-]{36})/.exec(admin.url())![1];

  // a segunda pessoa, também sem MFA
  const bia = await signUpWithoutMfa(guest, `mfa${tag}b`);

  // convite (ação sensível na organização): o diálogo pede a SENHA
  await admin.goto(`/o/${org}/administracao/convites`);
  await admin.getByLabel(/^E-mail da pessoa/).fill(bia.email);
  await admin.getByLabel(/^Papel/).selectOption('OPERATOR');
  await admin.getByLabel(/^Workspace do papel/).selectOption(workspaceId);
  await admin.getByRole('button', { name: 'Convidar' }).click();
  await confirmPassword(admin, ana.password, 'Enviar convite');
  await expect(admin.getByText('Convite enviado.')).toBeVisible();

  // aceite pela segunda pessoa (link da caixa local), com a senha dela
  const token = await waitToken('ORG_INVITATION', bia.email);
  await guest.goto('about:blank');
  await guest.goto(`/o/${org}/convite#token=${token}`);
  await guest.getByRole('button', { name: 'Aceitar convite' }).click();
  await confirmPassword(guest, bia.password, 'Aceitar');
  await expect(guest.getByRole('heading', { name: 'Convite aceito' })).toBeVisible();
  await guest.getByRole('button', { name: 'Entrar na organização' }).click();
  await expect(guest).toHaveURL(new RegExp(`/o/${org}$`));
  await guest.goto(`/o/${org}/workspaces`);
  await expect(guest.getByRole('link', { name: wsName })).toBeVisible();

  // a administradora confere o papel da segunda pessoa
  await admin.goto(`/o/${org}/administracao/membros`);
  await admin.getByRole('link', { name: `Acessos de ${bia.name}` }).click();
  await expect(admin.getByRole('list', { name: 'Papéis ativos' })).toContainText('Operação');

  // 2. ativação voluntária posterior (Segurança da conta)
  await admin.goto('/organizacoes');
  const { auth } = await activateMfa(admin, ana.password);
  const depois = await (await admin.request.get('/api/v1/me/session')).json();
  expect(depois).toMatchObject({ mfaEnabled: true, stepUpMethod: 'totp' });

  // 3. conta já protegida: a entrada seguinte pede o código; o diálogo sensível pede o código, nunca a senha
  const outraCtx = await browser.newContext();
  const outra = await outraCtx.newPage();
  await outra.goto('/entrar');
  await outra.getByRole('textbox', { name: /E-mail/ }).fill(ana.email);
  await outra.getByLabel(/^Senha/).fill(ana.password);
  await outra.getByLabel(/^Senha/).press('Enter');
  await expect(outra).toHaveURL(/\/entrar\/verificacao$/);
  await outra.getByLabel('Código de autenticação').fill(await auth.next());
  await expect(outra).toHaveURL(/\/organizacoes$/);
  await expect(outra.getByRole('listitem').filter({ hasText: orgName })).toBeVisible();
  await outra.goto('/organizacoes/nova');
  await outra.getByLabel(/^Nome da organização/).fill(`Outra ${tag}`);
  await outra.getByRole('button', { name: 'Continuar' }).click();
  const dialog = outra.getByRole('alertdialog');
  await expect(dialog.getByLabel('Código do seu aplicativo autenticador')).toBeVisible();
  await expect(dialog.getByLabel(/^Sua senha/)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  // a senha não substitui mais o código: a API recusa a reconfirmação
  expect(await identityPost(outra, '/api/v1/auth/password-confirm', { password: ana.password })).toBe(403);

  await outraCtx.close();
  await adminCtx.close();
  await guestCtx.close();
});
