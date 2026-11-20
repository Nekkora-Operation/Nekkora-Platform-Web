import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { confirmStepUp, LAB, signUpAndEnroll, waitToken, type Person } from './support/lab';

/**
 * PLATFORM-LICENCIAMENTO-001 — ROTEIRO INTEGRADO (navegador), executado com a Web e a API REAIS no laboratório descartável da
 * missão (migrations 001-068, as com elevação aplicadas só nele). Três pessoas, cada uma no seu contexto de navegador:
 *
 *   Ana    administra a organização cliente;
 *   Bruno  é membro convidado da organização da Ana;
 *   Nara   é operadora de licenças da Nekkora, pela TELA do operador (Suporte Nekkora › Operador de licenças).
 *
 * CONFIGURAÇÃO REPRESENTATIVA: a Web é a versão de PRODUÇÃO (`vite build` + `vite preview`), e os limites de frequência da
 * API NÃO são zerados em nenhum momento. O roteiro anda no ritmo de uma pessoa (um respiro entre páginas); se a tela
 * mostrar "Tentar novamente", ele espera e usa o botão, como a pessoa faria, e conta quantas vezes.
 *
 * Atos de PROCEDIMENTO ADMINISTRATIVO (o que na vida real o migrador faz), executados por SQL no banco do laboratório e
 * registrados: cadastro da operadora, bloqueio de uma organização pela Nekkora, a chave das organizações novas (D7) e a
 * "passagem do tempo" que vence uma licença (não há como esperar 30 dias).
 *
 * FIXTURES DECLARADAS: limites de recursos da organização da Ana antes das licenças (no lugar da ativação pela CLI dos
 * operadores), e UMA sessão do Agent anterior em "resultado desconhecido" gravada direto no banco (não há Agent anterior no
 * laboratório), para a transferência e a reconciliação.
 *
 * A máquina com o Client empacotado está no roteiro irmão, `licenciamento-001-maquina.spec.ts`.
 *
 *   FRONT_LAB_ID=frontlab-lic003 FRONT_PORTA=5192 npx playwright test -c playwright.real.config.ts licenciamento-001.spec
 */
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-licenciamento-001`);
const SEG = join(homedir(), '.nekkora', 'front-lab', LAB, 'segredos.env');
const TAG = Date.now().toString(36);

const sql = (q: string) => (compose(LAB, ['exec', '-T', 'postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'nekkora', '-d', 'nekkora', '-c', q]) as string).trim();
const log = (k: string, v: unknown) => {
  mkdirSync(EVID, { recursive: true });
  const line = `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
  appendFileSync(join(EVID, 'roteiro.txt'), `${line}\n`);
  console.log(line);
};
/** Só telas sem segredo (nenhuma de MFA, de código ou de link). */
const shot = async (page: Page, name: string) => {
  mkdirSync(EVID, { recursive: true });
  await page.screenshot({ path: join(EVID, `${name}.png`), fullPage: true });
};

/** Requisições à API que falharam ou foram recusadas nesta página (para dizer o que houve quando a tela mostrar erro). */
function watch(page: Page): string[] {
  const seen: string[] = [];
  page.on('requestfailed', (r) => r.url().includes('/api/') && seen.push(`${new Date().toISOString().slice(11, 19)} FALHOU ${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`));
  page.on('response', (r) => r.url().includes('/api/') && r.status() >= 400 && seen.push(`${new Date().toISOString().slice(11, 19)} ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
  return seen;
}

/**
 * A API limita as leituras por sessão. Nada é zerado: se a tela mostrar "Tentar novamente" (leitura recusada com 429), o
 * roteiro espera como uma pessoa esperaria e usa o botão da própria tela. Cada uso é contado e vai para a evidência.
 */
let retried = 0;
const retriedAt: string[] = [];
async function settle(page: Page) {
  for (let i = 0; i < 4; i++) {
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    // o estado de erro pode aparecer um instante depois de a rede assentar
    await page.waitForTimeout(400);
    const retry = page.getByRole('button', { name: 'Tentar novamente' });
    if ((await retry.count()) === 0) return;
    retried++;
    retriedAt.push(new URL(page.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'ID'));
    await page.waitForTimeout(20_000);
    await retry.first().click().catch(() => undefined);
    await page.waitForTimeout(1_500);
  }
}
async function go(page: Page, url: string) {
  // o ritmo de uma pessoa: alguns segundos entre uma página e a seguinte
  await page.waitForTimeout(4_000);
  await page.goto(url);
  await settle(page);
}

/**
 * Abre a página do ambiente e espera o botão de criar automação. Se a tela disser que não conseguiu conferir as permissões,
 * registra o que falhou e usa o "Tentar novamente" da própria tela (uma vez), como a pessoa faria.
 */
async function openWorkspace(page: Page, url: string, seen: string[]) {
  await go(page, url);
  const create = page.getByRole('button', { name: 'Criar automação' });
  const retry = page.getByRole('button', { name: 'Tentar novamente' }).first();
  await expect(create.or(retry).first()).toBeVisible();
  if (!(await create.isVisible())) {
    log('OBSERVACAO_permissoes_nao_carregaram', { url: new URL(page.url()).pathname, falhas_recentes: seen.slice(-8) });
    await retry.click();
    if (await retry.isVisible().catch(() => false)) await retry.click().catch(() => undefined);
  }
  await expect(create).toBeVisible();
}

/** Workers > Criar Worker (sem Agent), com a navegação tolerante ao limite de rajada do laboratório. */
async function newWorker(page: Page, org: string, workerName: string) {
  await go(page, `/o/${org}/workers`);
  await page.getByRole('heading', { name: 'Workers', level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Criar Worker' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel(/^Nome do Worker/).fill(workerName);
  await dialog.getByRole('button', { name: 'Criar Worker' }).click();
}

async function createOrganization(page: Page, person: Person, name: string) {
  await go(page, '/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, person, 'Criar organização');
  await settle(page);
  await expect(page).toHaveURL(/\/organizacoes$/);
  await expect(page.getByRole('button', { name: `Entrar em ${name}` })).toBeVisible();
}

async function enter(page: Page, name: string): Promise<string> {
  await go(page, '/organizacoes');
  await page.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await settle(page);
  return /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];
}

/** Chamada à API real com a sessão de organização da página (cookie do navegador + CSRF da sessão). */
async function api(page: Page, org: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ org, method, path, body }) => {
      const headers: Record<string, string> = {};
      if (method !== 'GET') {
        const c = await (await fetch(`/api/v1/o/${org}/auth/csrf`)).json();
        headers['X-CSRF-Token'] = c.csrfToken;
        headers['Content-Type'] = 'application/json';
      }
      const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: r.status, body: parsed };
    },
    { org, method, path, body },
  );
}

/** A operadora abre a organização do cliente na tela do operador. */
async function openTarget(page: Page, orgN: string, target: string) {
  await go(page, `/o/${orgN}/operador-de-licencas`);
  await page.getByLabel('Identificador da organização').fill(target);
  await page.getByRole('button', { name: 'Abrir' }).click();
  await expect(page.getByRole('button', { name: 'Conceder licenças' })).toBeVisible();
  await settle(page);
}

async function waitPlatform(page: Page) {
  await expect
    .poll(async () => (await page.request.get('/api/v1/csrf').catch(() => null))?.status() ?? 0, { timeout: 180_000, intervals: [2_000] })
    .toBe(200);
}

// uma ação que não encontra o alvo falha em segundos, dizendo onde, em vez de esperar o tempo total do roteiro
test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('PLATFORM-LICENCIAMENTO-001: organizações por perfil, licenças pelo operador e pelo administrador, capacidade, validade e vencimento', async ({ browser }) => {
  test.setTimeout(2_400_000);
  rmSync(EVID, { recursive: true, force: true });
  log('laboratorio', readFileSync(resolve(`tools/lab/saidas/${LAB}/laboratorio.txt`), 'utf8').replace(/\n/g, ' | '));
  log('migrador', sql("SELECT 'migrations aplicadas ate ' || max(substr(c.relname, 1, 0) || '068') FROM pg_class c WHERE c.relname = 'agent_run_reconciliations'"));
  log('estado_inicial', sql("SELECT 'chave D7=' || (SELECT new_organizations_licensed FROM license_rollout) || ' limite de vazias=' || (SELECT empty_organizations_limit FROM organization_creation_settings) || ' limites tecnicos=' || (SELECT string_agg(resource_code || ':' || limit_value, ',' ORDER BY resource_code) FROM technical_capacity_limits)"));
  expect(sql('SELECT new_organizations_licensed FROM license_rollout')).toBe('f');

  const anaPage = await (await browser.newContext()).newPage();
  const anaSeen = watch(anaPage);
  const brunoPage = await (await browser.newContext()).newPage();
  const naraPage = await (await browser.newContext()).newPage();

  // ================================================================== 0. A operadora da Nekkora (preparo)
  const nara = await signUpAndEnroll(naraPage, 'lic-op');
  const operatorOrgName = `Nekkora Operação ${TAG}`;
  await createOrganization(naraPage, nara, operatorOrgName);
  const orgN = await enter(naraPage, operatorOrgName);
  // sem a organização operadora configurada, as rotas do operador não existem
  expect((await api(naraPage, orgN, 'GET', `/api/v1/o/${orgN}/license-operations/organizations/${orgN}/enforcement-preview`)).status).toBe(404);
  // PROCEDIMENTO ADMINISTRATIVO: cadastro da operadora e a organização de onde os operadores agem
  const naraUser = sql(`SELECT user_id FROM users WHERE organization_id = '${orgN}' AND email = '${nara.email}'`);
  sql(`INSERT INTO license_operators (operator_user_id, organization_id, registered_by) VALUES ('${naraUser}', '${orgN}', 'roteiro de laboratorio PLATFORM-LICENCIAMENTO-001')`);
  const env = readFileSync(SEG, 'utf8');
  writeFileSync(SEG, `${env.replace(/^LAB_LICENCAS_ORGANIZACAO_OPERADORA=.*\n/m, '')}LAB_LICENCAS_ORGANIZACAO_OPERADORA=${orgN}\n`);
  compose(LAB, ['up', '-d', '--no-deps', '--wait', 'platform'], { stdio: ['ignore', 'ignore', 'inherit'] }, ['compose.licencas.yml']);
  await waitPlatform(naraPage);
  await go(naraPage, `/o/${orgN}`);
  await expect(naraPage.getByRole('link', { name: 'Operador de licenças' })).toBeVisible();
  await go(naraPage, `/o/${orgN}/operador-de-licencas`);
  await expect(naraPage.getByRole('heading', { name: 'Criação excepcional de organização' })).toBeVisible();
  log('0_operadora', { procedimento: 'license_operators + organizacao operadora configurada; Platform recriada', organizacao: orgN, tela: 'menu "Suporte Nekkora > Operador de licencas" visivel para ela' });

  // ================================================================== A. Organizações por perfil
  // A1. recém-cadastrada cria a primeira organização direto
  const ana = await signUpAndEnroll(anaPage, 'lic-a');
  await go(anaPage, '/organizacoes');
  await expect(anaPage.getByRole('button', { name: 'Criar minha primeira organização' })).toBeVisible();
  const matrizName = `Matriz ${TAG}`;
  await createOrganization(anaPage, ana, matrizName);
  const matriz = await enter(anaPage, matrizName);
  await expect(anaPage.getByRole('link', { name: 'Operador de licenças' })).toHaveCount(0);
  await expect(anaPage.getByText('Organização aguardando ativação')).toBeVisible();
  await shot(anaPage, 'A1-inicio-modelo-anterior-aguardando-ativacao');
  log('A1_primeira_organizacao', { quem: 'Ana (recem-cadastrada)', resultado: 'criada direto', organizacao: matriz, inicio: 'modelo anterior: "aguardando ativacao"', menu_do_operador: 'ausente' });

  // ambiente e duas automações (só o nome)
  await go(anaPage, `/o/${matriz}/workspaces`);
  await anaPage.getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
  await anaPage.getByRole('alertdialog').getByLabel(/^Nome/).fill('Fiscal');
  await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
  await expect(anaPage).toHaveURL(new RegExp(`/o/${matriz}/workspaces/[0-9a-f-]{36}$`));
  await expect(anaPage.getByRole('heading', { name: 'Fiscal' })).toBeVisible();
  const workspaceUrl = anaPage.url();
  const workspaceId = /ambientes de trabalho\/([0-9a-f-]{36})/.exec(workspaceUrl)![1];
  const automationUrls: Record<string, string> = {};
  for (const name of ['Notas de entrada', 'Folha', 'Conciliação']) {
    // a primeira é criada na página em que o ambiente acabou de nascer; a segunda, abrindo o ambiente de novo
    if (name !== 'Notas de entrada') await openWorkspace(anaPage, workspaceUrl, anaSeen);
    await anaPage.getByRole('button', { name: 'Criar automação' }).click();
    await settle(anaPage);
    await anaPage.getByLabel(/^Nome da automação/).fill(name);
    await anaPage.getByRole('radio', { name: /Só o nome, como rascunho/ }).check();
    await anaPage.getByRole('button', { name: 'Salvar rascunho' }).click();
    await settle(anaPage);
    await expect(anaPage.getByRole('heading', { name })).toBeVisible();
    automationUrls[name] = anaPage.url();
  }
  const automationId = (name: string) => sql(`SELECT automation_id FROM automations WHERE organization_id = '${matriz}' AND name = '${name}'`);

  // A2. Bruno entra como membro (convite com papel de operador do ambiente)
  const bruno = await signUpAndEnroll(brunoPage, 'lic-b');
  await go(anaPage, `/o/${matriz}/administracao/convites`);
  await anaPage.getByLabel(/^E-mail da pessoa/).fill(bruno.email);
  await anaPage.getByLabel(/^Papel/).selectOption('OPERATOR');
  await anaPage.getByLabel(/^Ambiente de trabalho do papel/).selectOption(workspaceId);
  await anaPage.getByRole('button', { name: 'Convidar' }).click();
  await confirmStepUp(anaPage, ana, 'Enviar convite');
  await settle(anaPage);
  await expect(anaPage.getByText('Convite enviado.')).toBeVisible();
  const token = await waitToken('ORG_INVITATION', bruno.email);
  await go(brunoPage, 'about:blank');
  await go(brunoPage, `/o/${matriz}/convite#token=${token}`);
  await brunoPage.getByRole('button', { name: 'Aceitar convite' }).click();
  await confirmStepUp(brunoPage, bruno, 'Aceitar');
  await settle(brunoPage);
  await expect(brunoPage.getByRole('heading', { name: 'Convite aceito' })).toBeVisible();

  // A3. o membro NÃO cria: a tela explica e oferece solicitar; a criação direta é recusada pelo servidor
  await go(brunoPage, '/organizacoes');
  await expect(brunoPage.getByText('Para ter uma nova organização, solicite a quem administra a sua.')).toBeVisible();
  await expect(brunoPage.getByRole('button', { name: 'Criar organização' })).toHaveCount(0);
  await shot(brunoPage, 'A3-membro-nao-cria');
  await go(brunoPage, '/organizacoes/nova');
  await brunoPage.getByLabel(/^Nome da organização/).fill(`Direta ${TAG}`);
  await brunoPage.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(brunoPage, bruno, 'Criar organização');
  await settle(brunoPage);
  await expect(brunoPage.getByRole('alertdialog').getByText(/solicite a quem administra a sua.*Nada foi criado\./)).toBeVisible();
  await brunoPage.getByRole('alertdialog').getByRole('button', { name: /Cancelar|Fechar/ }).first().click();
  expect(sql(`SELECT count(*) FROM organizations WHERE name = 'Direta ${TAG}'`)).toBe('0');
  log('A3_membro', { quem: 'Bruno (operador de ambiente)', tela: 'sem "Criar organizacao", com "Solicitar organizacao"', criacao_direta: 'recusada pelo servidor, nada criado' });

  // A4. Bruno solicita; Ana aprova ficando ELA responsável (padrão); Bruno não recebe acesso
  const filial = `Filial Norte ${TAG}`;
  const filialDele = `Filial Sul ${TAG}`;
  for (const name of [filial, filialDele]) {
    await go(brunoPage, '/organizacoes/solicitar');
    await brunoPage.getByLabel(/^Nome da nova organização/).fill(name);
    await brunoPage.getByRole('button', { name: 'Continuar' }).click();
    await confirmStepUp(brunoPage, bruno, 'Enviar pedido');
    await settle(brunoPage);
    await expect(brunoPage.getByText('Pedido enviado.')).toBeVisible();
  }
  expect(sql(`SELECT count(*) FROM organizations WHERE name IN ('${filial}', '${filialDele}')`), 'pedir não cria nada').toBe('0');
  await go(anaPage, `/o/${matriz}/administracao/pedidos-de-organizacao`);
  await expect(anaPage.getByRole('row').filter({ hasText: filial })).toContainText('Aguardando decisão');
  await anaPage.getByRole('button', { name: `Aprovar o pedido de ${filial}` }).click();
  const approve = anaPage.getByRole('alertdialog');
  await expect(approve.getByText(/A escolha concede a administração da nova organização a essa pessoa e define de quem será contado o limite de organizações vazias/)).toBeVisible();
  await expect(approve.getByRole('radio', { name: /^Eu \(quem está aprovando\)/ })).toBeChecked();
  await expect(approve.getByText(/Só a pessoa escolhida recebe acesso à nova organização/)).toBeVisible();
  await shot(anaPage, 'A4-aprovar-escolha-do-responsavel');
  await confirmStepUp(anaPage, ana, 'Aprovar e criar a organização');
  await settle(anaPage);
  await expect(anaPage.getByText(/foi criada sob a sua administração/)).toBeVisible();
  await go(brunoPage, '/organizacoes');
  await expect(brunoPage.getByRole('button', { name: `Entrar em ${filial}` })).toHaveCount(0);
  await expect(brunoPage.getByText('A organização foi criada sob a responsabilidade de quem aprovou. Você não recebeu acesso a ela: se precisar, peça um convite.')).toBeVisible();
  log('A4_aprovacao_responsavel_aprovador', {
    banco: sql(`SELECT 'responsavel=' || (SELECT email FROM identities i WHERE i.identity_id = r.responsible_identity_id) || ' origem=' || r.source || ' contas_na_nova=' || (SELECT count(*) FROM users u WHERE u.organization_id = o.organization_id) FROM organizations o JOIN organization_responsibility r ON r.organization_id = o.organization_id WHERE o.name = '${filial}'`).replace(ana.email, 'Ana'),
    solicitante: 'sem acesso a nova organizacao',
  });

  // A5. o segundo pedido Ana entrega ao SOLICITANTE: ele passa a administrar, ela não entra
  await go(anaPage, `/o/${matriz}/administracao/pedidos-de-organizacao`);
  await anaPage.getByRole('button', { name: `Aprovar o pedido de ${filialDele}` }).click();
  await anaPage.getByRole('alertdialog').getByRole('radio', { name: /^Quem solicitou/ }).check();
  await confirmStepUp(anaPage, ana, 'Aprovar e criar a organização');
  await settle(anaPage);
  await expect(anaPage.getByText(/Você não tem acesso a ela\./)).toBeVisible();
  await go(brunoPage, '/organizacoes');
  await expect(brunoPage.getByRole('button', { name: `Entrar em ${filialDele}` })).toBeVisible();
  await go(anaPage, '/organizacoes');
  await expect(anaPage.getByRole('button', { name: `Entrar em ${filialDele}` })).toHaveCount(0);
  await expect(anaPage.getByRole('button', { name: `Entrar em ${filial}` })).toBeVisible();
  log('A5_aprovacao_responsavel_solicitante', { bruno: 'administra a Filial Sul', ana: 'sem acesso a ela' });

  // A6. limite de três organizações vazias da Ana: Filial Norte + duas novas; a Matriz tem automações e não conta
  const vazia2 = `Vazia dois ${TAG}`;
  const vazia3 = `Vazia tres ${TAG}`;
  await createOrganization(anaPage, ana, vazia2);
  await createOrganization(anaPage, ana, vazia3);
  await go(anaPage, '/organizacoes');
  await expect(anaPage.getByText('Você atingiu o limite de organizações vazias.')).toBeVisible();
  await expect(anaPage.getByText(/Organizações vazias hoje \(3 de 3\):/)).toBeVisible();
  await expect(anaPage.getByRole('button', { name: 'Criar organização' })).toHaveCount(0);
  await shot(anaPage, 'A6-limite-de-vazias');
  log('A6_limite_de_vazias', sql(`SELECT 'vazias da Ana=' || cardinality(empty_organization_ids) || '/' || empty_limit FROM (SELECT array_agg(o.organization_id) AS empty_organization_ids, (SELECT empty_organizations_limit FROM organization_creation_settings) AS empty_limit FROM organization_responsibility r JOIN organizations o ON o.organization_id = r.organization_id AND o.status = 1 JOIN identities i ON i.identity_id = r.responsible_identity_id WHERE i.email = '${ana.email}' AND NOT EXISTS (SELECT 1 FROM automations a WHERE a.organization_id = o.organization_id)) x`));

  // A7. desativar uma vazia: sai da lista de entrada, deixa de contar, e só ela reativa
  await anaPage.getByRole('button', { name: `Desativar a organização ${vazia3}` }).click();
  const off = anaPage.getByRole('alertdialog');
  await expect(off.getByText(/Nada é apagado: histórico, automações, máquinas, licenças e entregas ficam como estão\./)).toBeVisible();
  await expect(off.getByText(/Desativar não libera licença/)).toBeVisible();
  await confirmStepUp(anaPage, ana, 'Desativar organização');
  await settle(anaPage);
  await expect(anaPage.getByText(new RegExp(`Organização "${vazia3}" desativada\\.`))).toBeVisible();
  await expect(anaPage.getByRole('button', { name: `Entrar em ${vazia3}` })).toHaveCount(0);
  await expect(anaPage.getByRole('button', { name: `Reativar a organização ${vazia3}` })).toBeVisible();
  await expect(anaPage.getByRole('button', { name: 'Criar organização' })).toBeVisible();
  await shot(anaPage, 'A7-desativada-pelo-responsavel');
  log('A7_desativada', sql(`SELECT 'situacao=' || o.status || ' desativacao_aberta=' || (SELECT count(*) FROM organization_deactivations d WHERE d.organization_id = o.organization_id AND d.reactivated_at IS NULL) FROM organizations o WHERE o.name = '${vazia3}'`));
  await anaPage.getByRole('button', { name: `Reativar a organização ${vazia3}` }).click();
  await confirmStepUp(anaPage, ana, 'Reativar organização');
  await settle(anaPage);
  await expect(anaPage.getByText(new RegExp(`Organização "${vazia3}" reativada\\.`))).toBeVisible();
  await expect(anaPage.getByRole('button', { name: `Entrar em ${vazia3}` })).toBeVisible();

  // A8. BLOQUEIO DA NEKKORA (procedimento administrativo): a responsável vê, sem ação para remover
  sql(`UPDATE organizations SET status = 3 WHERE name = '${vazia2}'; INSERT INTO organization_nekkora_holds (organization_id, reason, registered_by) SELECT organization_id, 'bloqueio de ensaio do roteiro integrado', 'roteiro de laboratorio PLATFORM-LICENCIAMENTO-001' FROM organizations WHERE name = '${vazia2}'`);
  await go(anaPage, '/organizacoes');
  const blocked = anaPage.getByRole('list', { name: 'Organizações sob sua responsabilidade' }).getByRole('listitem').filter({ hasText: vazia2 });
  await expect(blocked.getByText('Bloqueada pela Nekkora', { exact: true })).toBeVisible();
  await expect(blocked.getByRole('button')).toHaveCount(0);
  await shot(anaPage, 'A8-bloqueada-pela-nekkora');
  // pela API, com a sessão e a confirmação dela: recusado, e nada muda
  const vazia2Id = sql(`SELECT organization_id FROM organizations WHERE name = '${vazia2}'`);
  const forced = await anaPage.evaluate(async (organizationId) => {
    const session = await (await fetch('/api/v1/me/session')).json();
    const r = await fetch('/api/v1/organization-reactivations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ organizationId }) });
    return { status: r.status, body: await r.text() };
  }, vazia2Id);
  expect(forced.status).toBe(409);
  expect(forced.body).toContain('organization_blocked_by_nekkora');
  expect(sql(`SELECT status FROM organizations WHERE organization_id = '${vazia2Id}'`)).toBe('3');
  log('A8_bloqueio_da_nekkora', { tela: 'Bloqueada pela Nekkora, sem botao', api: `${forced.status} ${forced.body}`, situacao: '3 (inalterada)' });

  // A9. CRIAÇÃO EXCEPCIONAL pela operadora, pela TELA: ela indica a pessoa responsável; a pessoa administra; a operadora não entra.
  //     O limite de vazias VALE por padrão; ultrapassá-lo é exceção explícita, com justificativa própria.
  //     A Ana tem duas vazias ativas (Filial Norte e Vazia três; a bloqueada não conta): a primeira criação cabe no limite.
  const excecao = `Excecao ${TAG}`;
  const excecaoAlem = `Excecao alem ${TAG}`;
  const abrirExcecao = async (nome: string) => {
    await go(naraPage, `/o/${orgN}/operador-de-licencas`);
    await naraPage.getByRole('button', { name: 'Criar organização por exceção' }).click();
    const d = naraPage.getByRole('alertdialog');
    await expect(d.getByText(/Você não recebe conta nem acesso\..*O limite de organizações vazias da pessoa continua valendo\./)).toBeVisible();
    await d.getByLabel('Nome da organização').fill(nome);
    await d.getByLabel('Razão social').fill(`${nome} Ltda`);
    await d.getByLabel('Justificativa', { exact: true }).fill('roteiro integrado: criacao excepcional a pedido do cliente');
    await expect(d.getByRole('button', { name: 'Criar a organização' })).toBeDisabled();
    await d.getByLabel('E-mail da pessoa responsável').fill(ana.email);
    return d;
  };
  let exc = await abrirExcecao(excecao);
  await shot(naraPage, 'A9-criacao-excepcional');
  await confirmStepUp(naraPage, nara, 'Criar a organização');
  await settle(naraPage);
  await expect(naraPage.getByText(/Organização criada\..*A pessoa indicada a administra; você não tem acesso a ela\./)).toBeVisible();
  await expect(naraPage.getByText(/foi ultrapassado por exceção/)).toHaveCount(0);
  await go(anaPage, '/organizacoes');
  await expect(anaPage.getByRole('button', { name: `Entrar em ${excecao}` })).toBeVisible();
  await go(naraPage, '/organizacoes');
  await expect(naraPage.getByRole('button', { name: `Entrar em ${excecao}` })).toHaveCount(0);
  // agora a Ana está no limite (3 vazias): a criação seguinte é RECUSADA, e nada é criado
  exc = await abrirExcecao(excecaoAlem);
  await confirmStepUp(naraPage, nara, 'Criar a organização');
  await expect(exc.getByText(/já está no limite de organizações vazias\..*Nada foi alterado\./)).toBeVisible();
  await shot(naraPage, 'A9-limite-de-vazias-vale-na-criacao-pela-nekkora');
  await exc.getByRole('button', { name: 'Cancelar' }).click();
  expect(sql(`SELECT count(*) FROM organizations WHERE name = '${excecaoAlem}'`), 'nada criado').toBe('0');
  // a exceção EXPLÍCITA: marcada, exige justificativa própria; fica registrada
  exc = await abrirExcecao(excecaoAlem);
  await exc.getByRole('checkbox', { name: /Ultrapassar o limite de organizações vazias desta pessoa/ }).check();
  await expect(exc.getByRole('button', { name: 'Criar a organização' })).toBeDisabled();
  await exc.getByLabel('Justificativa da exceção ao limite').fill('roteiro integrado: diretoria autorizou a quarta organizacao vazia');
  await shot(naraPage, 'A9-excecao-explicita-ao-limite');
  await confirmStepUp(naraPage, nara, 'Criar a organização');
  await settle(naraPage);
  await expect(naraPage.getByText(/O limite de organizações vazias dela foi ultrapassado por exceção, registrada com a sua justificativa\./)).toBeVisible();
  log('A9_criacao_excepcional', {
    pela_tela: 'operadora indicou a Ana como responsavel',
    no_limite: 'recusada por padrao; nada criado',
    excecao_explicita: 'criada com a opcao marcada e justificativa propria',
    banco: sql(`SELECT string_agg(o.name || ': origem=' || r.source || ' limite_ultrapassado=' || x.empty_limit_exceeded || ' justificativa_do_limite=' || coalesce(x.limit_justification, '-') || ' contas=' || (SELECT count(*) FROM users u WHERE u.organization_id = x.organization_id), ' | ' ORDER BY x.created_at) FROM organization_exceptional_creations x JOIN organization_responsibility r ON r.organization_id = x.organization_id JOIN organizations o ON o.organization_id = x.organization_id WHERE o.name IN ('${excecao}', '${excecaoAlem}')`),
    operadora: 'sem acesso as organizacoes criadas',
  });

  // ================================================================== B. Licenças
    const day = (days: number) => {
    const d = new Date(Date.now() + days * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const authorizeWorkerInWorkspace = async (worker: string) => {
    await go(anaPage, `/o/${matriz}/workers`);
    await anaPage.getByRole('button', { name: `Autorizar ${worker} num ambiente de trabalho` }).click();
    await anaPage.getByRole('alertdialog').getByLabel('Ambiente de trabalho').selectOption(workspaceId);
    await confirmStepUp(anaPage, ana, 'Autorizar');
    await settle(anaPage);
    await expect(anaPage.getByText('Worker autorizado no ambiente de trabalho.')).toBeVisible();
  };
  // B0. USO NO MODELO ANTERIOR, antes de qualquer licença: a organização já monitora a automação "Folha".
  // FIXTURE DECLARADA do laboratório (`lab.mjs limites`): limites de recursos como os de uma organização ativada pela operação
  // (a ativação real é pela CLI dos operadores e tem o próprio roteiro); sem ela a organização não cadastra Worker.
  execFileSync('node', ['tools/lab/lab.mjs', LAB, 'limites', matriz, ana.email]);
  await newWorker(anaPage, matriz, 'Worker fiscal');
  await settle(anaPage);
  await expect(anaPage.getByText('Worker Worker fiscal criado, sem Agent.', { exact: false })).toBeVisible();
  await authorizeWorkerInWorkspace('Worker fiscal');
  await go(anaPage, automationUrls['Folha']);
  await expect(anaPage.getByRole('heading', { name: 'Monitoramento de Python externo' })).toBeVisible();
  await anaPage.getByLabel(/^Worker autorizado neste ambiente de trabalho/).selectOption({ label: 'Worker fiscal' });
  await anaPage.getByLabel(/^Vale até/).fill(day(20));
  await anaPage.getByRole('button', { name: 'Autorizar monitoramento' }).click();
  await confirmStepUp(anaPage, ana, 'Autorizar monitoramento');
  await settle(anaPage);
  await expect(anaPage.getByText(/Monitoramento autorizado\. Nada foi iniciado/)).toBeVisible();
  await expect(anaPage.getByText(/A validade foi reduzida/)).toHaveCount(0);
  log('B0_uso_no_modelo_anterior', { fixture: 'limites de recursos do laboratorio (lab.mjs limites)', folha: 'monitoramento autorizado por 20 dias, sem licenca (modelo anterior)' });

  // B1. a prévia do operador, pela TELA: mostra o que ficaria impedido; nada muda
  await openTarget(naraPage, orgN, matriz);
  await expect(naraPage.getByText('Modelo anterior (exigência desligada)')).toBeVisible();
  await expect(naraPage.getByText(/1 automação\(ões\) em uso ficaria\(m\) sem licença; 1\s+autorização\(ões\) já entregue\(s\) continuaria\(m\) valendo/)).toBeVisible();
  // impedida = automação EM USO sem licença. As que nunca foram usadas não aparecem: nada pararia nelas
  await expect(naraPage.getByRole('list', { name: 'Automações em uso sem licença' })).toHaveText(/Folha \(Fiscal\)/);
  await shot(naraPage, 'B1-operador-previa');
  log('B1_previa', { pela_tela: true, modelo: 'anterior', impedidas: ['Folha'], autorizacoes_anteriores: 1 });
  // quem administra o cliente não usa as rotas do operador
  expect((await api(anaPage, matriz, 'GET', `/api/v1/o/${matriz}/license-operations/organizations/${matriz}/enforcement-preview`)).status).toBe(404);

  // B2. a operadora concede duas licenças de 30 dias, pela TELA (justificativa e confirmação reforçada)
  const until = new Date(`${day(30)}T23:59:59`).toISOString();
  await naraPage.getByRole('button', { name: 'Conceder licenças' }).click();
  const grant = naraPage.getByRole('alertdialog');
  await grant.getByLabel('Quantidade').fill('2');
  await grant.getByLabel('Início da validade').fill(day(0));
  await grant.getByLabel('Fim da validade').fill(day(30));
  await expect(grant.getByRole('button', { name: 'Conceder' })).toBeDisabled();
  await grant.getByLabel('Justificativa').fill('roteiro integrado: contratacao de duas licencas');
  await confirmStepUp(naraPage, nara, 'Conceder');
  await settle(naraPage);
  await expect(naraPage.getByText(/Licenças concedidas\. Elas nascem sem vínculo/)).toBeVisible();
  await expect(naraPage.getByRole('region', { name: 'Lista de licenças da organização' }).getByText('sem vínculo')).toHaveCount(2);
  const l1 = sql(`SELECT license_id FROM organization_licenses WHERE organization_id = '${matriz}' AND license_number = 1`);
  const l2 = sql(`SELECT license_id FROM organization_licenses WHERE organization_id = '${matriz}' AND license_number = 2`);
  log('B2_concessao', { pela_tela: true, licencas: 2, ate: until.slice(0, 10) });

  // B3. a administradora vê as licenças e vincula a nº 1 a uma automação, pela tela
  await go(anaPage, `/o/${matriz}/administracao/licencas`);
  await expect(anaPage.getByText('Esta organização ainda não exige licença.')).toBeVisible();
  const count = anaPage.getByRole('group', { name: 'Conta das licenças' });
  await expect(count).toContainText(/Contratadas \(vigentes\)\s*2/);
  await expect(count).toContainText(/Disponíveis \(sem automação\)\s*2/);
  await anaPage.getByRole('button', { name: 'Vincular à automação a licença nº 1' }).click();
  const assign = anaPage.getByRole('alertdialog');
  await assign.getByLabel('Automação que vai usar esta licença').selectOption({ label: 'Notas de entrada · Fiscal' });
  await expect(assign.getByText('Você não desfaz este vínculo por aqui.')).toBeVisible();
  await confirmStepUp(anaPage, ana, 'Vincular licença');
  await settle(anaPage);
  await expect(anaPage.getByText("Licença nº 1 vinculada a Notas de entrada.", { exact: false })).toBeVisible();
  await expect(count).toContainText(/Utilizadas \(com automação\)\s*1/);
  await shot(anaPage, 'B3-licencas-modelo-anterior');
  log('B3_vinculo_pela_administradora', sql(`SELECT 'licenca ' || l.license_number || ' -> ' || a.name FROM organization_license_assignments s JOIN organization_licenses l ON l.license_id = s.license_id JOIN automations a ON a.automation_id = s.automation_id WHERE s.organization_id = '${matriz}' AND s.released_at IS NULL`));

  // B4. ligar a exigência, pela TELA. A tela da operadora ainda mostra a prévia de ANTES do vínculo da Ana: o servidor recusa
  //     (o conjunto mudou), a tela refaz a prévia, e com ela conferida de novo a exigência liga
  await naraPage.getByRole('button', { name: 'Ligar a exigência de licença' }).click();
  let enforce = naraPage.getByRole('alertdialog');
  await expect(enforce.getByText(/Autorizações já entregues continuam valendo sem conexão até a validade/)).toBeVisible();
  await expect(enforce.getByRole('list', { name: 'Automações que ficariam sem trabalho novo' })).toHaveText(/Folha \(Fiscal\)/);
  await enforce.getByLabel('Justificativa').fill('roteiro integrado: ligar com a previa antiga');
  await expect(enforce.getByRole('button', { name: 'Ligar a exigência' })).toBeDisabled();
  await enforce.getByRole('checkbox', { name: /Conferi a prévia/ }).check();
  await confirmStepUp(naraPage, nara, 'Ligar a exigência');
  await expect(enforce.getByText(/O conjunto de automações mudou desde a prévia\..*Nada foi alterado\./)).toBeVisible();
  await shot(naraPage, 'B4-previa-antiga-recusada');
  await enforce.getByRole('button', { name: /Cancelar|Fechar/ }).first().click();
  expect(sql(`SELECT public.license_model('${matriz}')`), 'nada mudou').toBe('1');
  await settle(naraPage);
  await expect(naraPage.getByRole('region', { name: 'Lista de licenças da organização' }).getByText('Notas de entrada')).toBeVisible();
  await naraPage.getByRole('button', { name: 'Ligar a exigência de licença' }).click();
  enforce = naraPage.getByRole('alertdialog');
  await enforce.getByLabel('Justificativa').fill('roteiro integrado: exigencia ligada apos a previa conferida');
  await enforce.getByRole('checkbox', { name: /Conferi a prévia/ }).check();
  await confirmStepUp(naraPage, nara, 'Ligar a exigência');
  await settle(naraPage);
  await expect(naraPage.getByText('Exigência de licença ligada.')).toBeVisible();
  await expect(naraPage.getByText('Modelo por licença (exigência ligada)')).toBeVisible();
  log('B4_exigencia', { pela_tela: true, previa_antiga: 'recusada: o conjunto mudou; nada alterado', previa_refeita: { impedidas: ['Folha'], cobertas: ['Notas de entrada'] }, ligada: sql(`SELECT public.license_model('${matriz}')`) });

  // B4b. os textos acompanham o modelo: nada de "aguardando ativação" para quem já pode registrar Workers
  await go(anaPage, `/o/${matriz}`);
  await expect(anaPage.getByText('Organização aguardando ativação')).toHaveCount(0);
  await expect(anaPage.getByText(/Esta organização usa o modelo por licença: Workers podem ser registrados dentro do limite técnico/)).toBeVisible();
  await shot(anaPage, 'B4b-inicio-modelo-por-licenca');
  await go(anaPage, '/organizacoes');
  const matrizItem = anaPage.getByRole('list', { name: 'Organizações' }).getByRole('listitem').filter({ hasText: matrizName });
  await expect(matrizItem.getByText('Execução: por licença', { exact: true })).toBeVisible();
  await expect(matrizItem.getByText('Aguardando ativação')).toHaveCount(0);
  await expect(matrizItem.getByText(/nenhum Worker pode ser registrado/)).toHaveCount(0);
  await shot(anaPage, 'B4b-organizacoes-modelo-por-licenca');
  await anaPage.getByRole('button', { name: `Entrar em ${matrizName}` }).click();
  await expect(anaPage).toHaveURL(new RegExp(`/o/${matriz}$`));
  log('B4b_textos_por_modelo', { inicio: 'sem "aguardando ativacao"; diz modelo por licenca', lista: 'selo "Modelo por licenca"; a ativacao da operacao continua em ' + sql(`SELECT state FROM ops_activation.organization_states WHERE organization_id = '${matriz}'`) + ' (aguardando), sem efeito' });

  // B5. a tela passa a dizer que a organização exige licença, e mostra a capacidade em seção própria
  await go(anaPage, `/o/${matriz}/administracao/licencas`);
  await expect(anaPage.getByText('Esta organização exige licença.')).toBeVisible();
  const capacity = anaPage.getByRole('group', { name: 'Capacidade técnica' });
  await expect(capacity).toContainText(/Workers cadastrados\s*1 de 50/);
  await expect(capacity).toContainText(/Execuções simultâneas\s*0 de 5/);
  await expect(capacity).toContainText(/Execuções pendentes \(na fila\)\s*0 de 50/);
  await expect(anaPage.getByText(/Não são contratados e não têm relação com a quantidade de licenças/)).toBeVisible();

  // B6. capacidade no lugar da ativação: a organização (nunca ativada) cadastra um Worker
  await newWorker(anaPage, matriz, 'Worker dois');
  await settle(anaPage);
  await expect(anaPage.getByText('Worker Worker dois criado, sem Agent.', { exact: false })).toBeVisible();
  await authorizeWorkerInWorkspace('Worker dois');
  await go(anaPage, `/o/${matriz}/administracao/licencas`);
  await expect(anaPage.getByRole('group', { name: 'Capacidade técnica' })).toContainText(/Workers cadastrados\s*2 de 50/);
  await shot(anaPage, 'B6-licencas-e-capacidade');
  log('B6_capacidade', { workers: '2 de 50 (limite tecnico)', transicao: sql(`SELECT 'autorizacao da Folha anterior ao modelo continua valida ate ' || to_char(valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM local_run_authorizations WHERE organization_id = '${matriz}' AND automation_id = '${automationId('Folha')}' AND revoked_at IS NULL`) });

  // B7. VALIDADE REDUZIDA: a autorização pedida para 90 dias sai até o fim da licença (30), e a tela diz a data e o motivo
  await go(anaPage, automationUrls['Notas de entrada']);
  await expect(anaPage.getByRole('heading', { name: 'Monitoramento de Python externo' })).toBeVisible();
  await anaPage.getByLabel(/^Worker autorizado neste ambiente de trabalho/).selectOption({ label: 'Worker fiscal' });
  await anaPage.getByLabel(/^Vale até/).fill(day(90));
  await anaPage.getByRole('button', { name: 'Autorizar monitoramento' }).click();
  await confirmStepUp(anaPage, ana, 'Autorizar monitoramento');
  await settle(anaPage);
  const reduced = anaPage.getByText(/A validade foi reduzida porque a licença desta automação termina nessa data/);
  await expect(reduced).toBeVisible();
  const limit = new Date(until).toLocaleDateString('pt-BR');
  await expect(reduced).toContainText(`A autorização vale até ${limit}`);
  await shot(anaPage, 'B7-validade-reduzida');
  log('B7_validade_reduzida', { pedida: day(90), efetiva: sql(`SELECT to_char(valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM local_run_authorizations WHERE organization_id = '${matriz}' AND automation_id = '${automationId('Notas de entrada')}'`), fim_da_licenca: until.slice(0, 10), tela: 'data efetiva e motivo exibidos' });

  // B8. automação SEM licença: a autorização é recusada com o motivo de licença (não de capacidade)
  await go(anaPage, automationUrls['Conciliação']);
  await anaPage.getByLabel(/^Worker autorizado neste ambiente de trabalho/).selectOption({ label: 'Worker fiscal' });
  await anaPage.getByLabel(/^Vale até/).fill(day(10));
  await anaPage.getByRole('button', { name: 'Autorizar monitoramento' }).click();
  await confirmStepUp(anaPage, ana, 'Autorizar monitoramento');
  await settle(anaPage);
  await expect(anaPage.getByRole('alertdialog').getByText(/Esta automação não tem licença\..*Nada foi alterado\./)).toBeVisible();
  await shot(anaPage, 'B8-sem-licenca');
  await anaPage.getByRole('alertdialog').getByRole('button', { name: /Cancelar|Fechar/ }).first().click();
  expect(sql(`SELECT count(*) FROM local_run_authorizations WHERE automation_id = '${automationId('Conciliação')}'`)).toBe('0');
  log('B8_sem_licenca', { automacao: 'Conciliação', resultado: 'autorizacao recusada: sem licenca; nada gravado' });

  // B9. TRANSFERÊNCIA pela operadora, pela TELA, a pedido da administradora.
  // FIXTURE DECLARADA: uma sessão do Agent anterior em RESULTADO DESCONHECIDO na automação de origem, gravada direto no banco
  // (não há Agent anterior neste laboratório). Ela não comprova o término: segura a transferência até a reconciliação.
  const cycle = sql(`SELECT string_agg(period_number || ':' || starts_at || ':' || ends_at, ',' ORDER BY period_number) FROM organization_license_periods WHERE license_id = '${l1}'`);
  sql(`SET session_replication_role = replica; INSERT INTO agent_runs (organization_id, workspace_id, automation_id, automation_version_id, authorization_id, agent_id, worker_id, worker_agent_assignment_id, agent_execution_id, package_fingerprint, authorization_state_at_registration, supervisor_state, last_report_at) VALUES ('${matriz}', '${workspaceId}', '${automationId('Notas de entrada')}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'ex-' || repeat('9', 32), repeat('a', 64), 1, 9, clock_timestamp() - interval '2 days')`);
  const transfer = async (requester: string) => {
    await naraPage.getByRole('button', { name: 'Transferir a licença nº 1' }).click();
    const d = naraPage.getByRole('alertdialog');
    await expect(d.getByText(/Você atesta o pedido: o solicitante, o chamado e como a identidade foi verificada ficam gravados/)).toBeVisible();
    await d.getByLabel('Automação de destino').selectOption({ label: 'Folha' });
    await d.getByLabel('E-mail do administrador que pediu').fill(requester);
    await d.getByLabel('Como a identidade do solicitante foi verificada').fill('retorno por telefone ao numero do cadastro');
    await d.getByLabel('Justificativa').fill('roteiro integrado: a automacao foi substituida');
    // sem a referência do chamado a tela não deixa enviar
    await expect(d.getByRole('button', { name: 'Transferir' })).toBeDisabled();
    await d.getByLabel('Referência do chamado').fill('CH-LAB-0001');
    await confirmStepUp(naraPage, nara, 'Transferir');
    return d;
  };
  // o resultado desconhecido RESERVA uma vaga: a administradora vê a reserva à parte das execuções ativas
  await go(anaPage, `/o/${matriz}/administracao/licencas`);
  const capB9 = anaPage.getByRole('group', { name: 'Capacidade técnica' });
  await expect(capB9).toContainText(/Execuções simultâneas\s*1 de 5/);
  await expect(capB9).toContainText('Em execução: 0');
  await expect(capB9).toContainText('Reservadas por situação incerta: 1 (1 com resultado desconhecido (Agent anterior))');
  await expect(anaPage.getByText('Há execução do Agent anterior com resultado desconhecido reservando vaga.')).toBeVisible();
  await shot(anaPage, 'B9-reserva-por-resultado-desconhecido');
  await openTarget(naraPage, orgN, matriz);
  const sessions = naraPage.getByRole('region', { name: 'Lista de sessões sem desfecho' });
  await expect(sessions.getByRole('row').filter({ hasText: 'Notas de entrada' })).toContainText('Resultado desconhecido');
  // (a) solicitante que não administra a organização
  let t = await transfer(bruno.email);
  await expect(t.getByText(/O solicitante informado não administra esta organização agora\..*Nada foi alterado\./)).toBeVisible();
  await t.getByRole('button', { name: /Cancelar|Fechar/ }).first().click();
  // (b) pode existir trabalho na origem: a sessão de resultado desconhecido segura
  t = await transfer(ana.email);
  await expect(t.getByText(/sessão do Agent anterior sem desfecho confiável.*Nada foi alterado\./)).toBeVisible();
  await shot(naraPage, 'B9-transferencia-segura-por-resultado-desconhecido');
  await t.getByRole('button', { name: /Cancelar|Fechar/ }).first().click();
  expect(sql(`SELECT a.name FROM organization_license_assignments s JOIN automations a ON a.automation_id = s.automation_id WHERE s.license_id = '${l1}' AND s.released_at IS NULL`), 'nada mudou').toBe('Notas de entrada');
  // (c) RECONCILIAÇÃO pelo suporte: justificativa, verificação realizada e a afirmação explícita; a sessão não muda
  await naraPage.getByRole('button', { name: 'Reconciliar a sessão de Notas de entrada' }).click();
  const rec = naraPage.getByRole('alertdialog');
  await expect(rec.getByText(/Ela não altera a sessão: o estado continua o que a máquina informou, nenhum desfecho é gravado e nada declara a máquina livre/)).toBeVisible();
  await rec.getByLabel('Justificativa').fill('roteiro integrado: chamado CH-LAB-0001, maquina substituida pelo cliente');
  await expect(rec.getByRole('button', { name: 'Registrar a reconciliação' })).toBeDisabled();
  await rec.getByLabel('Verificação realizada').fill('cliente confirmou por escrito que o computador antigo foi formatado');
  await expect(rec.getByRole('button', { name: 'Registrar a reconciliação' })).toBeDisabled();
  await rec.getByRole('checkbox', { name: /Verifiquei, fora do sistema/ }).check();
  await shot(naraPage, 'B9-reconciliacao');
  await confirmStepUp(naraPage, nara, 'Registrar a reconciliação');
  await settle(naraPage);
  await expect(naraPage.getByText(/Reconciliação registrada\. A sessão não foi alterada/)).toBeVisible();
  await expect(naraPage.getByText('Nenhuma sessão sem desfecho nesta organização.')).toBeVisible();
  const reconciled = sql(`SELECT 'estado_da_sessao=' || r.supervisor_state || ' (9 = resultado desconhecido, inalterado) fim_gravado=' || (r.agent_ended_at IS NOT NULL) || ' operador=' || (c.operator_user_id IS NOT NULL) || ' verificacao=' || c.verification FROM agent_run_reconciliations c JOIN agent_runs r ON r.agent_run_id = c.agent_run_id WHERE c.organization_id = '${matriz}'`);
  expect(reconciled).toContain('estado_da_sessao=9');
  expect(sql(`SELECT concurrent_previous_agent_uncertain FROM public.capacity_state('${matriz}')`), 'reconciliada: a reserva sai').toBe('0');
  // (d) agora a transferência passa; o ciclo não muda
  t = await transfer(ana.email);
  await settle(naraPage);
  await expect(naraPage.getByText('Licença transferida. O fim do ciclo não mudou.')).toBeVisible();
  expect(sql(`SELECT string_agg(period_number || ':' || starts_at || ':' || ends_at, ',' ORDER BY period_number) FROM organization_license_periods WHERE license_id = '${l1}'`), 'fim do ciclo preservado').toBe(cycle);
  await go(anaPage, `/o/${matriz}/administracao/licencas`);
  await expect(anaPage.getByRole('row').filter({ hasText: 'nº 1' })).toContainText('Folha');
  log('B9_transferencia', {
    pela_tela: true,
    sem_chamado: 'a tela nao deixa enviar',
    solicitante_nao_administra: 'recusada',
    resultado_desconhecido: 'segurou a transferencia e reservou uma vaga, mostrada a parte (fixture declarada)',
    reconciliacao: reconciled,
    transferida: 'Notas de entrada -> Folha',
    trilha: sql(`SELECT 'chamado=' || (detail->>'ticket') || ' verificacao=' || (detail->>'identityCheck') || ' solicitante=' || (requester_membership_id IS NOT NULL) || ' operador=' || (operator_user_id IS NOT NULL) FROM organization_license_acts WHERE license_id = '${l1}' AND act = 5`),
    ciclo: 'inalterado',
  });

  // B10. VENCIMENTO (passagem do tempo simulada no banco do laboratório): a tela avisa, e trabalho novo é recusado
  sql(`SET session_replication_role = replica; UPDATE organization_license_periods SET ends_at = clock_timestamp() WHERE license_id = '${l1}'`);
  await go(anaPage, `/o/${matriz}/administracao/licencas`);
  await expect(anaPage.getByText('Uma licença vencida continua vinculada a uma automação.')).toBeVisible();
  await expect(anaPage.getByRole('row').filter({ hasText: 'nº 1' })).toContainText('Vencida');
  await shot(anaPage, 'B10-licenca-vencida');
  await go(anaPage, automationUrls['Folha']);
  await anaPage.getByLabel(/^Worker autorizado neste ambiente de trabalho/).selectOption({ label: 'Worker dois' });
  await anaPage.getByLabel(/^Vale até/).fill(day(10));
  await anaPage.getByRole('button', { name: 'Autorizar monitoramento' }).click();
  await confirmStepUp(anaPage, ana, 'Autorizar monitoramento');
  await settle(anaPage);
  await expect(anaPage.getByRole('alertdialog').getByText(/A licença desta automação venceu\./)).toBeVisible();
  await anaPage.getByRole('alertdialog').getByRole('button', { name: /Cancelar|Fechar/ }).first().click();
  // o histórico continua legível: a autorização emitida antes continua na lista da outra automação
  await go(anaPage, automationUrls['Notas de entrada']);
  await expect(anaPage.getByRole('region', { name: 'Autorizações de execução local' })).toContainText('Worker fiscal');
  log('B10_vencimento', { tela: 'licenca vencida avisada', trabalho_novo: 'recusado: licenca vencida', historico: 'legivel' });

  // B11. a operadora renova, pela TELA: a mesma automação continua vinculada (não precisa vincular de novo)
  await openTarget(naraPage, orgN, matriz);
  await expect(naraPage.getByRole('region', { name: 'Lista de licenças da organização' }).getByRole('row').filter({ hasText: 'nº 1' })).toContainText('Sem período vigente');
  await naraPage.getByRole('button', { name: 'Renovar a licença nº 1' }).click();
  const renew = naraPage.getByRole('alertdialog');
  await renew.getByLabel('Fim do novo período').fill(day(30));
  await renew.getByLabel('Justificativa').fill('roteiro integrado: renovacao do ciclo');
  await confirmStepUp(naraPage, nara, 'Renovar');
  await settle(naraPage);
  await expect(naraPage.getByText('Licença renovada. O vínculo com a automação não muda.')).toBeVisible();
  const renewedRow = naraPage.getByRole('region', { name: 'Lista de licenças da organização' }).getByRole('row').filter({ hasText: 'nº 1' });
  await expect(renewedRow).toContainText('Vigente');
  await expect(renewedRow).toContainText('Folha');
  log('B11_renovacao', { pela_tela: true, licenca: 'nº 1 vigente de novo', vinculo: 'Folha (inalterado)' });
  expect(l2).toBeTruthy();

  // ================================================================== C. D7 — organizações novas no modelo por licença
  sql(`UPDATE license_rollout SET new_organizations_licensed = true, updated_by = 'roteiro de laboratorio PLATFORM-LICENCIAMENTO-001', updated_at = clock_timestamp()`);
  try {
    const born = `Nascida licenciada ${TAG}`;
    await createOrganization(brunoPage, bruno, born);
    await go(brunoPage, '/organizacoes');
    const bornItem = brunoPage.getByRole('list', { name: 'Organizações' }).getByRole('listitem').filter({ hasText: born });
    await expect(bornItem.getByText('Execução: por licença', { exact: true })).toBeVisible();
    await expect(bornItem.getByText(/nenhum Worker pode ser registrado/)).toHaveCount(0);
    const bornId = await enter(brunoPage, born);
    await go(brunoPage, `/o/${bornId}/administracao/licencas`);
    await expect(brunoPage.getByText('Esta organização exige licença.')).toBeVisible();
    await expect(brunoPage.getByText('Esta organização ainda não tem licenças.')).toBeVisible();
    await expect(brunoPage.getByRole('group', { name: 'Capacidade técnica' })).toContainText(/Workers cadastrados\s*0 de 50/);
    await shot(brunoPage, 'C-organizacao-nascida-no-modelo-por-licenca');
    // capacidade no lugar da ativação: nunca ativada, sem fixture nenhuma, ela cadastra um Worker (limite técnico)
    await newWorker(brunoPage, bornId, 'Worker novo');
    await settle(brunoPage);
    await expect(brunoPage.getByText('Worker Worker novo criado, sem Agent.', { exact: false })).toBeVisible();
    expect(sql(`SELECT state FROM ops_activation.organization_states WHERE organization_id = '${bornId}'`), 'continua aguardando ativação: nada foi ativado').toBe('1');
    log('C_D7', {
      chave: 'ligada por procedimento',
      worker_sem_ativacao: 'cadastrado pelo limite tecnico; ativacao continua "aguardando"',
      organizacao_nova: sql(`SELECT 'modelo=' || e.model || ' ato=' || a.act || ' autorizado_por=' || (a.detail->>'rolloutAuthorizedBy') FROM organization_license_enforcement e JOIN organization_license_acts a ON a.act_id = e.act_id WHERE e.organization_id = '${bornId}'`),
      existentes: sql(`SELECT 'Filial Sul sem modelo registrado=' || (count(*) = 0) FROM organization_license_enforcement e JOIN organizations o ON o.organization_id = e.organization_id WHERE o.name = '${filialDele}'`),
    });
  } finally {
    sql(`UPDATE license_rollout SET new_organizations_licensed = false, updated_by = 'roteiro de laboratorio (chave devolvida)', updated_at = clock_timestamp()`);
  }
  expect(sql('SELECT new_organizations_licensed FROM license_rollout')).toBe('f');
  log('limites_de_frequencia', `nenhum limite foi zerado. "Tentar novamente" usado ${retried} vez(es)${retried ? ` em: ${retriedAt.join(', ')}` : ''}`);
  log('fim', 'roteiro integrado (navegador) concluido, com a Web de producao e sem zerar limites de frequencia');
});
