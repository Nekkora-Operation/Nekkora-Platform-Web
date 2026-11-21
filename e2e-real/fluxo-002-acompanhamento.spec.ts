import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { Authenticator } from '../mock/totp';
import { activateAutomation, confirmStepUp, LAB, signInWithTotp, signUpAndEnroll, waitToken, type Person } from './support/lab';

/**
 * PLATFORM-FLUXO-002 — ACOMPANHAMENTO UNIFICADO contra a API REAL do laboratório descartável, com a Web de produção e as
 * CÓPIAS DE LABORATÓRIO dos dois aplicativos (nunca os instalados, nunca um perfil pessoal):
 *   - Agent Client (fluxo-002/exe/maquina): execução REMOTA pedida pela Platform, com registros e resultado;
 *   - Agent anterior (fluxo-002/exe-agent/copia): execução LOCAL registrada, o DESFECHO DESCONHECIDO (a cópia é derrubada,
 *     com o processo da automação, no meio de uma execução longa; reaberta, ela reconcilia e nada é relançado) e o PEDIDO
 *     ao Agent anterior que fica aguardando a máquina (a cópia fechada).
 * Os dois aplicativos são conduzidos por dentro do próprio processo (botões reais, doClick), sem tecla global nem Robot; o
 * seletor de arquivo e a confirmação "Aprovar este pacote?" são SIMULADOS (o mesmo método que a janela chama), como nos
 * roteiros do licenciamento.
 *
 * FIXTURE DECLARADA: duas execuções da PLATFORM (a origem do modelo orquestrado, que não tem produtor no laboratório),
 * inseridas no banco. PROCEDIMENTOS DECLARADOS: o cadastro da operadora de licenças; a "passagem do tempo" que deixa o
 * desfecho desconhecido ANTIGO (45 dias). Nenhum limite de frequência é zerado.
 *
 * Partes (o estado fica em ~/.nekkora/front-lab/<lab>/acompanhamento.json, fora dos repositórios):
 *   1. preparo — pessoas, organização por licença, ambientes, automações, máquinas, ativação e as execuções;
 *   2. verificação — Em andamento / Histórico, as quatro origens sem duplicação, filtros, detalhes, registros e resultados;
 *      Máquinas → Ver atividade → detalhe → máquina; o desconhecido antigo em "Requer atenção"; os endereços antigos de
 *      Supervisão; permissões (leitura num ambiente só) e isolamento entre organizações;
 *   3. convite para o aceite (só com ACEITE_EMAIL): a administradora convida a conta indicada como administradora.
 *
 *   FRONT_LAB_ID=frontlab-fluxo002 FRONT_PORTA=5196 npx playwright test -c playwright.real.config.ts fluxo-002-acompanhamento
 *   (ACOMP_SO_VERIFICAR=1 repete só a verificação sobre o estado guardado)
 */
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-fluxo-002-acompanhamento`);
const SEG = join(homedir(), '.nekkora', 'front-lab', LAB, 'segredos.env');
const ESTADO = join(homedir(), '.nekkora', 'front-lab', LAB, 'acompanhamento.json');
// as pessoas sintéticas, guardadas assim que se cadastram: numa repetição, elas ENTRAM em vez de se cadastrar de novo (o
// produto aceita 10 cadastros por endereço por hora e o laboratório sai sempre do mesmo endereço; nenhum limite é zerado)
const PESSOAS = join(homedir(), '.nekkora', 'front-lab', LAB, 'acompanhamento-pessoas.json');
type Pessoas = { nara?: Guardada; ana?: Guardada; bruno?: Guardada; orgN?: string; orgNName?: string };
const pessoas = (): Pessoas => (existsSync(PESSOAS) ? (JSON.parse(readFileSync(PESSOAS, 'utf8')) as Pessoas) : {});
const guardarPessoa = (patch: Pessoas) => writeFileSync(PESSOAS, JSON.stringify({ ...pessoas(), ...patch }, null, 2));
const CLIENT = resolve(process.cwd(), '../exe/maquina');
const AGENT = resolve(process.cwd(), '../exe-agent/copia');
const PYLAB = resolve(process.cwd(), '../../client-preparacao-002/lab');
const PYTHON = resolve(PYLAB, 'projeto-robo/.venv/Scripts/python.exe');
const RAPIDO = resolve(process.cwd(), '../exe/robo-licenca-rapido.zip');
const LONGO = resolve(process.cwd(), '../exe/robo-licenca-longo.zip');
const TAG = Date.now().toString(36);
const W_CLIENT = 'Estação Client';
const W_AGENT = 'Estação Agent';
const PC_CLIENT = 'PC-ACOMP-CLIENT';
const PC_AGENT = 'PC-ACOMP-AGENT';
const A_REMOTA = 'Robô de notas';
const A_LOCAL = 'Rotina local';
const A_LONGA = 'Rotina longa';
const A_COMPRAS = 'Compras diária';
const A_MONITORADA = 'Relatório CSV';
// o exemplo de Python externo do repositório do Agent (só os arquivos são copiados para a pasta de laboratório)
const EXEMPLO = resolve(process.cwd(), '../../Nekkora-Agent/tools/external-package/exemplo-relatorio');
const CLIENTE = resolve(process.cwd(), '../exe-agent/cliente');

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
const day = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ------------------------------------------------------------------ estado guardado entre as partes
type Guardada = { email: string; password: string; name: string; secret: string };
interface Estado {
  nara: Guardada;
  ana: Guardada;
  bruno: Guardada;
  orgN: string;
  org: string;
  orgName: string;
  fiscal: string;
  compras: string;
  automacoes: Record<string, string>;
  versoes: Record<string, string>;
  workers: Record<string, string>;
  remota: string;
  localOk: string;
  desconhecida: string;
  pedido: string;
  platform: string[];
}
const guardar = (x: Person): Guardada => ({ email: x.email, password: x.password, name: x.name, secret: (x.auth as unknown as { secret: string }).secret });
const reviver = (g: Guardada): Person => ({ email: g.email, password: g.password, name: g.name, auth: new Authenticator(g.secret), recoveryCodes: [] });

// ------------------------------------------------------------------ as cópias dos aplicativos (condutor dentro do processo)
type Linha = Record<string, unknown>;
class App {
  exe: ChildProcess | null = null;
  constructor(
    readonly dir: string,
    readonly binary: string,
    readonly saida: string,
    readonly env: () => NodeJS.ProcessEnv = () => process.env,
  ) {}
  linhas(): Linha[] {
    return existsSync(this.saida)
      ? readFileSync(this.saida, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Linha)
      : [];
  }
  async abrir(): Promise<Linha> {
    const antes = this.linhas().length;
    this.exe = spawn(resolve(this.dir, 'app', this.binary), [], { detached: false, stdio: 'ignore', env: this.env() });
    await expect.poll(() => this.linhas().length > antes, { timeout: 90_000, intervals: [300] }).toBe(true);
    const l = this.linhas()[antes];
    expect(l.erro ?? null, JSON.stringify(l)).toBeNull();
    return l;
  }
  /** Envia o comando sem esperar a resposta (para derrubar a cópia no meio de uma execução). */
  enviar(c: string, codigo?: string) {
    if (codigo) writeFileSync(resolve(this.dir, 'saida/codigo.txt'), codigo);
    writeFileSync(resolve(this.dir, 'saida/comando.txt'), c);
  }
  async comando(c: string, codigo?: string, timeout = 420_000): Promise<Linha> {
    const antes = this.linhas().length;
    this.enviar(c, codigo);
    await expect.poll(() => this.linhas().length > antes || this.linhas().some((l) => l.etapa === 'falha'), { timeout, intervals: [300] }).toBe(true);
    const l = this.linhas()[antes] ?? this.linhas().find((x) => x.etapa === 'falha')!;
    expect(existsSync(resolve(this.dir, 'saida/codigo.txt')), 'o código é apagado pelo aplicativo ao ser lido').toBe(false);
    expect(l.erroDoRoteiro ?? l.erro ?? null, JSON.stringify(l).slice(0, 600)).toBeNull();
    return l;
  }
  async fechar() {
    if (!this.exe) return;
    writeFileSync(resolve(this.dir, 'saida/comando.txt'), 'sair');
    await expect.poll(() => this.linhas().some((l, i) => l.etapa === 'fim' && i === this.linhas().length - 1), { timeout: 120_000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 2_000));
    this.exe.kill();
    this.exe = null;
  }
  /** Derruba a cópia E o processo da automação que ela iniciou (só a árvore deste processo, pelo PID que o roteiro abriu). */
  derrubar() {
    if (!this.exe?.pid) return;
    execFileSync('taskkill', ['/PID', String(this.exe.pid), '/T', '/F'], { stdio: 'ignore' });
    this.exe = null;
  }
  limpar(manter: string[] = []) {
    const guardados = manter.map((f) => [f, readFileSync(resolve(this.dir, f), 'utf8')] as const);
    rmSync(resolve(this.dir, 'dados'), { recursive: true, force: true });
    rmSync(resolve(this.dir, 'saida'), { recursive: true, force: true });
    mkdirSync(resolve(this.dir, 'dados'), { recursive: true });
    mkdirSync(resolve(this.dir, 'saida'), { recursive: true });
    for (const [f, t] of guardados) {
      mkdirSync(resolve(this.dir, f, '..'), { recursive: true });
      writeFileSync(resolve(this.dir, f), t);
    }
  }
  guardarJanelas(prefixo: string) {
    mkdirSync(EVID, { recursive: true });
    for (const f of readdirSync(resolve(this.dir, 'saida')).filter((n) => n.endsWith('.png'))) copyFileSync(resolve(this.dir, 'saida', f), join(EVID, `${prefixo}-${f}`));
  }
}
const client = new App(CLIENT, 'Nekkora Agent Client.exe', resolve(CLIENT, 'saida/exe-1.jsonl'), () => {
  // só o PATH deste processo ganha os dois ambientes virtuais sintéticos (como no roteiro da máquina)
  const env = { ...process.env };
  const chave = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  env[chave] = [resolve(PYLAB, 'projeto-robo/.venv/Scripts'), resolve(PYLAB, 'ambiente-sem-dependencia/Scripts'), env[chave] ?? ''].join(';');
  return env;
});
const agent = new App(AGENT, 'Nekkora Agent.exe', resolve(AGENT, 'saida/agent.jsonl'));

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
  await page.waitForTimeout(3_000);
  await page.goto(url);
  await settle(page);
}
async function reler(page: Page) {
  await page.waitForTimeout(3_000);
  await page.reload();
  await settle(page);
}
async function waitPlatform(page: Page) {
  await expect.poll(async () => (await page.request.get('/api/v1/csrf').catch(() => null))?.status() ?? 0, { timeout: 180_000, intervals: [2_000] }).toBe(200);
}
async function createOrganization(page: Page, person: Person, name: string) {
  await go(page, '/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, person, 'Criar organização');
  await settle(page);
  await expect(page.getByRole('button', { name: `Entrar em ${name}` })).toBeVisible();
}
async function enter(page: Page, name: string): Promise<string> {
  await go(page, '/organizacoes');
  await page.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await settle(page);
  return /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];
}
/** GET pela sessão da página (mesma origem; o servidor decide o acesso). */
async function apiGet(page: Page, path: string): Promise<{ status: number; body: any }> {
  return page.evaluate(async (path) => {
    const r = await fetch(path);
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: r.status, body };
  }, path);
}
/** Todas as páginas de /activity da aba pedida (sem período no histórico: tudo o que a pessoa vê). */
async function activityAll(page: Page, org: string, tab: 'in_progress' | 'history', extra = ''): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const r = await apiGet(page, `/api/v1/o/${org}/activity?tab=${tab}&limit=100${extra}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    items.push(...r.body.items);
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return items;
}
const tableRows = (page: Page) => page.getByRole('region', { name: 'Lista de execuções' }).locator('tbody tr');

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });
test.describe.configure({ mode: 'serial' });

// ==================================================================================================== 1. preparo
test('1. preparo: organização por licença, máquinas reais (Agent Client e Agent anterior) e as quatro origens', async ({ browser }) => {
  test.skip(process.env.ACOMP_SO_VERIFICAR === '1' && existsSync(ESTADO), 'só a verificação (estado guardado)');
  test.setTimeout(3_600_000);
  rmSync(EVID, { recursive: true, force: true });
  for (const d of [CLIENT, AGENT]) expect(d.replace(/\\/g, '/'), 'só as cópias desta etapa').toMatch(/fluxo-002\/(exe\/maquina|exe-agent\/copia)$/);
  expect(existsSync(PYTHON), `Python sintético do laboratório: ${PYTHON}`).toBe(true);
  log('laboratorio', readFileSync(resolve(`tools/lab/saidas/${LAB}/laboratorio.txt`), 'utf8').replace(/\n/g, ' | '));
  log('copias', {
    client: readFileSync(resolve(CLIENT, 'app/VERSOES.txt'), 'utf8').split('\n').slice(0, 2).join(' | '),
    agent: readFileSync(resolve(AGENT, 'app/VERSOES.txt'), 'utf8').split('\n').slice(0, 2).join(' | '),
    confianca: 'só o certificado novo do laboratório (confianca.p12 de cada cópia)',
  });
  expect(sql('SELECT new_organizations_licensed FROM license_rollout'), 'chave da D7 ligada pelo preparo do laboratório').toBe('t');
  client.limpar();
  agent.limpar(['dados/config/agent-config.json']);

  const naraPage = await (await browser.newContext()).newPage();
  const anaPage = await (await browser.newContext()).newPage();
  const brunoPage = await (await browser.newContext()).newPage();
  try {
    // ------------------------------------------------ operadora de licenças (procedimento administrativo de laboratório)
    const ja = pessoas();
    let nara: Person;
    let orgN: string;
    if (ja.nara && ja.orgN && ja.orgNName) {
      nara = reviver(ja.nara);
      await signInWithTotp(naraPage, nara);
      orgN = await enter(naraPage, ja.orgNName);
    } else {
      nara = await signUpAndEnroll(naraPage, 'acp-op');
      guardarPessoa({ nara: guardar(nara) });
      await createOrganization(naraPage, nara, `Nekkora Suporte ${TAG}`);
      orgN = await enter(naraPage, `Nekkora Suporte ${TAG}`);
      const naraUser = sql(`SELECT user_id FROM users WHERE organization_id = '${orgN}' AND email = '${nara.email}'`);
      sql(`INSERT INTO license_operators (operator_user_id, organization_id, registered_by) VALUES ('${naraUser}', '${orgN}', 'roteiro de laboratorio PLATFORM-FLUXO-002 acompanhamento')`);
      guardarPessoa({ orgN, orgNName: `Nekkora Suporte ${TAG}` });
    }
    const env = readFileSync(SEG, 'utf8');
    writeFileSync(SEG, `${env.replace(/^LAB_LICENCAS_ORGANIZACAO_OPERADORA=.*\n/m, '')}LAB_LICENCAS_ORGANIZACAO_OPERADORA=${orgN}\n`);
    compose(LAB, ['up', '-d', '--no-deps', '--wait', 'platform'], { stdio: ['ignore', 'ignore', 'inherit'] }, ['compose.licencas.yml']);
    await waitPlatform(naraPage);
    log('1_operadora', { procedimento: 'license_operators + organizacao operadora; Platform recriada', organizacao: orgN });

    // ------------------------------------------------ a organização da Ana: dois ambientes, quatro automações publicadas
    let ana: Person;
    if (ja.ana) {
      ana = reviver(ja.ana);
      await signInWithTotp(anaPage, ana);
    } else {
      ana = await signUpAndEnroll(anaPage, 'acp-a');
      guardarPessoa({ ana: guardar(ana) });
    }
    const orgName = `Acompanhamento ${TAG}`;
    // a organização da Ana é criada pela operadora, POR EXCEÇÃO, com a Ana como responsável (o caminho do roteiro do
    // licenciamento): numa repetição, a Ana já pode ter usado as três organizações por dia; nenhum limite é zerado
    await go(naraPage, `/o/${orgN}/operador-de-licencas`);
    await naraPage.getByRole('button', { name: 'Criar organização por exceção' }).click();
    const exc = naraPage.getByRole('alertdialog');
    await exc.getByLabel('E-mail da pessoa responsável').fill(ana.email);
    await exc.getByLabel('Nome da organização').fill(orgName);
    await exc.getByLabel('Razão social').fill(`${orgName} Ltda`);
    await exc.getByLabel('Justificativa', { exact: true }).fill('roteiro FLUXO-002 acompanhamento: organizacao de laboratorio');
    await confirmStepUp(naraPage, nara, 'Criar a organização');
    await settle(naraPage);
    await expect(naraPage.getByText(/Organização criada\./)).toBeVisible();
    const org = await enter(anaPage, orgName);
    if (sql(`SELECT public.license_model('${org}')`) !== '2') {
      // criada por exceção fora da chave da D7: a operadora liga a exigência, pela tela, conferindo a prévia
      await go(naraPage, `/o/${orgN}/operador-de-licencas`);
      await naraPage.getByLabel('Identificador da organização').fill(org);
      await naraPage.getByRole('button', { name: 'Abrir' }).click();
      await naraPage.getByRole('button', { name: 'Ligar a exigência de licença' }).click();
      const enforce = naraPage.getByRole('alertdialog');
      await enforce.getByLabel('Justificativa').fill('roteiro FLUXO-002 acompanhamento: organizacao no modelo por licenca');
      await enforce.getByRole('checkbox', { name: /Conferi a prévia/ }).check();
      await confirmStepUp(naraPage, nara, 'Ligar a exigência');
      await settle(naraPage);
    }
    expect(sql(`SELECT public.license_model('${org}')`), 'no modelo por licença').toBe('2');
    const ambientes: Record<string, string> = {};
    for (const nome of ['Fiscal', 'Compras']) {
      await go(anaPage, `/o/${org}/workspaces`);
      await anaPage.getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
      await anaPage.getByRole('alertdialog').getByLabel(/^Nome/).fill(nome);
      await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Criar ambiente de trabalho' }).click();
      await expect(anaPage).toHaveURL(new RegExp(`/o/${org}/workspaces/[0-9a-f-]{36}$`));
      ambientes[nome] = /workspaces\/([0-9a-f-]{36})/.exec(anaPage.url())![1];
    }
    const automacoes: Record<string, string> = {};
    const versoes: Record<string, string> = {};
    for (const [nome, ambiente, zip] of [
      [A_REMOTA, 'Fiscal', RAPIDO],
      [A_LOCAL, 'Fiscal', RAPIDO],
      [A_LONGA, 'Fiscal', LONGO],
      [A_COMPRAS, 'Compras', RAPIDO],
    ] as const) {
      await go(anaPage, `/o/${org}/workspaces/${ambientes[ambiente]}`);
      await anaPage.getByRole('button', { name: 'Criar automação' }).click();
      await settle(anaPage);
      await anaPage.getByLabel(/^Nome da automação/).fill(nome);
      await anaPage.getByRole('radio', { name: /Só o nome, como rascunho/ }).check();
      await anaPage.getByRole('button', { name: 'Salvar rascunho' }).click();
      await settle(anaPage);
      await expect(anaPage.getByRole('heading', { name: nome })).toBeVisible();
      automacoes[nome] = /automacoes\/([0-9a-f-]{36})/.exec(anaPage.url())![1];
      // o limite de frequência (429) não é zerado: diante do aviso, espera-se e envia-se de novo pelo mesmo botão; se a
      // leitura da página da versão recebe "Muitas tentativas", usa-se o "Tentar novamente" dela (settle)
      await anaPage.getByRole('button', { name: 'Nova versão' }).click();
      await expect(anaPage).toHaveURL(/\/automacoes\/[0-9a-f-]{36}\/nova-versao$/);
      await anaPage.getByLabel('Arquivo .zip do pacote').setInputFiles(zip);
      for (let vez = 0; vez < 4; vez++) {
        await anaPage.getByRole('button', { name: 'Enviar o pacote e criar o rascunho' }).click();
        const enviado = await Promise.race([
          anaPage.waitForURL(/\/versoes\/[0-9a-f-]{36}$/, { timeout: 60_000 }).then(() => true),
          anaPage.getByText('Muitas tentativas em pouco tempo. Aguarde antes de enviar de novo.').waitFor({ timeout: 60_000 }).then(() => false),
        ]);
        if (enviado) break;
        await anaPage.waitForTimeout(65_000);
      }
      versoes[nome] = /versoes\/([0-9a-f-]{36})/.exec(anaPage.url())![1];
      await settle(anaPage);
      expect(sql(`SELECT status FROM automation_versions WHERE automation_version_id = '${versoes[nome]}'`), 'rascunho criado com o pacote').toBe('1');
      await anaPage.getByRole('button', { name: 'Publicar versão' }).click();
      await confirmStepUp(anaPage, ana, 'Publicar');
      await settle(anaPage);
      await expect.poll(() => sql(`SELECT status FROM automation_versions WHERE automation_version_id = '${versoes[nome]}'`), { timeout: 60_000 }).toBe('2');
    }
    log('2_organizacao', { org, ambientes, automacoes: Object.keys(automacoes), versoes_publicadas: 4 });

    // ------------------------------------------------ três licenças de teste (sem cobrança), pela tela da operadora
    await go(naraPage, `/o/${orgN}/operador-de-licencas`);
    await naraPage.getByLabel('Identificador da organização').fill(org);
    await naraPage.getByRole('button', { name: 'Abrir' }).click();
    await naraPage.getByRole('button', { name: 'Conceder licenças' }).click();
    const grant = naraPage.getByRole('alertdialog');
    await grant.getByLabel('Quantidade').fill('3');
    await grant.getByLabel('Início da validade').fill(day(0));
    await grant.getByLabel('Fim da validade').fill(day(30));
    await grant.getByLabel('Justificativa').fill('roteiro FLUXO-002 acompanhamento: licencas de teste, sem cobranca');
    await confirmStepUp(naraPage, nara, 'Conceder');
    await settle(naraPage);
    await expect(naraPage.getByText(/Licenças concedidas\./)).toBeVisible();

    // ------------------------------------------------ as duas máquinas, pareadas pelos aplicativos reais
    const workers: Record<string, string> = {};
    const cadastrar = async (nome: string) => {
      await go(anaPage, `/o/${org}/workers`);
      await anaPage.getByRole('button', { name: 'Cadastrar máquina' }).click();
      await anaPage.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill(nome);
      await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Cadastrar máquina' }).click();
      await settle(anaPage);
      await expect(anaPage.getByText(`Máquina ${nome} cadastrada, sem computador vinculado.`, { exact: false })).toBeVisible();
      workers[nome] = sql(`SELECT worker_id FROM workers WHERE organization_id = '${org}' AND name = '${nome}'`);
      await go(anaPage, `/o/${org}/workers`);
      await anaPage.getByRole('button', { name: `Autorizar ${nome} num ambiente de trabalho` }).click();
      await anaPage.getByRole('alertdialog').getByLabel('Ambiente de trabalho').selectOption(ambientes.Fiscal);
      await confirmStepUp(anaPage, ana, 'Autorizar');
      await settle(anaPage);
    };
    // Agent Client: habilitado para execução remota
    await cadastrar(W_CLIENT);
    let l = await client.abrir();
    await go(anaPage, `/o/${org}/workers`);
    await anaPage.getByRole('button', { name: `Vincular Agent a ${W_CLIENT}` }).click();
    await anaPage.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill(PC_CLIENT);
    await anaPage.getByRole('alertdialog').getByLabel('Habilitar esta máquina para execução remota').check();
    await confirmStepUp(anaPage, ana, 'Gerar código');
    let codigo = (await anaPage.getByLabel('Código de uso único').innerText()).trim();
    l = await client.comando('habilitar', codigo);
    expect(l.estado, JSON.stringify({ tela: l.tela, resultado: l.resultado })).toBe('RECEIVING');
    await anaPage.getByRole('button', { name: 'Concluir' }).click();
    await client.comando('presenca');
    await client.comando('python');
    const agenteClient = sql(`SELECT agent_id FROM agent_remote_enablements WHERE worker_id = '${workers[W_CLIENT]}' ORDER BY enabled_at DESC LIMIT 1`);
    // Agent anterior
    await cadastrar(W_AGENT);
    l = await agent.abrir();
    expect(l.vinculo, 'cópia nova: sem vínculo').toBe('NOT_PAIRED');
    await go(anaPage, `/o/${org}/workers`);
    await anaPage.getByRole('button', { name: `Vincular Agent a ${W_AGENT}` }).click();
    await anaPage.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill(PC_AGENT);
    await anaPage.getByRole('alertdialog').getByRole('radio', { name: 'Nekkora Agent anterior' }).check();
    await confirmStepUp(anaPage, ana, 'Gerar código');
    codigo = (await anaPage.getByLabel('Código de uso único').innerText()).trim();
    l = await agent.comando('parear', codigo);
    expect(l.vinculo, String(l.janelaPrincipal).slice(0, 300)).toBe('PAIRED');
    await anaPage.getByRole('button', { name: 'Concluir' }).click();
    log('3_maquinas', { [W_CLIENT]: `${PC_CLIENT} (Agent Client, habilitada para execucao remota)`, [W_AGENT]: `${PC_AGENT} (Agent anterior, pareada pelo dialogo real)` });

    // ------------------------------------------------ ativação (um passo) de cada automação com a sua máquina
    await activateAutomation(anaPage, ana, org, { workspace: 'Fiscal', automation: A_REMOTA, workers: [W_CLIENT] });
    await activateAutomation(anaPage, ana, org, { workspace: 'Fiscal', automation: A_LOCAL, workers: [W_AGENT] });
    await activateAutomation(anaPage, ana, org, { workspace: 'Fiscal', automation: A_LONGA, workers: [W_AGENT] });
    log('4_ativacao', sql(`SELECT string_agg(a.name || '=licenca ' || l.license_number, ', ' ORDER BY a.name) FROM organization_license_assignments g JOIN organization_licenses l ON l.license_id = g.license_id JOIN automations a ON a.automation_id = g.automation_id WHERE g.organization_id = '${org}' AND g.released_at IS NULL`));

    // ------------------------------------------------ REMOTA (Agent Client): Python, dependências, aceite na confirmação, registros e resultado
    await go(anaPage, `/o/${org}/automacoes/${automacoes[A_REMOTA]}`);
    const deps = anaPage.locator('section').filter({ has: anaPage.getByRole('heading', { name: 'Dependências de execução' }) });
    await deps.getByRole('button', { name: /Declarar dependências|Declarar de novo/ }).click();
    await deps.getByRole('radio', { name: /Só as do pacote/ }).check();
    await deps.getByRole('button', { name: 'Declarar', exact: true }).click();
    await expect(deps.getByText(/Dependências declaradas \(revisão \d+\)/)).toBeVisible({ timeout: 30_000 });
    const versaoRemota = `/o/${org}/versoes/${versoes[A_REMOTA]}`;
    const secao = anaPage.locator('section').filter({ has: anaPage.getByRole('heading', { name: 'Execução remota', exact: true }) });
    const linha = () => secao.getByRole('row').filter({ hasText: PC_CLIENT });
    await go(anaPage, versaoRemota);
    await expect(secao).toBeVisible({ timeout: 60_000 });
    const conferido = () => sql(`SELECT coalesce((SELECT c.outcome::text FROM remote_dependency_checks c WHERE c.agent_id = '${agenteClient}' ORDER BY c.requested_at DESC LIMIT 1), 'pendente')`);
    let escolhido = -1;
    for (const n of [0, 1]) {
      await linha().getByRole('button', { name: new RegExp(`(Escolher|Trocar) o Python de ${PC_CLIENT}`) }).click();
      const seletor = anaPage.getByRole('alertdialog').getByLabel('Python da máquina');
      await expect(seletor).toBeVisible({ timeout: 60_000 });
      const virtuais = (await seletor.locator('option').allInnerTexts()).filter((o) => o.includes('ambiente virtual'));
      await seletor.selectOption({ label: virtuais[n] });
      await confirmStepUp(anaPage, ana, 'Escolher este Python');
      await settle(anaPage);
      await reler(anaPage);
      for (let vez = 1; ; vez++) {
        await linha().getByRole('button', { name: `Verificar as dependências em ${PC_CLIENT}` }).click();
        const pedida = secao.getByText(/Verificação pedida a/);
        const cedo = secao.getByText(/já houve um pedido para esta máquina e esta automação há pouco/);
        await expect(pedida.or(cedo).first()).toBeVisible({ timeout: 30_000 });
        if (await pedida.isVisible()) break;
        if (vez >= 3) throw new Error('a verificação de dependências continuou recusada pelo intervalo mínimo');
        await anaPage.waitForTimeout(65_000);
        await reler(anaPage);
      }
      for (let vez = 1; vez <= 12 && conferido() === 'pendente'; vez++) {
        await client.comando('consulta');
        await anaPage.waitForTimeout(2_000);
      }
      await reler(anaPage);
      if ((await linha().innerText()).includes('As dependências declaradas estão neste Python.')) {
        escolhido = n;
        break;
      }
    }
    expect(escolhido, 'um dos ambientes virtuais tem a dependência do pacote').toBeGreaterThanOrEqual(0);
    await linha().getByRole('button', { name: `Solicitar execução em ${PC_CLIENT}` }).click();
    const solicitar = anaPage.getByRole('alertdialog');
    const aceite = solicitar.getByRole('checkbox', { name: /^Aceito executar a versão/ });
    if (await aceite.isVisible().catch(() => false)) await aceite.check();
    await confirmStepUp(anaPage, ana, 'Solicitar execução');
    await settle(anaPage);
    const ultima = () =>
      sql(`SELECT t.state || '|' || coalesce(t.exit_code::text, '') || '|' || t.attempt_id || '|' || x.remote_execution_id FROM remote_attempts t JOIN remote_executions x ON x.remote_execution_id = t.remote_execution_id WHERE x.automation_version_id = '${versoes[A_REMOTA]}' ORDER BY t.created_at DESC LIMIT 1`).split('|');
    for (let vez = 1; Number(ultima()[0] || 0) < 7; vez++) {
      if (vez > 80) throw new Error(`a tentativa remota não terminou: ${ultima().join('|')}`);
      await client.comando('consulta');
      await anaPage.waitForTimeout(1_500);
    }
    const [estadoRemoto, saidaRemota, tentativa, remota] = ultima();
    expect(estadoRemoto, 'remota concluída').toBe('7');
    expect(saidaRemota).toBe('0');
    for (let vez = 1; sql(`SELECT (SELECT count(*) FROM remote_attempt_log_closures WHERE attempt_id = '${tentativa}') + (SELECT count(*) FROM remote_attempt_result_closures WHERE attempt_id = '${tentativa}')`) !== '2'; vez++) {
      if (vez > 30) throw new Error('o envio dos registros e dos resultados não foi fechado');
      await client.comando('consulta');
      await anaPage.waitForTimeout(2_000);
    }
    await client.comando('presenca');
    await client.fechar();
    log('5_remota', { remota, tentativa, estado: 'SUCCEEDED (7)', codigo_de_saida: 0, registros_e_resultados: 'fechados' });

    // ------------------------------------------------ LOCAL (Agent anterior): execução registrada com sucesso
    await agent.comando('autorizacoes');
    const runs = () => Number(sql(`SELECT count(*) FROM agent_runs WHERE organization_id = '${org}'`));
    writeFileSync(resolve(AGENT, 'saida/executar.txt'), [RAPIDO, PYTHON, resolve(AGENT, 'saida/resultado')].join('\n'));
    l = await agent.comando('executar');
    expect(l.estadoLocal, String(l.telaDaExecucao).slice(0, 300)).toBe('SUCCEEDED');
    await expect.poll(async () => { await agent.comando('estado'); return runs(); }, { timeout: 180_000, intervals: [5_000] }).toBe(1);
    const localOk = sql(`SELECT agent_run_id FROM agent_runs WHERE organization_id = '${org}' ORDER BY registered_at DESC LIMIT 1`);
    await expect.poll(() => sql(`SELECT supervisor_state FROM agent_runs WHERE agent_run_id = '${localOk}'`), { timeout: 180_000, intervals: [5_000] }).not.toBe('3');
    log('6_local', { agent_run: localOk, estado_local: l.estadoLocal, registro: l.registroEscolhido, estado_na_api: sql(`SELECT supervisor_state || ' eventos=' || events_stored FROM agent_runs WHERE agent_run_id = '${localOk}'`) });

    // ------------------------------------------------ DESFECHO DESCONHECIDO: a cópia cai com a execução longa em curso
    writeFileSync(resolve(AGENT, 'saida/executar.txt'), [LONGO, PYTHON, resolve(AGENT, 'saida/resultado-longo')].join('\n'));
    agent.enviar('executar');
    await expect.poll(() => runs(), { timeout: 120_000, intervals: [1_000] }).toBe(2);
    const desconhecida = sql(`SELECT agent_run_id FROM agent_runs WHERE organization_id = '${org}' ORDER BY registered_at DESC LIMIT 1`);
    await expect.poll(() => sql(`SELECT agent_started_at IS NOT NULL FROM agent_runs WHERE agent_run_id = '${desconhecida}'`), { timeout: 60_000, intervals: [1_000] }).toBe('t');
    await new Promise((r) => setTimeout(r, 8_000));
    expect(sql(`SELECT supervisor_state FROM agent_runs WHERE agent_run_id = '${desconhecida}'`), 'em execução quando a cópia cai').toBe('3');
    agent.derrubar();
    log('7_queda', { agent_run: desconhecida, ato: 'copia do Agent anterior e o processo da automacao encerrados a forca (arvore do PID aberto pelo roteiro)' });
    await new Promise((r) => setTimeout(r, 3_000));
    l = await agent.abrir();
    expect(l.vinculo).toBe('PAIRED');
    await expect
      .poll(async () => { await agent.comando('estado'); return sql(`SELECT supervisor_state FROM agent_runs WHERE agent_run_id = '${desconhecida}'`); }, { timeout: 300_000, intervals: [10_000] })
      .toBe('9');
    expect(runs(), 'reabrir não relança nada').toBe(2);
    expect(sql(`SELECT count(*) FROM agent_run_reconciliations WHERE agent_run_id = '${desconhecida}'`), 'ninguém reconciliou na Platform').toBe('0');
    // PASSAGEM DO TEMPO (procedimento declarado): o desconhecido fica ANTIGO, de 45 dias atrás
    sql(`SET session_replication_role = replica; UPDATE agent_runs SET registered_at = registered_at - interval '45 days', agent_started_at = agent_started_at - interval '45 days', last_report_at = last_report_at - interval '45 days' WHERE agent_run_id = '${desconhecida}'`);
    log('8_desconhecido', { agent_run: desconhecida, estado: 'OUTCOME_UNKNOWN (9)', reconciliacoes: 0, passagem_do_tempo: '45 dias (declarada)', registrado_em: sql(`SELECT registered_at FROM agent_runs WHERE agent_run_id = '${desconhecida}'`) });
    agent.guardarJanelas('agent');
    await agent.fechar();

    // ------------------------------------------------ PEDIDO ao Agent anterior que fica aguardando a máquina (cópia fechada)
    await go(anaPage, `/o/${org}/versoes/${versoes[A_LOCAL]}`);
    await anaPage.getByRole('button', { name: new RegExp(`^Executar na máquina ${W_AGENT}`) }).first().click();
    await anaPage.getByRole('alertdialog').getByLabel('Validade do pedido (minutos)').fill('1440');
    await confirmStepUp(anaPage, ana, 'Pedir execução');
    await expect(anaPage.getByText(/Pedido de execução registrado/)).toBeVisible();
    const pedido = sql(`SELECT run_request_id FROM run_requests WHERE organization_id = '${org}' ORDER BY requested_at DESC LIMIT 1`);
    log('9_pedido', { run_request: pedido, estado: sql(`SELECT state FROM run_requests WHERE run_request_id = '${pedido}'`), validade: '24 h; a copia do Agent fica fechada' });

    // ------------------------------------------------ FIXTURE DECLARADA: duas execuções da Platform (Fiscal e Compras)
    const membro = sql(`SELECT m.membership_id FROM organization_memberships m JOIN users u ON u.user_id = m.user_id WHERE m.organization_id = '${org}' AND u.email = '${ana.email}'`);
    const platform: string[] = [];
    for (const [nome, ambiente] of [[A_REMOTA, 'Fiscal'], [A_COMPRAS, 'Compras']] as const) {
      const id = sql('SELECT gen_random_uuid()');
      sql(
        // como na massa do teste de integração: a regra "nasce PENDING" é do fluxo orquestrado, que não roda no laboratório
        `SET session_replication_role = replica; INSERT INTO executions (execution_id, organization_id, workspace_id, automation_id, automation_version_id, request_key, request_fingerprint, requested_by_membership_id, command_snapshot, status, status_reason, origin, created_at, finished_at) ` +
          `SELECT '${id}', '${org}', '${ambientes[ambiente]}', '${automacoes[nome]}', v.automation_version_id, 'k-' || gen_random_uuid(), repeat('b', 64), '${membro}', v.command_json, 4, 1, 1, clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours' + interval '5 seconds' ` +
          `FROM automation_versions v WHERE v.automation_version_id = '${versoes[nome]}'`,
      );
      platform.push(id);
    }
    log('10_fixture_platform', { execucoes: platform, nota: 'origem do modelo orquestrado, sem produtor no laboratorio: inseridas no banco (declarado)' });

    // ------------------------------------------------ Bruno: só leitura, e só no ambiente Fiscal
    let bruno: Person;
    if (ja.bruno) {
      bruno = reviver(ja.bruno);
      await signInWithTotp(brunoPage, bruno);
    } else {
      bruno = await signUpAndEnroll(brunoPage, 'acp-b');
      guardarPessoa({ bruno: guardar(bruno) });
    }
    await go(anaPage, `/o/${org}/administracao/convites`);
    await anaPage.getByLabel(/^E-mail da pessoa/).fill(bruno.email);
    await anaPage.getByLabel(/^Papel/).selectOption('VIEWER');
    await anaPage.getByLabel(/^Ambiente de trabalho do papel/).selectOption(ambientes.Fiscal);
    await anaPage.getByRole('button', { name: 'Convidar' }).click();
    await confirmStepUp(anaPage, ana, 'Enviar convite');
    await settle(anaPage);
    const token = await waitToken('ORG_INVITATION', bruno.email);
    await go(brunoPage, `/o/${org}/convite#token=${token}`);
    await brunoPage.getByRole('button', { name: 'Aceitar convite' }).click();
    await confirmStepUp(brunoPage, bruno, 'Aceitar');
    await settle(brunoPage);
    log('11_bruno', 'leitura (VIEWER) so no ambiente Fiscal');

    const estado: Estado = {
      nara: guardar(nara), ana: guardar(ana), bruno: guardar(bruno), orgN, org, orgName,
      fiscal: ambientes.Fiscal, compras: ambientes.Compras, automacoes, versoes, workers,
      remota, localOk, desconhecida, pedido, platform,
    };
    writeFileSync(ESTADO, JSON.stringify(estado, null, 2));
    log('preparo', 'concluido; estado guardado fora dos repositorios');
  } catch (e) {
    await shot(anaPage, 'falha-ana').catch(() => undefined);
    await shot(naraPage, 'falha-operadora').catch(() => undefined);
    throw e;
  } finally {
    client.derrubar();
    agent.derrubar();
    rmSync(resolve(CLIENT, 'saida/codigo.txt'), { force: true });
    rmSync(resolve(AGENT, 'saida/codigo.txt'), { force: true });
    for (const [a, n] of [[client, 'client'], [agent, 'agent']] as const) if (existsSync(a.saida)) { mkdirSync(EVID, { recursive: true }); copyFileSync(a.saida, join(EVID, `aplicativo-${n}.jsonl`)); }
  }
});

// ==================================================================================================== 2. verificação
/** Entra (senha + TOTP) e abre a organização pelo botão "Entrar em …" (a sessão é por organização). */
async function signedIn(browser: Browser, person: Person, orgName: RegExp): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  try {
    await signInWithTotp(page, person);
  } catch (e) {
    // o código do intervalo atual já foi usado (outra passada há menos de 30 s): espera o próximo, como a pessoa
    if (!page.url().includes('/entrar/verificacao')) throw e;
    await page.waitForTimeout(31_000);
    await page.getByLabel('Código de autenticação').fill(await person.auth.next());
    await expect(page).toHaveURL(/\/organizacoes$/);
  }
  await settle(page);
  const entrar = page.getByRole('button', { name: orgName }).first();
  for (let vez = 0; vez < 4 && !(await entrar.isVisible().catch(() => false)); vez++) {
    await entrar.waitFor({ timeout: 20_000 }).catch(() => undefined);
    if (await entrar.isVisible()) break;
    await shot(page, `entrar-${person.name.replace(/\W+/g, '-')}-${vez}`);
    await go(page, '/organizacoes');
  }
  await entrar.click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await settle(page);
  return page;
}
// os nomes das organizações do roteiro têm só letras, dígitos e espaços
const exato = (nome: string) => new RegExp(`^Entrar em ${nome}(?![0-9a-z])`);

test('2. verificação: Em andamento e Histórico, quatro origens sem duplicação, máquina ↔ atividade, atenção, links antigos, permissões e isolamento', async ({ browser }) => {
  test.setTimeout(1_800_000);
  expect(existsSync(ESTADO), 'o preparo guardou o estado').toBe(true);
  const s = JSON.parse(readFileSync(ESTADO, 'utf8')) as Estado;
  const { org } = s;
  const ana = await signedIn(browser, reviver(s.ana), exato(s.orgName));

  // ------------------------------------------------ 1. as quatro origens pela API real: cada execução uma vez, nas abas certas
  const andamento = await activityAll(ana, org, 'in_progress');
  const historico = await activityAll(ana, org, 'history');
  const chaves = [...andamento, ...historico].map((e) => `${e.kind}:${e.id}`);
  const banco = {
    platform: Number(sql(`SELECT count(*) FROM executions WHERE organization_id = '${org}'`)),
    local_agent: Number(sql(`SELECT count(*) FROM agent_runs WHERE organization_id = '${org}'`)),
    // a mesma definição da API: pedido que não virou execução (sem agent_run_id) e não convertido (estado 6)
    local_request: Number(sql(`SELECT count(*) FROM run_requests q WHERE q.organization_id = '${org}' AND q.state <> 6 AND q.agent_run_id IS NULL`)),
    remote: Number(sql(`SELECT count(*) FROM remote_executions WHERE organization_id = '${org}'`)),
  };
  const porOrigem = (k: string) => new Set(chaves.filter((c) => c.startsWith(`${k}:`))).size;
  log('v1_origens', { banco, na_api: { platform: porOrigem('platform'), local_agent: porOrigem('local_agent'), local_request: porOrigem('local_request'), remote: porOrigem('remote') }, em_andamento: andamento.length, historico: historico.length });
  for (const k of Object.keys(banco) as (keyof typeof banco)[]) expect(porOrigem(k), `origem ${k}: uma linha por execução`).toBe(banco[k]);
  // o preparo criou 2 da Platform, 2 do Agent anterior, 1 pedido e 1 remota; a parte 4 acrescenta pedidos
  expect(banco.platform).toBe(2);
  expect(banco.local_agent).toBe(2);
  expect(banco.local_request).toBeGreaterThanOrEqual(1);
  expect(banco.remote).toBe(1);
  const dias30 = Date.now() - 30 * 86_400_000;
  const noPeriodo = historico.filter((e) => Date.parse(e.requestedAt) >= dias30);
  // sem duplicação: nenhuma chave repetida dentro de uma aba; e só o desconhecido (atenção, com desfecho) aparece nas duas
  expect(new Set(andamento.map((e) => `${e.kind}:${e.id}`)).size).toBe(andamento.length);
  expect(new Set(historico.map((e) => `${e.kind}:${e.id}`)).size).toBe(historico.length);
  const nasDuas = andamento.filter((e) => historico.some((h) => h.kind === e.kind && h.id === e.id)).map((e) => e.id);
  expect(nasDuas, 'só a pendência de atenção (que já tem desfecho) aparece também no histórico').toEqual([s.desconhecida]);
  const unk = andamento.find((e) => e.id === s.desconhecida);
  expect(unk, 'o desconhecido antigo está em Em andamento').toBeTruthy();
  expect(unk.attention).toBe(true);
  expect(unk.outcome).toBe('unconfirmed');
  expect(andamento.find((e) => e.id === s.pedido)?.outcome).toBe('in_progress');
  expect(historico.find((e) => e.id === s.remota)?.machine?.workerId).toBe(s.workers[W_CLIENT]);
  expect(historico.find((e) => e.id === s.localOk)?.machine?.workerId).toBe(s.workers[W_AGENT]);

  // ------------------------------------------------ Em andamento pela tela (padrão, sem período)
  await go(ana, `/o/${org}/execucoes`);
  await expect(ana.getByRole('tab', { name: 'Em andamento' })).toHaveAttribute('aria-selected', 'true');
  await expect(ana.getByLabel('Período')).toHaveCount(0);
  await expect(tableRows(ana)).toHaveCount(andamento.length);
  const linhaUnk = tableRows(ana).filter({ hasText: A_LONGA });
  await expect(linhaUnk).toContainText('Requer atenção');
  await expect(linhaUnk).toContainText('Resultado não confirmado');
  await expect(linhaUnk).not.toContainText('Em andamento');
  await expect(linhaUnk).toContainText(W_AGENT);
  await expect(ana.getByText('1 execução requer atenção.')).toBeVisible();
  const linhaPedido = tableRows(ana).filter({ hasText: 'Pedido ao Agent anterior' }).last();
  await expect(linhaPedido).toContainText(A_LOCAL);
  await expect(linhaPedido).toContainText('Em andamento');
  await shot(ana, 'v1-em-andamento');

  // ------------------------------------------------ Histórico (padrão 30 dias): o desconhecido de 45 dias fica fora; com todo o histórico, aparece marcado
  await ana.getByRole('tab', { name: 'Histórico' }).click();
  await settle(ana);
  await expect(ana).toHaveURL(/aba=historico/);
  await expect(tableRows(ana)).toHaveCount(noPeriodo.length);
  for (const nome of [A_REMOTA, A_LOCAL, A_COMPRAS]) await expect(tableRows(ana).filter({ hasText: nome }).first()).toBeVisible();
  // a local (Python externo, código 0 sem sinal) nunca aparece como sucesso de negócio
  const linhaLocal = tableRows(ana).filter({ hasText: A_LOCAL }).filter({ hasText: 'Agent anterior' });
  await expect(linhaLocal).toContainText('Terminou sem erro sinalizado');
  await expect(linhaLocal).not.toContainText('Concluída com sucesso');
  await expect(tableRows(ana).filter({ hasText: A_LONGA })).toHaveCount(0);
  await expect(ana.getByText(/Pendências que requerem atenção continuam em “Em andamento”/)).toBeVisible();
  await shot(ana, 'v1-historico-30-dias');
  await ana.getByLabel('Período').selectOption('all');
  await settle(ana);
  await expect(tableRows(ana)).toHaveCount(historico.length);
  await expect(tableRows(ana).filter({ hasText: A_LONGA })).toContainText('Requer atenção');

  // filtros: ambiente, automação e máquina (na tela e no que vai à API)
  await ana.getByLabel('Ambiente de trabalho').selectOption({ label: 'Compras' });
  await settle(ana);
  await expect(tableRows(ana)).toHaveCount(1);
  await expect(tableRows(ana).first()).toContainText(A_COMPRAS);
  await ana.getByLabel('Ambiente de trabalho').selectOption({ index: 0 });
  await settle(ana);
  await go(ana, `/o/${org}/execucoes?aba=historico&periodo=all&automacao=${s.automacoes[A_REMOTA]}`);
  await expect(tableRows(ana)).toHaveCount(historico.filter((e) => e.automation.id === s.automacoes[A_REMOTA]).length); // a remota e a da Platform
  expect(historico.filter((e) => e.automation.id === s.automacoes[A_REMOTA]).length).toBe(2);
  for (const t of await tableRows(ana).allInnerTexts()) expect(t).toContain(A_REMOTA);
  log('v1_filtros', 'ambiente (Compras: 1), automacao (Robo de notas: 2), maquina (abaixo)');

  // detalhes: remota (registros e resultados), local (eventos), Platform, pedido (automação)
  await go(ana, `/o/${org}/execucoes?aba=historico`);
  await tableRows(ana).filter({ hasText: 'Agent Client' }).getByRole('link', { name: /^Execução de / }).click();
  await expect(ana).toHaveURL(new RegExp(`/execucoes-remotas/${s.remota}$`));
  const tentativa = ana.getByLabel('Tentativa 1', { exact: true });
  await expect(tentativa).toContainText('Nome da máquina');
  await expect(tentativa).toContainText(PC_CLIENT);
  await tentativa.getByRole('button', { name: 'Ver registros da tentativa 1' }).click();
  await expect(tentativa.getByRole('list', { name: 'Registros da tentativa 1' })).toContainText('fim da execucao sintetica', { timeout: 60_000 });
  await tentativa.getByRole('button', { name: 'Ver resultados da tentativa 1' }).click();
  await expect(tentativa.getByRole('list', { name: 'Resultados da tentativa 1' })).toContainText('relatorio.txt', { timeout: 60_000 });
  await shot(ana, 'v1-detalhe-remota-registros-resultados');
  // detalhe → máquina → atividade da máquina
  await tentativa.getByRole('link', { name: 'Abrir a máquina' }).click();
  await expect(ana).toHaveURL(new RegExp(`/workers\\?maquina=${s.workers[W_CLIENT]}$`));
  await expect(ana.getByText('Mostrando só a máquina da execução.')).toBeVisible();
  await expect(ana.getByRole('region', { name: 'Lista de máquinas' }).locator('tbody tr')).toHaveCount(1);
  await expect(ana.getByRole('region', { name: 'Lista de máquinas' })).toContainText(W_CLIENT);

  await go(ana, `/o/${org}/execucoes?aba=historico`);
  await tableRows(ana).filter({ hasText: A_LOCAL }).filter({ hasText: 'Agent anterior' }).getByRole('link', { name: /^Execução de / }).click();
  await expect(ana).toHaveURL(new RegExp(`/execucoes-locais/${s.localOk}$`));
  await expect(ana.getByRole('heading', { name: 'Execução local' })).toBeVisible();
  await expect(ana.locator('main')).toContainText('Nome da máquina');
  await expect(ana.locator('main')).toContainText(PC_AGENT);
  await settle(ana);
  await ana.waitForTimeout(3_000);
  await shot(ana, 'v1-detalhe-local');
  // pacote Python externo: o registro é o do supervisor (relatos), sem etapas do Framework; código 0 sem sinal
  await expect(ana.locator('main')).toContainText('Supervisor: Terminou sem erro sinalizado');
  await expect(ana.locator('main')).toContainText('Completo');
  await expect(ana.getByText('Etapas indisponíveis')).toBeVisible();
  await shot(ana, 'v1-detalhe-local-eventos');

  await go(ana, `/o/${org}/execucoes?aba=historico`);
  await tableRows(ana).filter({ hasText: A_COMPRAS }).getByRole('link', { name: /^Execução de / }).click();
  await expect(ana).toHaveURL(new RegExp(`/execucoes/${s.platform[1]}$`));
  await expect(ana.getByRole('heading', { level: 1, name: /^Execução de / })).toBeVisible();

  await go(ana, `/o/${org}/execucoes`);
  await tableRows(ana).filter({ hasText: 'Pedido ao Agent anterior' }).last().getByRole('link', { name: /^Pedido de / }).click();
  await expect(ana).toHaveURL(new RegExp(`/automacoes/${s.automacoes[A_LOCAL]}$`));
  log('v1_detalhes', 'remota (registros e resultados), local (relatos do supervisor, codigo 0 sem sinal), Platform e pedido (automacao) abertos pela linha');

  // ------------------------------------------------ 2. Máquinas → Ver atividade → detalhe → máquina (o filtro identifica a máquina certa)
  await go(ana, `/o/${org}/workers`);
  const linhaAgent = ana.getByRole('row', { name: new RegExp(W_AGENT) });
  await expect(linhaAgent).toContainText('1 requer atenção');
  // os pedidos aguardando a máquina contam como em andamento; a pendência não
  await expect(linhaAgent).toContainText(`${andamento.filter((e) => e.machine?.workerId === s.workers[W_AGENT] && !e.attention).length} em andamento`);
  await expect(linhaAgent).not.toContainText(/livre|disponível/i);
  await shot(ana, 'v2-maquinas-atividade');
  await linhaAgent.getByRole('link', { name: `Ver atividade de ${W_AGENT}` }).click();
  await expect(ana).toHaveURL(new RegExp(`/execucoes\\?maquina=${s.workers[W_AGENT]}$`));
  await settle(ana);
  await expect(ana.getByText(new RegExp(`^Somente a máquina ${W_AGENT} \\(nome da máquina: ${PC_AGENT}\\)\\.$`))).toBeVisible();
  await expect(tableRows(ana)).toHaveCount(andamento.filter((e) => e.machine?.workerId === s.workers[W_AGENT]).length);
  for (const t of await tableRows(ana).allInnerTexts()) expect(t).toContain(W_AGENT);
  await tableRows(ana).filter({ hasText: A_LONGA }).getByRole('link', { name: /^Execução de / }).click();
  await expect(ana).toHaveURL(new RegExp(`/execucoes-locais/${s.desconhecida}$`));
  await expect(ana.getByText(/Supervisor: Desfecho desconhecido/)).toBeVisible({ timeout: 60_000 });
  await ana.getByRole('link', { name: 'Abrir a máquina' }).click();
  await expect(ana).toHaveURL(new RegExp(`/workers\\?maquina=${s.workers[W_AGENT]}$`));
  await expect(ana.getByRole('region', { name: 'Lista de máquinas' }).locator('tbody tr')).toHaveCount(1);
  await expect(ana.getByRole('region', { name: 'Lista de máquinas' })).toContainText(W_AGENT);
  // a outra máquina: "Ver atividade" sem nada em andamento ainda identifica a máquina pelo nome
  await go(ana, `/o/${org}/workers`);
  await ana.getByRole('row', { name: new RegExp(W_CLIENT) }).getByRole('link', { name: `Ver atividade de ${W_CLIENT}` }).click();
  await settle(ana);
  await expect(ana.getByText(new RegExp(`^Somente a máquina ${W_CLIENT} \\(nome da máquina: ${PC_CLIENT}\\)\\.$`))).toBeVisible();
  await expect(ana.getByText('Nada em andamento agora.')).toBeVisible();
  await ana.getByRole('tab', { name: 'Histórico' }).click();
  await settle(ana);
  await expect(ana).toHaveURL(new RegExp(`maquina=${s.workers[W_CLIENT]}`));
  await expect(tableRows(ana)).toHaveCount(1);
  await expect(tableRows(ana).first()).toContainText(A_REMOTA);
  log('v2_maquina_atividade', { [W_AGENT]: 'atencao 1, em andamento 1, filtro com o nome; detalhe do desconhecido e volta a maquina', [W_CLIENT]: 'filtro com o nome mesmo sem linha em andamento; historico com a remota' });

  // ------------------------------------------------ 3. o desconhecido antigo: em "Requer atenção", sem máquina disponível
  await go(ana, `/o/${org}/execucoes-locais/${s.desconhecida}`);
  await expect(ana.locator('main')).toContainText(/Desfecho Desconhecido/i);
  await expect(ana.locator('main')).not.toContainText('Concluída com sucesso');
  log('v3_desconhecido', { registrado_ha: '45 dias', em_andamento: 'Requer atencao + Resultado nao confirmado', historico_30_dias: 'fora', todo_o_historico: 'marcado', maquina: '1 requer atencao; nao conta como em andamento nem livre' });

  // ------------------------------------------------ 5. endereços antigos de Supervisão
  await go(ana, `/o/${org}/supervisao`);
  await expect(ana).toHaveURL(new RegExp(`/o/${org}/execucoes([?]aba=andamento)?$`));
  await expect(ana.getByRole('tab', { name: 'Em andamento' })).toHaveAttribute('aria-selected', 'true');
  await go(ana, `/o/${org}/supervisao/${s.desconhecida}`);
  await expect(ana).toHaveURL(new RegExp(`/o/${org}/execucoes-locais/${s.desconhecida}$`));
  await expect(ana.getByRole('heading', { name: 'Execução local' })).toBeVisible();
  await expect(ana.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Supervisão' })).toHaveCount(0);
  log('v5_links_antigos', { lista: '/supervisao -> /execucoes', detalhe: '/supervisao/:id -> /execucoes-locais/:id', menu: 'sem Supervisao' });

  // ------------------------------------------------ permissões: Bruno lê só o ambiente Fiscal
  const bruno = await signedIn(browser, reviver(s.bruno), exato(s.orgName));
  await go(bruno, `/o/${org}/execucoes?aba=historico&periodo=all`);
  await expect(tableRows(bruno).first()).toBeVisible();
  for (const t of await tableRows(bruno).allInnerTexts()) expect(t).not.toContain(A_COMPRAS);
  const brunoTudo = [...(await activityAll(bruno, org, 'in_progress')), ...(await activityAll(bruno, org, 'history'))];
  expect(brunoTudo.some((e) => e.workspace.id === s.compras), 'nada de Compras para quem só lê Fiscal').toBe(false);
  expect(brunoTudo.some((e) => e.id === s.desconhecida)).toBe(true);
  await go(bruno, `/o/${org}/execucoes/${s.platform[1]}`);
  await expect(bruno.getByText(/não encontrada/i).first()).toBeVisible();
  await go(bruno, `/o/${org}/supervisao/${s.desconhecida}`);
  await expect(bruno).toHaveURL(new RegExp(`/execucoes-locais/${s.desconhecida}$`));
  await expect(bruno.getByText(/Supervisor: Desfecho desconhecido/)).toBeVisible({ timeout: 60_000 });
  const brunoMaquinas = await apiGet(bruno, `/api/v1/o/${org}/activity/machines`);
  log('v_permissoes', { bruno: 'VIEWER em Fiscal', linhas_de_compras: 0, detalhe_de_compras: 'nao encontrada', link_antigo_do_detalhe: 'abre o detalhe de Fiscal', resumo_por_maquina: brunoMaquinas.status });
  expect(brunoMaquinas.status).toBe(200);

  // ------------------------------------------------ isolamento entre organizações
  const nara = await signedIn(browser, reviver(s.nara), /^Entrar em Nekkora Suporte/);
  const fora = await apiGet(nara, `/api/v1/o/${org}/activity?tab=history`);
  expect([401, 403, 404], `outra organização: ${fora.status}`).toContain(fora.status);
  const foraMaq = await apiGet(nara, `/api/v1/o/${org}/activity/machines`);
  expect([401, 403, 404]).toContain(foraMaq.status);
  const propria = [...(await activityAll(nara, s.orgN, 'in_progress')), ...(await activityAll(nara, s.orgN, 'history'))];
  expect(propria.filter((e) => [s.remota, s.localOk, s.desconhecida, s.pedido, ...s.platform].includes(e.id))).toEqual([]);
  await go(nara, `/o/${org}/execucoes`);
  await expect(nara).not.toHaveURL(new RegExp(`/o/${org}/execucoes`));
  const anaFora = await apiGet(ana, `/api/v1/o/${s.orgN}/activity?tab=history`);
  expect([401, 403, 404]).toContain(anaFora.status);
  log('v_isolamento', { outra_organizacao_na_api: [fora.status, foraMaq.status], na_tela: nara.url().replace(/^https?:\/\/[^/]+/, ''), no_sentido_contrario: anaFora.status });
  log('fim', `verificacao concluida; "Tentar novamente" usado ${retried} vez(es); nenhum limite de frequencia zerado`);
});

// ==================================================================================================== 3. convite para o aceite
test('3. convite para o aceite manual (ACEITE_EMAIL)', async ({ browser }) => {
  test.skip(!process.env.ACEITE_EMAIL, 'sem ACEITE_EMAIL');
  const s = JSON.parse(readFileSync(ESTADO, 'utf8')) as Estado;
  // um autenticador só para a pessoa: o código usado na entrada não é reaproveitado na confirmação
  const anaPessoa = reviver(s.ana);
  const ana = await signedIn(browser, anaPessoa, exato(s.orgName));
  await go(ana, `/o/${s.org}/administracao/convites`);
  await ana.getByLabel(/^E-mail da pessoa/).fill(process.env.ACEITE_EMAIL!);
  await ana.getByLabel(/^Papel/).selectOption('ORG_ADMIN');
  await ana.getByRole('button', { name: 'Convidar' }).click();
  try {
    await confirmStepUp(ana, anaPessoa, 'Enviar convite');
    await settle(ana);
    await expect(ana.getByText('Convite enviado. A pessoa recebe o link por e-mail.')).toBeVisible();
  } finally {
    await shot(ana, 'convite-do-aceite');
  }
  log('convite_do_aceite', { organizacao: s.orgName, papel: 'ORG_ADMIN' });
});

// ==================================================================================================== 4. a lista se atualiza sozinha
test('4. Em andamento aberta antes: o pedido novo aparece sem recarregar nem "Atualizar"', async ({ browser }) => {
  test.setTimeout(600_000);
  const s = JSON.parse(readFileSync(ESTADO, 'utf8')) as Estado;
  const ana = reviver(s.ana);
  const lista = await signedIn(browser, ana, exato(s.orgName));
  const outra = await signedIn(browser, ana, exato(s.orgName));
  await go(lista, `/o/${s.org}/execucoes`);
  await expect(lista.getByRole('tab', { name: 'Em andamento' })).toHaveAttribute('aria-selected', 'true');
  await expect(tableRows(lista).first()).toBeVisible();
  const antes = await tableRows(lista).count();
  const url = lista.url();
  // em outra aba: um pedido novo ao Agent anterior (a cópia continua fechada: ele fica aguardando a máquina)
  await go(outra, `/o/${s.org}/versoes/${s.versoes[A_LOCAL]}`);
  await outra.getByRole('button', { name: new RegExp(`^Executar na máquina ${W_AGENT}`) }).first().click();
  await outra.getByRole('alertdialog').getByLabel('Validade do pedido (minutos)').fill('1440');
  await confirmStepUp(outra, ana, 'Pedir execução');
  await expect(outra.getByText(/Pedido de execução registrado/)).toBeVisible();
  const pedidoEm = Date.now();
  // a lista aberta antes recebe o pedido sozinha (a aba relê a cada 30 s), sem navegar
  await expect(tableRows(lista)).toHaveCount(antes + 1, { timeout: 75_000 });
  expect(lista.url(), 'sem navegar nem recarregar').toBe(url);
  log('v4_atualiza_sozinha', { linhas_antes: antes, depois: antes + 1, segundos_ate_aparecer: Math.round((Date.now() - pedidoEm) / 1000) });
});

// ==================================================================================================== 5. lançador e pedido convertido
/** Executável de console da cópia do Agent (nekkora-console / nekkora-lancar), com a mesma pasta de dados da cópia. */
function consoleDaCopia(exe: 'nekkora-console' | 'nekkora-lancar', args: string[], input?: string, cwd?: string) {
  const cfg = resolve(AGENT, `app/app/${exe}.cfg`);
  const t = readFileSync(cfg, 'utf8');
  const dataDir = `java-options=-Dnekkora.agent.dataDir=${resolve(AGENT, 'dados')}`;
  if (!t.includes('nekkora.agent.dataDir')) writeFileSync(cfg, t.replace('[JavaOptions]', `[JavaOptions]\r\n${dataDir}`));
  return spawnSync(resolve(AGENT, `app/${exe}.exe`), args, { input, encoding: 'utf8', timeout: 600_000, cwd });
}

test('5. Python externo monitorado pelo lançador e pedido ao Agent anterior que vira execução (lista sem duplicar, detalhe preservado)', async ({ browser }) => {
  test.setTimeout(2_400_000);
  const s = JSON.parse(readFileSync(ESTADO, 'utf8')) as Estado;
  const { org } = s;
  const anaPessoa = reviver(s.ana);
  const naraPessoa = reviver(s.nara);
  const ana = await signedIn(browser, anaPessoa, exato(s.orgName));
  const nara = await signedIn(browser, naraPessoa, /^Entrar em Nekkora Suporte/);
  try {
    // ------------------------------------------------ automação só monitorada (sem versão), com uma licença nova e a Estação Agent
    let monitorada = sql(`SELECT automation_id FROM automations WHERE organization_id = '${org}' AND name = '${A_MONITORADA}'`);
    if (!monitorada) {
      await go(ana, `/o/${org}/workspaces/${s.fiscal}`);
      await ana.getByRole('button', { name: 'Criar automação' }).click();
      await settle(ana);
      await ana.getByLabel(/^Nome da automação/).fill(A_MONITORADA);
      await ana.getByRole('radio', { name: /Só o nome, como rascunho/ }).check();
      await ana.getByRole('button', { name: 'Salvar rascunho' }).click();
      await settle(ana);
      await expect(ana.getByRole('heading', { name: A_MONITORADA })).toBeVisible();
      monitorada = /automacoes\/([0-9a-f-]{36})/.exec(ana.url())![1];
      await go(nara, `/o/${s.orgN}/operador-de-licencas`);
      await nara.getByLabel('Identificador da organização').fill(org);
      await nara.getByRole('button', { name: 'Abrir' }).click();
      await nara.getByRole('button', { name: 'Conceder licenças' }).click();
      const grant = nara.getByRole('alertdialog');
      await grant.getByLabel('Quantidade').fill('1');
      await grant.getByLabel('Início da validade').fill(day(0));
      await grant.getByLabel('Fim da validade').fill(day(30));
      await grant.getByLabel('Justificativa').fill('roteiro FLUXO-002 acompanhamento: licenca de teste para o monitoramento');
      await confirmStepUp(nara, naraPessoa, 'Conceder');
      await settle(nara);
      await activateAutomation(ana, anaPessoa, org, { workspace: 'Fiscal', automation: A_MONITORADA, workers: [W_AGENT] });
    }
    log('5_monitorada', { automacao: monitorada, licenca: 'nova (operadora, pela tela)', maquina: W_AGENT });

    // ------------------------------------------------ PEDIDO → EXECUÇÃO: o pacote da Rotina local aprovado NA máquina (com a cópia fechada)
    const pendentes = sql(`SELECT string_agg(run_request_id::text, ',') FROM run_requests WHERE organization_id = '${org}' AND agent_run_id IS NULL AND state IN (1, 2)`).split(',').filter(Boolean);
    expect(pendentes.length, 'há pedidos aguardando a máquina').toBeGreaterThan(0);
    mkdirSync(resolve(AGENT, 'saida/pedidos'), { recursive: true });
    const instalar = consoleDaCopia('nekkora-console', ['pacote', 'instalar', RAPIDO, '--python', PYTHON, '--saida', resolve(AGENT, 'saida/pedidos')], 'SIM\n');
    log('5_pacote_aprovado_na_maquina', { codigo: instalar.status, saida: (instalar.stdout || instalar.stderr).replace(/\s+/g, ' ').slice(0, 220), confirmacao: 'SIM pela entrada padrao do console (ato da pessoa na maquina, feito pelo operador do laboratorio)' });
    expect(instalar.status, instalar.stderr).toBe(0);

    // a lista aberta ANTES (Em andamento): os pedidos aparecem como pedidos
    await go(ana, `/o/${org}/execucoes`);
    await expect(tableRows(ana).filter({ hasText: 'Pedido ao Agent anterior' })).toHaveCount(pendentes.length);
    const linhasAntes = await tableRows(ana).count();
    const url = ana.url();

    // a máquina volta: a cópia do Agent recebe os pedidos e executa
    const l = await agent.abrir();
    expect(l.vinculo).toBe('PAIRED');
    await expect
      .poll(async () => {
        await agent.comando('estado');
        return Number(sql(`SELECT count(*) FROM run_requests WHERE run_request_id IN (${pendentes.map((x) => `'${x}'`).join(',')}) AND agent_run_id IS NOT NULL`));
      }, { timeout: 600_000, intervals: [10_000] })
      .toBe(pendentes.length);
    const convertidas = sql(`SELECT string_agg(agent_run_id::text, ',') FROM run_requests WHERE run_request_id IN (${pendentes.map((x) => `'${x}'`).join(',')})`).split(',');
    await expect
      .poll(() => sql(`SELECT count(*) FROM agent_runs WHERE agent_run_id IN (${convertidas.map((x) => `'${x}'`).join(',')}) AND supervisor_state NOT IN (1, 2, 3)`), { timeout: 600_000, intervals: [10_000] })
      .toBe(String(convertidas.length));
    log('5_pedidos_convertidos', sql(`SELECT string_agg(q.run_request_id || ' -> ' || r.agent_run_id || ' estado=' || r.supervisor_state || ' codigo=' || coalesce(r.supervisor_code, '-'), ' ; ') FROM run_requests q JOIN agent_runs r ON r.agent_run_id = q.agent_run_id WHERE q.run_request_id IN (${pendentes.map((x) => `'${x}'`).join(',')})`));

    // a mesma lista, SEM recarregar: os pedidos saíram de "Em andamento" (já terminaram) e nada ficou repetido
    await expect(tableRows(ana).filter({ hasText: 'Pedido ao Agent anterior' })).toHaveCount(0, { timeout: 90_000 });
    expect(ana.url(), 'sem navegar nem recarregar').toBe(url);
    const andamento = await activityAll(ana, org, 'in_progress');
    const historico = await activityAll(ana, org, 'history');
    const todos = [...andamento, ...historico];
    for (const pedido of pendentes) expect(todos.some((e) => e.kind === 'local_request' && e.id === pedido), `o pedido ${pedido} não aparece mais como pedido`).toBe(false);
    for (const run of convertidas) expect(historico.filter((e) => e.kind === 'local_agent' && e.id === run), `a execução ${run} aparece uma vez`).toHaveLength(1);
    for (const aba of [andamento, historico]) expect(new Set(aba.map((e) => `${e.kind}:${e.id}`)).size, 'sem chave repetida na aba').toBe(aba.length);
    log('5_lista_sem_duplicar', { linhas_em_andamento_antes: linhasAntes, depois: await tableRows(ana).count(), pedidos_na_api: 0, execucoes_dos_pedidos_no_historico: convertidas.length });
    // o acesso ao detalhe: a linha da execução leva ao detalhe, com a origem do pedido
    await go(ana, `/o/${org}/execucoes?aba=historico`);
    const linhaRun = tableRows(ana).filter({ has: ana.locator(`a[href$="/execucoes-locais/${convertidas[0]}"]`) });
    await expect(linhaRun).toHaveCount(1);
    await linhaRun.getByRole('link', { name: /^Execução de / }).click();
    await expect(ana).toHaveURL(new RegExp(`/execucoes-locais/${convertidas[0]}$`));
    await expect(ana.locator('main')).toContainText('Pedido pela Platform');
    await shot(ana, 'v5-pedido-convertido-detalhe');

    // ------------------------------------------------ PYTHON EXTERNO MONITORADO pelo lançador
    await agent.comando('autorizacoes');
    const authFile = resolve(AGENT, 'dados/plataforma/autorizacoes.json');
    await expect
      .poll(async () => { await agent.comando('autorizacoes'); return existsSync(authFile) ? readFileSync(authFile, 'utf8') : ''; }, { timeout: 420_000, intervals: [10_000] })
      .toContain('EXTERNAL_MONITORED');
    rmSync(CLIENTE, { recursive: true, force: true });
    mkdirSync(CLIENTE, { recursive: true });
    copyFileSync(resolve(EXEMPLO, 'relatorio.py'), resolve(CLIENTE, 'relatorio.py'));
    copyFileSync(resolve(EXEMPLO, 'vendas-exemplo.csv'), resolve(CLIENTE, 'vendas.csv'));
    const vinculo = consoleDaCopia('nekkora-console', ['vincular', '--nome', 'relatorio-csv', '--automacao', monitorada, '--python', PYTHON, '--script', resolve(CLIENTE, 'relatorio.py'), '--pasta', CLIENTE], 'SIM\n');
    log('5_vinculo', { codigo: vinculo.status, saida: (vinculo.stdout || vinculo.stderr).replace(/\s+/g, ' ').slice(0, 200), confirmacao: 'SIM pela entrada padrao do console' });
    expect(vinculo.status, vinculo.stderr).toBe(0);
    const lancar = (extra: string[]) =>
      consoleDaCopia('nekkora-lancar', ['--vinculo', 'relatorio-csv', '--', PYTHON, resolve(CLIENTE, 'relatorio.py'), '--entrada', 'vendas.csv', '--saida', 'resumo.txt', '--efeitos', 'efeitos.txt', ...extra], undefined, CLIENTE);
    const ok = lancar([]);
    const erro = lancar(['--falhar']);
    log('5_lancador', { codigo_sem_erro: ok.status, codigo_com_erro: erro.status, efeitos: existsSync(resolve(CLIENTE, 'efeitos.txt')) ? readFileSync(resolve(CLIENTE, 'efeitos.txt'), 'utf8').trim().split(/\r?\n/).length : 0 });
    expect(ok.status, ok.stderr).toBe(0);
    expect(erro.status, 'o código do script chega a quem chamou o lançador').toBe(3);
    await expect
      .poll(async () => {
        await agent.comando('estado');
        return sql(`SELECT count(*) FROM agent_runs WHERE organization_id = '${org}' AND automation_id = '${monitorada}' AND source_kind = 3 AND supervisor_state NOT IN (1, 2, 3)`);
      }, { timeout: 600_000, intervals: [10_000] })
      .toBe('2');
    log('5_monitoradas_na_api', sql(`SELECT string_agg(agent_run_id || ' estado=' || supervisor_state || ' codigo=' || coalesce(supervisor_code, '-') || ' saida=' || coalesce(exit_code::text, '-'), ' ; ' ORDER BY registered_at) FROM agent_runs WHERE automation_id = '${monitorada}'`));
    // na lista: automação, máquina e desfecho; código 0 sem sinal NÃO é sucesso; o erro com o código no detalhe
    await go(ana, `/o/${org}/execucoes?aba=historico&automacao=${monitorada}`);
    await expect(tableRows(ana)).toHaveCount(2);
    for (const t of await tableRows(ana).allInnerTexts()) {
      expect(t).toContain(A_MONITORADA);
      expect(t).toContain(W_AGENT);
      expect(t).not.toContain('Concluída com sucesso');
    }
    await expect(tableRows(ana).filter({ hasText: 'Terminou sem erro sinalizado' })).toHaveCount(1);
    await expect(tableRows(ana).filter({ hasText: 'Falhou' })).toHaveCount(1);
    await shot(ana, 'v5-monitoradas-lista');
    await tableRows(ana).filter({ hasText: 'Falhou' }).getByRole('link', { name: /^Execução de / }).click();
    await expect(ana.getByText(/Terminou com erro \(código de saída 3\)/)).toBeVisible({ timeout: 60_000 });
    await expect(ana.locator('main')).toContainText(/sem versão \(Python externo monitorado/);
    await shot(ana, 'v5-monitorada-erro-detalhe');
    log('5_fim', 'lancador e pedido convertido verificados na tela e na API');
  } finally {
    agent.guardarJanelas('agent-parte5');
    await agent.fechar().catch(() => agent.derrubar());
    if (existsSync(agent.saida)) copyFileSync(agent.saida, join(EVID, 'aplicativo-agent-parte5.jsonl'));
  }
});
