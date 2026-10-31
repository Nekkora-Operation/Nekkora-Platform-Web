import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { expect, test, type Page, type Request } from '@playwright/test';
import { confirmStepUp, LAB, signUpAndEnroll, syntheticEmail } from './support/lab';

/**
 * FRONT-V1-004 — erro de gateway DEPOIS do envio, com a API REAL do laboratório descartável.
 *
 * Como o erro é produzido (nada é simulado na resposta):
 *   1. o navegador emite o pedido do ato (convite com step-up; envio do pacote);
 *   2. `page.route` só SEGURA esse pedido até o laboratório congelar a API (`lab.mjs api pausar`, docker pause do
 *      platform) e o solta sem alterar nada (`route.continue()`);
 *   3. o pedido atravessa o Vite e o nginx e fica no buffer do socket da API congelada; o nginx responde 504 no prazo
 *      dele (60 s, proxy_read_timeout padrão do api/e2e/nginx.conf);
 *   4. a API é descongelada e processa o pedido que já tinha chegado.
 * A tela tem de manter o resultado DESCONHECIDO: não afirmar que nada foi feito, não reenviar e não liberar a repetição
 * sem a pessoa. O efeito real no servidor é conferido depois e registrado, seja qual for.
 * Pré-condição declarada: limites da organização (010) por fixture.
 */
const PKG = `tools/lab/saidas/${LAB}/pacotes/pacote-studio-real.zip`;
const lab = (...args: string[]) => execFileSync('node', ['tools/lab/lab.mjs', LAB, ...args], { encoding: 'utf8' });
const log = (text: string) => {
  const line = `${new Date().toISOString()} ${text}`;
  console.log(line);
  appendFileSync(`tools/lab/saidas/${LAB}/gateway.txt`, `${line}\n`);
};
/**
 * Nada na tela pode AFIRMAR ausência de efeito depois do 504 ("Nada foi feito.", "nada foi gravado"…). A frase que nega a
 * conclusão ("não comprova que nada foi feito") é o aviso correto e não conta.
 */
const ABSENCE = /(?<!que )nada foi (feito|enviado|gravado|criado|emitido|aplicado)|não chegou/i;

/** Segura o PRIMEIRO pedido `method` que casar com `url`, congela a API e o solta sem alteração. */
async function freezeApiOnFirst(page: Page, method: string, url: RegExp) {
  let frozen = false;
  await page.route(url, async (route) => {
    if (frozen || route.request().method() !== method) return route.fallback();
    frozen = true;
    lab('api', 'pausar');
    log(`API congelada com o pedido ${method} ${new URL(route.request().url()).pathname} a caminho`);
    await route.continue();
  });
  return () => frozen;
}

function countRequests(page: Page, method: string, url: RegExp) {
  const seen: { at: number; status?: number }[] = [];
  const mine = (r: Request) => r.method() === method && url.test(r.url());
  page.on('request', (r) => mine(r) && seen.push({ at: Date.now() }));
  page.on('response', (r) => {
    if (!mine(r.request())) return;
    const last = seen.at(-1);
    if (last) last.status = r.status();
  });
  page.on('requestfailed', (r) => {
    if (!mine(r)) return;
    const last = seen.at(-1);
    if (last) last.status = -1;
  });
  return seen;
}

test('FRONT-V1-004: 504 do gateway depois do envio (step-up e upload) mantém o resultado desconhecido', async ({ page }) => {
  test.setTimeout(30 * 60_000);
  try {
    const ana = await signUpAndEnroll(page, 'gw');
    const name = `Ensaio gateway ${Date.now().toString(36)}`;
    await page.goto('/organizacoes/nova');
    await page.getByLabel(/^Nome da organização/).fill(name);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await confirmStepUp(page, ana, 'Criar organização');
    await page.getByRole('button', { name: `Entrar em ${name}` }).click();
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
    const org = /\/o\/([0-9a-f-]{36})/.exec(page.url())![1];
    lab('limites', org, ana.email);
    log(`org=${org}`);

    // ---------------- step-up: convite (POST .../invitations depois do step-up aceito)
    const invitee = syntheticEmail('gw-convidada');
    const invitationsUrl = /\/api\/v1\/o\/[0-9a-f-]{36}\/invitations$/;
    const invitePosts = countRequests(page, 'POST', invitationsUrl);
    await page.goto(`/o/${org}/administracao/convites`);
    await page.getByLabel(/^E-mail da pessoa/).fill(invitee);
    await page.getByRole('button', { name: 'Convidar' }).click();
    const frozeInvite = await freezeApiOnFirst(page, 'POST', invitationsUrl);
    await confirmStepUp(page, ana, 'Enviar convite');
    const dialog = page.getByRole('alertdialog');
    try {
      await expect(dialog.getByText('Não foi possível confirmar se o convite foi emitido.', { exact: false })).toBeVisible({ timeout: 120_000 });
    } finally {
      if (frozeInvite()) lab('api', 'retomar');
    }
    expect(frozeInvite(), 'o pedido do convite passou pela API congelada').toBe(true);
    expect(invitePosts.map((p) => p.status), 'um único POST, respondido 504 pelo gateway').toEqual([504]);
    await expect(dialog.getByText('Nada será repetido automaticamente.', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Enviar convite' })).toBeDisabled();
    expect(await dialog.innerText()).not.toMatch(ABSENCE);
    log(`convite: POST único respondido ${invitePosts[0]?.status}; diálogo em "resultado não confirmado"`);

    // nenhuma repetição sozinha, mesmo com a API de volta
    await page.waitForTimeout(15_000);
    expect(invitePosts).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Cancelar' }).click();

    // efeito real, conferido pela lista (seja qual for)
    let applied = false;
    for (let i = 0; i < 6 && !applied; i++) {
      await page.getByRole('button', { name: 'Atualizar' }).click();
      await page.waitForTimeout(5_000);
      applied = (await page.locator('main').innerText()).includes(invitee);
    }
    log(`convite: depois de descongelar, a lista ${applied ? 'MOSTRA' : 'NÃO mostra'} o convite (efeito ${applied ? 'aplicado' : 'não visto'} pela API)`);

    // recarga: o registro persistente continua bloqueando a mesma operação até a pessoa liberar
    await page.reload();
    await page.getByLabel(/^E-mail da pessoa/).fill(invitee);
    await page.getByRole('button', { name: 'Convidar' }).click();
    await expect(dialog.getByText('Uma tentativa enviada às', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Enviar convite' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Já conferi o estado atual; liberar nova tentativa' })).toBeVisible();
    expect(await dialog.innerText()).not.toMatch(ABSENCE);
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    expect(invitePosts).toHaveLength(1);
    log('convite: depois da recarga, a confirmação continua bloqueada até a liberação explícita; nenhum POST novo');

    // ---------------- upload do pacote (PUT .../artifact)
    await page.goto(`/o/${org}/workspaces`);
    await page.getByRole('button', { name: 'Criar workspace' }).click();
    await page.getByRole('alertdialog').getByLabel(/^Nome/).fill('Operações');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Criar workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Operações' })).toBeVisible();
    await page.getByRole('button', { name: 'Criar automação' }).click();
    await page.getByRole('alertdialog').getByLabel(/^Nome da automação/).fill('Biografias da Wikipédia');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Criar automação' }).click();
    await page.getByRole('button', { name: 'Nova versão' }).click();
    await expect(page).toHaveURL(/\/versoes\/[0-9a-f-]{36}$/);
    const artifactUrl = /\/api\/v1\/o\/[0-9a-f-]{36}\/automation-versions\/[0-9a-f-]{36}\/artifact$/;
    const uploads = countRequests(page, 'PUT', artifactUrl);
    await page.getByLabel('Arquivo .zip do pacote').setInputFiles(PKG);
    const frozeUpload = await freezeApiOnFirst(page, 'PUT', artifactUrl);
    await page.getByRole('button', { name: 'Enviar pacote' }).click();
    try {
      await expect(page.getByText('O envio foi interrompido ou ficou sem resposta.')).toBeVisible({ timeout: 120_000 });
    } finally {
      if (frozeUpload()) lab('api', 'retomar');
    }
    expect(frozeUpload(), 'o envio do pacote passou pela API congelada').toBe(true);
    expect(uploads.map((u) => u.status), 'um único PUT, respondido 504 pelo gateway').toEqual([504]);
    await expect(page.getByText('Os bytes podem ter chegado. Nada é reenviado automaticamente', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar pacote' })).toBeDisabled();
    await expect(page.getByLabel('Arquivo .zip do pacote')).toBeDisabled();
    expect(await page.locator('main').innerText()).not.toMatch(ABSENCE);
    await page.waitForTimeout(15_000);
    expect(uploads).toHaveLength(1);
    log(`upload: PUT único respondido ${uploads[0]?.status}; tela em "resultado não confirmado", envio e arquivo bloqueados`);

    // conferência explícita da pessoa: a tela compara com o que a Platform tem
    await page.getByRole('button', { name: 'Conferir a versão' }).click();
    const verdict = page.getByText(/Conferido: a Platform tem o pacote|A versão não tem o pacote deste arquivo|Não foi possível comparar/);
    await expect(verdict).toBeVisible({ timeout: 60_000 });
    log(`upload: conferência depois de descongelar: "${(await verdict.innerText()).trim()}"`);
    expect(uploads).toHaveLength(1);
  } finally {
    // nunca deixar a API congelada (o descongelamento repetido é inofensivo só se estiver congelada: confere antes)
    const state = lab('compose', 'ps', '--format', '{{.Service}} {{.State}}', 'platform');
    if (/paused/i.test(state)) lab('api', 'retomar');
  }
});
