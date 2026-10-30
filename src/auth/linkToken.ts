/**
 * Token de links de e-mail (cadastro, recuperação de senha, convite).
 *
 * Os caminhos são contrato da API (MailTemplates, token SEMPRE no fragmento): /cadastro/confirmar, /recuperar-senha,
 * /o/{org}/recuperar-senha e /o/{org}/convite. Os antigos /o/{org}/reset-password e /o/{org}/verify-email continuam
 * aceitos por compatibilidade.
 * O fragmento (#) não é enviado a servidores nem em Referer. Por compatibilidade também aceitamos ?token=.
 *
 * O token é lido UMA vez e removido da barra de endereços imediatamente (history.replaceState), para não
 * ficar no histórico, em favoritos, capturas de tela ou compartilhamentos. Nunca é exibido nem registrado.
 */
const FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function takeLinkToken(): string | null {
  const url = new URL(window.location.href);
  const fromHash = new URLSearchParams(url.hash.replace(/^#/, '')).get('token');
  const fromQuery = url.searchParams.get('token');
  const token = fromHash ?? fromQuery;
  if (fromHash !== null || fromQuery !== null) {
    url.hash = '';
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', url.pathname + url.search);
  }
  return token;
}

/** Formato do token do contrato (43 caracteres base64url). Só evita chamada inútil; a API decide a validade. */
export function hasTokenFormat(token: string | null): token is string {
  return token !== null && FORMAT.test(token);
}

/**
 * Captura o token do link UMA vez, na carga da página (antes do React), e o remove da URL. As páginas de
 * redefinição/verificação o consomem da memória — assim renderizações duplicadas (StrictMode) ou navegação
 * interna não perdem nem reutilizam o token.
 */
let initial: { path: string; token: string | null } | undefined;

export function captureInitialLinkToken(): void {
  const path = window.location.pathname;
  if (/\/(reset-password|verify-email|resend-verification)\/?$/.test(path) || /[#?&]token=/.test(window.location.href)) {
    initial = { path, token: takeLinkToken() };
  }
}

/** Há token capturado para o caminho (sem consumi-lo): decide a tela antes de a página o usar. */
export function peekInitialLinkToken(path: string): boolean {
  return !!initial && initial.path === path && initial.token !== null;
}

/** Devolve (e esquece) o token capturado para o caminho atual. */
export function consumeInitialLinkToken(path: string): string | null {
  if (!initial || initial.path !== path) return null;
  const { token } = initial;
  initial = undefined;
  return token;
}

/** Só para testes. */
export function resetLinkTokenCapture(): void {
  initial = undefined;
}
