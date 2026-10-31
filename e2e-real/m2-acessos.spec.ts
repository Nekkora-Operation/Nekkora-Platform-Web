import { expect, test, type Page } from '@playwright/test';
import { confirmStepUp, signUpAndEnroll, waitToken, type Person } from './support/lab';

/**
 * M2 contra a API REAL: duas pessoas em contextos de navegador separados (cookies próprios). A administradora cria a
 * organização e um workspace; convida a segunda pessoa como OPERATOR do workspace; a convidada aceita pelo link da caixa.
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

test('J07/J08: workspace, convite com papel, aceite pela caixa, visão limitada, mudança de papel, último admin e retirada', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const guest = await guestCtx.newPage();

  const ana = await signUpAndEnroll(admin, 'j08a');
  const org = await createOrganizationAndEnter(admin, ana, `Ensaio J08 ${Date.now().toString(36)}`);

  // workspace (workspace.lifecycle) com a organização ainda aguardando ativação
  await admin.goto(`/o/${org}/workspaces`);
  await admin.getByRole('button', { name: 'Criar workspace' }).click();
  const wsName = `Financeiro ${Date.now().toString(36)}`;
  await admin.getByRole('alertdialog').getByLabel(/^Nome/).fill(wsName);
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
  await expect(admin).toHaveURL(new RegExp(`/o/${org}/workspaces/[0-9a-f-]{36}$`));
  await expect(admin.getByRole('heading', { name: wsName })).toBeVisible();
  const workspaceId = /workspaces\/([0-9a-f-]{36})/.exec(admin.url())![1];

  // a convidada se cadastra (identidade própria, outro e-mail)
  const bia = await signUpAndEnroll(guest, 'j08b');

  // convite como OPERATOR do workspace (step-up)
  await admin.goto(`/o/${org}/administracao/convites`);
  await admin.getByLabel(/^E-mail da pessoa/).fill(bia.email);
  await admin.getByLabel(/^Papel/).selectOption('OPERATOR');
  await admin.getByLabel(/^Workspace do papel/).selectOption(workspaceId);
  await admin.getByRole('button', { name: 'Convidar' }).click();
  await confirmStepUp(admin, ana, 'Enviar convite');
  await expect(admin.getByText('Convite enviado.')).toBeVisible();
  await expect(admin.getByRole('row').filter({ hasText: bia.email })).toContainText('Pendente');

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

  // visão limitada: só o workspace do papel; administração fora do menu e recusada por URL direta
  await guest.goto(`/o/${org}/workspaces`);
  await expect(guest.getByRole('link', { name: wsName })).toBeVisible();
  await expect(guest.getByRole('link', { name: 'Membros' })).toHaveCount(0);
  await guest.goto(`/o/${org}/administracao/convites`);
  await expect(guest.getByText('Você não tem permissão para ver os convites.')).toBeVisible();

  // mudança de papel pela administradora (step-up)
  await admin.goto(`/o/${org}/administracao/membros`);
  await admin.getByRole('link', { name: `Acessos de ${bia.name}` }).click();
  await expect(admin.getByRole('list', { name: 'Papéis ativos' })).toContainText('Operação');
  await admin.getByRole('button', { name: 'Mudar para Leitura' }).click();
  await confirmStepUp(admin, ana, 'Mudar papel');
  await expect(admin.getByText('Papel alterado no mesmo escopo.')).toBeVisible();
  await expect(admin.getByRole('list', { name: 'Papéis ativos' }).getByText('Leitura', { exact: true })).toBeVisible();

  // último administrador: retirar a si mesma é recusado pela API
  await admin.goto(`/o/${org}/administracao/membros`);
  await admin.getByRole('link', { name: `Acessos de ${ana.name}` }).click();
  await admin.getByRole('button', { name: 'Retirar vínculo' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Retirar vínculo' }).click();
  await expect(admin.getByRole('alertdialog')).toContainText('A retirada não foi permitida');
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();

  // retirada da convidada: a sessão dela na organização cai
  await admin.goto(`/o/${org}/administracao/membros`);
  await admin.getByRole('link', { name: `Acessos de ${bia.name}` }).click();
  await admin.getByRole('button', { name: 'Retirar vínculo' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Retirar vínculo' }).click();
  await expect(admin.getByText('Vínculo retirado.')).toBeVisible();

  await guest.goto(`/o/${org}/workspaces`);
  await expect(guest).toHaveURL(new RegExp(`/o/${org}/entrar$`));
  await guest.getByRole('button', { name: 'Entrar nesta organização' }).click();
  await expect(guest.getByText(/Não foi possível entrar nesta organização/)).toBeVisible();

  // auditoria registra os atos
  await admin.goto(`/o/${org}/administracao/auditoria`);
  for (const act of ['Convite emitido', 'Convite aceito', 'Papel alterado', 'Vínculo retirado']) {
    await expect(admin.getByRole('cell', { name: act }).first()).toBeVisible();
  }

  await adminCtx.close();
  await guestCtx.close();
});
