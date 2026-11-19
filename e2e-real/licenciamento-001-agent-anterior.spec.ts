import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Authenticator } from '../mock/totp';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../tools/lab/lab.mjs';
import { confirmStepUp, LAB, newVersionWithPackage, signInWithTotp, type Person } from './support/lab';

/**
 * PLATFORM-LICENCIAMENTO-001 — ROTEIRO DO AGENT ANTERIOR, numa CÓPIA ISOLADA do pacote gerado da branch da missão, com pasta
 * de dados própria e SEM bandeja, contra a API real do laboratório descartável. Nunca o Agent instalado, nunca um perfil
 * pessoal: as contas são as duas pessoas sintéticas do roteiro da máquina.
 *
 * O que é exercitado: a RECUSA VISÍVEL do registro por licença (na execução, na janela principal e em "Envios parados"), a
 * PRESERVAÇÃO dos dados depois de fechar e reabrir o aplicativo, e o botão "Tentar registrar de novo" — sem duplicar registros.
 *
 * COMO O APLICATIVO É CONDUZIDO: a cópia abre a JANELA REAL; um condutor, dentro do mesmo processo, aciona os botões reais
 * (doClick) e os mesmos métodos que a janela chama, e lê os textos da tela. Nenhuma tecla global, nenhum Robot, nenhuma
 * automação de interface do sistema. SIMULADO, e dito na evidência: o seletor de arquivo do sistema (o caminho é entregue ao
 * método que o seletor chamaria) e a confirmação "Aprovar este pacote?" (chama-se o método que a janela chama depois do sim).
 *
 * PROCEDIMENTO ADMINISTRATIVO por SQL no laboratório: a "passagem do tempo" que vence a licença. Nenhum limite é zerado.
 * Pré-requisito: o roteiro da máquina já rodou neste laboratório (ele cadastra as duas pessoas sintéticas e a operadora).
 *
 *   FRONT_LAB_ID=frontlab-lic003 FRONT_PORTA=5192 npx playwright test -c playwright.real.config.ts licenciamento-001-agent-anterior
 */
const DIR = resolve(process.cwd(), '../exe-agent/copia');
const SAIDA = resolve(DIR, 'saida/agent.jsonl');
const COMANDO = resolve(DIR, 'saida/comando.txt');
const CODIGO = resolve(DIR, 'saida/codigo.txt');
const PYTHON = resolve(process.cwd(), '../../client-preparacao-002/lab/projeto-robo/.venv/Scripts/python.exe');
const RAPIDO = resolve(process.cwd(), '../exe/robo-licenca-rapido.zip');
const EVID = resolve(`tools/lab/saidas/${LAB}/evidencias-licenciamento-001-agent-anterior`);
const PESSOAS = join(homedir(), '.nekkora', 'front-lab', LAB, 'pessoas-roteiro-maquina.json');
const TAG = Date.now().toString(36);
const WORKER = 'Worker da oficina';
const MAQUINA = 'PC sintetico da oficina';
const AUTOMACAO = 'Robo da oficina';

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

// ------------------------------------------------------------------ a cópia isolada do Agent anterior
type Linha = Record<string, unknown>;
const linhas = (): Linha[] =>
  existsSync(SAIDA)
    ? readFileSync(SAIDA, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Linha)
    : [];
let exe: ChildProcess | null = null;
async function aberto(): Promise<Linha> {
  const antes = linhas().length;
  exe = spawn(resolve(DIR, 'app/Nekkora Agent.exe'), [], { detached: false, stdio: 'ignore' });
  await expect.poll(() => linhas().length > antes, { timeout: 90_000, intervals: [300] }).toBe(true);
  const l = linhas()[antes];
  expect(l.erro ?? null, JSON.stringify(l)).toBeNull();
  return l;
}
async function comando(c: string, codigo?: string): Promise<Linha> {
  const antes = linhas().length;
  if (codigo) writeFileSync(CODIGO, codigo);
  writeFileSync(COMANDO, c);
  await expect.poll(() => linhas().length > antes, { timeout: 420_000, intervals: [300] }).toBe(true);
  const l = linhas()[antes];
  expect(existsSync(CODIGO), 'o código é apagado pelo aplicativo ao ser lido').toBe(false);
  expect(l.erroDoRoteiro ?? l.erro ?? null, JSON.stringify(l).slice(0, 600)).toBeNull();
  return l;
}
async function fechar() {
  if (!exe) return;
  writeFileSync(COMANDO, 'sair');
  await expect.poll(() => linhas().some((l, i) => l.etapa === 'fim' && i === linhas().length - 1), { timeout: 60_000 }).toBe(true);
  // o processo termina sozinho (halt); a espera cobre o caso de ele demorar a sair
  await new Promise((r) => setTimeout(r, 2_000));
  exe.kill();
  exe = null;
}
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

test.use({ actionTimeout: 20_000, navigationTimeout: 45_000 });

test('PLATFORM-LICENCIAMENTO-001 com o Agent anterior em cópia isolada: recusa visível, dados preservados e tentar registrar de novo', async ({ browser }) => {
  test.setTimeout(2_400_000);
  expect(DIR.replace(/\\/g, '/'), 'só a cópia isolada desta missão').toMatch(/licenciamento-001\/exe-agent\/copia$/);
  expect(existsSync(PESSOAS), 'rode antes o roteiro da máquina: ele cadastra as pessoas sintéticas deste laboratório').toBe(true);
  rmSync(EVID, { recursive: true, force: true });
  // pasta de dados e saída da CÓPIA isolada: a configuração (endereço do laboratório) fica; o resto começa vazio
  const config = readFileSync(resolve(DIR, 'dados/config/agent-config.json'), 'utf8');
  rmSync(resolve(DIR, 'dados'), { recursive: true, force: true });
  rmSync(resolve(DIR, 'saida'), { recursive: true, force: true });
  mkdirSync(resolve(DIR, 'dados/config'), { recursive: true });
  mkdirSync(resolve(DIR, 'saida'), { recursive: true });
  writeFileSync(resolve(DIR, 'dados/config/agent-config.json'), config);
  log('laboratorio', readFileSync(resolve(`tools/lab/saidas/${LAB}/laboratorio.txt`), 'utf8').replace(/\n/g, ' | '));
  log('pacote_do_agent', readFileSync(resolve(DIR, 'app/VERSOES.txt'), 'utf8').split('\n').slice(0, 3).join(' | '));
  log('isolamento', { pasta_de_dados: 'exe-agent/copia/dados (propria desta copia)', bandeja: 'desligada', agent_instalado: 'nao usado', perfil_pessoal: 'nao usado' });

  const g = JSON.parse(readFileSync(PESSOAS, 'utf8')) as { nara: Record<string, string>; ana: Record<string, string>; orgN: string };
  const reviver = (x: Record<string, string>): Person => ({ email: x.email, password: x.password, name: x.name, auth: new Authenticator(x.secret), recoveryCodes: [] });
  const nara = reviver(g.nara);
  const ana = reviver(g.ana);
  const orgN = g.orgN;
  const anaPage = await (await browser.newContext()).newPage();
  const naraPage = await (await browser.newContext()).newPage();

  try {
    // ================================================================ 0. a cópia isolada abre, sem vínculo
    let l = await aberto();
    expect(l.vinculo, 'cópia nova: sem vínculo com a Platform').toBe('NOT_PAIRED');
    log('0_aplicativo', { vinculo: l.vinculo, janela: 'real, conduzida por dentro do processo' });

    // ================================================================ 1. organização nova no modelo por licença (pela tela do operador)
    await signInWithTotp(naraPage, nara);
    await go(naraPage, '/organizacoes');
    await naraPage.getByRole('button', { name: /^Entrar em Nekkora Suporte/ }).first().click();
    await expect(naraPage).toHaveURL(new RegExp(`/o/${orgN}$`));
    const oficinaName = `Oficina ${TAG}`;
    await go(naraPage, `/o/${orgN}/operador-de-licencas`);
    await naraPage.getByRole('button', { name: 'Criar organização por exceção' }).click();
    const exc = naraPage.getByRole('alertdialog');
    await exc.getByLabel('E-mail da pessoa responsável').fill(ana.email);
    await exc.getByLabel('Nome da organização').fill(oficinaName);
    await exc.getByLabel('Razão social').fill(`${oficinaName} Ltda`);
    await exc.getByLabel('Justificativa', { exact: true }).fill('roteiro do Agent anterior: organizacao nova de laboratorio');
    await confirmStepUp(naraPage, nara, 'Criar a organização');
    await settle(naraPage);
    await expect(naraPage.getByText(/Organização criada\./)).toBeVisible();
    await signInWithTotp(anaPage, ana);
    const oficina = await enter(anaPage, oficinaName);
    await openTarget(naraPage, orgN, oficina);
    await naraPage.getByRole('button', { name: 'Conceder licenças' }).click();
    const grant = naraPage.getByRole('alertdialog');
    await grant.getByLabel('Quantidade').fill('1');
    await grant.getByLabel('Início da validade').fill(day(0));
    await grant.getByLabel('Fim da validade').fill(day(30));
    await grant.getByLabel('Justificativa').fill('roteiro do Agent anterior: uma licenca para a oficina');
    await confirmStepUp(naraPage, nara, 'Conceder');
    await settle(naraPage);
    await expect(naraPage.getByText(/Licenças concedidas\./)).toBeVisible();
    await naraPage.getByRole('button', { name: 'Ligar a exigência de licença' }).click();
    const enforce = naraPage.getByRole('alertdialog');
    await enforce.getByLabel('Justificativa').fill('roteiro do Agent anterior: organizacao nova no modelo por licenca');
    await enforce.getByRole('checkbox', { name: /Conferi a prévia/ }).check();
    await confirmStepUp(naraPage, nara, 'Ligar a exigência');
    await settle(naraPage);
    await expect(naraPage.getByText('Exigência de licença ligada.')).toBeVisible();
    const license = sql(`SELECT license_id FROM organization_licenses WHERE organization_id = '${oficina}' AND license_number = 1`);

    // ================================================================ 2. automação publicada, licença vinculada, Worker e máquina pareada
    await go(anaPage, `/o/${oficina}/workspaces`);
    await anaPage.getByRole('button', { name: 'Criar workspace' }).click();
    await anaPage.getByRole('alertdialog').getByLabel(/^Nome/).fill('Oficina');
    await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
    await expect(anaPage).toHaveURL(new RegExp(`/o/${oficina}/workspaces/[0-9a-f-]{36}$`));
    await settle(anaPage);
    const workspaceId = /workspaces\/([0-9a-f-]{36})/.exec(anaPage.url())![1];
    await anaPage.getByRole('button', { name: 'Criar automação' }).click();
    await settle(anaPage);
    await anaPage.getByLabel(/^Nome da automação/).fill(AUTOMACAO);
    await anaPage.getByRole('radio', { name: /Só o nome, como rascunho/ }).check();
    await anaPage.getByRole('button', { name: 'Salvar rascunho' }).click();
    await settle(anaPage);
    await expect(anaPage.getByRole('heading', { name: AUTOMACAO })).toBeVisible();
    const versao = await newVersionWithPackage(anaPage, RAPIDO);
    const versaoId = /versoes\/([0-9a-f-]{36})/.exec(versao)![1];
    await anaPage.getByRole('button', { name: 'Publicar versão' }).click();
    await confirmStepUp(anaPage, ana, 'Publicar');
    await settle(anaPage);
    await expect.poll(() => sql(`SELECT status FROM automation_versions WHERE automation_version_id = '${versaoId}'`), { timeout: 60_000 }).toBe('2');
    await go(anaPage, `/o/${oficina}/administracao/licencas`);
    await anaPage.getByRole('button', { name: 'Vincular a licença nº 1 a uma automação' }).click();
    await anaPage.getByRole('alertdialog').getByLabel('Automação que vai usar esta licença').selectOption({ label: `${AUTOMACAO} · Oficina` });
    await confirmStepUp(anaPage, ana, 'Vincular licença');
    await settle(anaPage);
    await expect(anaPage.getByText(`Licença vinculada a ${AUTOMACAO}.`)).toBeVisible();

    await go(anaPage, `/o/${oficina}/workers`);
    await anaPage.getByRole('heading', { name: 'Workers', level: 1 }).waitFor();
    await anaPage.getByRole('button', { name: 'Criar Worker' }).click();
    await anaPage.getByRole('alertdialog').getByLabel(/^Nome do Worker/).fill(WORKER);
    await anaPage.getByRole('alertdialog').getByRole('button', { name: 'Criar Worker' }).click();
    await settle(anaPage);
    await go(anaPage, `/o/${oficina}/workers`);
    await anaPage.getByRole('button', { name: `Vincular Agent a ${WORKER}` }).click();
    await anaPage.getByRole('alertdialog').getByLabel(/^Nome da máquina/).fill(MAQUINA);
    await anaPage.getByRole('alertdialog').getByRole('radio', { name: 'Nekkora Agent anterior' }).check();
    await confirmStepUp(anaPage, ana, 'Gerar código');
    const codigo = (await anaPage.getByLabel('Código de uso único').innerText()).trim();
    // o pareamento, pelo diálogo real do aplicativo (botão "Parear" da janela principal, campo do código, botão de enviar)
    l = await comando('parear', codigo);
    expect(l.vinculo, String(l.janelaPrincipal).slice(0, 300)).toBe('PAIRED');
    await anaPage.getByRole('button', { name: 'Concluir' }).click();
    const worker = sql(`SELECT worker_id FROM workers WHERE organization_id = '${oficina}' AND name = '${WORKER}'`);
    await go(anaPage, `/o/${oficina}/workers`);
    await anaPage.getByRole('button', { name: `Autorizar ${WORKER} num workspace` }).click();
    await anaPage.getByRole('alertdialog').getByLabel('Workspace').selectOption(workspaceId);
    await confirmStepUp(anaPage, ana, 'Autorizar');
    await settle(anaPage);

    // a autorização de execução local desta versão para o Worker (com a licença vigente)
    await go(anaPage, versao);
    const cartao = anaPage.locator('section').filter({ has: anaPage.getByRole('heading', { name: /Autorizações de execução local/ }) });
    await cartao.getByLabel('Worker autorizado neste workspace').selectOption(worker);
    await cartao.getByLabel('Vale até').fill(day(10));
    await cartao.getByRole('button', { name: 'Autorizar execução local' }).click();
    await confirmStepUp(anaPage, ana, 'Autorizar execução local');
    await settle(anaPage);
    await expect.poll(() => sql(`SELECT count(*) FROM local_run_authorizations WHERE automation_version_id = '${versaoId}' AND worker_id = '${worker}' AND revoked_at IS NULL`), { timeout: 60_000 }).toBe('1');
    await comando('autorizacoes');
    log('2_preparo', { organizacao: 'modelo por licenca, criada por excecao para a cliente', automacao: AUTOMACAO, licenca: 'nº 1 vinculada', maquina: 'pareada pelo dialogo real do aplicativo', autorizacao: 'da versao para o Worker, vigente' });

    // ================================================================ 3. a licença VENCE (passagem do tempo); a execução acontece DEPOIS
    sql(`SET session_replication_role = replica; UPDATE organization_license_periods SET ends_at = clock_timestamp() WHERE license_id = '${license}'`);
    const runs = () => sql(`SELECT count(*) FROM agent_runs WHERE organization_id = '${oficina}'`);
    expect(runs()).toBe('0');
    writeFileSync(resolve(DIR, 'saida/executar.txt'), [RAPIDO, PYTHON, resolve(DIR, 'saida/resultado')].join('\n'));
    l = await comando('executar');
    guardarJanelas('A3');
    const execucao = String(l.ultimaExecucao);
    expect(l.estadoLocal, 'a automação EXECUTOU neste computador').toBe('SUCCEEDED');
    expect(l.codigoDeSaida).toBe(0);
    // RECUSA VISÍVEL: na execução, com o motivo; não como "envio parado" genérico, e sem descartar nada
    expect(String(l.envioNaTela)).toMatch(/^Executou neste computador · não registrada na Platform: /);
    expect(String(l.envioNaTela)).toMatch(/licença|autorização que a cobrisse/);
    expect(String(l.enviosParados)).toMatch(new RegExp(`${execucao}=AGT-PLT-03[567]`));
    expect(String(l.janelaPrincipal)).toContain('Execução não registrada na Platform');
    expect(String(l.telaDaExecucao)).toContain('Executou neste computador · não registrada na Platform');
    expect(l.arquivoDeEntregaNoDisco).toBe(true);
    expect(runs(), 'a Platform não registrou').toBe('0');
    log('3_recusa_visivel', {
      simulado: l.simulado,
      registro_escolhido_no_campo_real: l.registroEscolhido,
      execucao_local: `${l.estadoLocal}, codigo de saida ${l.codigoDeSaida}`,
      na_tela_da_execucao: l.envioNaTela,
      codigo: String(l.enviosParados).split('=')[1],
      janela_principal: String(l.janelaPrincipal).match(/Execução não registrada na Platform[^|]*\|[^|]*/)?.[0] ?? '',
      na_platform: 'nenhuma sessao registrada',
    });

    // "Envios parados": as duas coisas ditas em linhas separadas, o aviso de que nada foi apagado e o botão
    l = await comando('envios');
    guardarJanelas('A3');
    expect(l.botaoEnviosParados).toBe(true);
    expect(String(l.dialogo)).toContain('Neste computador: a automação executou.');
    // o motivo INTEIRO, em parágrafo (na primeira passada ele aparecia cortado com reticências na janela)
    expect(String(l.dialogo)).toMatch(/Na Platform: não registrada e não monitorada, porque a licença da automação venceu \(AGT-PLT-036\)\./);
    expect(String(l.dialogo)).toContain('nada foi apagado nem descartado');
    expect(l.botaoTentarDeNovo).toBe(true);
    const dialogo = String(l.dialogo);
    await comando('fechar');
    log('3_envios_parados', { dialogo: dialogo.slice(0, 700) });

    // PREPARO DO ACEITE MANUAL (ACEITE_PARAR_NA_RECUSA=1): para aqui, com a cópia fechada no estado de recusa e a licença vencida,
    // para a pessoa abrir o aplicativo, ver a recusa, renovar a licença pela Web e clicar ela mesma em "Tentar registrar de novo"
    if (process.env.ACEITE_PARAR_NA_RECUSA === '1') {
      await fechar();
      writeFileSync(resolve(process.cwd(), '../aceite/estado-do-aceite.txt'), [`organizacao=${oficinaName}`, `id_da_organizacao=${oficina}`, `automacao=${AUTOMACAO}`, `execucao=${execucao}`, 'licenca=nº 1 (vencida por passagem do tempo no laboratorio)', ''].join(String.fromCharCode(10)));
      log('aceite_manual', 'copia fechada no estado de recusa; a licenca continua vencida; nada foi registrado na Platform');
      return;
    }

    // ================================================================ 4. FECHAR e REABRIR: os dados continuam lá
    await fechar();
    l = await aberto();
    expect(l.vinculo, 'o vínculo continua').toBe('PAIRED');
    expect(l.ultimaExecucao).toBe(execucao);
    expect(String(l.enviosParados), 'o envio parado continua, com o mesmo motivo').toMatch(new RegExp(`${execucao}=AGT-PLT-03[567]`));
    expect(String(l.envioNaTela)).toMatch(/^Executou neste computador · não registrada na Platform: /);
    expect(String(l.janelaPrincipal)).toContain('Execução não registrada na Platform');
    expect(l.arquivoDeEntregaNoDisco).toBe(true);
    log('4_depois_de_fechar_e_reabrir', { vinculo: l.vinculo, envio: l.envioNaTela, envios_parados: l.enviosParados, arquivo_no_disco: l.arquivoDeEntregaNoDisco });

    // ================================================================ 5. TENTAR DE NOVO com a licença ainda vencida: para de novo, com o motivo; nada registrado
    l = await comando('envios');
    expect(l.botaoTentarDeNovo).toBe(true);
    l = await comando('tentar');
    expect(String(l.enviosParados), 'sem cobertura, o envio para de novo').toMatch(new RegExp(`${execucao}=AGT-PLT-03[567]`));
    expect(runs()).toBe('0');
    log('5_tentar_de_novo_ainda_sem_licenca', { envio: l.envioNaTela, na_platform: 'nenhuma sessao registrada' });

    // ================================================================ 6. a operadora RENOVA (o período continua do fim do anterior: cobre o início da execução)
    await openTarget(naraPage, orgN, oficina);
    await naraPage.getByRole('button', { name: 'Renovar a licença nº 1' }).click();
    const renew = naraPage.getByRole('alertdialog');
    await renew.getByLabel('Fim do novo período').fill(day(30));
    await renew.getByLabel('Justificativa').fill('roteiro do Agent anterior: renovacao do ciclo');
    await confirmStepUp(naraPage, nara, 'Renovar');
    await settle(naraPage);
    await expect(naraPage.getByText('Licença renovada. O vínculo com a automação não muda.')).toBeVisible();

    // ================================================================ 7. TENTAR DE NOVO: registrada UMA vez, e os eventos seguem
    l = await comando('envios');
    l = await comando('tentar');
    expect(String(l.enviosParados), 'o envio deixou de estar parado').toBe('');
    expect(['PENDING', 'DELIVERED']).toContain(l.envioEstado);
    await expect.poll(() => runs(), { timeout: 60_000 }).toBe('1');
    // o botão de envios parados some; mais consultas não criam outro registro
    const depois = await comando('envios');
    expect(depois.botaoEnviosParados, 'não há mais envio parado: o botão de tentar não existe mais').toBe(false);
    await comando('estado');
    await new Promise((r) => setTimeout(r, 8_000));
    l = await comando('estado');
    guardarJanelas('A7');
    expect(runs(), 'uma sessão, sem duplicar').toBe('1');
    const registrada = sql(`SELECT 'execucao=' || agent_execution_id || ' estado=' || supervisor_state || ' base_da_licenca=' || coalesce(license_basis::text, '-') || ' eventos=' || events_stored FROM agent_runs WHERE organization_id = '${oficina}'`);
    expect(registrada).toContain(execucao);
    await go(anaPage, `/o/${oficina}/execucoes`);
    await shot(anaPage, 'A7-execucoes-na-platform');
    log('7_tentar_de_novo_depois_da_renovacao', { envio: l.envioNaTela, estado_do_envio: l.envioEstado, eventos_confirmados: l.eventosConfirmados, na_platform: registrada, sessoes: runs() });

    await fechar();
    log('limites_de_frequencia', `nenhum limite de frequencia foi zerado. "Tentar novamente" (da Web) usado ${retried} vez(es)`);
    log('fim', 'roteiro do Agent anterior concluido');
  } finally {
    writeFileSync(COMANDO, 'sair');
    await new Promise((r) => setTimeout(r, 3_000));
    exe?.kill();
    rmSync(CODIGO, { force: true });
    if (existsSync(SAIDA)) {
      mkdirSync(EVID, { recursive: true });
      copyFileSync(SAIDA, join(EVID, 'aplicativo.jsonl'));
    }
  }
});
