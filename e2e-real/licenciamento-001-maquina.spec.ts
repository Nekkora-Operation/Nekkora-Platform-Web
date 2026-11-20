import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { Authenticator } from '../mock/totp';
import { confirmStepUp, LAB, newVersionWithPackage, signInWithTotp, signUpAndEnroll, type Person } from './support/lab';

/**
 * PLATFORM-LICENCIAMENTO-001 — ROTEIRO DA MÁQUINA: a Web de produção, a API real do laboratório descartável e o EXECUTÁVEL
 * EMPACOTADO do Agent Client (cópia de laboratório do pacote gerado da branch da missão), numa organização do modelo por
 * licença. Fluxo: licença vinculada → execução → registros e resultado → vencimento → recusa de trabalho novo, preservando a
 * entrega do que já estava autorizado. E, no caminho: autorizar a versão no mesmo passo de solicitar, "Aguardando vaga",
 * a reconciliação que libera a vaga, e as mensagens do aplicativo na janela real.
 *
 * COMO O EXECUTÁVEL É CONDUZIDO: a cópia de laboratório do pacote abre a JANELA REAL do aplicativo; um condutor, dentro do
 * mesmo processo, aciona os botões reais (doClick, setText) e lê os textos da tela (getText). Nenhuma tecla global, nenhum
 * Robot, nenhuma automação de interface do sistema. Ninguém entra no aplicativo: habilitar a máquina é um ato da máquina.
 * O condutor e a ponte ficam FORA do repositório e do pacote (licenciamento-001/exe/src). O `mainclass` normal não é o que
 * roda nesta cópia: o condutor monta a mesma janela e as mesmas ligações do ClientMain.
 *
 * PROCEDIMENTOS ADMINISTRATIVOS por SQL no laboratório, registrados: cadastro da operadora; limite técnico de execuções
 * simultâneas e de Workers (para chegar ao limite com uma máquina só); a "passagem do tempo" que vence a licença.
 * FIXTURES DECLARADAS: uma sessão do Agent anterior sem encerramento (não há Agent anterior no laboratório), que ocupa a vaga;
 * e um gatilho de laboratório que vence a licença no instante em que a máquina começa a preparar uma tentativa (para a recusa
 * acontecer entre o recebimento e o início, que é quando o aplicativo é avisado).
 *
 * Nenhum limite de frequência é zerado. O produto aceita 10 cadastros por endereço por hora, e no laboratório todas as pessoas
 * saem do mesmo endereço: por isso, numa repetição, o roteiro ENTRA com as duas pessoas sintéticas da passada anterior (guardadas
 * na pasta de segredos do laboratório, fora dos repositórios) em vez de cadastrar outras, e a organização nova da cliente é
 * criada pela operadora, por exceção, com a cliente como responsável.
 *
 *   FRONT_LAB_ID=frontlab-lic003 FRONT_PORTA=5192 npx playwright test -c playwright.real.config.ts licenciamento-001-maquina
 */
const DIR = resolve(process.cwd(), '../exe/maquina');
const SAIDA = resolve(DIR, 'saida/exe-1.jsonl');
const COMANDO = resolve(DIR, 'saida/comando.txt');
const CODIGO = resolve(DIR, 'saida/codigo.txt');
const PYLAB = resolve(process.cwd(), '../../client-preparacao-002/lab');
const RAPIDO = resolve(process.cwd(), '../exe/robo-licenca-rapido.zip');
const LONGO = resolve(process.cwd(), '../exe/robo-licenca-longo.zip');
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-licenciamento-001-maquina`);
const SEG = join(homedir(), '.nekkora', 'front-lab', LAB, 'segredos.env');
const PESSOAS = join(homedir(), '.nekkora', 'front-lab', LAB, 'pessoas-roteiro-maquina.json');
type Guardadas = { nara: Guardada; ana: Guardada; orgN: string };
type Guardada = { email: string; password: string; name: string; secret: string };
const guardar = (x: Person): Guardada => ({ email: x.email, password: x.password, name: x.name, secret: (x.auth as unknown as { secret: string }).secret });
const reviver = (g: Guardada): Person => ({ email: g.email, password: g.password, name: g.name, auth: new Authenticator(g.secret), recoveryCodes: [] });
const TAG = Date.now().toString(36);
const WORKER = 'Worker da fabrica';
const MAQUINA = 'PC sintetico da fabrica';
const AUTOMACAO = 'Robo de notas';

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
const day = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ------------------------------------------------------------------ o executável empacotado
type Linha = Record<string, unknown>;
const linhas = (): Linha[] =>
  existsSync(SAIDA)
    ? readFileSync(SAIDA, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Linha)
    : [];
let exe: ChildProcess | null = null;
/** Abre a cópia de laboratório do executável. Só o PATH deste processo ganha os dois ambientes virtuais sintéticos. */
async function aberto(): Promise<Linha> {
  const antes = linhas().length;
  const env = { ...process.env };
  const chave = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  env[chave] = [resolve(PYLAB, 'projeto-robo/.venv/Scripts'), resolve(PYLAB, 'ambiente-sem-dependencia/Scripts'), env[chave] ?? ''].join(';');
  exe = spawn(resolve(DIR, 'app/Nekkora Agent Client.exe'), [], { detached: false, stdio: 'ignore', env });
  await expect.poll(() => linhas().length > antes, { timeout: 90_000, intervals: [300] }).toBe(true);
  const l = linhas()[antes];
  expect(l.erro ?? null, JSON.stringify(l)).toBeNull();
  return l;
}
async function comando(c: string, codigo?: string): Promise<Linha> {
  const antes = linhas().length;
  if (codigo) writeFileSync(CODIGO, codigo);
  writeFileSync(COMANDO, c);
  await expect.poll(() => linhas().length > antes || linhas().some((l) => l.etapa === 'falha'), { timeout: 240_000, intervals: [300] }).toBe(true);
  const l = linhas()[antes] ?? linhas().find((x) => x.etapa === 'falha')!;
  expect(existsSync(CODIGO), 'o código é apagado pelo aplicativo ao ser lido').toBe(false);
  expect(l.erroDoRoteiro ?? l.erro ?? null, JSON.stringify(l)).toBeNull();
  return l;
}
async function fecharExe() {
  if (!exe) return;
  writeFileSync(COMANDO, 'sair');
  await expect.poll(() => linhas().some((l, i) => l.etapa === 'fim' && i === linhas().length - 1), { timeout: 120_000 }).toBe(true);
  exe.kill();
  exe = null;
}
/** As capturas que o próprio aplicativo fez da janela dele (renderização da janela real, sem captura de tela do sistema). */
function guardarJanelas(prefixo: string) {
  mkdirSync(EVID, { recursive: true });
  for (const f of readdirSync(resolve(DIR, 'saida')).filter((n) => n.endsWith('.png'))) copyFileSync(resolve(DIR, 'saida', f), join(EVID, `${prefixo}-${f}`));
}

// ------------------------------------------------------------------ a Web
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
async function reler(page: Page) {
  await page.waitForTimeout(4_000);
  await page.reload();
  await settle(page);
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
/** Chamada à API real com a sessão de organização da página (para conferir que a recusa é do SERVIDOR, não só da tela). */
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

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('PLATFORM-LICENCIAMENTO-001 com o Client empacotado: licença → execução → registros e resultado → vaga → vencimento → recusa', async ({ browser }) => {
  test.setTimeout(3_300_000);
  expect(DIR.replace(/\\/g, '/'), 'só a cópia de laboratório desta missão').toMatch(/licenciamento-001\/exe\/maquina$/);
  rmSync(EVID, { recursive: true, force: true });
  // pasta de dados e saída da CÓPIA de laboratório, vazias (nunca a pasta de dados de um aplicativo instalado)
  rmSync(resolve(DIR, 'dados'), { recursive: true, force: true });
  rmSync(resolve(DIR, 'saida'), { recursive: true, force: true });
  mkdirSync(resolve(DIR, 'dados'), { recursive: true });
  mkdirSync(resolve(DIR, 'saida'), { recursive: true });
  log('laboratorio', readFileSync(resolve(`tools/lab/saidas/${LAB}/laboratorio.txt`), 'utf8').replace(/\n/g, ' | '));
  log('pacote_do_client', readFileSync(resolve(DIR, 'app/VERSOES.txt'), 'utf8').split('\n').slice(0, 3).join(' | '));

  const anaPage = await (await browser.newContext()).newPage();
  const naraPage = await (await browser.newContext()).newPage();
  const limits = { restored: false };
  const restoreLimits = () => {
    if (limits.restored) return;
    sql(`UPDATE technical_capacity_limits SET limit_value = CASE resource_code WHEN 1 THEN 50 WHEN 2 THEN 5 ELSE 50 END, updated_by = 'roteiro da maquina (limites devolvidos)'`);
    sql('DROP TRIGGER IF EXISTS trg_lab_expire_on_preparing ON public.remote_attempts; DROP FUNCTION IF EXISTS public.lab_expire_on_preparing()');
    limits.restored = true;
  };

  try {
    // ================================================================ 0. o aplicativo empacotado, como sai do pacote
    let l = await aberto();
    expect(l.estado, 'cópia nova: máquina ainda não habilitada').toBe('NOT_ENABLED');
    expect(l.executa, 'o aplicativo empacotado executa o que a Platform solicitar').toBe(true);
    log('0_aplicativo', { versao: l.versao, estado: l.estado, entrou_alguem: l.entrou, janela: 'real, conduzida por dentro do processo' });

    // ================================================================ 1. a operadora (preparo) e a organização da cliente
    const fabricaName = `Fabrica ${TAG}`;
    let nara: Person;
    let ana: Person;
    let orgN: string;
    let fabrica: string;
    const configurarOperadora = async () => {
      const env = readFileSync(SEG, 'utf8');
      if (new RegExp(`^LAB_LICENCAS_ORGANIZACAO_OPERADORA=${orgN}$`, 'm').test(env)) return;
      writeFileSync(SEG, `${env.replace(/^LAB_LICENCAS_ORGANIZACAO_OPERADORA=.*\n/m, '')}LAB_LICENCAS_ORGANIZACAO_OPERADORA=${orgN}\n`);
      compose(LAB, ['up', '-d', '--no-deps', '--wait', 'platform'], { stdio: ['ignore', 'ignore', 'inherit'] }, ['compose.licencas.yml']);
      await waitPlatform(naraPage);
    };
    if (!existsSync(PESSOAS)) {
      // primeira passada: as duas pessoas se cadastram; a cliente cria a própria organização
      nara = await signUpAndEnroll(naraPage, 'licm-op');
      const operatorOrgName = `Nekkora Suporte ${TAG}`;
      await createOrganization(naraPage, nara, operatorOrgName);
      orgN = await enter(naraPage, operatorOrgName);
      const naraUser = sql(`SELECT user_id FROM users WHERE organization_id = '${orgN}' AND email = '${nara.email}'`);
      sql(`INSERT INTO license_operators (operator_user_id, organization_id, registered_by) VALUES ('${naraUser}', '${orgN}', 'roteiro da maquina PLATFORM-LICENCIAMENTO-001')`);
      await configurarOperadora();
      ana = await signUpAndEnroll(anaPage, 'licm-a');
      writeFileSync(PESSOAS, JSON.stringify({ nara: guardar(nara), ana: guardar(ana), orgN } satisfies Guardadas));
      await createOrganization(anaPage, ana, fabricaName);
      fabrica = await enter(anaPage, fabricaName);
      log('1_pessoas', 'cadastradas nesta passada; a cliente criou a propria organizacao');
    } else {
      // repetição: as mesmas pessoas sintéticas entram; a organização nova nasce por CRIAÇÃO EXCEPCIONAL, pela tela do operador
      const g = JSON.parse(readFileSync(PESSOAS, 'utf8')) as Guardadas;
      nara = reviver(g.nara);
      ana = reviver(g.ana);
      orgN = g.orgN;
      await signInWithTotp(naraPage, nara);
      await configurarOperadora();
      await go(naraPage, '/organizacoes');
      await naraPage.getByRole('button', { name: /^Entrar em Nekkora Suporte/ }).first().click();
      await expect(naraPage).toHaveURL(new RegExp(`/o/${orgN}$`));
      await go(naraPage, `/o/${orgN}/operador-de-licencas`);
      await naraPage.getByRole('button', { name: 'Criar organização por exceção' }).click();
      const exc = naraPage.getByRole('alertdialog');
      await exc.getByLabel('E-mail da pessoa responsável').fill(ana.email);
      await exc.getByLabel('Nome da organização').fill(fabricaName);
      await exc.getByLabel('Razão social').fill(`${fabricaName} Ltda`);
      await exc.getByLabel('Justificativa', { exact: true }).fill('roteiro da maquina: organizacao nova para a passada de laboratorio');
      await confirmStepUp(naraPage, nara, 'Criar a organização');
      await settle(naraPage);
      await expect(naraPage.getByText(/Organização criada\./)).toBeVisible();
      await signInWithTotp(anaPage, ana);
      fabrica = await enter(anaPage, fabricaName);
      log('1_pessoas', 'as mesmas pessoas sinteticas da passada anterior entraram (sem cadastro novo); a organizacao nova foi criada pela operadora, por excecao, com a cliente como responsavel');
    }

    // 1b. a operadora, pela TELA: uma licença de 30 dias e a exigência ligada (a organização ainda não tem uso: prévia vazia)
    await openTarget(naraPage, orgN, fabrica);
    await naraPage.getByRole('button', { name: 'Conceder licenças' }).click();
    const grant = naraPage.getByRole('alertdialog');
    await grant.getByLabel('Quantidade').fill('1');
    await grant.getByLabel('Início da validade').fill(day(0));
    await grant.getByLabel('Fim da validade').fill(day(30));
    await grant.getByLabel('Justificativa').fill('roteiro da maquina: uma licenca para a fabrica');
    await confirmStepUp(naraPage, nara, 'Conceder');
    await settle(naraPage);
    await expect(naraPage.getByText(/Licenças concedidas\./)).toBeVisible();
    await naraPage.getByRole('button', { name: 'Ligar a exigência de licença' }).click();
    const enforce = naraPage.getByRole('alertdialog');
    await expect(enforce.getByText('Nenhuma automação em uso ficaria sem licença.')).toBeVisible();
    await enforce.getByLabel('Justificativa').fill('roteiro da maquina: organizacao nova no modelo por licenca');
    await enforce.getByRole('checkbox', { name: /Conferi a prévia/ }).check();
    await confirmStepUp(naraPage, nara, 'Ligar a exigência');
    await settle(naraPage);
    await expect(naraPage.getByText('Exigência de licença ligada.')).toBeVisible();
    const license = sql(`SELECT license_id FROM organization_licenses WHERE organization_id = '${fabrica}' AND license_number = 1`);
    log('1_organizacao_no_modelo_por_licenca', { pela_tela_do_operador: true, licencas: 1, modelo: sql(`SELECT public.license_model('${fabrica}')`), ativacao: 'nunca feita; nenhuma fixture de limites' });

    // ================================================================ 2. ambiente, automação com pacote publicado, licença vinculada
    await go(anaPage, `/o/${fabrica}/workspaces`);
    await anaPage.getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
    await anaPage.getByRole('alertdialog').getByLabel(/^Nome/).fill('Fiscal');
    await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
    await expect(anaPage).toHaveURL(new RegExp(`/o/${fabrica}/workspaces/[0-9a-f-]{36}$`));
    await settle(anaPage);
    const workspaceId = /workspaces\/([0-9a-f-]{36})/.exec(anaPage.url())![1];
    await anaPage.getByRole('button', { name: 'Criar automação' }).click();
    await settle(anaPage);
    await anaPage.getByLabel(/^Nome da automação/).fill(AUTOMACAO);
    await anaPage.getByRole('radio', { name: /Só o nome, como rascunho/ }).check();
    await anaPage.getByRole('button', { name: 'Salvar rascunho' }).click();
    await settle(anaPage);
    await expect(anaPage.getByRole('heading', { name: AUTOMACAO })).toBeVisible();
    const automationUrl = anaPage.url();
    const automation = /automacoes\/([0-9a-f-]{36})/.exec(automationUrl)![1];
    const publicar = async (zip: string): Promise<string> => {
      await go(anaPage, automationUrl);
      const url = await newVersionWithPackage(anaPage, zip);
      await anaPage.getByRole('button', { name: 'Publicar versão' }).click();
      await confirmStepUp(anaPage, ana, 'Publicar');
      await settle(anaPage);
      const id = /versoes\/([0-9a-f-]{36})/.exec(url)![1];
      await expect.poll(() => sql(`SELECT status FROM automation_versions WHERE automation_version_id = '${id}'`), { timeout: 60_000 }).toBe('2');
      return url;
    };
    const versaoRapida = await publicar(RAPIDO);
    const versaoRapidaId = /versoes\/([0-9a-f-]{36})/.exec(versaoRapida)![1];

    await go(anaPage, `/o/${fabrica}/administracao/licencas`);
    await expect(anaPage.getByText('Esta organização exige licença.')).toBeVisible();
    await anaPage.getByRole('button', { name: 'Vincular à automação a licença nº 1' }).click();
    await anaPage.getByRole('alertdialog').getByLabel('Automação que vai usar esta licença').selectOption({ label: `${AUTOMACAO} · Fiscal` });
    await confirmStepUp(anaPage, ana, 'Vincular licença');
    await settle(anaPage);
    await expect(anaPage.getByText(`Licença nº 1 vinculada a ${AUTOMACAO}.`, { exact: false })).toBeVisible();

    // as dependências de execução: só as do próprio pacote
    await go(anaPage, automationUrl);
    const deps = anaPage.locator('section').filter({ has: anaPage.getByRole('heading', { name: 'Dependências de execução' }) });
    await deps.getByRole('button', { name: /Declarar dependências|Declarar de novo/ }).click();
    await deps.getByRole('radio', { name: /Só as do pacote/ }).check();
    await deps.getByRole('button', { name: 'Declarar', exact: true }).click();
    await expect(deps.getByText(/Dependências declaradas \(revisão \d+\)/)).toBeVisible({ timeout: 30_000 });
    log('2_automacao_publicada_e_licenciada', { automacao: AUTOMACAO, pacote: 'robo-licenca-rapido.zip (sintetico)', licenca: 'nº 1 vinculada pela administradora', dependencias: 'as do pacote' });

    // ================================================================ 3. o Worker e a máquina (habilitação no executável)
    await go(anaPage, `/o/${fabrica}/workers`);
    await anaPage.getByRole('heading', { name: 'Workers', level: 1 }).waitFor();
    await anaPage.getByRole('button', { name: 'Criar Worker' }).click();
    await anaPage.getByRole('alertdialog').getByLabel(/^Nome do Worker/).fill(WORKER);
    await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Criar Worker' }).click();
    await settle(anaPage);
    await expect(anaPage.getByText(`Worker ${WORKER} criado, sem Agent.`, { exact: false })).toBeVisible();
    await go(anaPage, `/o/${fabrica}/workers`);
    await anaPage.getByRole('button', { name: `Vincular Agent a ${WORKER}` }).click();
    await anaPage.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill(MAQUINA);
    await anaPage.getByRole('alertdialog').getByLabel('Habilitar esta máquina para execução remota').check();
    await confirmStepUp(anaPage, ana, 'Gerar código');
    const codigo = (await anaPage.getByLabel('Código de uso único').innerText()).trim();
    l = await comando('habilitar', codigo);
    expect(l.estado, JSON.stringify({ tela: l.tela, resultado: l.resultado })).toBe('RECEIVING');
    await anaPage.getByRole('button', { name: 'Concluir' }).click();
    const worker = sql(`SELECT worker_id FROM workers WHERE organization_id = '${fabrica}' AND name = '${WORKER}'`);
    const agente = sql(`SELECT agent_id FROM agent_remote_enablements WHERE worker_id = '${worker}' ORDER BY enabled_at DESC LIMIT 1`);
    await go(anaPage, `/o/${fabrica}/workers`);
    await anaPage.getByRole('button', { name: `Autorizar ${WORKER} num ambiente de trabalho` }).click();
    await anaPage.getByRole('alertdialog').getByLabel('Ambiente de trabalho').selectOption(workspaceId);
    await confirmStepUp(anaPage, ana, 'Autorizar');
    await settle(anaPage);
    await comando('presenca');
    l = await comando('python');
    log('3_maquina_habilitada', {
      executavel: 'pacote da branch da missao, copia de laboratorio',
      estado_na_janela: l.estado,
      tela: String(l.tela).slice(0, 160),
      organizacao_na_janela: l.organizacao,
      worker_na_janela: l.worker,
      capacidade: sql(`SELECT 'workers ' || workers_used || ' de ' || workers_limit FROM public.capacity_state('${fabrica}')`),
    });

    // ================================================================ 4. página da versão: Python, dependências, e só falta a autorização
    const secaoDe = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Execução remota', exact: true }) });
    const secao = secaoDe(anaPage);
    const linha = () => secao.getByRole('row').filter({ hasText: MAQUINA });
    await go(anaPage, versaoRapida);
    await expect(secao).toBeVisible({ timeout: 60_000 });
    await expect(linha()).toContainText('Ainda não foi escolhido o Python desta automação nesta máquina.', { timeout: 60_000 });
    const escolher = async (n: number): Promise<number> => {
      await linha().getByRole('button', { name: new RegExp(`(Escolher|Trocar) o Python de ${MAQUINA}`) }).click();
      const dialogo = anaPage.getByRole('alertdialog');
      const seletor = dialogo.getByLabel('Python da máquina');
      await expect(seletor).toBeVisible({ timeout: 60_000 });
      const virtuais = (await seletor.locator('option').allInnerTexts()).filter((o) => o.includes('ambiente virtual'));
      expect(virtuais.length, 'os dois ambientes virtuais sintéticos foram informados pela máquina').toBeGreaterThanOrEqual(2);
      await seletor.selectOption({ label: virtuais[n] });
      await confirmStepUp(anaPage, ana, 'Escolher este Python');
      await settle(anaPage);
      await expect(secao.getByText(/escolhido para esta automação em/)).toBeVisible({ timeout: 60_000 });
      return virtuais.length;
    };
    const conferido = () => sql(`SELECT coalesce((SELECT c.outcome::text FROM remote_dependency_checks c WHERE c.agent_id = '${agente}' ORDER BY c.requested_at DESC LIMIT 1), 'pendente')`);
    let escolhido = -1;
    let esperasDoIntervalo = 0;
    for (const n of [0, 1]) {
      await escolher(n);
      await reler(anaPage);
      // o produto aceita um pedido de verificação por minuto para a mesma máquina e automação: se vier cedo, a tela diz, e o
      // roteiro ESPERA o intervalo e pede de novo, como a pessoa faria (nenhum limite é zerado)
      for (let vez = 1; ; vez++) {
        await linha().getByRole('button', { name: `Verificar as dependências em ${MAQUINA}` }).click();
        const pedida = secao.getByText(/Verificação pedida a/);
        const cedo = secao.getByText(/já houve um pedido para esta máquina e esta automação há pouco/);
        await expect(pedida.or(cedo).first()).toBeVisible({ timeout: 30_000 });
        if (await pedida.isVisible()) break;
        if (vez >= 3) throw new Error('a verificação de dependências continuou recusada pelo intervalo mínimo');
        esperasDoIntervalo++;
        await anaPage.waitForTimeout(65_000);
        await reler(anaPage);
      }
      for (let vez = 1; vez <= 12 && conferido() === 'pendente'; vez++) {
        await comando('consulta');
        await anaPage.waitForTimeout(2_000);
      }
      await reler(anaPage);
      if ((await linha().innerText()).includes('As dependências declaradas estão neste Python.')) {
        escolhido = n;
        break;
      }
    }
    expect(escolhido, 'um dos ambientes virtuais tem a dependência do pacote').toBeGreaterThanOrEqual(0);
    log('4_python_e_dependencias', { ambiente_escolhido: `o ${escolhido + 1}o ambiente virtual informado pela maquina`, esperas_pelo_intervalo_de_um_minuto_entre_verificacoes: esperasDoIntervalo });
    // falta SÓ a autorização da versão: a tela oferece autorizar e solicitar no mesmo passo
    await expect(linha().getByRole('list', { name: `O que falta em ${MAQUINA}` })).toHaveText(/Falta a autorização de execução desta versão para o Worker desta máquina\./);
    await expect(linha().getByRole('button', { name: `Solicitar execução em ${MAQUINA}` })).toHaveCount(0);
    await shot(anaPage, 'M4-falta-so-a-autorizacao');

    /**
     * Depois de uma execução, a Platform só volta a oferecer a máquina quando o aplicativo informa que está livre, na presença
     * seguinte (a do aplicativo é a cada 60 s; o roteiro pede uma agora, para não esperar).
     */
    const maquinaLivre = async () => {
      for (let vez = 1; ; vez++) {
        await comando('presenca');
        await reler(anaPage);
        await expect(linha()).toBeVisible({ timeout: 60_000 });
        if (!/informou que está ocupada|já tem uma execução remota em andamento|Finalizando — processos|comunicar, sozinho, não basta/.test(await linha().innerText())) return;
        if (vez >= 8) throw new Error(`a máquina não voltou a ficar livre: ${(await linha().innerText()).slice(0, 300)}`);
        await comando('consulta');
      }
    };

    // ================================================================ 5. S2: autorizar a versão e solicitar no MESMO passo
    const ultima = (versao: string) =>
      sql(
        `SELECT t.state || '|' || coalesce(t.refusal_reason, '') || '|' || coalesce(t.exit_code::text, '') || '|' || t.attempt_id FROM remote_attempts t JOIN remote_executions x ON x.remote_execution_id = t.remote_execution_id WHERE x.automation_version_id = '${versao}' ORDER BY t.created_at DESC LIMIT 1`,
      ).split('|');
    const autorizarESolicitar = async () => {
      await linha().getByRole('button', { name: `Autorizar esta versão e solicitar em ${MAQUINA}` }).click();
      const d = anaPage.getByRole('alertdialog');
      await expect(d.getByText(/A autorização vale só para esta versão, neste Worker\. Versões futuras não ficam autorizadas/)).toBeVisible();
      await expect(d.getByRole('button', { name: 'Autorizar e solicitar' })).toBeDisabled();
      await d.getByRole('checkbox', { name: /^Autorizo a execução da versão/ }).check();
      await confirmStepUp(anaPage, ana, 'Autorizar e solicitar');
      await settle(anaPage);
    };
    await autorizarESolicitar();
    await expect(anaPage.getByText(/Versão autorizada para este Worker e solicitação registrada\./)).toBeVisible({ timeout: 30_000 });
    await expect(anaPage.getByText(/A autorização vale até /)).toBeVisible({ timeout: 30_000 });
    await shot(anaPage, 'M5-autorizada-e-solicitada-no-mesmo-passo');
    const autorizacao = sql(`SELECT to_char(valid_until AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') || ' por ' || (SELECT email FROM users u JOIN organization_memberships m ON m.user_id = u.user_id WHERE m.membership_id = z.granted_by_membership_id) FROM local_run_authorizations z WHERE z.automation_version_id = '${versaoRapidaId}' AND z.worker_id = '${worker}' AND z.revoked_at IS NULL`);
    log('5_autorizar_e_solicitar_no_mesmo_passo', { pela_tela: true, autorizacao_criada: autorizacao, fim_da_licenca: day(30), validade_em_branco: 'vale ate o fim da licenca, e a tela disse a data' });

    // ================================================================ 6. a máquina executa; registros e resultado chegam à Platform
    const ateEstado = async (versao: string, alvo: (estado: number) => boolean, limite = 80) => {
      for (let vez = 1; !alvo(Number(ultima(versao)[0])); vez++) {
        if (vez > limite) throw new Error(`a tentativa não chegou ao estado esperado: ${ultima(versao).join('|')}`);
        await comando('consulta');
        await anaPage.waitForTimeout(1_500);
      }
      return ultima(versao);
    };
    let [estado, , saida, tentativa] = await ateEstado(versaoRapidaId, (e) => e >= 7);
    expect(estado, `o resultado é o do robô (${ultima(versaoRapidaId).join('|')})`).toBe('7');
    expect(saida).toBe('0');
    const fechamentos = async (id: string) => {
      for (let vez = 1; sql(`SELECT (SELECT count(*) FROM remote_attempt_log_closures WHERE attempt_id = '${id}') + (SELECT count(*) FROM remote_attempt_result_closures WHERE attempt_id = '${id}')`) !== '2'; vez++) {
        if (vez > 30) throw new Error('o envio dos registros e dos resultados não foi fechado');
        await comando('consulta');
        await anaPage.waitForTimeout(2_000);
      }
      return sql(`SELECT 'registros=' || (SELECT lines FROM remote_attempt_log_closures WHERE attempt_id = '${id}') || ' resultados=' || (SELECT sent FROM remote_attempt_result_closures WHERE attempt_id = '${id}')`);
    };
    const entrega1 = await fechamentos(tentativa);
    await reler(anaPage);
    await expect(secao.getByText(/Concluída/).first()).toBeVisible({ timeout: 60_000 });
    await secao.getByRole('button', { name: 'Ver registros da tentativa 1' }).first().click();
    const registros = secao.getByRole('list', { name: 'Registros da tentativa 1' }).first();
    await expect(registros).toContainText('inicio da execucao sintetica do roteiro de licencas', { timeout: 60_000 });
    await expect(registros).toContainText('fim da execucao sintetica');
    await secao.getByRole('button', { name: 'Ver resultados da tentativa 1' }).first().click();
    await expect(secao.getByRole('list', { name: 'Resultados da tentativa 1' }).first()).toContainText('relatorio.txt', { timeout: 60_000 });
    await shot(anaPage, 'M6-execucao-concluida-registros-e-resultado');
    l = await comando('tela');
    log('6_execucao_com_licenca', { estado: 'SUCCEEDED', codigo_de_saida: 0, entrega: entrega1, na_web: 'registros e resultado visiveis', aplicativo: { estado: l.estado, atividade: l.atividade } });

    // ================================================================ 7. AGUARDANDO VAGA: capacidade, não licença
    // PROCEDIMENTO ADMINISTRATIVO: limite técnico de execuções simultâneas = 1 (o padrão é 5; com uma máquina só não há como chegar a 5).
    // FIXTURE DECLARADA: uma sessão do Agent anterior "em execução", com a última notícia há CINCO MINUTOS, ocupa a única vaga
    // (não há espera obrigatória para reconciliar: o que autoriza é a verificação registrada).
    sql(`UPDATE technical_capacity_limits SET limit_value = 1, updated_by = 'roteiro da maquina: limite 1 para chegar ao limite com uma maquina' WHERE resource_code = 2`);
    sql(`SET session_replication_role = replica; INSERT INTO agent_runs (organization_id, workspace_id, automation_id, automation_version_id, authorization_id, agent_id, worker_id, worker_agent_assignment_id, agent_execution_id, package_fingerprint, authorization_state_at_registration, supervisor_state, last_report_at) VALUES ('${fabrica}', '${workspaceId}', '${automation}', '${versaoRapidaId}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'ex-' || repeat('7', 32), repeat('a', 64), 1, 3, clock_timestamp() - interval '5 minutes')`);
    await go(anaPage, `/o/${fabrica}/administracao/licencas`);
    await expect(anaPage.getByRole('group', { name: 'Capacidade técnica' })).toContainText(/Execuções simultâneas\s*1 de 1/);
    await expect(anaPage.getByRole('group', { name: 'Capacidade técnica' })).toContainText('Em execução: 1 (1 pelo Agent anterior)');
    await expect(anaPage.getByRole('group', { name: 'Capacidade técnica' })).toContainText('Reservadas por situação incerta: 0');
    await go(anaPage, versaoRapida);
    await maquinaLivre();
    await expect(linha()).toContainText('Pode solicitar', { timeout: 60_000 });
    await linha().getByRole('button', { name: `Solicitar execução em ${MAQUINA}` }).click();
    await confirmStepUp(anaPage, ana, 'Solicitar execução');
    await settle(anaPage);
    await expect(anaPage.getByText(/Solicitação registrada\./)).toBeVisible({ timeout: 30_000 });
    // a máquina pergunta duas vezes: sem vaga, a Platform não entrega
    await comando('consulta');
    await comando('consulta');
    expect(ultima(versaoRapidaId)[0], 'continua na fila: a vaga está ocupada').toBe('1');
    await reler(anaPage);
    await expect(secao.getByText('Aguardando vaga', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(secao.getByText(/É um limite de capacidade, não falta de licença/).first()).toBeVisible();
    await shot(anaPage, 'M7-aguardando-vaga');
    const ocupacao = sql(`SELECT 'simultaneas ' || concurrent_used || ' de ' || concurrent_limit || ' (agent anterior ' || concurrent_previous_agent || ') pendentes ' || pending_used FROM public.capacity_state('${fabrica}')`);
    // a operadora reconcilia a sessão sem encerramento, pela TELA: a vaga é liberada pelo ATO, não pelo tempo
    await openTarget(naraPage, orgN, fabrica);
    const sessoes = naraPage.getByRole('region', { name: 'Lista de sessões sem desfecho' });
    await expect(sessoes.getByRole('row').filter({ hasText: AUTOMACAO })).toContainText('Em execução (sem encerramento)');
    await expect(sessoes.getByRole('row').filter({ hasText: AUTOMACAO })).toContainText('transferência e uma vaga de execução');
    await naraPage.getByRole('button', { name: `Reconciliar a sessão de ${AUTOMACAO}` }).click();
    const rec = naraPage.getByRole('alertdialog');
    await rec.getByLabel('Justificativa', { exact: true }).fill('roteiro da maquina: chamado de laboratorio, computador antigo desligado');
    await rec.getByLabel('Verificação realizada').fill('administradora confirmou por escrito que o computador antigo foi desligado e retirado');
    await rec.getByRole('checkbox', { name: /Verifiquei, fora do sistema/ }).check();
    await confirmStepUp(naraPage, nara, 'Registrar a reconciliação');
    await settle(naraPage);
    await expect(naraPage.getByText(/Reconciliação registrada\. A sessão não foi alterada/)).toBeVisible();
    [estado, , saida, tentativa] = await ateEstado(versaoRapidaId, (e) => e >= 7);
    expect(estado, 'com a vaga livre a mesma solicitação é entregue e executa, sem pedir de novo').toBe('7');
    await fechamentos(tentativa);
    log('7_aguardando_vaga', {
      procedimento: 'limite tecnico de simultaneas = 1',
      fixture: 'sessao do Agent anterior sem encerramento (ultima noticia ha 5 minutos: sem espera obrigatoria)',
      ocupacao_antes: ocupacao,
      na_web: '"Aguardando vaga", dito como capacidade e nao licenca',
      reconciliacao: sql(`SELECT 'estado_da_sessao=' || r.supervisor_state || ' (3 = em execucao, inalterado) verificacao=' || c.verification FROM agent_run_reconciliations c JOIN agent_runs r ON r.agent_run_id = c.agent_run_id WHERE c.organization_id = '${fabrica}'`),
      depois: `a mesma solicitacao executou: estado ${estado}, codigo de saida ${saida}`,
    });

    // ================================================================ 8. VENCIMENTO com execução em andamento: o que foi autorizado termina e entrega
    const versaoLonga = await publicar(LONGO);
    const versaoLongaId = /versoes\/([0-9a-f-]{36})/.exec(versaoLonga)![1];
    await go(anaPage, versaoLonga);
    await expect(secao).toBeVisible({ timeout: 60_000 });
    await maquinaLivre();
    // versão nova: a autorização da anterior NÃO vale para ela
    await expect(linha().getByRole('list', { name: `O que falta em ${MAQUINA}` })).toContainText('Falta a autorização de execução desta versão para o Worker desta máquina.', { timeout: 60_000 });
    await autorizarESolicitar();
    await expect(anaPage.getByText(/Versão autorizada para este Worker e solicitação registrada\./)).toBeVisible({ timeout: 30_000 });
    [estado, , , tentativa] = await ateEstado(versaoLongaId, (e) => e >= 6);
    expect(estado, `em execução (${ultima(versaoLongaId).join('|')})`).toBe('6');
    for (let vez = 1; Number(sql(`SELECT count(*) FROM remote_attempt_log_lines WHERE attempt_id = '${tentativa}'`)) < 2; vez++) {
      if (vez > 20) throw new Error('as primeiras linhas não chegaram com a execução em andamento');
      await comando('consulta');
      await anaPage.waitForTimeout(2_000);
    }
    // PASSAGEM DO TEMPO (procedimento no banco do laboratório): a licença vence AGORA, com a execução em andamento
    sql(`SET session_replication_role = replica; UPDATE organization_license_periods SET ends_at = clock_timestamp() WHERE license_id = '${license}'`);
    const venceuEm = sql('SELECT clock_timestamp()');
    await go(anaPage, `/o/${fabrica}/administracao/licencas`);
    await expect(anaPage.getByRole('row').filter({ hasText: 'nº 1' })).toContainText('Vencida');
    await shot(anaPage, 'M8-licenca-vencida-com-execucao-em-andamento');
    [estado, , saida, tentativa] = await ateEstado(versaoLongaId, (e) => e >= 7, 120);
    expect(estado, 'a execução que já estava autorizada TERMINA depois do vencimento').toBe('7');
    expect(saida).toBe('0');
    const entrega2 = await fechamentos(tentativa);
    const depois = sql(`SELECT 'linhas depois do vencimento=' || (SELECT count(*) FROM remote_attempt_log_lines WHERE attempt_id = '${tentativa}' AND received_at > '${venceuEm}') || ' fim=' || (SELECT ended_at > '${venceuEm}' FROM remote_attempts WHERE attempt_id = '${tentativa}')`);
    await go(anaPage, versaoLonga);
    await maquinaLivre();
    await expect(secao.getByText(/Concluída/).first()).toBeVisible({ timeout: 60_000 });
    await secao.getByRole('button', { name: 'Ver registros da tentativa 1' }).first().click();
    await expect(secao.getByRole('list', { name: 'Registros da tentativa 1' }).first()).toContainText('fim da execucao sintetica', { timeout: 60_000 });
    await secao.getByRole('button', { name: 'Ver resultados da tentativa 1' }).first().click();
    await expect(secao.getByRole('list', { name: 'Resultados da tentativa 1' }).first()).toContainText('relatorio.txt', { timeout: 60_000 });
    // trabalho NOVO: recusado por licença, na tela e no servidor
    await expect(linha().getByRole('list', { name: `O que falta em ${MAQUINA}` })).toContainText('A licença desta automação venceu.', { timeout: 60_000 });
    await expect(linha().getByRole('list', { name: `O que falta em ${MAQUINA}` })).toContainText('a renovação da licença é feita pelo suporte da Nekkora');
    await expect(linha().getByText(/Aguarde a execução em andamento/)).toHaveCount(0);
    await expect(linha().getByRole('button', { name: /Solicitar execução|Autorizar esta versão e solicitar/ })).toHaveCount(0);
    await shot(anaPage, 'M8-entregue-depois-do-vencimento-e-trabalho-novo-recusado');
    const antes = sql(`SELECT count(*) FROM remote_executions WHERE organization_id = '${fabrica}'`);
    const direto = await api(anaPage, fabrica, 'POST', `/api/v1/o/${fabrica}/workspaces/${workspaceId}/remote-executions`, { automationVersionId: versaoLongaId, agentId: agente, requestKey: crypto.randomUUID() });
    expect([direto.status, direto.body?.reason], 'o servidor recusa, não só a tela').toEqual([409, 'license_expired']);
    expect(sql(`SELECT count(*) FROM remote_executions WHERE organization_id = '${fabrica}'`), 'nada gravado').toBe(antes);
    log('8_vencimento', { licenca_venceu_com_execucao_em_andamento: true, a_execucao: `terminou: estado ${estado}, codigo de saida ${saida}`, entrega: entrega2, depois_do_vencimento: depois, trabalho_novo: `recusado: ${direto.status} ${direto.body?.reason}; nada gravado`, na_web: 'a maquina aparece com "A licenca desta automacao venceu."' });

    // ================================================================ 9. A MENSAGEM DO APLICATIVO: recusa por licença entre o recebimento e o início
    // A operadora renova a licença pela TELA (o trabalho novo volta a ser aceito)...
    await openTarget(naraPage, orgN, fabrica);
    await naraPage.getByRole('button', { name: 'Renovar a licença nº 1' }).click();
    const renew = naraPage.getByRole('alertdialog');
    await renew.getByLabel('Fim do novo período').fill(day(30));
    await renew.getByLabel('Justificativa').fill('roteiro da maquina: renovacao do ciclo');
    await confirmStepUp(naraPage, nara, 'Renovar');
    await settle(naraPage);
    await expect(naraPage.getByText('Licença renovada. O vínculo com a automação não muda.')).toBeVisible();
    // ...e a FIXTURE DECLARADA: um gatilho de laboratório vence a licença no instante em que a máquina começa a PREPARAR a tentativa.
    // Assim a recusa acontece entre o recebimento e o início, que é quando a Platform avisa o aplicativo (S1: conferência no início).
    sql(`CREATE FUNCTION public.lab_expire_on_preparing() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $f$ BEGIN IF NEW.state = 4 AND OLD.state < 4 AND NEW.organization_id = '${fabrica}' THEN SET LOCAL session_replication_role = replica; UPDATE public.organization_license_periods SET ends_at = clock_timestamp() WHERE license_id = '${license}' AND ends_at > clock_timestamp(); SET LOCAL session_replication_role = origin; END IF; RETURN NEW; END $f$; CREATE TRIGGER trg_lab_expire_on_preparing BEFORE UPDATE ON public.remote_attempts FOR EACH ROW EXECUTE FUNCTION public.lab_expire_on_preparing()`);
    await go(anaPage, versaoRapida);
    await maquinaLivre();
    await expect(linha()).toContainText('Pode solicitar', { timeout: 60_000 });
    await linha().getByRole('button', { name: `Solicitar execução em ${MAQUINA}` }).click();
    await confirmStepUp(anaPage, ana, 'Solicitar execução');
    await settle(anaPage);
    let motivo = '';
    [estado, motivo] = await ateEstado(versaoRapidaId, (e) => e >= 7);
    expect([estado, motivo], 'a tentativa não inicia: recusada por licença antes do início').toEqual(['11', 'LICENSE_EXPIRED']);
    // a janela "Execução remota" ESTÁ ABERTA desde a habilitação: a mensagem aparece nela sem fechar nem reabrir
    l = await comando('consulta');
    expect(String(l.atividade), 'a JANELA ABERTA do aplicativo diz que a Platform recusou por licença').toMatch(/A Platform não iniciou a última execução solicitada a este computador: a licença da automação venceu\. Nada foi executado aqui\./);
    guardarJanelas('M9');
    const reaberta = await comando('tela');
    expect(String(reaberta.atividade), 'reaberta, a janela continua dizendo').toMatch(/a licença da automação venceu/);
    await reler(anaPage);
    await expect(secao.getByText(/a licença da automação venceu antes do início/).first()).toBeVisible({ timeout: 60_000 });
    await shot(anaPage, 'M9-recusada-por-licenca-antes-do-inicio');
    log('9_mensagem_do_aplicativo_recusa_por_licenca', { fixture: 'gatilho de laboratorio vence a licenca quando a maquina comeca a preparar', tentativa: `${estado}|${motivo}`, janela_do_aplicativo: l.atividade, na_web: 'Nao iniciada: a licenca da automacao venceu antes do inicio', nada_executou: sql(`SELECT started_at IS NULL FROM remote_attempts t JOIN remote_executions x ON x.remote_execution_id = t.remote_execution_id WHERE x.automation_version_id = '${versaoRapidaId}' ORDER BY t.created_at DESC LIMIT 1`) });
    sql('DROP TRIGGER IF EXISTS trg_lab_expire_on_preparing ON public.remote_attempts; DROP FUNCTION IF EXISTS public.lab_expire_on_preparing()');

    // ================================================================ 10. LIMITE DE WORKERS: a recusa é dita à PESSOA, na Platform
    // PROCEDIMENTO ADMINISTRATIVO: limite técnico de Workers = 1 (a organização já tem um). O limite é conferido quando a
    // pessoa cria o Worker; a máquina não participa e o aplicativo não recebe esse motivo.
    sql(`UPDATE technical_capacity_limits SET limit_value = 1, updated_by = 'roteiro da maquina: limite 1 de Workers' WHERE resource_code = 1`);
    await go(anaPage, `/o/${fabrica}/workers`);
    await anaPage.getByRole('button', { name: 'Criar Worker' }).click();
    const novo = anaPage.getByRole('alertdialog');
    await novo.getByLabel(/^Nome do Worker/).fill('Worker dois');
    await novo.getByRole('button', { name: 'Criar Worker' }).click();
    await settle(anaPage);
    await expect(novo.getByRole('alert').first()).toBeVisible({ timeout: 30_000 });
    const recusaDoLimite = (await novo.getByRole('alert').first().innerText()).replace(/\s+/g, ' ').trim();
    expect(recusaDoLimite, 'no modelo por licença a recusa fala do limite técnico, sem ativação').toMatch(/limite técnico de Workers cadastrados/);
    expect(recusaDoLimite).not.toMatch(/aguarda ativação|depois da ativação/);
    expect(recusaDoLimite, 'capacidade, não licença').toMatch(/sem relação com a ativação nem com a quantidade de licenças/);
    await shot(anaPage, 'M10-limite-de-workers-na-platform');
    expect(sql(`SELECT count(*) FROM workers WHERE organization_id = '${fabrica}'`), 'nada foi criado').toBe('1');
    log('10_limite_de_workers', {
      procedimento: 'limite tecnico de Workers = 1, com um Worker cadastrado',
      na_web: recusaDoLimite,
      nada_criado: true,
      aplicativo: 'nao participa: a Platform nao envia esse motivo a maquina (o texto que o aplicativo tinha para isso foi retirado)',
    });
    // a máquina é desabilitada no aplicativo, pelo botão da janela
    l = await comando('desabilitar');
    expect(l.estado).toBe('NOT_ENABLED');
    guardarJanelas('M10');

    await fecharExe();
    log('limites_de_frequencia', `nenhum limite de frequencia foi zerado. "Tentar novamente" usado ${retried} vez(es)`);
    log('fim', 'roteiro da maquina concluido');
  } finally {
    restoreLimits();
    writeFileSync(COMANDO, 'sair');
    await new Promise((r) => setTimeout(r, 3_000));
    exe?.kill();
    rmSync(CODIGO, { force: true });
    if (existsSync(SAIDA)) {
      mkdirSync(EVID, { recursive: true });
      copyFileSync(SAIDA, join(EVID, 'aplicativo.jsonl'));
    }
  }
  expect(linhas().find((x) => x.etapa === 'falha')?.erro ?? null).toBeNull();
});
