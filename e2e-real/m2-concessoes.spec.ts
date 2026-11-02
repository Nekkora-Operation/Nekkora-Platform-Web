import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { confirmStepUp, LAB, signUpAndEnroll, waitToken, type Person } from './support/lab';

/**
 * J09 contra a API REAL, com pessoas diferentes em contextos de navegador separados (FRONT-V1-002).
 *
 * Pré-condições DECLARADAS (não são a jornada):
 *  - fixture de laboratório `lab.mjs cliente`: cliente, workspace do cliente e conta externa ativa (sem concessão) —
 *    a API não tem rota humana para isso (D-API-03);
 *  - o PRIMEIRO pedido de concessão é criado pela API real (POST /client-grants, sessão e CSRF da solicitante): a tela
 *    não tem como escolher o vínculo sem uma leitura autorizada dos vínculos (D-API-03). Todos os pedidos seguintes,
 *    as aprovações, a revisão e a renovação passam pela tela.
 * Aprovação da renovação: INDISPONÍVEL na tela até a leitura do pedido existir (D-API-02); o teste prova a ausência.
 */
const ORIGIN = 'http://localhost:5173';

async function createOrganizationAndEnter(page: Page, person: Person, name: string): Promise<string> {
  await page.goto('/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, person, 'Criar organização');
  await page.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  return /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];
}

async function inviteAndAccept(admin: Page, ana: Person, guest: Page, person: Person, org: string, role: '' | 'ORG_ADMIN') {
  await admin.goto(`/o/${org}/administracao/convites`);
  await admin.getByLabel(/^E-mail da pessoa/).fill(person.email);
  await admin.getByLabel(/^Papel/).selectOption(role);
  await admin.getByRole('button', { name: 'Convidar' }).click();
  await confirmStepUp(admin, ana, 'Enviar convite');
  await expect(admin.getByText('Convite enviado.')).toBeVisible();
  const token = await waitToken('ORG_INVITATION', person.email);
  await guest.goto('about:blank');
  await guest.goto(`/o/${org}/convite#token=${token}`);
  await guest.getByRole('button', { name: 'Aceitar convite' }).click();
  await confirmStepUp(guest, person, 'Aceitar');
  await guest.getByRole('button', { name: 'Entrar na organização' }).click();
  await expect(guest).toHaveURL(new RegExp(`/o/${org}$`));
}

const grantsUrl = (org: string) => `/o/${org}/administracao/concessoes`;
const list = (page: Page) => page.getByRole('region', { name: 'Lista de concessões' });

test('J09: concessão entre duas pessoas — aprovação inicial, recusas de autoridade, KEEP sem data, renovação e conflito', async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx = { ana: await browser.newContext(), bia: await browser.newContext(), caio: await browser.newContext() };
  const anaPage = await ctx.ana.newPage();
  const biaPage = await ctx.bia.newPage();
  const caioPage = await ctx.caio.newPage();

  const ana = await signUpAndEnroll(anaPage, 'j09a');
  const org = await createOrganizationAndEnter(anaPage, ana, `Ensaio J09 ${Date.now().toString(36)}`);
  const bia = await signUpAndEnroll(biaPage, 'j09b');
  const caio = await signUpAndEnroll(caioPage, 'j09c');
  await inviteAndAccept(anaPage, ana, biaPage, bia, org, 'ORG_ADMIN');
  await inviteAndAccept(anaPage, ana, caioPage, caio, org, '');

  // pré-condição declarada: cliente + workspace do cliente + conta externa (fixture de laboratório)
  const fx = JSON.parse(execFileSync('node', ['tools/lab/lab.mjs', LAB, 'cliente', org], { encoding: 'utf8' })) as {
    clientMembershipId: string;
    workspaceId: string;
    externalName: string;
    workspaceName: string;
  };
  const who = `${fx.externalName} em ${fx.workspaceName}`;

  // pré-condição declarada: primeiro pedido pela API real, com a sessão e o CSRF da Ana (D-API-03: sem tela de escolha)
  const csrf = (await (await anaPage.request.get(`/api/v1/o/${org}/auth/csrf`)).json()).csrfToken as string;
  const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000);
  inTwoWeeks.setHours(23, 59, 59, 0);
  const created = await anaPage.request.post(`/api/v1/o/${org}/client-grants`, {
    headers: { 'X-CSRF-Token': csrf, Origin: ORIGIN },
    data: { clientMembershipId: fx.clientMembershipId, workspaceId: fx.workspaceId, nextReviewAt: inTwoWeeks.toISOString() },
  });
  expect(created.status()).toBe(201);

  // recusa de autoridade 1: Caio (vínculo sem papel) não vê concessões, nem por endereço direto
  await caioPage.goto(grantsUrl(org));
  await expect(caioPage.getByText(/permissão/i).first()).toBeVisible();
  await expect(caioPage.getByRole('button', { name: `Aprovar: ${who}` })).toHaveCount(0);

  // recusa de autoridade 2: quem pediu não aprova (403 da API, nada aplicado)
  await anaPage.goto(grantsUrl(org));
  await list(anaPage).getByRole('button', { name: `Aprovar: ${who}` }).click();
  await anaPage.getByRole('alertdialog').getByLabel('Conferi os valores pedidos.').check();
  await confirmStepUp(anaPage, ana, 'Aprovar');
  await expect(anaPage.getByRole('alertdialog')).toContainText(/não foi permitido|quem pediu não pode aprovar/i);
  await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
  await expect(list(anaPage)).toContainText('Pendente');

  // aprovação inicial pela Bia: valores lidos do servidor (sem digitação), step-up
  await biaPage.goto(grantsUrl(org));
  await list(biaPage).getByRole('button', { name: `Aprovar: ${who}` }).click();
  const approve = biaPage.getByRole('alertdialog');
  await expect(approve).toContainText('Próxima revisão');
  await expect(approve.locator('input[type="date"]')).toHaveCount(0); // nenhum valor digitado na aprovação inicial
  await approve.getByLabel('Conferi os valores pedidos.').check();
  await confirmStepUp(biaPage, bia, 'Aprovar');
  await expect(biaPage.getByText('Concessão aprovada com os valores pedidos.')).toBeVisible();
  await expect(list(biaPage)).toContainText('Ativa');
  const before = (await list(biaPage).innerText()).replace(/\s+/g, ' ');

  // KEEP sem data: registra a revisão; próxima revisão e prazo continuam os mesmos
  await list(biaPage).getByRole('button', { name: `Revisar: ${who}` }).click();
  await confirmStepUp(biaPage, bia, 'Manter');
  await expect(biaPage.getByText('Revisão registrada; o prazo e a próxima revisão continuam os mesmos.')).toBeVisible();
  await biaPage.reload();
  await expect(list(biaPage).getByRole('button', { name: `Revisar: ${who}` })).toBeVisible();
  expect((await list(biaPage).innerText()).replace(/\s+/g, ' ')).toBe(before);

  // renovação: Ana pede pela tela; a aprovação da renovação NÃO é oferecida (D-API-02)
  await anaPage.goto(grantsUrl(org));
  await list(anaPage).getByRole('button', { name: `Pedir renovação: ${who}` }).click();
  const renew = anaPage.getByRole('alertdialog');
  const later = new Date(Date.now() + 40 * 86_400_000);
  await renew.getByLabel(/^Próxima revisão/).fill(later.toISOString().slice(0, 10));
  await renew.getByLabel(/^Justificativa/).fill('Contrato renovado (ensaio sintético).');
  await renew.getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(anaPage.getByText(/Pedido de renovação registrado\. O acesso não muda/)).toBeVisible();
  await biaPage.reload();
  await expect(list(biaPage)).toContainText('Ativa');
  await expect(biaPage.getByRole('button', { name: /^Aprovar renovação/ })).toHaveCount(0);

  // conflito: Bia abre a aprovação de um pedido novo; Ana revoga antes da confirmação → 409, lista relida, nada aprovado
  await list(anaPage).getByRole('button', { name: /^Revogar a concessão de / }).first().click();
  await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Revogar' }).click();
  await expect(list(anaPage)).toContainText('Revogada');
  await anaPage.reload();
  await list(anaPage).getByRole('button', { name: `Pedir de novo: ${who}` }).first().click();
  const again = anaPage.getByRole('alertdialog');
  await again.getByLabel(/^Próxima revisão/).fill(inTwoWeeks.toISOString().slice(0, 10));
  await again.getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(anaPage.getByText('Pedido de concessão criado. Ele precisa da aprovação de outra pessoa.')).toBeVisible();

  await biaPage.reload();
  await list(biaPage).getByRole('button', { name: `Aprovar: ${who}` }).click();
  await biaPage.getByRole('alertdialog').getByLabel('Conferi os valores pedidos.').check();
  await anaPage.reload();
  await list(anaPage).getByRole('button', { name: /^Revogar a concessão de / }).first().click();
  await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Revogar' }).click();
  await expect(list(anaPage)).not.toContainText('Pendente');
  await confirmStepUp(biaPage, bia, 'Aprovar');
  await expect(biaPage.getByRole('alertdialog')).toContainText('A concessão mudou desde a leitura');
  await biaPage.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
  await expect(list(biaPage)).not.toContainText('Pendente');
  await expect(list(biaPage)).not.toContainText('Ativa');

  // pedido novo pela tela e aprovação pela outra pessoa: o caminho completo pela interface
  await anaPage.reload();
  await list(anaPage).getByRole('button', { name: `Pedir de novo: ${who}` }).first().click();
  await anaPage.getByRole('alertdialog').getByLabel(/^Próxima revisão/).fill(inTwoWeeks.toISOString().slice(0, 10));
  await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(anaPage.getByText('Pedido de concessão criado. Ele precisa da aprovação de outra pessoa.')).toBeVisible();
  await biaPage.reload();
  await list(biaPage).getByRole('button', { name: `Aprovar: ${who}` }).click();
  await biaPage.getByRole('alertdialog').getByLabel('Conferi os valores pedidos.').check();
  await confirmStepUp(biaPage, bia, 'Aprovar');
  await expect(biaPage.getByText('Concessão aprovada com os valores pedidos.')).toBeVisible();
  console.log(`J09 org=${org} vinculo=${fx.clientMembershipId}`);
});
