import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { confirmStepUp, LAB, pairNewWorker, signUpAndEnroll, type Person, workersText } from './support/lab';

/**
 * AGENT-PYTHON-001 — Marco 1 com Web, API e Agent REAIS: um Python externo (sem nada da Nekkora) que o Agendador de Tarefas
 * já executa passa a ser monitorado; a única mudança na tarefa é o programa (nekkora-lancar). Cenários: término com 0,
 * erro com efeito (código preservado no agendador), execução longa com o canal Agent–API interrompido e devolvido, e um
 * argumento sentinela que não pode aparecer na Platform nem nos arquivos do Agent.
 *
 * Atos da pessoa NA MÁQUINA executados pelo operador do laboratório e registrados: colar o código de pareamento (Agent,
 * teclado conferido) e confirmar o vínculo (SIM no console). Fixture declarada: limites da organização (010).
 */
const AGENT_REPO = process.env.PY1_AGENT_REPO ?? resolve('../py1-agent-build'); // clone limpo da branch (commit certo no VERSOES.txt)
const LABDIR = resolve(`tools/lab/saidas/${LAB}`);
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-m1`);
const SENTINEL = `SENTINELA-AP1-${Date.now().toString(36)}`;

const ps = (file: string, args: string[], input?: string) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { input, encoding: 'utf8', timeout: 900_000 });
  if (r.status !== 0) throw new Error(`${file} ${args.join(' ')} falhou: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const agent = (acao: string, input?: string) => ps('tools/lab/agent.ps1', ['-Id', LAB, '-Acao', acao, '-AgentRepo', AGENT_REPO], input);
const machine = (acao: string, extra: string[] = []) => ps('tools/lab/python-externo.ps1', ['-Id', LAB, '-Acao', acao, ...extra]);
const schedulerCode = (out: string) => Number(/codigo_registrado_pelo_agendador=(-?\d+)/.exec(out)![1]);
const effects = () => Number(/efeitos=(\d+)/.exec(machine('efeitos'))![1]);
const sql = (q: string) =>
  execFileSync('node', ['tools/lab/lab.mjs', LAB, 'compose', 'exec', '-T', 'postgres', 'psql', '-X', '-At', '-U', 'nekkora', '-d', 'nekkora', '-c', q], { encoding: 'utf8' }).trim();
const log = (k: string, v: unknown) => {
  mkdirSync(EVID, { recursive: true });
  writeFileSync(join(EVID, 'jornada-m1.txt'), `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`, { flag: 'a' });
  console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
};
const shot = async (page: Page, name: string) => {
  mkdirSync(EVID, { recursive: true });
  await page.screenshot({ path: join(EVID, `${name}.png`), fullPage: true });
};
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}

async function prepareOrganization(page: Page, person: Person) {
  const name = `Ensaio PY1 ${Date.now().toString(36)}`;
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

test('M1: Python externo do agendador monitorado pela Platform (0, erro com efeito, longa com queda do canal, sentinela)', async ({ page }) => {
  test.setTimeout(3_600_000);
  rmSync(join(EVID, 'jornada-m1.txt'), { force: true });
  log('sentinela_prefixo', SENTINEL.slice(0, 14));

  // ---------- máquina: Agent do laboratório limpo e o cliente com a tarefa ORIGINAL (Python direto, sem Nekkora)
  agent('parar');
  rmSync(`${LABDIR}/agent-dados`, { recursive: true, force: true });
  log('agent_preparar', agent('preparar').trim());
  expect(readFileSync(`${LABDIR}/agent-app/VERSOES.txt`, 'utf8')).toMatch(/commit: [0-9a-f]{40}/);
  log('cliente', machine('preparar-cliente', ['-Exemplo', resolve(AGENT_REPO, 'tools/external-package/exemplo-relatorio')]).trim());
  const original = schedulerCode(machine('rodar'));
  expect(original).toBe(0);
  expect(effects()).toBe(1);
  log('tarefa_original', { codigo: original, efeitos: 1 });

  // ---------- Platform (pessoa): organização, workspace e automação cadastrada (SEM versão nem pacote)
  const ana = await signUpAndEnroll(page, 'py1m1');
  const org = await prepareOrganization(page, ana);
  await page.goto(`/o/${org}/workspaces`);
  await page.getByRole('button', { name: 'Criar workspace' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome/).fill('Operações');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Operações' })).toBeVisible();
  const workspaceId = /workspaces\/([0-9a-f-]{36})/.exec(page.url())![1];
  await page.getByRole('button', { name: 'Criar automação' }).click();
  // T04: criação em página própria; aqui, o caminho só com o nome (rascunho)
  await page.getByLabel(/^Nome da automação/).fill('Relatório CSV');
  await page.getByRole('radio', { name: /Só o nome, como rascunho/ }).check();
  await page.getByRole('button', { name: 'Salvar rascunho' }).click();
  await expect(page.getByRole('heading', { name: 'Relatório CSV' })).toBeVisible();
  const automationUrl = page.url();
  const automationId = /automacoes\/([0-9a-f-]{36})/.exec(automationUrl)?.[1] ?? /([0-9a-f-]{36})$/.exec(automationUrl)![1];
  log('ids', { org, workspaceId, automationId });

  // ---------- pareamento do Agent real (T07: Workers → Criar Worker → Vincular Agent; código na tela, digitado no Agent)
  const code = await pairNewWorker(page, org, ana, 'Worker relatórios', 'ESTACAO-PY1');
  agent('iniciar');
  agent('parear', `${code}\n`);
  await page.getByRole('button', { name: 'Concluir' }).click();
  await expect.poll(() => workersText(page, org), { timeout: 240_000, intervals: [10_000] }).toMatch(/ESTACAO-PY1[\s\S]*Conectada/);
  await page.goto(`/o/${org}/workers`);
  await page.getByRole('button', { name: 'Autorizar Worker relatórios num workspace' }).click();
  await page.getByRole('alertdialog').getByLabel('Workspace').selectOption(workspaceId);
  await confirmStepUp(page, ana, 'Autorizar');
  await expect(page.getByText('Worker autorizado no workspace.')).toBeVisible();

  // ---------- autorização de MONITORAMENTO na automação (sem versão nem impressão)
  await page.goto(automationUrl);
  await expect(page.getByRole('heading', { name: 'Monitoramento de Python externo' })).toBeVisible();
  await page.getByLabel(/^Worker autorizado neste workspace/).selectOption({ label: 'Worker relatórios' });
  await page.getByRole('button', { name: 'Autorizar monitoramento' }).click();
  await confirmStepUp(page, ana, 'Autorizar monitoramento');
  await expect(page.getByText(/Monitoramento autorizado\. Nada foi iniciado/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Autorizações de execução local.' })).toContainText('sem pacote');
  await shot(page, 'm1-01-autorizacao-monitoramento');

  // o Agent baixa a autorização (até 5 min); o lançador só a enxerga depois disso
  const authFile = `${LABDIR}/agent-dados/plataforma/autorizacoes.json`;
  await expect.poll(() => (existsSync(authFile) ? readFileSync(authFile, 'utf8') : ''), { timeout: 420_000, intervals: [10_000] }).toContain('EXTERNAL_MONITORED');
  log('autorizacao_baixada_pelo_agent', true);

  // ---------- máquina: vínculo aprovado e a ÚNICA mudança na tarefa (programa = lançador)
  log('vincular', machine('vincular', ['-Automacao', automationId]).replace(/\s+/g, ' ').slice(0, 160));
  log('tarefa_com_lancador', machine('usar-lancador').trim());

  // A: término com 0
  const a = schedulerCode(machine('rodar'));
  expect(a).toBe(0);
  expect(effects()).toBe(2);
  // B: efeito verificável e saída com erro (o agendador vê o código do script)
  machine('argumentos', ['-Extra', '--falhar']);
  const b = schedulerCode(machine('rodar'));
  expect(b).toBe(3);
  expect(effects()).toBe(3);
  log('codigos_no_agendador', { a, b });

  // C: execução longa com o canal Agent–API interrompido e devolvido; argumento sentinela
  machine('argumentos', ['-Extra', `--dormir 60 --token ${SENTINEL}`]);
  machine('disparar');
  await page.waitForTimeout(8_000);
  log('canal', execFileSync('node', ['tools/lab/lab.mjs', LAB, 'canal-agent', 'pausar'], { encoding: 'utf8' }).trim());
  const c = schedulerCode(machine('esperar'));
  expect(c).toBe(0);
  await page.waitForTimeout(20_000); // o processo já terminou; o canal continua fora por mais um tempo
  log('canal', execFileSync('node', ['tools/lab/lab.mjs', LAB, 'canal-agent', 'retomar'], { encoding: 'utf8' }).trim());
  expect(effects()).toBe(4);

  // ---------- Platform: as três execuções do lançador, com automação, máquina, início, fim/duração e desfecho
  const runsText = async () => {
    await page.goto(`/o/${org}/supervisao`);
    const table = page.getByRole('region', { name: 'Execuções locais' });
    await table.waitFor({ timeout: 20_000 }).catch(() => undefined);
    return table.innerText().catch(() => '');
  };
  await expect
    .poll(async () => ((await runsText()).match(/Python externo monitorado/g) ?? []).length, { timeout: 600_000, intervals: [15_000] })
    .toBe(3);
  await expect
    .poll(async () => {
      const t = await runsText();
      return /Terminou com erro \(código de saída 3\)/.test(t) && (t.match(/Terminou sem erro sinalizado/g) ?? []).length === 2;
    }, { timeout: 600_000, intervals: [15_000] })
    .toBe(true);
  const listText = await runsText();
  expect(listText).toContain('Relatório CSV');
  expect(listText).toContain('ESTACAO-PY1');
  expect(listText).not.toContain(SENTINEL);
  await shot(page, 'm1-02-supervisao-lista');
  // detalhe da execução longa (a primeira da lista: a mais recente... a lista é por registro crescente: a última linha)
  const links = page.getByRole('region', { name: 'Execuções locais' }).getByRole('link');
  await links.last().click();
  await expect(page.getByRole('heading', { name: 'Execução local' })).toBeVisible();
  await expect(page.getByText(/sem versão \(Python externo monitorado/)).toBeVisible();
  await expect(page.getByText(/Completo|Entrega pendente/)).toBeVisible();
  await shot(page, 'm1-03-supervisao-detalhe-longa');

  // ---------- API: uma execução por invocação, eventos sem duplicata, nenhum vazamento
  const runs = sql(`SELECT count(*) FROM agent_runs WHERE organization_id = '${org}'`);
  const perRun = sql(
    `SELECT r.agent_execution_id || ':' || r.source_kind || ':' || r.supervisor_state || ':' || coalesce(r.supervisor_code,'-') || ':' || coalesce(r.exit_code::text,'-') || ':' || ` +
      `(SELECT count(*) FROM agent_run_events e WHERE e.agent_run_id = r.agent_run_id) || ':' || (SELECT count(DISTINCT sequence) FROM agent_run_events e WHERE e.agent_run_id = r.agent_run_id) ` +
      `|| ':' || (r.package_fingerprint IS NULL)::text FROM agent_runs r WHERE organization_id = '${org}' ORDER BY registered_at`,
  );
  const refusals = sql(`SELECT count(*) FROM agent_ingestion_refusals WHERE organization_id = '${org}'`);
  const leak = sql(
    `SELECT count(*) FROM (SELECT to_jsonb(t)::text x FROM agent_runs t UNION ALL SELECT to_jsonb(t)::text FROM agent_run_events t UNION ALL ` +
      `SELECT to_jsonb(t)::text FROM agent_run_reports t UNION ALL SELECT to_jsonb(t)::text FROM agent_admin_events t UNION ALL SELECT to_jsonb(t)::text FROM local_run_authorizations t) s ` +
      `WHERE x LIKE '%${SENTINEL}%' OR x LIKE '%relatorio.py%' OR x LIKE '%vendas.csv%'`,
  );
  log('api_execucoes', runs);
  log('api_por_execucao(exec:origem:estado:codigo:saida:eventos:sequencias_distintas:sem_impressao)', perRun.split('\n'));
  log('api_recusas_de_ingestao', refusals);
  log('api_vazamento(sentinela|script|csv)', leak);
  expect(runs).toBe('3');
  expect(refusals).toBe('0');
  expect(leak).toBe('0');
  for (const line of perRun.split('\n')) {
    const [, kind, , , , events, distinct, noFp] = line.split(':');
    expect(kind).toBe('3');
    expect(events).toBe(distinct);
    expect(noFp).toBe('true');
  }
  // ---------- Agent: uma pasta de execução por invocação do lançador; nenhum arquivo do Agent tem a sentinela
  agent('parar'); // a trava de instância fica aberta enquanto o Agent roda
  const agentFiles = walk(`${LABDIR}/agent-dados`);
  const leaking = agentFiles.filter((f) => readFileSync(f).toString('latin1').includes(SENTINEL));
  log('agent_arquivos_com_sentinela', leaking.length);
  expect(leaking).toEqual([]);
  const execs = readdirSync(`${LABDIR}/agent-dados/execucoes`).filter((n) => /^ex-[0-9a-f]{32}$/.test(n));
  log('agent_execucoes_locais', execs.length);
  expect(execs.length).toBe(3);
  log('fim', 'M1 concluído');
});
