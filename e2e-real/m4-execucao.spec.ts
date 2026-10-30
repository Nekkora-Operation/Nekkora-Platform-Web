import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
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
 *   A (J13 + J14): sucesso. Durante a execução: (a) SÓ navegador–API cai (contexto offline) e volta; (b) SÓ Agent–API cai
 *     (agent-gateway pausado) e volta. Prova: uma execução, eventos sem sequência repetida, desfecho e histórico.
 *   B (J15): cancelamento local, reportado pelo supervisor.
 *   C (J15): desfecho desconhecido em reprodução segura (como a C6 do AGENT-PLATFORM-002): Agent encerrado à força e o
 *     processo da execução encerrado com ele fora; reaberto, o Agent reconcilia, nada é relançado.
 * Pré-condição DECLARADA: limites da organização (010) por fixture — a ativação operacional não foi demonstrada.
 */
const LABDIR = resolve(`tools/lab/saidas/${LAB}`);
const PKG_ZIP = `tools/lab/saidas/${LAB}/pacotes/pacote-studio-real.zip`;
const PKG_DIR = resolve(LABDIR, 'pacote-studio-real');
const PYTHON = process.env.FRONT_LAB_PYTHON ?? resolve('..', 'front-v1-002-framework', '.venv', 'Scripts', 'python.exe');
const INPUT = resolve(LABDIR, 'entrada-j14.csv');
const OUT = resolve(LABDIR, 'saida-execucoes');
const WAIT_PERSON = 45 * 60_000;

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
    return readFileSync(`${LABDIR}/agent-dados/logs/agent.log`, 'utf8');
  } catch {
    return '';
  }
};
const count = (pattern: RegExp) => (agentLog().match(new RegExp(pattern.source, 'g')) ?? []).length;
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
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: 'Atualizar' }).click();
        return page.getByRole('region', { name: 'Lista de Agents' }).innerText().catch(() => '');
      },
      { timeout: 240_000, intervals: [10_000] },
    )
    .toMatch(/LAB-FRONT-02[\s\S]*Conectado/);

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
  // dados novos do Agent para esta sessão (os anteriores ficam preservados como evidência)
  if (existsSync(`${LABDIR}/agent-dados`)) renameSync(`${LABDIR}/agent-dados`, `${LABDIR}/agent-dados-${Date.now().toString(36)}`);
  agent('preparar');
  step(`sessão assistida: Agent ${readFileSync(`${LABDIR}/agent.txt`, 'utf8').split('\n')[0]}`);
  const ana = await signUpAndEnroll(page, 'j13');
  const { org } = await setup(page, ana);
  // este build busca as autorizações ao conectar: reabre para receber a autorização recém-criada
  agent('parar');
  agent('iniciar');
  await expect.poll(() => count(/PLATFORM_AUTHORIZATIONS count=[1-9]/), { timeout: 240_000, intervals: [5_000] }).toBeGreaterThan(0);

  // ---------------- A: J13 + J14
  await startByPerson('A (sucesso)');
  await openNewestRun(page, org, 1);
  await expect(page.getByText(/Atualiza a cada 10 s/)).toBeVisible();

  // J14a: SÓ navegador–API (o Agent continua falando com a API)
  const reportsBeforeOffline = count(/PLATFORM_REPORT/);
  step('J14a: navegador offline (canal Agent–API intacto)');
  await context.setOffline(true);
  await expect(page.getByText('Os dados podem estar desatualizados.')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(20_000);
  await context.setOffline(false);
  await expect(page.getByText('Os dados podem estar desatualizados.')).toHaveCount(0, { timeout: 60_000 });
  step(`J14a: navegador de volta; relatórios do Agent durante a queda do navegador: ${count(/PLATFORM_REPORT/) - reportsBeforeOffline}`);

  // J14b: SÓ Agent–API (o navegador continua falando com a API)
  const disc0 = count(/PLATFORM_DISCONNECTED/);
  const conn0 = count(/PLATFORM_CONNECTED/);
  lab('canal-agent', 'pausar');
  step('J14b: canal Agent–API pausado (agent-gateway); navegador–API intacto');
  try {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Execução local' })).toBeVisible();
    await expect(page.getByText('Os dados podem estar desatualizados.')).toHaveCount(0);
    await page.waitForTimeout(200_000); // passa do limite de presença (180 s sem sinal)
    await page.reload();
    await expect(page.getByText('Agent sem sinal recente')).toBeVisible({ timeout: 60_000 });
  } finally {
    lab('canal-agent', 'retomar');
  }
  step(`J14b: canal retomado; desconexões no log do Agent: ${count(/PLATFORM_DISCONNECTED/) - disc0}`);
  await expect.poll(() => count(/PLATFORM_CONNECTED/), { timeout: 300_000, intervals: [5_000] }).toBeGreaterThan(conn0);

  // desfecho de A
  await expect(page.getByText('Acompanhamento automático encerrado: nada pendente.')).toBeVisible({ timeout: 30 * 60_000 });
  let detail = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  step(`A detalhe: ${detail.slice(0, 900)}`);
  expect(detail).toMatch(/Concluída com sucesso/);
  expect(detail).toMatch(/Desfecho Conhecido/);
  const seqA = await eventSequences(page);
  expect(seqA.length).toBeGreaterThan(0);
  expect(new Set(seqA).size).toBe(seqA.length); // nenhuma sequência repetida depois das quedas
  await page.goto(`/o/${org}/supervisao`);
  await expect(page.getByRole('region', { name: 'Execuções locais' }).getByRole('link')).toHaveCount(1); // nenhuma nova execução

  // ---------------- B: cancelamento local
  const cancel0 = count(/EXEC_CANCEL_REQUESTED/);
  await startByPerson('B (cancelamento)', ' Depois que ela começar, clique em "Cancelar execução" no próprio Agent.');
  await person('Execução B: no Agent, clique em "Cancelar execução".', /EXEC_CANCEL_REQUESTED/, cancel0);
  await openNewestRun(page, org, 2);
  await expect(page.getByText('Acompanhamento automático encerrado: nada pendente.')).toBeVisible({ timeout: 15 * 60_000 });
  detail = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  step(`B detalhe: ${detail.slice(0, 900)}`);
  expect(detail).toMatch(/Cancelada/);

  // ---------------- C: desfecho desconhecido (reprodução segura)
  await startByPerson('C (desfecho desconhecido: o laboratório vai derrubar o Agent depois do início)');
  const reports0 = count(/PLATFORM_REPORT/);
  await expect.poll(() => count(/PLATFORM_REPORT/), { timeout: 180_000, intervals: [2_000] }).toBeGreaterThan(reports0);
  step('C: Agent encerrado à força e, com ele fora, o processo da execução (laboratório)');
  step(agent('derrubar', ['-Saida', OUT]).trim());
  const rec0 = count(/EXEC_RECONCILED/);
  agent('iniciar');
  await expect.poll(() => count(/EXEC_RECONCILED/), { timeout: 180_000, intervals: [3_000] }).toBeGreaterThan(rec0);
  await openNewestRun(page, org, 3); // reabrir não relança nada
  await expect(page.getByText(/Supervisor: Desfecho desconhecido/)).toBeVisible({ timeout: 15 * 60_000 });
  detail = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  step(`C detalhe: ${detail.slice(0, 900)}`);
  expect(detail).toMatch(/Desfecho Desconhecido/);
  expect(detail).not.toMatch(/Concluída com sucesso/);
  step(`J13–J15 org=${org}`);
});
