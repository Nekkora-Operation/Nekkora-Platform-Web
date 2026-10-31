import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { confirmStepUp, LAB, signUpAndEnroll, type Person } from './support/lab';

/**
 * J13–J15 com o Agent REAL e a API REAL, em sessão ASSISTIDA (FRONT-V1-002).
 *
 * Atos da PESSOA no Agent (o teste nunca os simula; só prepara até o ponto e confere no log do próprio Agent):
 *   1. aprovar o pacote ("Aprovar este pacote…" e a confirmação) — uma vez: o Agent guarda "Aprovado nesta máquina";
 *   2. clicar em "Iniciar" em cada execução;
 *   3. na segunda execução, clicar em "Cancelar execução" (cancelamento LOCAL).
 * Cada ponto aparece numa caixa de mensagem na tela e em tools/lab/saidas/<id>/intervencoes.txt.
 *
 * Execuções:
 *   A (J13 + J14): sucesso. A supervisão é aberta ANTES do início, com a lista vazia, e recebe a execução sem recarregar.
 *     Durante a execução: (b) SÓ Agent–API cai (agent-gateway pausado) e volta — o teste FALHA se algum ACK passar pelo
 *     canal pausado, se a execução já tiver terminado na retomada, ou se a entrega não retomar (ACK depois da retomada
 *     além do último antes da pausa); (a) SÓ navegador–API cai (contexto offline) e volta. Prova final: entrega completa,
 *     ACKs sem duplicata e crescentes, e a tela com a sequência contínua 1..N dos eventos entregues (FRONT-V1-004).
 *   B (J15): cancelamento local, reportado pelo supervisor.
 *   C (J15): desfecho desconhecido em reprodução segura (como a C6 do AGENT-PLATFORM-002): Agent encerrado à força e o
 *     processo da execução encerrado com ele fora; reaberto, o Agent reconcilia, nada é relançado.
 * Pré-condição DECLARADA: limites da organização (010) por fixture — a ativação operacional não foi demonstrada.
 */
const LABDIR = resolve(`tools/lab/saidas/${LAB}`);
const PKG_ZIP = `tools/lab/saidas/${LAB}/pacotes/pacote-studio-real.zip`;
const PKG_DIR = resolve(LABDIR, 'pacote-studio-real');
const PYTHON = process.env.FRONT_LAB_PYTHON ?? resolve('..', 'front-v1-002-framework', '.venv', 'Scripts', 'python.exe');
// 22 biografias distintas com as linhas da ficha que a automação do Studio lê (Nome completo, Nascimento, Nacionalidade,
// Ocupação); a 1ª lista parou por dados da Wikipédia e linhas repetidas são recusadas pela planilha (SINK_REJECTED)
const INPUT = resolve(LABDIR, 'entrada-j14.csv');
const OUT = resolve(LABDIR, 'saida-execucoes');
const WAIT_PERSON = 45 * 60_000;
// dados novos do Agent para esta sessão, numa pasta própria (as anteriores ficam como estão, como evidência)
// FRONT_LAB_AGENT_DADOS reaproveita a pasta de uma sessão anterior (a aprovação do pacote "nesta máquina" continua; o
// pareamento é refeito)
const DADOS = process.env.FRONT_LAB_AGENT_DADOS ?? `agent-dados-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
process.env.FRONT_LAB_AGENT_DADOS = DADOS;

const agent = (acao: string, extra: string[] = [], input?: string) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tools/lab/agent.ps1', '-Id', LAB, '-Acao', acao, ...extra], {
    input,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (r.status !== 0) throw new Error(`agent.ps1 ${acao} falhou: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const lab = (...args: string[]) => execFileSync('node', ['tools/lab/lab.mjs', LAB, ...args], { encoding: 'utf8' });
const agentLog = () => {
  try {
    return readFileSync(`${LABDIR}/${DADOS}/logs/agent.log`, 'utf8');
  } catch {
    return '';
  }
};
const count = (pattern: RegExp) => (agentLog().match(new RegExp(pattern.source, 'g')) ?? []).length;
/** Confirmações de entrega da API no log do Agent (relógio UTC desta máquina; nanossegundos cortados em ms). */
const acks = () =>
  [...agentLog().matchAll(/^(\S+) INFO PLATFORM_ACK execution=\S+ stored_through=(\d+) settled_through=(\d+) stored=(\d+) duplicates=(\d+)/gm)].map((m) => ({
    t: Date.parse(m[1].replace(/(\.\d{3})\d*Z$/, '$1Z')),
    through: Number(m[2]),
    dup: Number(m[5]),
  }));
const step = (text: string) => {
  const line = `${new Date().toISOString()} ${text}`;
  console.log(line);
  appendFileSync(`${LABDIR}/intervencoes.txt`, `${line}\n`);
};
/** Ponto de intervenção: aviso na tela e espera do ato no log do Agent (nunca simulado). */
async function person(text: string, pattern: RegExp, before: number) {
  step(`SUA VEZ: ${text}`);
  agent('avisar', ['-Aviso', text]);
  await expect.poll(() => count(pattern), { timeout: WAIT_PERSON, intervals: [2_000] }).toBeGreaterThan(before);
  step(`feito (log do Agent: ${pattern.source})`);
}

async function setup(page: Page, person: Person) {
  const name = `Ensaio J13 ${Date.now().toString(36)}`;
  await page.goto('/organizacoes/nova');
  await page.getByLabel(/^Nome da organização/).fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, person, 'Criar organização');
  await page.getByRole('button', { name: `Entrar em ${name}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  const org = /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];
  lab('limites', org, person.email);

  await page.goto(`/o/${org}/workspaces`);
  await page.getByRole('button', { name: 'Criar workspace' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome/).fill('Operações');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Operações' })).toBeVisible();
  const workspaceId = /workspaces\/([0-9a-f-]{36})/.exec(page.url())![1];
  await page.getByRole('button', { name: 'Criar automação' }).click();
  await page.getByRole('alertdialog').getByLabel(/^Nome da automação/).fill('Biografias da Wikipédia');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Criar automação' }).click();
  await page.getByRole('button', { name: 'Nova versão' }).click();
  await expect(page).toHaveURL(/\/versoes\/[0-9a-f-]{36}$/);
  const versionUrl = page.url();
  await page.getByLabel('Arquivo .zip do pacote').setInputFiles(PKG_ZIP);
  await page.getByRole('button', { name: 'Enviar pacote' }).click();
  await expect(page.getByText('Pacote recebido e conferido pela Platform.')).toBeVisible();
  await page.getByRole('button', { name: 'Publicar versão' }).click();
  await page.getByRole('alertdialog').getByLabel('Conferi o pacote desta versão.').check();
  await confirmStepUp(page, person, 'Publicar');
  await expect(page.getByText('Publicada (imutável)')).toBeVisible();

  // pareamento (código só na tela, entregue ao Agent pela entrada padrão do script)
  await page.goto(`/o/${org}/agents`);
  await page.getByRole('button', { name: 'Parear novo Agent' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel(/^Nome da máquina/).fill('LAB-FRONT-02');
  await dialog.getByLabel(/^Nome do Worker/).fill('Worker do laboratório');
  await confirmStepUp(page, person, 'Gerar código');
  const code = (await page.getByLabel('Código de uso único').innerText()).trim();
  agent('iniciar');
  agent('parear', [], `${code}\n`);
  await page.getByRole('button', { name: 'Concluir' }).click();
  let seen = '';
  try {
    await expect
      .poll(
        async () => {
          await page.getByRole('button', { name: 'Atualizar' }).click();
          await page.waitForTimeout(1_500);
          seen = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ');
          return seen;
        },
        { timeout: 240_000, intervals: [10_000] },
      )
      .toMatch(/LAB-FRONT-02[\s\S]*Conectado/);
  } finally {
    step(`Agents na tela: ${seen.slice(0, 600)}`);
  }

  await page.goto(`/o/${org}/workers`);
  await page.getByRole('button', { name: 'Autorizar Worker do laboratório num workspace' }).click();
  await page.getByRole('alertdialog').getByLabel('Workspace').selectOption(workspaceId);
  await confirmStepUp(page, person, 'Autorizar');
  await expect(page.getByText('Worker autorizado no workspace.')).toBeVisible();

  await page.goto(versionUrl);
  await page.getByLabel(/^Worker autorizado neste workspace/).selectOption({ label: 'Worker do laboratório' });
  await page.getByRole('button', { name: 'Autorizar execução local' }).click();
  await confirmStepUp(page, person, 'Autorizar execução local');
  await expect(page.getByText(/Execução local autorizada\. Nada foi iniciado/)).toBeVisible();
  return { org };
}

/** Prepara a janela de execução até o ponto da pessoa e espera o início feito por ela. */
async function startByPerson(label: string, extraInstruction = '') {
  const approved0 = count(/EXEC_PACKAGE_APPROVED/);
  const started0 = count(/EXEC_STARTED/);
  agent('abrir-execucao', ['-Pacote', PKG_DIR]);
  if (approved0 === 0) {
    await person('No Agent, janela "Execução local": clique em "Aprovar este pacote…", leia o que será executado e confirme.', /EXEC_PACKAGE_APPROVED/, approved0);
  }
  agent('completar-execucao', ['-Python', PYTHON, '-Entrada', INPUT, '-Saida', OUT]);
  await person(`Execução ${label}: no Agent, clique em "Iniciar".${extraInstruction}`, /EXEC_STARTED/, started0);
}

async function openNewestRun(page: Page, org: string, expectedRuns: number) {
  await page.goto(`/o/${org}/supervisao`);
  const rows = page.getByRole('region', { name: 'Execuções locais' }).getByRole('link');
  await expect.poll(() => rows.count(), { timeout: 180_000, intervals: [5_000] }).toBe(expectedRuns);
  await rows.first().click();
  await expect(page.getByRole('heading', { name: 'Execução local' })).toBeVisible();
}

async function eventSequences(page: Page): Promise<number[]> {
  const table = page.getByRole('table', { name: /Eventos/ });
  if ((await table.count()) === 0) return [];
  const cells = await table.locator('tbody tr td:first-child').allInnerTexts();
  return cells.map((c) => Number(c.trim())).filter((n) => Number.isFinite(n));
}

test('J13–J15: execução real supervisionada, quedas de canal, cancelamento local e desfecho desconhecido', async ({ page, context }) => {
  test.setTimeout(4 * 60 * 60_000);
  if (!existsSync(PYTHON)) throw new Error(`Python do laboratório ausente: ${PYTHON}`);
  agent('parar');
  rmSync(`${LABDIR}/${DADOS}/plataforma`, { recursive: true, force: true });
  agent('preparar');
  step(`sessão assistida: Agent ${readFileSync(`${LABDIR}/agent.txt`, 'utf8').split('\n')[0]}`);
  const ana = await signUpAndEnroll(page, 'j13');
  const { org } = await setup(page, ana);
  // este build busca as autorizações ao conectar: reabre para receber a autorização recém-criada
  agent('parar');
  agent('iniciar');
  await expect.poll(() => count(/PLATFORM_AUTHORIZATIONS count=[1-9]/), { timeout: 240_000, intervals: [5_000] }).toBeGreaterThan(0);

  // FRONT_LAB_ETAPAS (ex.: "C"): só as execuções pedidas, quando as outras já foram comprovadas numa rodada anterior
  // (registradas em intervencoes.txt e no log da sessão)
  const etapas = (process.env.FRONT_LAB_ETAPAS ?? 'A,B,C').split(',');
  let runs = 0;
  let detail = '';
  if (etapas.includes('A')) {
    runs++;
    // ---------------- A: J13 + J14 (FRONT-V1-004: lista vazia que recebe a execução; J14b que falha sem reconexão)
    // Supervisão aberta ANTES do início: a lista está vazia e recebe a execução sozinha (sem recarregar nem "Atualizar")
    await page.goto(`/o/${org}/supervisao`);
    await expect(page.getByText('Nenhuma execução local registrada.')).toBeVisible();
    const listUrl = page.url();
    const rows = page.getByRole('region', { name: 'Execuções locais' }).getByRole('link');
    const registered0 = count(/PLATFORM_RUN_REGISTERED/);
    await startByPerson('A (sucesso)');
    await expect.poll(() => count(/PLATFORM_RUN_REGISTERED/), { timeout: 120_000, intervals: [1_000] }).toBeGreaterThan(registered0);

    // J14b: SÓ Agent–API, com a execução em curso (o navegador continua falando com a API)
    const finished0 = count(/EXEC_FINISHED/);
    const acksBefore = acks();
    lab('canal-agent', 'pausar');
    const pausedAt = Date.now();
    step(`J14b: canal Agent–API pausado (agent-gateway); navegador–API intacto; execução em curso: ${count(/EXEC_FINISHED/) === finished0}; ACKs até aqui: ${acksBefore.length}`);
    let runningAtResume = false;
    let resumeStartedAt = 0;
    try {
      // a lista aberta antes do início recebe a execução já registrada, sem navegação
      await expect.poll(() => rows.count(), { timeout: 120_000, intervals: [2_000] }).toBe(1);
      expect(page.url(), 'a lista recebeu a execução sem navegar').toBe(listUrl);
      step(`supervisão: lista vazia recebeu a execução sem recarregar; linha: ${(await rows.first().innerText()).replace(/\s+/g, ' ')}`);
      await page.waitForTimeout(20_000);
    } finally {
      runningAtResume = count(/EXEC_FINISHED/) === finished0;
      // a janela da pausa fecha quando o retorno COMEÇA: um ACK pode chegar antes de o comando terminar
      resumeStartedAt = Date.now();
      lab('canal-agent', 'retomar');
    }
    const resumedAt = resumeStartedAt;
    const lastBefore = acksBefore.at(-1)?.through ?? 0;
    // 1 s de folga depois da pausa: confirmação que já estava a caminho quando o canal foi pausado
    const inPause = acks().filter((a) => a.t > pausedAt + 1_000 && a.t < resumedAt);
    step(`J14b: canal retomado; execução ainda em curso na retomada: ${runningAtResume}; ACKs durante a pausa: ${inPause.length}`);
    // a queda foi real: nenhuma confirmação de entrega passou pelo canal pausado
    expect(inPause, 'nenhum ACK do canal Agent–API durante a pausa').toHaveLength(0);
    expect(runningAtResume, 'a execução ainda estava em curso quando o canal voltou (a retomada da entrega é exercida)').toBe(true);
    // reconexão e retomada da entrega: um ACK DEPOIS da retomada que avança além do último antes da pausa
    await expect
      .poll(() => acks().filter((a) => a.t >= resumedAt - 1_000 && a.through > lastBefore).length, { timeout: 180_000, intervals: [2_000] })
      .toBeGreaterThan(0);
    const firstAfter = acks().find((a) => a.t >= resumedAt - 1_000 && a.through > lastBefore)!;
    step(`J14b: entrega retomada em ${new Date(firstAfter.t).toISOString()} (stored_through ${lastBefore} → ${firstAfter.through})`);

    // detalhe: estado em execução e eventos chegando sem recarregar
    await rows.first().click();
    await expect(page.getByRole('heading', { name: 'Execução local' })).toBeVisible();
    const detailUrl = page.url();
    const seen0 = (await eventSequences(page)).length;
    if (count(/EXEC_FINISHED/) === finished0) {
      await expect(page.locator('main')).toContainText('Em execução');
      await expect.poll(async () => (await eventSequences(page)).length, { timeout: 60_000, intervals: [3_000] }).toBeGreaterThan(seen0);
      step(`detalhe: em execução; eventos na tela ${seen0} → ${(await eventSequences(page)).length} sem recarregar`);
    } else step(`detalhe: a execução terminou antes da abertura do detalhe (eventos na tela: ${seen0})`);

    // J14a: SÓ navegador–API (o Agent continua falando com a API)
    const reportsBeforeOffline = count(/PLATFORM_REPORT/);
    step(`J14a: navegador offline (canal Agent–API intacto); execução em curso: ${count(/EXEC_FINISHED/) === finished0}`);
    await context.setOffline(true);
    await expect(page.getByText('Os dados podem estar desatualizados.')).toBeVisible({ timeout: 60_000 });
    await context.setOffline(false);
    await expect(page.getByText('Os dados podem estar desatualizados.')).toHaveCount(0, { timeout: 60_000 });
    step(`J14a: navegador de volta; relatórios do Agent durante a queda do navegador: ${count(/PLATFORM_REPORT/) - reportsBeforeOffline}`);

    // desfecho de A: tudo entregue, sem duplicata, sequência contínua na tela até o último evento entregue
    await expect.poll(() => count(/PLATFORM_DELIVERY_COMPLETED/), { timeout: 30 * 60_000, intervals: [5_000] }).toBeGreaterThan(0);
    const settled = Number(/PLATFORM_DELIVERY_COMPLETED execution=\S+ settled=(\d+)/.exec(agentLog().split('\n').filter((l) => l.includes('PLATFORM_DELIVERY_COMPLETED')).at(-1) ?? '')?.[1]);
    const all = acks();
    expect(all.every((a) => a.dup === 0), 'nenhuma duplicata confirmada pela API').toBe(true);
    expect(all.every((a, i) => i === 0 || a.through > all[i - 1].through), 'stored_through sempre crescente').toBe(true);
    await expect(page.getByText('Acompanhamento automático encerrado: nada pendente.')).toBeVisible({ timeout: 30 * 60_000 });
    expect(page.url(), 'o detalhe acompanhou até o fim sem navegar').toBe(detailUrl);
    detail = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    step(`A detalhe: ${detail.slice(0, 900)}`);
    expect(detail).toMatch(/Concluída com sucesso/);
    expect(detail).toMatch(/Desfecho Conhecido/i);
    const seqA = (await eventSequences(page)).sort((x, y) => x - y);
    const expected = Array.from({ length: Math.min(settled, 2_000) }, (_, i) => i + 1);
    expect(seqA, `eventos na tela = 1..${expected.length} (entregues pelo Agent: ${settled})`).toEqual(expected);
    step(`A: ${settled} eventos entregues; tela com a sequência contínua 1..${seqA.length}; ACKs ${all.length}, sem duplicata`);
    await page.goto(`/o/${org}/supervisao`);
    await expect(page.getByRole('region', { name: 'Execuções locais' }).getByRole('link')).toHaveCount(1); // nenhuma nova execução
  }

  if (etapas.includes('B')) {
    runs++;
    // ---------------- B: cancelamento local
    const cancel0 = count(/EXEC_CANCEL_REQUESTED/);
    await startByPerson('B (cancelamento)', ' Depois que ela começar, clique em "Cancelar execução" no próprio Agent.');
    await person('Execução B: no Agent, clique em "Cancelar execução".', /EXEC_CANCEL_REQUESTED/, cancel0);
    await openNewestRun(page, org, runs);
    await expect(page.getByText('Acompanhamento automático encerrado: nada pendente.')).toBeVisible({ timeout: 15 * 60_000 });
    detail = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    step(`B detalhe: ${detail.slice(0, 900)}`);
    expect(detail).toMatch(/Cancelada/);
  }

  // ---------------- C: desfecho desconhecido (reprodução segura)
  if (!etapas.includes('C')) {
    step(`J13–J15 org=${org} (etapas ${etapas.join(',')})`);
    return;
  }
  runs++;
  const finishedC = count(/EXEC_FINISHED/);
  await startByPerson('C (desfecho desconhecido: o laboratório vai derrubar o Agent depois do início)');
  // derruba com a execução em curso (a 1ª tentativa esperou o próximo relatório, que só veio no fim da execução)
  await page.waitForTimeout(5_000);
  expect(count(/EXEC_FINISHED/), 'a execução C ainda está em curso quando o Agent cai').toBe(finishedC);
  step('C: Agent encerrado à força e, com ele fora, o processo da execução (laboratório)');
  step(agent('derrubar', ['-Saida', OUT]).trim());
  const rec0 = count(/EXEC_RECONCILED/);
  agent('iniciar');
  await expect.poll(() => count(/EXEC_RECONCILED/), { timeout: 180_000, intervals: [3_000] }).toBeGreaterThan(rec0);
  await openNewestRun(page, org, runs); // reabrir não relança nada
  await expect(page.getByText(/Supervisor: Desfecho desconhecido/)).toBeVisible({ timeout: 15 * 60_000 });
  detail = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  step(`C detalhe: ${detail.slice(0, 900)}`);
  expect(detail).toMatch(/Desfecho Desconhecido/i);
  expect(detail).not.toMatch(/Concluída com sucesso/);
  step(`J13–J15 org=${org}`);
});
