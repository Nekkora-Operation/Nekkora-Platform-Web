import { expect, test, type Page } from '@playwright/test';
import { confirmStepUp, signUpAndEnroll, waitToken, type Person } from './support/lab';

/**
 * M2 contra a API REAL: duas pessoas em contextos de navegador separados (cookies próprios). A administradora cria a
 * organização e um workspace; convida a segunda pessoa como OPERATOR do workspace; a convidada aceita pelo link da caixa.
 * PLATFORM-FLUXO-002 (adaptado em 21/11): Membros, Convites e Auditoria viraram "Pessoas e acessos" (abas Pessoas,
 * Compartilhamentos e Histórico); mudar perfil e retirar a pessoa passam pelo modal "Gerenciar acessos"; a própria conta não
 * tem ações na tabela (o último administrador não se retira).
 */

async function createOrganizationAndEnter(page: Page, person: Person, name: string): Promise<string> {
  await page.goto('/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, person, 'Criar organização');
  const card = page.getByRole('listitem').filter({ hasText: name });
  await card.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  return /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];
}

test('J07/J08: ambiente de trabalho, convite com papel, aceite pela caixa, visão limitada, mudança de papel, último admin e retirada', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const guest = await guestCtx.newPage();

  const ana = await signUpAndEnroll(admin, 'j08a');
  const org = await createOrganizationAndEnter(admin, ana, `Ensaio J08 ${Date.now().toString(36)}`);

  // workspace (workspace.lifecycle) com a organização ainda aguardando ativação
  await admin.goto(`/o/${org}/workspaces`);
  await admin.getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
  const wsName = `Financeiro ${Date.now().toString(36)}`;
  await admin.getByRole('alertdialog').getByLabel(/^Nome/).fill(wsName);
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
  await expect(admin).toHaveURL(new RegExp(`/o/${org}/workspaces/[0-9a-f-]{36}$`));
  await expect(admin.getByRole('heading', { name: wsName })).toBeVisible();
  const workspaceId = /workspaces\/([0-9a-f-]{36})/.exec(admin.url())![1];

  // a convidada se cadastra (identidade própria, outro e-mail)
  const bia = await signUpAndEnroll(guest, 'j08b');

  // convite como OPERATOR do workspace (step-up), em Pessoas e acessos
  await admin.goto(`/o/${org}/administracao/pessoas`);
  await admin.getByLabel(/^E-mail da pessoa/).fill(bia.email);
  await admin.getByLabel(/^Perfil \(opcional\)/).selectOption('OPERATOR');
  await admin.getByLabel(/^Ambiente de trabalho do perfil/).selectOption(workspaceId);
  await admin.getByRole('button', { name: 'Convidar' }).click();
  await confirmStepUp(admin, ana, 'Enviar convite');
  await expect(admin.getByText('Convite enviado. A pessoa recebe o link por e-mail.')).toBeVisible();
  const linha = (who: string) => admin.getByRole('region', { name: 'Lista de pessoas e convites' }).locator('tbody tr').filter({ hasText: who });
  await expect(linha(bia.email)).toContainText('Convite pendente');

  // aceite pela convidada com o link da caixa (step-up da identidade)
  const token = await waitToken('ORG_INVITATION', bia.email);
  await guest.goto('about:blank');
  await guest.goto(`/o/${org}/convite#token=${token}`);
  expect(guest.url()).not.toContain(token);
  await guest.getByRole('button', { name: 'Aceitar convite' }).click();
  await confirmStepUp(guest, bia, 'Aceitar');
  await expect(guest.getByRole('heading', { name: 'Convite aceito' })).toBeVisible();
  await guest.getByRole('button', { name: 'Entrar na organização' }).click();
  await expect(guest).toHaveURL(new RegExp(`/o/${org}$`));

  // visão limitada: só o workspace do papel; administração fora do menu e recusada por URL direta (endereço novo e antigo)
  await guest.goto(`/o/${org}/workspaces`);
  await expect(guest.getByRole('link', { name: wsName })).toBeVisible();
  await expect(guest.getByRole('link', { name: 'Pessoas e acessos' })).toHaveCount(0);
  for (const path of [`/o/${org}/administracao/pessoas`, `/o/${org}/administracao/convites`]) {
    await guest.goto(path);
    await expect(guest.getByText('Você não tem permissão para ver as pessoas e os convites desta organização.')).toBeVisible();
  }

  // mudança de perfil pela administradora (modal "Gerenciar acessos", step-up)
  await admin.goto(`/o/${org}/administracao/pessoas`);
  await linha(bia.email).getByRole('button', { name: `Gerenciar acessos de ${bia.name}` }).click();
  let modal = admin.getByRole('alertdialog', { name: `Gerenciar acessos de ${bia.name}` });
  await expect(modal.getByRole('list', { name: 'Acessos atuais' })).toContainText('Operação');
  await modal.getByLabel(`Perfil em ${wsName}`).selectOption('VIEWER');
  await confirmStepUp(admin, ana, 'Salvar acessos');
  await expect(admin.getByText(`Acessos de ${bia.name} salvos.`)).toBeVisible();
  await expect(linha(bia.email)).toContainText('Leitura');

  // último administrador: a própria conta não tem ações (não se retira nem muda o próprio acesso)
  await expect(linha(ana.email)).toContainText('Sua conta');
  await expect(linha(ana.email).getByRole('button')).toHaveCount(0);

  // retirada da convidada: a sessão dela na organização cai
  await linha(bia.email).getByRole('button', { name: `Gerenciar acessos de ${bia.name}` }).click();
  modal = admin.getByRole('alertdialog', { name: `Gerenciar acessos de ${bia.name}` });
  await modal.getByRole('checkbox', { name: 'Retirar esta pessoa da organização' }).check();
  await confirmStepUp(admin, ana, 'Retirar e salvar');
  await expect(admin.getByText(`${bia.name} foi retirada(o) da organização.`)).toBeVisible();

  await guest.goto(`/o/${org}/workspaces`);
  await expect(guest).toHaveURL(new RegExp(`/o/${org}/entrar$`));
  await guest.getByRole('button', { name: 'Entrar nesta organização' }).click();
  await expect(guest.getByText(/Não foi possível entrar nesta organização/)).toBeVisible();

  // histórico (aba Histórico de Pessoas e acessos) registra os atos; o endereço antigo da auditoria abre a mesma aba
  await admin.goto(`/o/${org}/administracao/auditoria`);
  await expect(admin.getByRole('tab', { name: 'Histórico' })).toHaveAttribute('aria-selected', 'true');
  const historico = admin.getByRole('region', { name: 'Histórico de acessos' });
  for (const act of ['Convite emitido', 'Convite aceito', 'Perfil trocado', 'Retirado da organização']) {
    await expect(historico.getByText(act, { exact: true }).first()).toBeVisible();
  }

  await adminCtx.close();
  await guestCtx.close();
});
