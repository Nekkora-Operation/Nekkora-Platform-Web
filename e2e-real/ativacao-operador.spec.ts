import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { confirmStepUp, LAB, signUpAndEnroll, type Person } from './support/lab';

/**
 * PLATFORM-LOCAL-002 (item 4) — ativação REAL de uma organização criada pela interface, sem fixture.
 *
 * A pessoa cria a organização na tela e vê "Aguardando ativação"; a ativação é um ato da OPERAÇÃO, feito pela CLI real dos
 * operadores (`bash tools/lab/local.sh ativar`, que chama `ativar-organizacao` da 022 com o papel op_lab_atv, certificado
 * de cliente de 15 min, a conta responsável do operador e limites explícitos); depois a pessoa volta ao navegador e vê o
 * estado novo e uma consequência prática: o código de pareamento de um Agent com Worker novo, recusado antes (capacidade
 * zero), passa a ser emitido — sem Agent desktop (o código não é usado e não aparece na saída).
 *
 *   FRONT_LAB_ID=<id> FRONT_PORTA=<porta do Vite> npx playwright test -c playwright.real.config.ts ativacao-operador
 * Pré-requisito: `LOCAL_ID=<id> bash tools/lab/local.sh operador preparar` (docs/USO-LOCAL.md, "Ativação pelo operador").
 * Contas descartáveis (@frontlab.test) e a caixa local; nenhum SQL de escrita.
 */
const local = (...args: string[]) =>
  execFileSync('bash', ['tools/lab/local.sh', ...args], { env: { ...process.env, LOCAL_ID: LAB }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function tentarParear(page: Page, org: string, person: Person, worker: string) {
  await page.goto(`/o/${org}/agents`);
  await expect(page.getByText('Nenhum Agent pareado.')).toBeVisible();
  await page.getByRole('button', { name: 'Parear novo Agent' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel(/^Nome da máquina/).fill(`LAB-${worker.toUpperCase()}`);
  await dialog.getByLabel(/^Nome do Worker/).fill(`Worker ${worker}`);
  await confirmStepUp(page, person, 'Gerar código');
}

test('ativação pela CLI real dos operadores: Aguardando ativação → Ativada, auditoria e capacidade para Workers', async ({ page }) => {
  test.setTimeout(600_000);
  const tag = Date.now().toString(36);
  const ana = await signUpAndEnroll(page, 'atv', `atv-${tag}@frontlab.test`);
  const nome = `Organização de teste ${tag}`;

  // 1. a pessoa cria a organização pela interface; ela nasce aguardando ativação
  // a entrada geral sem organização oferece "Criar minha primeira organização" (página inicial nova)
  await page.getByRole('button', { name: 'Criar minha primeira organização' }).click();
  await page.getByLabel(/^Nome da organização/).fill(nome);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await confirmStepUp(page, ana, 'Criar organização');
  await expect(page).toHaveURL(/\/organizacoes$/);
  const cartao = page.getByRole('listitem').filter({ hasText: nome });
  await expect(cartao.getByText('Aguardando ativação')).toBeVisible();
  await cartao.getByRole('button', { name: `Entrar em ${nome}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  const org = /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];

  // 2. antes da ativação: capacidade zero — o código de pareamento com Worker novo é recusado pela API
  await tentarParear(page, org, ana, 'antes');
  await expect(page.getByText(/ainda não tem capacidade para registrar Workers \(aguardando ativação\)/)).toBeVisible();
  await page.keyboard.press('Escape');

  // 3. a operação ativa pela CLI real, com limites explícitos de laboratório (2 Workers, 1 simultânea, 10 pendentes)
  const saida = local('ativar', org, '2', '1', '10', `laboratório: prova da ativação ${tag}`);
  expect(saida).toMatch(new RegExp(`organizacao=${org} resultado=OK evento=[0-9a-f-]{36} motivo=- limites_aplicados=trabalhadores=2,simultaneas=1,pendentes=10,alerta_logs=-,alerta_eventos=-`));
  const evento = /evento=([0-9a-f-]{36})/.exec(saida)![1];
  // repetição: recusada sem efeito
  expect(local('ativar', org, '9', '9', '99', 'repetição')).toMatch(/resultado=RECUSA .*motivo=JA_ATIVADA/);
  // auditoria (somente leitura): o ato OK com o papel do operador
  const estado = local('operador', 'estado');
  expect(estado).toContain(`${nome} | ${org} | ATIVADA`);
  expect(estado).toMatch(new RegExp(`ATIVACAO \\| OK \\| - \\| ${org} \\| op_lab_atv \\| laboratório: prova da ativação ${tag}`));
  test.info().annotations.push({ type: 'evento', description: evento });

  // 4. de volta ao navegador: o estado novo vem da API
  await page.goto('/organizacoes');
  const depois = page.getByRole('listitem').filter({ hasText: nome });
  await expect(depois.getByText('Ativada')).toBeVisible();
  await expect(depois.getByText('Aguardando ativação')).toHaveCount(0);

  // 5. consequência prática: agora o código de pareamento com Worker novo é emitido (sem Agent desktop; não é usado)
  await depois.getByRole('button', { name: `Entrar em ${nome}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await tentarParear(page, org, ana, 'depois');
  await expect(page.getByLabel('Código de uso único')).toHaveText(/^nkp1\./);
});
