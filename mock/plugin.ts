import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { DEV_ORG, DEV_PASSWORD, DEV_TOTP_SECRET, MockApi, type Failure } from './contract.ts';
import { currentStep, totp } from './totp.ts';

/**
 * Plugin do Vite: serve a API simulada em /api/v1 e o painel /__mock/ nos servidores de desenvolvimento e de
 * preview. Não participa do `vite build` — o bundle de produção não contém nada daqui.
 */
export function nekkoraMockApi(): Plugin {
  const api = new MockApi();
  const delay = Number(process.env.NEKKORA_MOCK_DELAY ?? 350);
  const install = (middlewares: Connect.Server) => {
    middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) return void handleApi(api, delay, req, res, url).catch(next);
      if (url.pathname === '/__mock' || url.pathname.startsWith('/__mock/')) return void handleControl(api, req, res, url).catch(next);
      next();
    });
  };
  return {
    name: 'nekkora-mock-api',
    configureServer(server) {
      install(server.middlewares);
      server.httpServer?.once('listening', () => {
        setTimeout(() => {
          const base = server.resolvedUrls?.local[0] ?? 'http://localhost:5173/';
          server.config.logger.info(
            `\n  API simulada (contrato 8.7) — contas, código TOTP e e-mails: ${base}__mock/\n  Login: ${base}o/${DEV_ORG}/login\n`,
          );
        }, 50);
      });
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8 * 1024) throw Object.assign(new Error('corpo grande demais'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function cookies(req: IncomingMessage) {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function handleApi(api: MockApi, delay: number, req: IncomingMessage, res: ServerResponse, url: URL) {
  const body = await readBody(req);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  if (api.failure === 'offline') {
    req.socket.destroy(); // queda de conexão: o navegador vê erro de rede
    return;
  }
  const out = api.handle({
    method: req.method ?? 'GET',
    path: url.pathname,
    origin: req.headers.origin,
    expectedOrigin: `http://${req.headers.host}`,
    csrf: typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined,
    cookies: cookies(req),
    body,
  });
  res.statusCode = out.status;
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  if (out.cookies.length) res.setHeader('Set-Cookie', out.cookies);
  if (out.body === undefined) return void res.end();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(out.body));
}

// ------------------------------------------------------------------ painel e controle (só simulação)

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

const FAILURES: Failure[] = ['none', 'offline', 'rate_limited', 'service_unavailable', 'internal_error'];

async function handleControl(api: MockApi, req: IncomingMessage, res: ServerResponse, url: URL) {
  const route = `${req.method} ${url.pathname.replace(/\/$/, '') || '/__mock'}`;
  const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
  const userId = String(body.userId ?? url.searchParams.get('userId') ?? '');
  const account = api.accounts.get(userId);

  switch (route) {
    case 'GET /__mock':
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return void res.end(PANEL);
    case 'GET /__mock/state': {
      const step = currentStep();
      return sendJson(res, 200, {
        org: DEV_ORG,
        password: DEV_PASSWORD,
        failure: api.failure,
        secondsLeft: 30 - Math.floor((Date.now() / 1000) % 30),
        accounts: [...api.accounts.values()]
          .filter((a) => a.org === DEV_ORG)
          .map((a) => ({
            userId: a.userId,
            email: a.email,
            displayName: a.displayName,
            accountType: a.accountType,
            verified: a.verified,
            mfa: !!a.totpSecret,
            code: a.totpSecret ? totp(a.totpSecret, step) : null,
            fixedSecret: a.totpSecret === DEV_TOTP_SECRET,
            recoveryCodes: a.recoveryCodes,
            sessions: api.activeSessions(a.userId),
          })),
        inbox: api.inbox,
      });
    }
    case 'POST /__mock/reset':
      api.reset();
      return sendJson(res, 200, { ok: true });
    case 'POST /__mock/failure': {
      const f = body.failure as Failure;
      if (!FAILURES.includes(f)) return sendJson(res, 400, { error: 'failure' });
      api.failure = f;
      return sendJson(res, 200, { failure: f });
    }
    case 'POST /__mock/organizations':
      return sendJson(res, 200, { org: api.createOrganization() });
    case 'POST /__mock/accounts': {
      const org = typeof body.org === 'string' ? body.org : api.createOrganization();
      const a = api.createAccount({ org, verified: body.verified !== false, displayName: 'Pessoa E2E' });
      return sendJson(res, 200, { org: a.org, userId: a.userId, email: a.email, password: a.password });
    }
    case 'POST /__mock/password-reset-tokens':
      if (!account) return sendJson(res, 404, { error: 'account' });
      return sendJson(res, 200, { token: api.issuePasswordResetToken(userId, { expired: body.expired === true }) });
    case 'GET /__mock/password-reset-tokens':
      return sendJson(res, 200, { count: api.passwordResetTokenCount(userId) });
    case 'POST /__mock/email-verification-tokens':
      if (!account) return sendJson(res, 404, { error: 'account' });
      return sendJson(res, 200, { token: api.issueEmailVerificationToken(userId, { expired: body.expired === true }) });
    case 'POST /__mock/revoke-sessions':
      if (!account) return sendJson(res, 404, { error: 'account' });
      api.revokeSessions(userId);
      return sendJson(res, 200, { ok: true });
    case 'POST /__mock/sessions/revoke-all':
      for (const a of api.accounts.values()) api.revokeSessions(a.userId);
      return sendJson(res, 200, { ok: true });
    default:
      return sendJson(res, 404, { error: 'not_found' });
  }
}

const PANEL = /* html */ `<!doctype html>
<html lang="pt-BR" data-nk-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>API simulada · Nekkora Platform</title>
<style>
  :root { color-scheme: dark; --bg:#180c1a; --panel:#221626; --line:#3a2a3e; --text:#f3e9f0; --muted:#b9a8b6; --accent:#f49ab5; --ok:#7fd6a4; --warn:#f3c77a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui, sans-serif; }
  main { max-width: 1080px; margin: 0 auto; padding: 24px 16px 48px; display:grid; gap:20px; }
  h1 { font-size: 20px; margin: 0; } h2 { font-size: 15px; margin: 0 0 10px; }
  p { margin: 0; color: var(--muted); }
  section { background: var(--panel); border:1px solid var(--line); border-radius: 12px; padding: 16px; overflow-x:auto; }
  table { width:100%; border-collapse: collapse; } th, td { text-align:left; padding: 8px; border-top:1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; border-top: 0; }
  code, .mono { font-family: ui-monospace, monospace; }
  .code { font: 600 20px ui-monospace, monospace; letter-spacing: .12em; color: var(--accent); }
  a { color: var(--accent); } button, select { font: inherit; color: var(--text); background: #2e1f33; border:1px solid var(--line); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
  .tag { display:inline-block; padding: 0 8px; border-radius: 999px; border:1px solid var(--line); color: var(--muted); font-size: 12px; }
  .ok { color: var(--ok); } .warn { color: var(--warn); }
  details summary { cursor: pointer; color: var(--muted); }
  .row { display:flex; flex-wrap: wrap; gap: 12px; align-items: center; }
</style>
</head>
<body>
<main>
  <div class="row" style="justify-content:space-between">
    <div><h1>API simulada · contrato 8.7</h1><p>Ferramenta de desenvolvimento. Dados só em memória; reiniciar o servidor restaura o estado inicial.</p></div>
    <button id="reset">Restaurar dados de exemplo</button>
  </div>
  <section>
    <h2>Acesso</h2>
    <p>Organização: <code id="org"></code> · Senha de todas as contas: <code id="pwd"></code></p>
    <p style="margin-top:8px"><a id="login" href="#">Abrir o login da organização →</a></p>
  </section>
  <section>
    <h2>Contas <span class="tag" id="timer"></span></h2>
    <table><thead><tr><th>E-mail</th><th>Estado</th><th>Código TOTP agora</th><th>Sessões</th><th></th></tr></thead><tbody id="accounts"></tbody></table>
    <p style="margin-top:10px">A conta com MFA usa a chave fixa <code>${DEV_TOTP_SECRET}</code> — cadastre-a num autenticador real, se preferir.</p>
  </section>
  <section>
    <h2>Caixa de e-mails simulada</h2>
    <table><thead><tr><th>Quando</th><th>Para</th><th>Mensagem</th><th>Link</th></tr></thead><tbody id="inbox"></tbody></table>
  </section>
  <section>
    <h2>Simular falha da API</h2>
    <div class="row"><select id="failure">
      <option value="none">Nenhuma (normal)</option><option value="offline">Queda de conexão</option>
      <option value="rate_limited">429 · muitas tentativas</option><option value="service_unavailable">503 · indisponível</option>
      <option value="internal_error">500 · erro interno</option></select>
      <p>Vale para todas as chamadas até voltar para "Nenhuma".</p></div>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  async function load() {
    const s = await (await fetch('/__mock/state')).json();
    $('org').textContent = s.org; $('pwd').textContent = s.password; $('login').href = '/o/' + s.org + '/login';
    $('timer').textContent = 'renova em ' + s.secondsLeft + ' s';
    if (document.activeElement !== $('failure')) $('failure').value = s.failure;
    $('accounts').innerHTML = s.accounts.map((a) => '<tr><td>' + esc(a.email) + '<br><span class="tag">' + (a.accountType === 'internal' ? 'interna · 30 min' : 'portal · 15 min') + '</span></td><td>' +
      (a.verified ? '<span class="ok">e-mail confirmado</span>' : '<span class="warn">e-mail pendente</span>') + '<br>' +
      (a.mfa ? 'MFA configurado' : '<span class="warn">primeiro acesso (sem MFA)</span>') + '</td><td>' +
      (a.code ? '<span class="code">' + a.code + '</span>' : '—') +
      (a.recoveryCodes.length ? '<details><summary>' + a.recoveryCodes.length + ' códigos de recuperação</summary><div class="mono">' + a.recoveryCodes.map(esc).join('<br>') + '</div></details>' : '') +
      '</td><td>' + a.sessions + '</td><td>' + (a.sessions ? '<button data-revoke="' + a.userId + '">Expirar sessões</button>' : '') + '</td></tr>').join('');
    $('inbox').innerHTML = s.inbox.length ? s.inbox.map((m) => '<tr><td>' + new Date(m.at).toLocaleTimeString('pt-BR') + '</td><td>' + esc(m.to) + '</td><td>' +
      (m.kind === 'password-reset' ? 'Redefinição de senha' : 'Confirmação de e-mail') + '</td><td><a href="' + esc(m.link) + '" target="_blank" rel="noopener">abrir link</a></td></tr>').join('')
      : '<tr><td colspan="4"><p>Nenhuma mensagem. Use "Esqueci minha senha" para gerar uma.</p></td></tr>';
  }
  document.addEventListener('click', async (e) => {
    const id = e.target.dataset && e.target.dataset.revoke;
    if (id) { await post('/__mock/revoke-sessions', { userId: id }); load(); }
  });
  $('reset').onclick = async () => { await post('/__mock/reset'); load(); };
  $('failure').onchange = async (e) => { await post('/__mock/failure', { failure: e.target.value }); load(); };
  load(); setInterval(load, 1000);
</script>
</body>
</html>`;
