import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { Authenticator } from '../mock/totp';
import { activateAutomation, confirmStepUp, LAB, newVersionWithPackage, signInWithTotp, type Person } from './support/lab';
import { abrirExe, acessos, comando, controle, derrubarExe, EVID, EXTRAS, fecharExe, GUARDADO, LABDIR, log, pidAtual, sql, vivo } from './support/ambiente';

/**
 * AMBIENTE-PYTHON-001 — VALIDAÇÃO DE PONTA A PONTA no laboratório descartável frontlab-amb001: a Web desta branch (5197), a
 * API real (3f0e3cf+, migration 076, chave do ambiente por execução ligada SÓ neste laboratório), a CÓPIA DE LABORATÓRIO do
 * Client empacotado (condutor por dentro do processo; o aplicativo é o ClientMain real) e o índice PEP 503 LOCAL (127.0.0.1,
 * configuração explícita de teste). Cenário montado por ambiente-001-preparo. Evidências em ../lab/evidencias.
 *
 *   FRONT_LAB_ID=frontlab-amb001 FRONT_PORTA=5197 CENARIO=<nome> npx playwright test -c playwright.real.config.ts ambiente-001-roteiro
 */
type Guardada = { email: string; password: string; name: string; secret: string };
const G = JSON.parse(readFileSync(GUARDADO, 'utf8')) as {
  ana: Guardada;
  oficina: string;
  oficinaName: string;
  workspaceId: string;
  agente: string;
  maquina: string;
  automacoes: Record<string, { automation: string; version: string }>;
};
const ana: Person = { email: G.ana.email, password: G.ana.password, name: G.ana.name, auth: new Authenticator(G.ana.secret), recoveryCodes: [] };
// AMB_SEGUNDA=1: a segunda máquina do laboratório (ambiente-001-segunda-maquina), para os cenários depois da queda do 6
const SEGUNDA = process.env.AMB_SEGUNDA === '1';
const M = SEGUNDA ? 'PC do laboratorio 2' : 'PC do laboratorio';
if (SEGUNDA) G.agente = (G as unknown as { agente2: string }).agente2;
const ARQ = 'roteiro.txt';
const STATES = ['QUEUED', 'OFFERED', 'RECEIVED', 'PREPARING', 'STARTING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'REFUSED', 'EXPIRED', 'ENDED_UNKNOWN'];

async function settle(page: Page) {
  for (let i = 0; i < 4; i++) {
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const retry = page.getByRole('button', { name: 'Tentar novamente' });
    if ((await retry.count()) === 0) return;
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
/** R7 não é afrouxado: antes de cada confirmação reforçada, espera a reposição do balde. */
async function confirmar(page: Page, label: string) {
  await page.waitForTimeout(31_000);
  await confirmStepUp(page, ana, label);
}
const shot = async (target: Page | Locator, name: string) => {
  await target.screenshot({ path: join(EVID, `${name}.png`), ...('goto' in target ? { fullPage: true } : {}) });
};

let page: Page;
async function entrar(browser: Browser) {
  page = await (await browser.newContext()).newPage();
  await signInWithTotp(page, ana);
  await page.getByRole('button', { name: `Entrar em ${G.oficinaName}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await settle(page);
}

const versao = (nome: string) => `/o/${G.oficina}/versoes/${G.automacoes[nome].version}`;
const secao = () => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Execução remota', exact: true }) });
const linha = () => secao().getByRole('row').filter({ hasText: M });

/** O Python desta automação nesta máquina: a INSTALAÇÃO 3.12 do computador (D6), pela tela. */
async function escolherPython() {
  const escolher = linha().getByRole('button', { name: `Escolher o Python de ${M}` });
  if ((await escolher.count()) === 0) return;
  await escolher.click();
  const d = page.getByRole('alertdialog');
  const seletor = d.getByLabel('Python da máquina');
  await expect(seletor).toBeVisible({ timeout: 60_000 });
  const opcao = (await seletor.locator('option').allInnerTexts()).find((o) => /Python 3\.12\.\d+ · instalação/.test(o));
  expect(opcao, 'a instalação 3.12 foi informada pela máquina').toBeTruthy();
  await seletor.selectOption({ label: opcao! });
  await confirmar(page, 'Escolher este Python');
  await settle(page);
}

/** "Ambiente por execução…" → "Gerar a lista completa nesta máquina" → espera a resposta da máquina (a tela se atualiza). */
async function gerarLista(nome: string, evid: string): Promise<{ d: Locator; texto: string; ok: boolean }> {
  await go(page, versao(nome));
  await expect(secao()).toBeVisible({ timeout: 60_000 });
  await escolherPython();
  const abrir = linha().getByRole('button', { name: `Ambiente por execução em ${M}` });
  for (let i = 0; i < 8 && (await abrir.count()) === 0; i++) {
    await page.waitForTimeout(15_000);
    await page.reload();
    await settle(page);
  }
  await abrir.click();
  const d = page.getByRole('alertdialog');
  await expect(d.getByText(/Python base:/)).toBeVisible({ timeout: 30_000 });
  const antes = acessos().length;
  await d.getByRole('button', { name: 'Gerar a lista completa nesta máquina' }).click();
  await expect(d.getByText('Pedido enviado: aguardando a máquina responder. Esta tela se atualiza sozinha.')).toBeVisible({ timeout: 30_000 });
  await shot(d, `${evid}-1-pedido`);
  const lista = d.getByRole('region', { name: 'Lista completa dos pacotes' });
  const falha = d.getByText(/Incompatível com esta máquina|Lista não gerada|não respondeu dentro do prazo/);
  await expect(lista.or(falha).first()).toBeVisible({ timeout: 600_000 });
  await shot(d, `${evid}-2-resposta`);
  const texto = await d.innerText();
  log(ARQ, `${evid}: indice local`, { pedidos_durante_a_resolucao: acessos().slice(antes).map((l) => l.split(' ').slice(2).join(' ')) });
  return { d, texto, ok: await lista.isVisible() };
}

/** O aceite explícito (D1), com os navegadores a conferir (D5). */
async function aceitar(d: Locator, evid: string, navegadores: string[] = []) {
  for (const n of navegadores) await d.getByRole('checkbox', { name: n }).check();
  await d.getByRole('checkbox', { name: /^Autorizo instalar estes \d+ pacotes/ }).check();
  await shot(d, `${evid}-3-aceite`);
  await confirmar(page, 'Autorizar o ambiente por execução');
  await settle(page);
  await expect(page.getByText(/Ambiente por execução aceito\./).first()).toBeVisible({ timeout: 30_000 });
}

/** O botão "Solicitar execução" da máquina, esperando a presença dizer que ela está livre (60 s), como a pessoa faria. */
async function botaoSolicitar(): Promise<Locator> {
  const botao = linha().getByRole('button', { name: `Solicitar execução em ${M}` }).first();
  for (let i = 0; i < 12 && (await botao.count()) === 0; i++) {
    await page.waitForTimeout(15_000);
    await page.reload();
    await settle(page);
  }
  return botao;
}

/** "Solicitar execução" com o ambiente escolhido; devolve o id da solicitação. */
async function solicitar(nome: string, modo: 'MANAGED' | 'PREPARED'): Promise<string> {
  await go(page, versao(nome));
  await expect(secao()).toBeVisible({ timeout: 60_000 });
  const antes = sql(`SELECT count(*) FROM remote_executions WHERE automation_version_id = '${G.automacoes[nome].version}'`);
  // logo depois de uma execução a máquina ainda se diz ocupada até a presença seguinte (60 s): espera, como a pessoa faria
  const botao = linha().getByRole('button', { name: `Solicitar execução em ${M}` }).first();
  for (let i = 0; i < 12 && (await botao.count()) === 0; i++) {
    await page.waitForTimeout(15_000);
    await page.reload();
    await settle(page);
  }
  await botao.click();
  const d = page.getByRole('alertdialog');
  // versão ainda não autorizada para a máquina: o aceite da versão vem na mesma confirmação
  const ack = d.getByRole('checkbox', { name: /^Aceito executar a / });
  if ((await ack.count()) > 0) await ack.check();
  if (modo === 'MANAGED') await d.getByRole('radio', { name: /Ambiente por execução \(aceito\)/ }).check();
  else if ((await d.getByRole('radio', { name: /Python preparado/ }).count()) > 0) await expect(d.getByRole('radio', { name: /Python preparado/ })).toBeChecked();
  await confirmar(page, 'Solicitar execução');
  await settle(page);
  await expect.poll(() => sql(`SELECT count(*) FROM remote_executions WHERE automation_version_id = '${G.automacoes[nome].version}'`), { timeout: 30_000 }).not.toBe(antes);
  return sql(`SELECT remote_execution_id FROM remote_executions WHERE automation_version_id = '${G.automacoes[nome].version}' ORDER BY requested_at DESC LIMIT 1`);
}

/** Aceite vigente da versão NESTA máquina; se não houver, gera a lista e aceita (como a pessoa faria). */
async function garantirAceite(nome: string, evid: string) {
  const n = sql(`SELECT count(*) FROM managed_environment_authorizations WHERE automation_version_id = '${G.automacoes[nome].version}' AND agent_id = '${G.agente}' AND revoked_at IS NULL`);
  if (n !== '0') return;
  const { d, texto, ok } = await gerarLista(nome, evid);
  expect(ok, texto).toBe(true);
  await aceitar(d, evid);
}

type Tentativa = { attempt: string; state: string; refusal: string; exit: string; started: string };
const tentativa = (x: string): Tentativa => {
  const [attempt, state, refusal, exit, started] = sql(
    `SELECT attempt_id, state, coalesce(refusal_reason, ''), coalesce(exit_code::text, ''), coalesce(started_at::text, '') FROM remote_attempts WHERE remote_execution_id = '${x}' ORDER BY attempt_number DESC LIMIT 1`,
  ).split('|');
  return { attempt, state: STATES[Number(state) - 1], refusal, exit, started };
};
const terminal = (s: string) => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'REFUSED', 'EXPIRED', 'ENDED_UNKNOWN'].includes(s);
const etapas = (attempt: string) => sql(`SELECT string_agg(stage::text || '@' || to_char(reached_at, 'HH24:MI:SS'), ',' ORDER BY reached_at) FROM remote_attempt_environment_stages WHERE attempt_id = '${attempt}'`);
const relatorio = (attempt: string) =>
  sql(`SELECT outcome || '|' || coalesce(failure_requirement, '') || '|' || coalesce(failure_phase, '') || '|' || coalesce(left(failure_summary, 300), '') || '|' || coalesce(jsonb_array_length(installed)::text, '') FROM remote_attempt_environment_reports WHERE attempt_id = '${attempt}'`);
/** O arquivo de resultado ambiente.json que a máquina enviou (do volume do laboratório, lido pelo gateway). */
function resultado(attempt: string): Record<string, any> | null {
  const sha = sql(`SELECT coalesce(max(sha256), '') FROM remote_attempt_results WHERE attempt_id = '${attempt}' AND file_name = 'ambiente.json' AND removed_at IS NULL`);
  if (!sha) return null;
  return JSON.parse(compose(LAB, ['exec', '-T', 'agent-gateway', 'cat', `/var/lib/nekkora/resultados/${G.oficina}/${sha}.zip`]) as string);
}

/** Espera a tentativa terminar, guardando o que o aplicativo viu enquanto isso (pasta do ambiente, diário, atividade). */
async function acompanhar(x: string, evid: string, limite = 900_000, durante?: (t: Tentativa, l: Record<string, any>) => Promise<void>) {
  const vistos: string[] = [];
  const ambientes = new Set<string>();
  const fim = Date.now() + limite;
  let t = tentativa(x);
  while (!terminal(t.state) && Date.now() < fim) {
    const l = await comando('estado');
    const v = `${t.state}/${l.diario.split(' ')[0] || '-'}/${l.atividade}`;
    if (vistos[vistos.length - 1] !== v) vistos.push(v);
    if (l.ambientesNasTentativas) ambientes.add(l.ambientesNasTentativas);
    if (durante) await durante(t, l);
    await page.waitForTimeout(2_000);
    t = tentativa(x);
  }
  expect(terminal(t.state), `a tentativa ${t.attempt} terminou (${t.state})`).toBe(true);
  // a entrega de registros e resultados acontece depois do desfecho; espera o aplicativo esvaziar o diário
  await expect.poll(async () => (await comando('estado')).diario, { timeout: 180_000, intervals: [3_000] }).toBe('');
  const depois = await comando('estado');
  log(ARQ, `${evid}: tentativa`, { ...t, etapas: etapas(t.attempt), relatorio: relatorio(t.attempt), sequencia_vista_no_aplicativo: vistos, ambiente_existiu_durante: [...ambientes], depois: { tentativas: depois.tentativas, ambientes: depois.ambientesNasTentativas, resultadosPendentes: depois.resultadosPendentes } });
  return { t, depois, ambientes: [...ambientes] };
}

async function cartao(evid: string) {
  await go(page, page.url());
  const c = secao().getByRole('article').or(secao().locator('[aria-label^="Solicitação de "]')).first();
  await expect(c).toBeVisible({ timeout: 30_000 });
  await shot(c, evid);
  return c.innerText();
}

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });
const CENARIO = process.env.CENARIO ?? 'todos';
const quando = (n: string) => CENARIO === 'todos' || CENARIO.split(',').includes(n);

test.describe.serial('AMBIENTE-PYTHON-001: ponta a ponta', () => {
  test.beforeAll(async ({ browser }) => {
    // a cópia do aplicativo precisa estar aberta (aberta aqui se não estiver)
    let aberto = false;
    try {
      aberto = vivo(pidAtual());
    } catch {
      aberto = false;
    }
    if (!aberto) await abrirExe();
    await entrar(browser);
  });

  test('1. fluxo completo: dependência indireta, lista para aceite, venv, instalação, execução e resultados; isolamento entre execuções', async () => {
    test.skip(!quando('fluxo'));
    test.setTimeout(3_600_000);
    const nome = 'Robô dependências';
    const { d, texto, ok } = await gerarLista(nome, '1-fluxo');
    expect(ok, texto).toBe(true);
    const lista = d.getByRole('region', { name: 'Lista completa dos pacotes' });
    const linhas = await lista.getByRole('row').allInnerTexts();
    log(ARQ, '1: lista completa na tela', linhas);
    expect(linhas.join('\n')).toMatch(/amblab-alfa[\s\S]*1\.0\.0[\s\S]*Declarada/);
    expect(linhas.join('\n')).toMatch(/amblab-beta[\s\S]*1\.0\.0[\s\S]*Indireta/);
    const lock = sql(`SELECT lock::text FROM managed_environment_resolutions WHERE automation_version_id = '${G.automacoes[nome].version}' ORDER BY requested_at DESC LIMIT 1`);
    log(ARQ, '1: lock gravado (nome, versão, sha256, arquivo)', lock);
    expect(lock).toContain('c032bba029100ad0e657ca980b7474447a79bd3c4ae040cd8796d6cf6d0cc467');
    expect(lock).toContain('f7ff6ab77b6ab679d79b9f8067a72fc61368492cb9a933f25a307f3d3f29cad8');
    await aceitar(d, '1-fluxo');
    log(ARQ, '1: aceite', sql(`SELECT lock_sha256 || ' checks=' || checks::text || ' rev=' || requirements_revision FROM managed_environment_authorizations WHERE automation_version_id = '${G.automacoes[nome].version}' AND revoked_at IS NULL`));
    const prefixos: string[] = [];
    for (const vez of [1, 2]) {
      const x = await solicitar(nome, 'MANAGED');
      const { t, depois, ambientes } = await acompanhar(x, `1-execucao-${vez}`);
      expect(t.state).toBe('SUCCEEDED');
      expect(t.exit).toBe('0');
      expect(ambientes.length, 'o ambiente temporário existiu durante a execução').toBeGreaterThan(0);
      expect(depois.ambientesNasTentativas, 'o ambiente temporário foi apagado no fim').toBe('');
      expect(depois.resultadosPendentes).toBe(0);
      const r = resultado(t.attempt);
      log(ARQ, `1-execucao-${vez}: o que a automação viu`, r);
      expect(r?.modulos).toEqual({ 'amblab-alfa': '1.0.0', 'amblab-beta': '1.0.0' });
      expect(String(r?.prefix)).toContain(t.attempt);
      expect(String(r?.base_prefix)).toMatch(/python312/i);
      prefixos.push(String(r?.prefix));
      log(ARQ, `1-execucao-${vez}: cartão na Web`, await cartao(`1-execucao-${vez}-web`));
    }
    expect(prefixos[0]).not.toBe(prefixos[1]);
  });

  test('2. versão nova com lista e aceite próprios; a antiga usa as suas; mudança na lista exige novo aceite', async () => {
    test.skip(!quando('versoes'));
    test.setTimeout(3_600_000);
    const nome = 'Robô dependências';
    const a = G.automacoes[nome].automation;
    // a versão 2 (amblab-alfa 1.1.0, que pede amblab-beta 2), publicada pela tela
    if (!G.automacoes['v2']) {
      await go(page, `/o/${G.oficina}/automacoes/${a}`);
      const url = await newVersionWithPackage(page, join(LABDIR, 'robos', 'dependencias-v2.zip'));
      await page.getByRole('button', { name: 'Publicar versão' }).click();
      await confirmar(page, 'Publicar');
      await settle(page);
      const v2 = /versoes\/([0-9a-f-]{36})/.exec(url)![1];
      await expect.poll(() => sql(`SELECT status FROM automation_versions WHERE automation_version_id = '${v2}'`), { timeout: 60_000 }).toBe('2');
      G.automacoes['v2'] = { automation: a, version: v2 };
      writeFileSync(GUARDADO, JSON.stringify({ ...JSON.parse(readFileSync(GUARDADO, 'utf8')), automacoes: G.automacoes }));
    }
    // o aceite da versão 1 NÃO vale para a 2: na solicitação da 2 a opção do ambiente por execução não aparece
    await go(page, versao('v2'));
    await linha().getByRole('button', { name: `Solicitar execução em ${M}` }).first().click();
    const pedir = page.getByRole('alertdialog');
    await expect(pedir).toBeVisible();
    const opcaoNaV2 = await pedir.getByRole('radio', { name: /Ambiente por execução \(aceito\)/ }).count();
    await shot(pedir, '2-v2-sem-aceite-solicitar');
    await pedir.getByRole('button', { name: 'Cancelar' }).click();
    log(ARQ, '2: v2 sem aceite próprio', { opcao_ambiente_por_execucao_na_solicitacao: opcaoNaV2 });
    const aceitaV2 = sql(`SELECT count(*) FROM managed_environment_authorizations WHERE automation_version_id = '${G.automacoes['v2'].version}' AND revoked_at IS NULL`);
    if (aceitaV2 === '0') expect(opcaoNaV2).toBe(0);
    const { d, texto, ok } = await gerarLista('v2', '2-v2');
    expect(ok, texto).toBe(true);
    const linhasV2 = (await d.getByRole('region', { name: 'Lista completa dos pacotes' }).getByRole('row').allInnerTexts()).join('\n');
    log(ARQ, '2: lista da v2', linhasV2);
    expect(linhasV2).toMatch(/amblab-alfa[\s\S]*1\.1\.0/);
    expect(linhasV2).toMatch(/amblab-beta[\s\S]*2\.0\.0[\s\S]*Indireta/);
    await aceitar(d, '2-v2');
    // cada versão executa com as suas: a 1 (alfa 1.0.0 / beta 1.0.0) e a 2 (alfa 1.1.0 / beta 2.0.0)
    for (const [v, esperado] of [
      [nome, { 'amblab-alfa': '1.0.0', 'amblab-beta': '1.0.0' }],
      ['v2', { 'amblab-alfa': '1.1.0', 'amblab-beta': '2.0.0' }],
    ] as const) {
      const x = await solicitar(v, 'MANAGED');
      const { t } = await acompanhar(x, `2-execucao-${v === nome ? 'v1' : 'v2'}`);
      expect(t.state).toBe('SUCCEEDED');
      expect(resultado(t.attempt)?.modulos).toEqual(esperado);
    }
  });

  test('2b. mudança na lista declarada exige novo aceite, com o que mudou', async () => {
    test.skip(!quando('novoaceite'));
    test.setTimeout(3_600_000);
    const nome = 'Robô dependências';
    const a = G.automacoes[nome].automation;
    // a lista declarada muda (mais um pacote): o aceite deixa de valer e a solicitação MANAGED é recusada até novo aceite
    log(ARQ, '2b: revisão declarada antes', sql(`SELECT max(revision_number) FROM automation_runtime_requirements WHERE automation_id = '${a}'`));
    await go(page, `/o/${G.oficina}/automacoes/${a}`);
    const deps = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Dependências de execução' }) });
    await deps.getByRole('button', { name: /Declarar dependências|Declarar de novo/ }).click();
    await deps.getByRole('radio', { name: /Lista digitada/ }).check();
    await deps.getByLabel('Lista de dependências').fill('typing_extensions==4.16.0');
    await deps.getByRole('button', { name: 'Conferir o texto' }).click();
    await expect(deps.getByRole('button', { name: 'Declarar', exact: true })).toBeEnabled({ timeout: 30_000 });
    await deps.getByRole('button', { name: 'Declarar', exact: true }).click();
    await expect(deps.getByText(/Dependências declaradas \(revisão \d+\)/)).toBeVisible({ timeout: 30_000 });
    await go(page, versao(nome));
    await shot(secao(), '2-mudou-a-lista-maquina');
    const linhaTexto = await linha().innerText();
    log(ARQ, '2: depois da mudança na lista', linhaTexto);
    await (await botaoSolicitar()).click();
    const pedir2 = page.getByRole('alertdialog');
    const opcaoDepois = await pedir2.getByRole('radio', { name: /Ambiente por execução \(aceito\)/ }).count();
    await shot(pedir2, '2-mudou-a-lista-solicitar');
    await pedir2.getByRole('button', { name: 'Cancelar' }).click();
    expect(opcaoDepois, 'sem aceite vigente, a solicitação não oferece o ambiente por execução').toBe(0);
    // nova lista: a tela mostra o que mudou em relação ao aceito; só com novo aceite volta a valer
    const nova = await gerarLista(nome, '2-nova-lista');
    expect(nova.ok, nova.texto).toBe(true);
    const mudou = await nova.d.getByRole('list', { name: 'O que mudou na lista' }).innerText().catch(() => '');
    log(ARQ, '2: o que mudou na lista', mudou);
    expect(mudou).toMatch(/typing.extensions==4\.16\.0/i);
    await aceitar(nova.d, '2-nova-lista');
    const x = await solicitar(nome, 'MANAGED');
    const { t } = await acompanhar(x, '2-execucao-v1-novo-aceite');
    expect(t.state).toBe('SUCCEEDED');
  });

  test('3. falhas na resolução: pacote inexistente e sem wheel compatível; nada a aceitar', async () => {
    test.skip(!quando('falhas'));
    test.setTimeout(1_800_000);
    for (const [nome, evid, espera] of [
      ['Robô inexistente', '3-inexistente', /amblab-inexistente/],
      ['Robô incompatível', '3-incompativel', /amblab-linux/],
    ] as const) {
      const { d, texto, ok } = await gerarLista(nome, evid);
      expect(ok).toBe(false);
      log(ARQ, `${evid}: tela`, texto.slice(texto.indexOf('Incompatível'), texto.indexOf('Incompatível') + 600));
      log(ARQ, `${evid}: resposta gravada`, sql(`SELECT outcome || '|' || coalesce(failure_requirement,'') || '|' || coalesce(failure_phase,'') || '|' || coalesce(failure_summary,'') FROM managed_environment_resolutions WHERE automation_version_id = '${G.automacoes[nome].version}' ORDER BY requested_at DESC LIMIT 1`));
      expect(texto).toMatch(espera);
      expect(await d.getByRole('checkbox', { name: /^Autorizo instalar/ }).count()).toBe(0);
      await d.getByRole('button', { name: 'Cancelar' }).click();
    }
  });

  test('4. falhas na instalação: hash divergente e download interrompido não iniciam a automação', async () => {
    test.skip(!quando('falhas'));
    test.setTimeout(2_400_000);
    for (const [nome, evid, arquivo, modo, fase] of [
      ['Robô hash', '4-hash', 'amblab_trocado-1.0.0-py3-none-any.whl', 'trocar', 'HASH_MISMATCH'],
      // queda de rede no meio do arquivo (conexão derrubada): o pip acusa e a fase é DOWNLOAD
      ['Robô download', '4-download-queda', 'amblab_cortado-1.0.0-py3-none-any.whl', 'resetar', 'DOWNLOAD'],
      // corte "limpo" (o servidor fecha a conexão sem erro): o pip não percebe o arquivo incompleto; quem barra é o hash aceito
      ['Robô download', '4-download-corte-limpo', 'amblab_cortado-1.0.0-py3-none-any.whl', 'cortar', 'HASH_MISMATCH'],
    ] as const) {
      const vigente = sql(`SELECT count(*) FROM managed_environment_authorizations WHERE automation_version_id = '${G.automacoes[nome].version}' AND revoked_at IS NULL`);
      if (vigente === '0') {
        const { d, texto, ok } = await gerarLista(nome, evid);
        expect(ok, texto).toBe(true);
        await aceitar(d, evid);
      }
      // depois do aceite, o índice do laboratório passa a entregar outros bytes / a cortar o download deste arquivo
      controle({ [modo]: [arquivo] });
      try {
        const x = await solicitar(nome, 'MANAGED');
        const { t } = await acompanhar(x, evid);
        expect(t.state).toBe('REFUSED');
        expect(t.refusal).toBe('DEPENDENCY_INSTALL_FAILED');
        expect(t.started, 'a automação não foi iniciada').toBe('');
        expect(relatorio(t.attempt)).toContain(`|${fase}|`);
        expect(resultado(t.attempt), 'nenhum resultado da automação').toBeNull();
        log(ARQ, `${evid}: na Web`, await cartao(`${evid}-web`));
      } finally {
        controle({});
      }
    }
  });

  test('5. instalação demorada: a máquina segue em comunicação; a resolução de outra automação mostra a espera', async () => {
    test.skip(!quando('demorado'));
    test.setTimeout(3_600_000);
    const nome = 'Robô demorado';
    const { d, texto, ok } = await gerarLista(nome, '5-demorado');
    expect(ok, texto).toBe(true);
    await aceitar(d, '5-demorado');
    // ~24 MiB a 96 KiB/s: uns 4 minutos instalando
    controle({ lento: { 'amblab_grande-1.0.0-py3-none-any.whl': 98_304 } });
    let pedidoDeEspera = false;
    const presencas: string[] = [];
    try {
      const x = await solicitar(nome, 'MANAGED');
      const { t } = await acompanhar(x, '5-demorado', 1_500_000, async (t, l) => {
        if (l.diario.startsWith('ENV_PREPARING')) {
          presencas.push(`${new Date().toISOString().slice(11, 19)} presença=${sql(`SELECT to_char(reported_at, 'HH24:MI:SS') FROM agent_presence WHERE agent_id = '${G.agente}'`)} emContato=${l.emContato}`);
        }
        if (!pedidoDeEspera && etapas(t.attempt).includes('2@')) {
          pedidoDeEspera = true;
          await shot(page, '5-demorado-instalando-pagina');
          // durante a instalação, pede a lista de OUTRA automação nesta máquina: ela espera a execução terminar, e a tela diz isso
          const outra = 'Robô navegador';
          await go(page, versao(outra));
          await escolherPython();
          await linha().getByRole('button', { name: `Ambiente por execução em ${M}` }).click();
          const dd = page.getByRole('alertdialog');
          await dd.getByRole('button', { name: 'Gerar a lista completa nesta máquina' }).click();
          await expect(dd.getByText(/só gera a lista quando ela terminar/)).toBeVisible({ timeout: 60_000 });
          await shot(dd, '5-resolucao-esperando-execucao');
          log(ARQ, '5: resolução pedida durante a instalação', (await dd.innerText()).slice(0, 900));
          await dd.getByRole('button', { name: 'Cancelar' }).click();
        }
      });
      expect(t.state).toBe('SUCCEEDED');
      log(ARQ, '5: presença durante a instalação (agent_presence.reported_at)', presencas);
      const distintas = new Set(presencas.map((p) => p.split('presença=')[1].split(' ')[0]));
      expect(distintas.size, 'a presença foi renovada durante a instalação').toBeGreaterThan(2);
      expect(presencas.every((p) => p.endsWith('emContato=true'))).toBe(true);
      // depois da execução, a resolução pendente da outra automação é respondida
      const r = sql(`SELECT coalesce(outcome::text, 'pendente') FROM managed_environment_resolutions WHERE automation_version_id = '${G.automacoes['Robô navegador'].version}' ORDER BY requested_at DESC LIMIT 1`);
      await expect.poll(() => sql(`SELECT coalesce(outcome::text, 'pendente') FROM managed_environment_resolutions WHERE automation_version_id = '${G.automacoes['Robô navegador'].version}' ORDER BY requested_at DESC LIMIT 1`), { timeout: 600_000, intervals: [5_000] }).toBe('1');
      log(ARQ, '5: a resolução que esperava foi respondida depois da execução', { antes: r, depois: 'RESOLVED' });
    } finally {
      controle({});
    }
  });

  test('6. reinício durante o preparo: não inicia nem relança; depois do início, resultado incerto preservado', async () => {
    test.skip(!quando('reinicio'));
    test.setTimeout(3_600_000);
    const nome = 'Robô demorado';
    await garantirAceite(nome, '6-aceite');
    controle({ lento: { 'amblab_grande-1.0.0-py3-none-any.whl': 65_536 } });
    try {
      for (const modo of ['fechar', 'derrubar'] as const) {
        const x = await solicitar(nome, 'MANAGED');
        let t = tentativa(x);
        await expect.poll(() => etapas(tentativa(x).attempt), { timeout: 300_000, intervals: [2_000] }).toContain('2@');
        t = tentativa(x);
        const antes = await comando('estado');
        const pid = pidAtual();
        log(ARQ, `6-${modo}: no meio da instalação`, { tentativa: t, diario: antes.diario, ambientes: antes.ambientesNasTentativas });
        // os Python deste computador neste momento: o pip DESTA tentativa (linha de comando com a pasta dela) e os outros
        const pythons = () =>
          execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { encoding: 'utf8' })
            .split(/\r?\n/)
            .filter(Boolean)
            .map((l) => ({ pid: Number(l.split('\t')[0]), daTentativa: l.includes(t.attempt) }));
        // um Python qualquer, de fora (outro programa): não pode ser atingido
        const sentinela = spawn('python', ['-I', '-c', 'import time; time.sleep(900)'], { detached: true, stdio: 'ignore' });
        sentinela.unref();
        await page.waitForTimeout(1_000);
        const antesDaQueda = pythons();
        const doPip = antesDaQueda.filter((p) => p.daTentativa).map((p) => p.pid);
        if (modo === 'fechar') await fecharExe(pid);
        else await derrubarExe(pid);
        await page.waitForTimeout(5_000);
        const aberto = await abrirExe();
        log(ARQ, `6-${modo}: aberto de novo`, { pid: aberto.pid, diario: aberto.diario, tentativas: aberto.tentativas, ambientes: aberto.ambientesNasTentativas });
        await expect.poll(() => tentativa(x).state, { timeout: 300_000, intervals: [3_000] }).toBe('REFUSED');
        t = tentativa(x);
        expect(t.refusal).toBe('ENVIRONMENT_SETUP_INTERRUPTED');
        expect(t.started, 'a automação não foi iniciada').toBe('');
        await page.waitForTimeout(60_000);
        const depois = await comando('limpeza');
        const novas = sql(`SELECT count(*) FROM remote_attempts WHERE remote_execution_id = '${x}'`);
        const agora = pythons();
        const outrosAntes = antesDaQueda.filter((p) => !p.daTentativa).map((p) => p.pid);
        const outrosVivos = outrosAntes.filter((p) => agora.some((q) => q.pid === p));
        log(ARQ, `6-${modo}: depois`, { tentativa: t, relatorio: relatorio(t.attempt), tentativas_da_solicitacao: novas, diario: depois.diario, ambientes: depois.ambientesNasTentativas, tentativas_no_disco: depois.tentativas, conteudo: depois.conteudoDasTentativas,
          pythonDaTentativaAntes: doPip, pythonDaTentativaDepois: agora.filter((p) => doPip.includes(p.pid)).map((p) => p.pid), outrosPythonAntes: outrosAntes.length, outrosPythonVivos: outrosVivos.length, sentinela: sentinela.pid, sentinelaViva: vivo(sentinela.pid!) });
        expect(novas, 'nada foi relançado sozinho').toBe('1');
        expect(depois.ambientesNasTentativas).toBe('');
        expect(String(depois.conteudoDasTentativas), 'nada da tentativa ficou no disco (nem a pasta do preparo)').not.toContain(t.attempt.slice(0, 8));
        expect(agora.filter((p) => doPip.includes(p.pid)), 'o venv/pip desta tentativa foi encerrado').toEqual([]);
        expect(vivo(sentinela.pid!), 'um Python de fora não é atingido').toBe(true);
        expect(outrosVivos.length, 'nenhum outro Python foi encerrado').toBe(outrosAntes.length);
        execFileSync('taskkill', ['/PID', String(sentinela.pid), '/F']);
        log(ARQ, `6-${modo}: na Web`, await cartao(`6-${modo}-web`));
      }
    } finally {
      controle({});
    }
    // depois do registro de início: a queda do aplicativo com a automação rodando não vira "não iniciada".
    // AMB_6_DEPOIS=0 pula esta parte (ela deixa a máquina em "ocupação incerta" até a prova pela própria máquina)
    if (process.env.AMB_6_DEPOIS === '0') return;
    const longo = 'Robô longo';
    const { d, texto, ok } = await gerarLista(longo, '6-longo');
    expect(ok, texto).toBe(true);
    await aceitar(d, '6-longo');
    const x = await solicitar(longo, 'MANAGED');
    await expect.poll(() => tentativa(x).state, { timeout: 600_000, intervals: [2_000] }).toBe('RUNNING');
    const pid = pidAtual();
    const filhos = (await comando('estado')).diario;
    log(ARQ, '6-depois-do-inicio: rodando', { tentativa: tentativa(x), diario: filhos });
    await derrubarExe(pid);
    await page.waitForTimeout(5_000);
    const aberto = await abrirExe();
    log(ARQ, '6-depois-do-inicio: aberto de novo', { diario: aberto.diario, atividade: aberto.atividade });
    const { t } = await acompanhar(x, '6-depois-do-inicio', 900_000);
    expect(t.refusal, 'não é classificada como não iniciada').not.toBe('ENVIRONMENT_SETUP_INTERRUPTED');
    expect(t.started, 'o início foi registrado').not.toBe('');
    expect(['SUCCEEDED', 'ENDED_UNKNOWN', 'FAILED']).toContain(t.state);
    log(ARQ, '6-depois-do-inicio: na Web', await cartao('6-depois-do-inicio-web'));
  });

  test('7. Playwright real: navegador disponível executa; ausente orienta, sem instalar nada', async () => {
    test.skip(!quando('playwright'));
    test.setTimeout(3_600_000);
    const pasta = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
    const navegadoresAntes = readdirSync(pasta).sort();
    // 1.63.0: o Chromium 1243 está instalado neste computador
    const com = 'Robô navegador';
    const r1 = await gerarLista(com, '7-chromium');
    expect(r1.ok, r1.texto).toBe(true);
    log(ARQ, '7-chromium: componentes externos na tela', (await r1.d.getByRole('list', { name: 'Componentes externos que a máquina precisa ter' }).innerText()).slice(0, 600));
    await aceitar(r1.d, '7-chromium', ['Chromium']);
    const x1 = await solicitar(com, 'MANAGED');
    const a1 = await acompanhar(x1, '7-chromium');
    expect(a1.t.state).toBe('SUCCEEDED');
    const v1 = resultado(a1.t.attempt);
    log(ARQ, '7-chromium: o que a automação viu', v1);
    expect(v1?.titulo).toBe('Pagina do laboratorio');
    // 1.65.2 com Firefox: o Firefox 1572 NÃO está instalado; o preparo recusa e orienta, sem instalar
    const sem = 'Robô sem navegador';
    const r2 = await gerarLista(sem, '7-firefox');
    expect(r2.ok, r2.texto).toBe(true);
    await aceitar(r2.d, '7-firefox', ['Firefox']);
    const x2 = await solicitar(sem, 'MANAGED');
    const a2 = await acompanhar(x2, '7-firefox');
    expect(a2.t.state).toBe('REFUSED');
    expect(a2.t.refusal).toBe('EXTERNAL_PREREQUISITE_MISSING');
    expect(a2.t.started).toBe('');
    log(ARQ, '7-firefox: relatório', relatorio(a2.t.attempt));
    log(ARQ, '7-firefox: na Web', await cartao('7-firefox-web'));
    const navegadoresDepois = readdirSync(pasta).sort();
    log(ARQ, '7: navegadores do Playwright neste computador', { antes: navegadoresAntes, depois: navegadoresDepois });
    expect(navegadoresDepois).toEqual(navegadoresAntes);
  });

  test('8. Python preparado continua o padrão e funcionando', async () => {
    test.skip(!quando('preparado'));
    test.setTimeout(1_800_000);
    const nome = 'Robô preparado';
    await go(page, versao(nome));
    await escolherPython();
    const x = await solicitar(nome, 'PREPARED');
    const { t } = await acompanhar(x, '8-preparado');
    expect(t.state).toBe('SUCCEEDED');
    expect(sql(`SELECT environment_mode FROM remote_executions WHERE remote_execution_id = '${x}'`)).toBe('1');
    expect(sql(`SELECT count(*) FROM remote_attempt_environments WHERE attempt_id = '${t.attempt}'`)).toBe('0');
    const r = resultado(t.attempt);
    log(ARQ, '8: o que a automação viu', r);
    expect(String(r?.prefix)).toMatch(/python312/i);
    // a versão com aceite: a solicitação vem com "Python preparado" marcado por padrão
    await garantirAceite('Robô dependências', '8-aceite');
    await go(page, versao('Robô dependências'));
    await (await botaoSolicitar()).click();
    const d = page.getByRole('alertdialog');
    await expect(d.getByRole('radio', { name: /^Python preparado/ })).toBeChecked();
    await shot(d, '8-padrao-python-preparado');
    await d.getByRole('button', { name: 'Cancelar' }).click();
  });

  test('10. limpeza (varredura e "Limpar cache") não apaga resultados pendentes', async () => {
    test.skip(!quando('limpeza'));
    test.setTimeout(1_800_000);
    const nome = 'Robô dependências';
    const canal = (acao: 'pausar' | 'retomar') => execFileSync('node', ['tools/lab/lab.mjs', LAB, 'canal-agent', acao], { encoding: 'utf8' });
    await garantirAceite(nome, '10-aceite');
    const x = await solicitar(nome, 'MANAGED');
    await expect.poll(() => tentativa(x).state, { timeout: 600_000, intervals: [2_000] }).toBe('RUNNING');
    // o canal das máquinas cai com a automação rodando: ela termina, mas o desfecho e os resultados ficam no computador.
    // Regra implementada (docs/execucao-remota.md, "Código da tentativa"; docs/ambiente-gerenciado.md, "Limpeza"): o venv da
    // tentativa sai com o CÓDIGO, quando a tentativa está resolvida com a Platform; a pasta de saída só com o recebimento confirmado.
    // Com o canal fora, nada disso aconteceu: o venv e a saída ficam, e a varredura não toca a tentativa pendente.
    const id8 = (tentativa(x).attempt as string).slice(0, 8);
    canal('pausar');
    let saidaAntes = '';
    try {
      await expect.poll(async () => (await comando('estado')).saidas as string, { timeout: 300_000, intervals: [3_000] }).toMatch(new RegExp(`${id8}/ex-[0-9a-f]+/ambiente\\.json=[0-9a-f]{64}`));
      await page.waitForTimeout(20_000);
      const antes = await comando('estado');
      saidaAntes = antes.saidas;
      const varredura = await comando('limpeza');
      const cache = await comando('limpar-cache');
      const depois = await comando('estado');
      log(ARQ, '10: com o canal fora', {
        antes: { diario: antes.diario, conteudo: antes.conteudoDasTentativas, saidas: antes.saidas, ambientes: antes.ambientesNasTentativas },
        varredura: { removidas: varredura.removidas, conteudo: varredura.conteudoDasTentativas },
        limparCache: { habilitado: cache.limparHabilitado, uso: cache.usoDoCache, tela: cache.resultado },
        depois: { diario: depois.diario, conteudo: depois.conteudoDasTentativas, saidas: depois.saidas },
      });
      expect(antes.diario, 'o desfecho espera a entrega').toContain(tentativa(x).attempt);
      expect(antes.ambientesNasTentativas, 'o venv da tentativa pendente fica até ela ser resolvida com a Platform').toContain(tentativa(x).attempt);
      expect(depois.diario).toBe(antes.diario);
      expect(depois.saidas, 'a varredura e o "Limpar cache" não tocam os arquivos de retorno').toBe(antes.saidas);
      expect(depois.ambientesNasTentativas).toBe(antes.ambientesNasTentativas);
    } finally {
      canal('retomar');
    }
    const { t } = await acompanhar(x, '10-limpeza', 600_000);
    expect(t.state).toBe('SUCCEEDED');
    expect(resultado(t.attempt)?.modulos).toBeTruthy();
    // o que a Platform recebeu é exatamente o que ficou guardado com o canal fora
    const recebido = sql(`SELECT file_name || '=' || sha256 FROM remote_attempt_results WHERE attempt_id = '${t.attempt}' ORDER BY file_name`);
    log(ARQ, '10: recebido pela Platform', { recebido, guardado: saidaAntes });
    expect(saidaAntes.replace(/\/ex-[0-9a-f]+\//, '/')).toBe(`${id8}/${recebido}`);
    // depois da entrega: o venv e a saída saem (código com a tentativa resolvida; saída com o recebimento confirmado)
    await expect.poll(async () => (await comando('estado')).tentativas as string, { timeout: 180_000, intervals: [3_000] }).not.toContain(t.attempt);
    log(ARQ, '10: depois da entrega', await comando('estado'));
  });

  test('9. chave desligada: comportamento de antes', async () => {
    test.skip(!quando('chave'));
    test.setTimeout(1_800_000);
    const seg = join(process.env.USERPROFILE ?? '', '.nekkora', 'front-lab', LAB, 'segredos.env');
    const ligar = (v: boolean) => {
      writeFileSync(seg, readFileSync(seg, 'utf8').replace(/^LAB_AMBIENTE_GERENCIADO=.*$/m, `LAB_AMBIENTE_GERENCIADO=${v}`));
      compose(LAB, ['up', '-d', '--no-deps', '--wait', 'platform', 'agent-gateway'], { stdio: ['ignore', 'ignore', 'inherit'] }, EXTRAS);
    };
    ligar(false);
    try {
      await expect.poll(async () => (await page.request.get('/api/v1/csrf').catch(() => null))?.status() ?? 0, { timeout: 180_000, intervals: [2_000] }).toBe(200);
      // a presença seguinte não traz a oferta; o aplicativo deixa de declarar a capacidade
      await comando('presenca');
      await comando('presenca');
      const caps = sql(`SELECT array_to_string(capabilities, ',') FROM agent_presence WHERE agent_id = '${G.agente}'`);
      log(ARQ, '9: capacidades declaradas com a chave desligada', caps);
      expect(caps).not.toContain('MANAGED_ENV_1_0');
      await go(page, versao('Robô dependências'));
      await expect(secao()).toBeVisible({ timeout: 60_000 });
      expect(await linha().getByRole('button', { name: `Ambiente por execução em ${M}` }).count()).toBe(0);
      await shot(secao(), '9-chave-desligada-versao');
      const x = await solicitar('Robô preparado', 'PREPARED');
      const { t } = await acompanhar(x, '9-preparado-chave-desligada');
      expect(t.state).toBe('SUCCEEDED');
    } finally {
      ligar(true);
    }
    // religada: a capacidade volta na presença seguinte à oferta (o aplicativo manda uma presença a mais na hora)
    const religou = Date.now();
    await expect
      .poll(
        async () => {
          await comando('presenca');
          return sql(`SELECT array_to_string(capabilities, ',') FROM agent_presence WHERE agent_id = '${G.agente}'`);
        },
        { timeout: 300_000, intervals: [5_000] },
      )
      .toContain('MANAGED_ENV_1_0');
    log(ARQ, '9: religada', { capacidades: sql(`SELECT array_to_string(capabilities, ',') FROM agent_presence WHERE agent_id = '${G.agente}'`), segundos: Math.round((Date.now() - religou) / 1000) });
  });

  test('12. sem a configuração explícita do índice: o aplicativo usa o PyPI público, nunca o índice local', async () => {
    // rodar com a cópia apontada por "cfg-lab.py sem-indice" (API em localhost, sem -Dnekkora.client.managedIndexUrl)
    test.skip(!quando('semindice'));
    test.setTimeout(1_800_000);
    const antes = acessos().length;
    const { texto, ok } = await gerarLista('Robô dependências', '12-sem-indice');
    const pedidos = acessos().slice(antes);
    const linhaRes = sql(`SELECT outcome || '|' || coalesce(failure_phase::text, '') || '|' || coalesce(failure_requirement, '') || '|' || coalesce(failure_summary, '') FROM managed_environment_resolutions WHERE automation_version_id = '${G.automacoes['Robô dependências'].version}' ORDER BY requested_at DESC LIMIT 1`);
    log(ARQ, '12: sem a configuração do índice', { ok, resolucao: linhaRes, pedidosAoIndiceLocal: pedidos.length, tela: texto.slice(0, 700) });
    expect(ok, 'amblab-alfa só existe no índice local: pelo PyPI a lista não sai').toBe(false);
    expect(pedidos, 'nenhum pedido chegou ao índice local').toEqual([]);
  });

  test('13. caminho normal: pacote público do PyPI com dependência indireta, versões fixadas; o cache do pip é usado na segunda', async () => {
    // rodar com a cópia apontada por "cfg-lab.py sem-indice exe-dados2" e AMB_SEGUNDA=1. O robô: versão nova do "Robô inexistente"
    // com python-dateutil==2.9.0.post0 (pede six). Nenhuma configuração de índice: o aplicativo usa o pypi.org (HTTPS)
    test.skip(!quando('pypi'));
    test.setTimeout(3_600_000);
    const nome = 'pypi';
    if (!G.automacoes[nome]) {
      const a = G.automacoes['Robô inexistente'].automation;
      await go(page, `/o/${G.oficina}/automacoes/${a}`);
      const url = await newVersionWithPackage(page, join(LABDIR, 'robos', 'pypi.zip'));
      await page.getByRole('button', { name: 'Publicar versão' }).click();
      await confirmar(page, 'Publicar');
      await settle(page);
      const v = /versoes\/([0-9a-f-]{36})/.exec(url)![1];
      await expect.poll(() => sql(`SELECT status FROM automation_versions WHERE automation_version_id = '${v}'`), { timeout: 60_000 }).toBe('2');
      G.automacoes[nome] = { automation: a, version: v };
      writeFileSync(GUARDADO, JSON.stringify({ ...JSON.parse(readFileSync(GUARDADO, 'utf8')), automacoes: G.automacoes }));
    }
    const worker = SEGUNDA ? 'Estação gerenciada 2' : 'Estação gerenciada';
    const ativa = sql(`SELECT count(*) FROM local_run_authorizations l JOIN workers w USING (worker_id) WHERE l.automation_id = '${G.automacoes[nome].automation}' AND w.name = '${worker}' AND l.revoked_at IS NULL`);
    if (ativa === '0') {
      await page.waitForTimeout(31_000);
      await activateAutomation(page, ana, G.oficina, { workspace: 'Fiscal', automation: 'Robô inexistente', workers: [worker] });
      await settle(page);
    }
    const cacheDir = join(LABDIR, SEGUNDA ? 'exe-dados2' : 'exe-dados', 'remota', 'cache-pip');
    const cache = () => {
      const arquivos: string[] = [];
      const andar = (p: string) => {
        try {
          for (const e of readdirSync(p, { withFileTypes: true })) (e.isDirectory() ? andar(join(p, e.name)) : arquivos.push(join(p, e.name)));
        } catch {
          /* ainda não existe */
        }
      };
      andar(cacheDir);
      return arquivos.length;
    };
    const antesIndice = acessos().length;
    const versao13 = G.automacoes[nome].version;
    const lockAtual = () => sql(`SELECT coalesce(lock::text, '') FROM managed_environment_resolutions WHERE automation_version_id = '${versao13}' ORDER BY requested_at DESC LIMIT 1`);
    const aceita = sql(`SELECT count(*) FROM managed_environment_authorizations WHERE automation_version_id = '${versao13}' AND agent_id = '${G.agente}' AND revoked_at IS NULL`);
    if (aceita === '0') {
      const cache0 = cache();
      const { d, texto, ok } = await gerarLista(nome, '13-pypi');
      expect(ok, texto).toBe(true);
      const linhas = (await d.getByRole('region', { name: 'Lista completa dos pacotes' }).getByRole('row').allInnerTexts()).join('\n');
      log(ARQ, '13: lista do PyPI', { linhas, lock: lockAtual(), cache_antes: cache0, cache_depois_da_resolucao: cache() });
      expect(linhas).toMatch(/python-dateutil[\s\S]*2\.9\.0\.post0[\s\S]*Declarada/);
      expect(linhas).toMatch(/six[\s\S]*Indireta/);
      await aceitar(d, '13-pypi');
    }
    // o lock aceito tem os SHA-256 que o próprio PyPI publica para esses arquivos (API JSON pública do pypi.org)
    const lock = JSON.parse(lockAtual()) as { name: string; version: string; sha256: string; fileName: string }[];
    expect(lock.map((l) => l.name).sort()).toEqual(['python-dateutil', 'six']);
    const publicados: Record<string, string> = {};
    for (const l of lock) {
      const j = (await (await fetch(`https://pypi.org/pypi/${l.name}/${l.version}/json`)).json()) as { urls: { filename: string; digests: { sha256: string } }[] };
      publicados[l.fileName] = j.urls.find((u) => u.filename === l.fileName)?.digests.sha256 ?? '';
      expect(l.sha256, `${l.fileName}: SHA-256 do lock = o publicado no PyPI`).toBe(publicados[l.fileName]);
    }
    log(ARQ, '13: lock conferido com o PyPI', { lock, publicados });
    // A: com o cache já preenchido (a resolução baixou do PyPI por HTTPS); B: depois do "Limpar cache" do aplicativo
    const logs: Record<string, string> = {};
    let six = '';
    for (const vez of ['A-com-cache', 'B-sem-cache']) {
      if (vez === 'B-sem-cache') {
        const limpo = await comando('limpar-cache');
        log(ARQ, '13: Limpar cache', { habilitado: limpo.botaoEstavaHabilitado, uso: limpo.usoDoCache, tela: limpo.resultado, arquivos_no_cache: cache() });
        expect(limpo.botaoEstavaHabilitado).toBe(true);
        expect(cache(), 'o cache ficou vazio').toBe(0);
      }
      const antes = cache();
      const x = await solicitar(nome, 'MANAGED');
      const { t, depois } = await acompanhar(x, `13-execucao-${vez}`);
      expect(t.state).toBe('SUCCEEDED');
      expect(depois.ambientesNasTentativas, 'o ambiente temporário foi apagado no fim').toBe('');
      const r = resultado(t.attempt);
      const preparo = sql(`SELECT coalesce(preparation_log, '') FROM remote_attempt_environment_reports WHERE attempt_id = '${t.attempt}'`);
      const relevantes = preparo.split(/\r?\n/).filter((l) => /Looking in indexes|Downloading|Using cached|Collecting|Successfully installed/i.test(l));
      logs[vez] = relevantes.join('\n');
      log(ARQ, `13-execucao-${vez}: o que a automação viu e o preparo`, { resultado: r, cache_antes: antes, cache_depois: cache(), preparo: relevantes });
      // sem "Looking in indexes": o pip só escreve essa linha quando o índice não é o padrão (pypi.org)
      expect(logs[vez]).not.toMatch(/Looking in indexes|127\.0\.0\.1/);
      expect(r?.modulos?.['python-dateutil']).toBe('2.9.0.post0');
      six ||= r?.modulos?.six;
      expect(r?.modulos?.six).toBe(six);
      expect(String(r?.arquivos?.dateutil)).toContain(t.attempt);
      expect(String(r?.arquivos?.six)).toContain(t.attempt);
      expect(cache(), 'o cache do pip tem arquivos (respostas HTTPS do PyPI)').toBeGreaterThan(0);
      log(ARQ, `13-execucao-${vez}: cartão na Web`, await cartao(`13-execucao-${vez}-web`));
    }
    expect(logs['A-com-cache'], 'com o cache, nada é baixado').toMatch(/Using cached python_dateutil-2\.9\.0\.post0[\s\S]*Using cached six-/);
    expect(logs['A-com-cache']).not.toMatch(/Downloading/);
    expect(logs['B-sem-cache'], 'sem o cache, baixa do PyPI').toMatch(/Downloading python_dateutil-2\.9\.0\.post0[\s\S]*Downloading six-1\.17\.0/);
    // o pip 25 só mostra a URL do download quando o índice não é o padrão; a origem é provada pelo lock = SHA-256 publicado no PyPI,
    // pela ausência de configuração de índice e por 0 pedidos ao índice local
    expect(acessos().slice(antesIndice), 'nenhum pedido ao índice local').toEqual([]);
  });

  test('11. registro do preparo: removido depois de 30 dias; o resumo da falha fica', async () => {
    test.skip(!quando('retencao'));
    test.setTimeout(1_800_000);
    const ultima = (nome: string) =>
      sql(`SELECT r.remote_execution_id || ' ' || a.attempt_id FROM remote_attempts a JOIN remote_executions r USING (remote_execution_id)
           JOIN remote_attempt_environment_reports e ON e.attempt_id = a.attempt_id
           WHERE r.automation_version_id = '${G.automacoes[nome].version}' AND e.preparation_log IS NOT NULL ORDER BY a.created_at DESC LIMIT 1`).split(' ');
    const [xv, av] = ultima('Robô hash'); // FAILED (HASH_MISMATCH), "não iniciada"
    const [xn, an] = ultima('Robô dependências'); // READY, recente: o controle
    const urlLog = (x: string, a: string) => `/api/v1/o/${G.oficina}/remote-executions/${x}/attempts/${a}/environment-log`;
    const estado = (a: string) => sql(`SELECT outcome || '|' || coalesce(failure_phase::text, '') || '|' || (preparation_log IS NOT NULL) || '|' || coalesce(log_expired_at::text, '') || '|' || reported_at FROM remote_attempt_environment_reports WHERE attempt_id = '${a}'`);
    log(ARQ, '11: antes', { vencida: { tentativa: av, linha: estado(av), http: (await page.request.get(urlLog(xv, av))).status() }, controle: { tentativa: an, linha: estado(an) } });
    // antes dos 30 dias o banco recusa apagar (gatilho da 076), mesmo pelo papel da Platform
    const recusa = sql(`DO $$ BEGIN UPDATE remote_attempt_environment_reports SET preparation_log = NULL WHERE attempt_id = '${av}'; RAISE EXCEPTION 'apagou antes do prazo'; EXCEPTION WHEN check_violation THEN CREATE TEMP TABLE r AS SELECT 'recusado ' || SQLSTATE || ': ' || SQLERRM AS v; END $$; SELECT v FROM r`);
    log(ARQ, '11: apagar antes dos 30 dias', recusa);
    expect(recusa).toContain('recusado 23514');
    expect(estado(av).split('|')[2]).toBe('true');
    // passagem do tempo (fixture do laboratório): só o relatório desta tentativa passa a ter 31 dias
    sql(`SET session_replication_role = replica; UPDATE remote_attempt_environment_reports SET reported_at = reported_at - interval '31 days' WHERE attempt_id = '${av}'`);
    // o ciclo roda 5 min depois de a Platform subir e depois de hora em hora: reinicia a Platform do laboratório
    compose(LAB, ['restart', 'platform'], { stdio: ['ignore', 'ignore', 'inherit'] }, EXTRAS);
    await expect.poll(async () => (await page.request.get('/api/v1/csrf').catch(() => null))?.status() ?? 0, { timeout: 180_000, intervals: [2_000] }).toBe(200);
    await expect.poll(() => estado(av).split('|')[2], { timeout: 600_000, intervals: [10_000] }).toBe('false');
    const depois = { vencida: estado(av), controle: estado(an), httpVencida: (await page.request.get(urlLog(xv, av))).status(), httpControle: (await page.request.get(urlLog(xn, an))).status() };
    log(ARQ, '11: depois do ciclo', depois);
    expect(depois.httpVencida).toBe(410);
    expect(depois.httpControle).toBe(200);
    expect(depois.vencida.split('|')[1], 'o resumo da falha fica').not.toBe('');
    expect(depois.vencida.split('|')[3], 'a data da remoção fica').not.toBe('');
    await go(page, versao('Robô hash'));
    const texto = await cartao('11-registro-removido-web');
    log(ARQ, '11: na Web', texto);
    expect(texto).toContain('removido após 30 dias');
  });
});
