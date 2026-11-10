import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { confirmStepUp, LAB, signUpAndEnroll, type Person } from './support/lab';

/**
 * AGENT-PYTHON-001 — Marco 2 com Web, API e Agent REAIS: um projeto Python externo é empacotado pelo gerador (build =
 * empacotar, não EXE), publicado na Platform, aprovado NA máquina e disparado por "Executar". Cenários: desfecho no mesmo
 * pedido; confirmação da decisão perdida (falha injetada SÓ de laboratório) com medição de processos e efeitos; máquina
 * offline e retorno; pedido vencido; queda do Agent na fronteira do início (falha injetada SÓ de laboratório) com o
 * desconhecido visível e nada relançado; credencial revogada (nada inicia).
 *
 * Atos da pessoa NA MÁQUINA executados pelo operador do laboratório e registrados: colar o código de pareamento e confirmar a
 * aprovação do pacote (SIM no console). Fixture declarada: limites da organização (010).
 */
test.use({ actionTimeout: 60_000, navigationTimeout: 60_000 });

const AGENT_REPO = process.env.PY1_AGENT_REPO ?? resolve('../py1-agent-build');
const LABDIR = resolve(`tools/lab/saidas/${LAB}`);
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-m2`);

const ps = (file: string, args: string[], input?: string) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { input, encoding: 'utf8', timeout: 900_000 });
  if (r.status !== 0) throw new Error(`${file} ${args.join(' ')} falhou: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const agent = (acao: string, input?: string) => ps('tools/lab/agent.ps1', ['-Id', LAB, '-Acao', acao, '-AgentRepo', AGENT_REPO], input);
const machine = (acao: string, extra: string[] = []) => ps('tools/lab/python-externo.ps1', ['-Id', LAB, '-Acao', acao, ...extra]);
const effects = () => Number(/efeitos=(\d+)/.exec(machine('efeitos-pedidos'))![1]);
const sql = (q: string) =>
  execFileSync('node', ['tools/lab/lab.mjs', LAB, 'compose', 'exec', '-T', 'postgres', 'psql', '-X', '-At', '-U', 'nekkora', '-d', 'nekkora', '-c', q], { encoding: 'utf8' }).trim();
const log = (k: string, v: unknown) => {
  mkdirSync(EVID, { recursive: true });
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  writeFileSync(join(EVID, 'jornada-m2.txt'), `${k}: ${t}\n`, { flag: 'a' });
  console.log(`${k}: ${t}`);
};
const shot = async (page: Page, name: string) => {
  mkdirSync(EVID, { recursive: true });
  await page.screenshot({ path: join(EVID, `${name}.png`), fullPage: true });
};
const agentAlive = () => spawnSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='Nekkora Agent.exe'" | Where-Object { $_.ExecutablePath -eq '${LABDIR}\\agent-app\\Nekkora Agent.exe' }).Count`], { encoding: 'utf8' }).stdout.trim() !== '0';

async function prepareOrganization(page: Page, person: Person) {
  const name = `Ensaio PY1 M2 ${Date.now().toString(36)}`;
  await page.goto('/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, person, 'Criar organização');
  await page.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  const org = /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];
  execFileSync('node', ['tools/lab/lab.mjs', LAB, 'limites', org, person.email]);
  return org;
}

/** Clica em Executar na versão, confirma com step-up e devolve o id do pedido (o painel mostra os estágios). */
async function execute(page: Page, person: Person, versionUrl: string, minutes = 15): Promise<string> {
  await page.goto(versionUrl);
  await page.getByRole('button', { name: /^Executar na máquina/ }).first().click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('Validade do pedido (minutos)').fill(String(minutes));
  await confirmStepUp(page, person, 'Pedir execução');
  await expect(page.getByText(/Pedido de execução registrado/)).toBeVisible();
  const id = sql(`SELECT run_request_id FROM run_requests ORDER BY requested_at DESC LIMIT 1`);
  return id;
}
async function panelText(page: Page) {
  const panel = page.getByLabel('Pedido de execução').first();
  await panel.getByRole('button', { name: 'Atualizar' }).click().catch(() => undefined);
  await page.waitForTimeout(800);
  return panel.innerText().catch(() => '');
}
const requestRow = (id: string) =>
  sql(`SELECT state || '|' || deliveries || '|' || coalesce(agent_execution_id,'-') || '|' || coalesce(decision_reason,'-') FROM run_requests WHERE run_request_id = '${id}'`);
const runOf = (id: string) =>
  sql(`SELECT coalesce((SELECT supervisor_state || '|' || coalesce(supervisor_code,'-') || '|' || (agent_started_at IS NOT NULL) FROM agent_runs WHERE run_request_id = '${id}'), 'sem-execucao')`);
const runsOf = (id: string) => sql(`SELECT count(*) FROM agent_runs WHERE run_request_id = '${id}'`);
const localDirs = (exec: string) => (existsSync(`${LABDIR}/agent-dados/execucoes/${exec}`) ? 1 : 0);
/** Só as duas provas de falha (S2 e S5), sem repetir a jornada inteira: PY1_M2_SO=falhas. */
const ONLY_FAULTS = process.env.PY1_M2_SO === 'falhas';
const FAULT_LOG = `${LABDIR}/falhas-laboratorio.txt`;
const faultLog = () => (existsSync(FAULT_LOG) ? readFileSync(FAULT_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean) : []);
/** Estado local gravado pelo Agent e os nomes (só nomes) do que existe na pasta da execução. */
const localRecord = (exec: string) => {
  const d = `${LABDIR}/agent-dados/execucoes/${exec}`;
  if (!existsSync(d)) return { estado: '-', arquivos: [] as string[] };
  const st = existsSync(`${d}/estado.json`) ? (/"state"\s*:\s*"([A-Z_]+)"/.exec(readFileSync(`${d}/estado.json`, 'utf8'))?.[1] ?? '?') : '-';
  return { estado: st, arquivos: readdirSync(d).sort() };
};
/** A cópia normal do Agent (distribuição) não traz o artefato de falhas nem opção de laboratório. */
const distributionClean = () => {
  const app = `${LABDIR}/agent-app/app`;
  const cfgs = readdirSync(app).filter((n) => n.endsWith('.cfg')).map((n) => readFileSync(`${app}/${n}`, 'utf8'));
  return !existsSync(`${app}/nekkora-agent-lab-falhas.jar`) && cfgs.every((t) => !/nekkora\.agent\.lab\.|lab-falhas/.test(t));
};
const decisionPosts = (id: string) =>
  (execFileSync('node', ['tools/lab/lab.mjs', LAB, 'compose', 'logs', '--no-color', 'nginx'], { encoding: 'utf8' }).match(new RegExp(`POST /agent/api/v1/run-requests/${id}/decision`, 'g')) ?? [])
    .length;

test('M2: pacote externo publicado, aprovado na máquina e disparado pela Platform (com quedas e recusas)', async ({ page }) => {
  test.setTimeout(5_400_000);
  rmSync(join(EVID, 'jornada-m2.txt'), { force: true });

  // ---------- build: empacotar o projeto externo (comando real do gerador)
  const pkgDir = `${LABDIR}/pacotes-externos`;
  rmSync(pkgDir, { recursive: true, force: true });
  const build = execFileSync('py', ['-3', resolve(AGENT_REPO, 'tools/external-package/nekkora_empacotar.py'), resolve(AGENT_REPO, 'tools/external-package/exemplo-pedido'),
    '--nome', 'relatorio-pedido', '--versao', '1.0.0', '--entrada', 'principal.py', '--incluir', 'dados_exemplo/vendas.csv', '--saida', pkgDir], { encoding: 'utf8' });
  const zip = /pacote:\s+(.+\.zip)/.exec(build)![1].trim();
  const zipSha = /sha256 do ZIP \(bytes do artefato\): ([0-9a-f]{64})/.exec(build)![1];
  const fingerprint = /impressao \(nekkora-agent\/external-python-fingerprint\/1\): ([0-9a-f]{64})/.exec(build)![1];
  log('build', { zipSha, fingerprint });

  // ---------- máquina: Agent limpo (distribuição com o Marco 2) e o ambiente Python preparado (venv do cliente)
  agent('parar');
  rmSync(`${LABDIR}/agent-dados`, { recursive: true, force: true });
  rmSync(`${LABDIR}/saida-pedidos`, { recursive: true, force: true });
  log('agent_preparar', agent('preparar').trim());
  machine('falha-laboratorio', ['-Extra', 'nenhuma']);
  rmSync(FAULT_LOG, { force: true });
  log('distribuicao_sem_falhas_de_laboratorio', distributionClean());
  expect(distributionClean()).toBe(true);
  machine('preparar-cliente', ['-Exemplo', resolve(AGENT_REPO, 'tools/external-package/exemplo-relatorio')]);

  // ---------- Platform: organização, workspace, automação, versão com o pacote externo e publicação
  const ana = await signUpAndEnroll(page, 'py1m2');
  const org = await prepareOrganization(page, ana);
  await page.goto(`/o/${org}/workspaces`);
  await page.getByRole('button', { name: 'Criar workspace' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome/).fill('Operações');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Operações' })).toBeVisible();
  const workspaceId = /workspaces\/([0-9a-f-]{36})/.exec(page.url())![1];
  await page.getByRole('button', { name: 'Criar automação' }).click();
  // T04: criação em página própria; aqui, o caminho só com o nome (rascunho)
  await page.getByLabel(/^Nome da automação/).fill('Relatório por pedido');
  await page.getByRole('radio', { name: /Só o nome, como rascunho/ }).check();
  await page.getByRole('button', { name: 'Salvar rascunho' }).click();
  await page.getByRole('button', { name: 'Nova versão' }).click();
  await expect(page).toHaveURL(/\/versoes\/[0-9a-f-]{36}$/);
  const versionUrl = page.url();
  await page.getByLabel('Arquivo .zip do pacote').setInputFiles(zip);
  await page.getByRole('button', { name: 'Enviar pacote' }).click();
  await expect(page.getByText('Pacote recebido e conferido pela Platform.')).toBeVisible();
  await expect(page.getByText('Python externo (sem framework Nekkora)')).toBeVisible();
  await expect(page.locator('main')).toContainText(fingerprint.slice(0, 12));
  await page.getByRole('button', { name: 'Publicar versão' }).click();
  await confirmStepUp(page, ana, 'Publicar');
  await expect(page.getByText('Publicada (imutável)')).toBeVisible();
  await shot(page, 'm2-01-versao-pacote-externo-publicada');
  const art = sql(`SELECT package_kind || '|' || fingerprint_rule || '|' || fingerprint || '|' || sha256 FROM automation_artifacts ORDER BY received_at DESC LIMIT 1`);
  log('api_artefato(tipo|regra|impressao|sha256)', art);
  expect(art).toBe(`2|nekkora-agent/external-python-fingerprint/1|${fingerprint}|${zipSha}`);

  // ---------- pareamento, Worker no workspace e autorização da versão
  await page.goto(`/o/${org}/agents`);
  await page.getByRole('button', { name: 'Parear novo Agent' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill('ESTACAO-PY1-M2');
  await page.getByRole('alertdialog').getByLabel(/^Nome do Worker/).fill('Worker pedidos');
  await confirmStepUp(page, ana, 'Gerar código');
  const code = (await page.getByLabel('Código de uso único').innerText()).trim();
  agent('iniciar');
  agent('parear', `${code}\n`);
  await page.getByRole('button', { name: 'Concluir' }).click();
  const agentsText = async () => {
    await page.goto(`/o/${org}/agents`);
    await page.getByRole('heading', { name: 'Agents' }).waitFor();
    await page.waitForTimeout(1_500);
    return page.locator('main').innerText();
  };
  await expect.poll(agentsText, { timeout: 240_000, intervals: [10_000] }).toMatch(/ESTACAO-PY1-M2[\s\S]*Conectado/);
  await page.goto(`/o/${org}/workers`);
  await page.getByRole('button', { name: 'Autorizar Worker pedidos num workspace' }).click();
  await page.getByRole('alertdialog').getByLabel('Workspace').selectOption(workspaceId);
  await confirmStepUp(page, ana, 'Autorizar');
  await expect(page.getByText('Worker autorizado no workspace.')).toBeVisible();
  await page.goto(versionUrl);
  await page.getByLabel(/^Worker autorizado neste workspace/).selectOption({ label: 'Worker pedidos' }, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Autorizar execução local' }).click();
  await confirmStepUp(page, ana, 'Autorizar execução local');
  await expect(page.getByText(/Execução local autorizada\. Nada foi iniciado/)).toBeVisible();

  // ---------- máquina: pacote presente e APROVADO (ato local); o Agent baixa a autorização
  log('instalar', machine('instalar-pacote', ['-Exemplo', zip]).replace(/\s+/g, ' ').slice(0, 400));
  const authFile = `${LABDIR}/agent-dados/plataforma/autorizacoes.json`;
  await expect.poll(() => (existsSync(authFile) ? readFileSync(authFile, 'utf8') : ''), { timeout: 420_000, intervals: [10_000] }).toContain('EXTERNAL_PACKAGE');

  // ---------- S1: Executar e ver o desfecho no mesmo pedido
  if (!ONLY_FAULTS) {
  const s1 = await execute(page, ana, versionUrl);
  await shot(page, 'm2-02-pedido-registrado');
  await expect.poll(() => panelText(page), { timeout: 300_000, intervals: [5_000] }).toMatch(/Desfecho reportado: Concluída com sucesso/);
  await shot(page, 'm2-03-pedido-desfecho');
  log('s1', { pedido: requestRow(s1), execucao: runOf(s1), execucoes: runsOf(s1), efeitos: effects() });
  expect(effects()).toBe(1);
  expect(runsOf(s1)).toBe('1');
  }

  // ---------- S2: confirmação da decisão perdida (falha injetada) — quantos processos e efeitos?
  agent('parar');
  machine('falha-laboratorio', ['-Extra', 'perderConfirmacaoDecisao', '-AgentRepo', AGENT_REPO]);
  agent('iniciar');
  const e2 = effects();
  const s2 = await execute(page, ana, versionUrl);
  await expect.poll(() => panelText(page), { timeout: 300_000, intervals: [5_000] }).toMatch(/Desfecho reportado/);
  const exec2 = requestRow(s2).split('|')[2];
  log('s2', { pedido: requestRow(s2), execucao: runOf(s2), execucoes_na_api: runsOf(s2), pastas_locais: localDirs(exec2), decisoes_enviadas: decisionPosts(s2), efeitos: effects() });
  expect(decisionPosts(s2)).toBeGreaterThanOrEqual(2);
  expect(runsOf(s2)).toBe('1');
  expect(localDirs(exec2)).toBe(1);
  expect(effects()).toBe(e2 + 1);
  log('s2_registro_da_falha', faultLog());
  expect(faultLog().filter((l) => l.includes('DECISION_RESPONSE_RECEIVED'))).toHaveLength(1);
  agent('parar');
  machine('falha-laboratorio', ['-Extra', 'nenhuma']);
  expect(distributionClean()).toBe(true);

  if (!ONLY_FAULTS) {

  // ---------- S3: máquina offline — o pedido fica aguardando; volta e executa
  const s3 = await execute(page, ana, versionUrl);
  await page.waitForTimeout(25_000);
  const offline = await panelText(page);
  await shot(page, 'm2-04-maquina-offline-aguardando');
  log('s3_offline', { tela: offline.replace(/\s+/g, ' ').slice(0, 160), pedido: requestRow(s3) });
  expect(offline).toMatch(/Solicitação registrada · aguardando a máquina/);
  expect(offline).not.toMatch(/Execução iniciada/);
  agent('iniciar');
  await expect.poll(() => panelText(page), { timeout: 300_000, intervals: [5_000] }).toMatch(/Desfecho reportado: Concluída com sucesso/);
  log('s3_volta', { pedido: requestRow(s3), execucao: runOf(s3), efeitos: effects() });
  expect(effects()).toBe(3);

  // ---------- S4: pedido vencido sem decisão (máquina fora) — nada roda quando ela volta
  agent('parar');
  const s4 = await execute(page, ana, versionUrl, 1);
  await page.waitForTimeout(75_000);
  await expect.poll(() => panelText(page), { timeout: 60_000, intervals: [5_000] }).toMatch(/Expirada sem decisão/);
  await shot(page, 'm2-05-pedido-expirado');
  agent('iniciar');
  await page.waitForTimeout(40_000);
  log('s4', { pedido: requestRow(s4), execucoes: runsOf(s4), efeitos: effects() });
  expect(requestRow(s4).split('|')[0]).toBe('7');
  expect(runsOf(s4)).toBe('0');
  expect(effects()).toBe(3);
  }

  // ---------- S5: queda do Agent na fronteira do início (falha injetada) — desconhecido visível, nada relançado
  agent('parar');
  machine('falha-laboratorio', ['-Extra', 'quedaAposStarting', '-AgentRepo', AGENT_REPO]);
  agent('iniciar');
  const e5 = effects();
  const s5 = await execute(page, ana, versionUrl);
  await expect.poll(() => agentAlive(), { timeout: 180_000, intervals: [3_000] }).toBe(false);
  const exec5 = requestRow(s5).split('|')[2];
  // ponto exato: STARTING gravado, processo Python ainda não criado (sem cópia do pacote, sem saída, sem posse de processo)
  log('s5_queda', { pedido: requestRow(s5), local: localRecord(exec5), efeitos: effects(), registro_da_falha: faultLog() });
  expect(localRecord(exec5).estado).toBe('STARTING');
  expect(faultLog().filter((l) => l.includes('STARTING_SAVED_BEFORE_PROCESS'))).toHaveLength(1);
  machine('falha-laboratorio', ['-Extra', 'nenhuma']);
  expect(distributionClean()).toBe(true);
  agent('iniciar');
  await expect.poll(() => panelText(page), { timeout: 300_000, intervals: [5_000] }).toMatch(/Desfecho reportado: Desfecho desconhecido/);
  await shot(page, 'm2-06-queda-fronteira-desconhecido');
  await page.waitForTimeout(20_000);
  log('s5_volta', { pedido: requestRow(s5), execucao: runOf(s5), execucoes: runsOf(s5), efeitos: effects() });
  expect(runsOf(s5)).toBe('1');
  expect(runOf(s5)).toMatch(/^9\|/); // OUTCOME_UNKNOWN
  expect(effects()).toBe(e5); // o processo nunca foi criado e nada foi relançado
  log('s5_local_depois', localRecord(exec5));
  if (ONLY_FAULTS) {
    agent('parar');
    log('fim', 'provas de falha (S2, S5) concluídas');
    return;
  }

  // ---------- S6: credencial revogada — o pedido existe, a máquina não o recebe, nada inicia
  agent('parar');
  const s6 = await execute(page, ana, versionUrl, 3);
  await page.goto(`/o/${org}/agents`);
  await page.getByRole('button', { name: 'Revogar ESTACAO-PY1-M2' }).click();
  await confirmStepUp(page, ana, 'Revogar Agent');
  await page.waitForTimeout(2_000);
  agent('iniciar');
  await page.waitForTimeout(45_000);
  log('s6', { pedido: requestRow(s6), execucoes: runsOf(s6), efeitos: effects() });
  expect(runsOf(s6)).toBe('0');
  expect(effects()).toBe(3);
  agent('parar');

  // ---------- supervisão: as execuções pedidas pela Platform aparecem com a origem
  await page.goto(`/o/${org}/supervisao`);
  await expect(page.locator('main')).toContainText('Pedido pela Platform');
  await shot(page, 'm2-07-supervisao-pedidos');
  log('pedidos_finais', sql(`SELECT run_request_id || '|' || state || '|' || deliveries || '|' || coalesce(decision_reason,'-') FROM run_requests q JOIN agents a USING (organization_id, agent_id) WHERE q.organization_id = '${org}' ORDER BY requested_at`).split('\n'));
  log('execucoes_locais', readdirSync(`${LABDIR}/agent-dados/execucoes`).filter((n) => /^ex-/.test(n)).length);
  log('fim', 'M2 concluído');
});
