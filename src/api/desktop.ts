/**
 * Entrada no aplicativo desktop Nekkora Agent pelo navegador (contrato: tag "Login do aplicativo desktop", desktop-login/1).
 * O aplicativo abre o navegador com um pedido (Authorization Code com PKCE); a Web o entrega à API, que o guarda no
 * servidor, e a pessoa — autenticada pelas telas normais de login e segundo fator — confere a conta e autoriza.
 *
 * A Web nunca vê código de autorização, verificador nem token do aplicativo: só recebe da API o endereço de retorno, que
 * é sempre o retorno local do próprio computador (`http://127.0.0.1:<porta>/callback`). Qualquer outro destino é recusado
 * aqui também, para que esta página nunca vire um redirecionamento aberto.
 */
import { preAuthPost } from './auth';
import { ApiError, request } from './http';
import { identityCsrf } from './identity';
import { validated, type OperationId } from './validate';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type DesktopAuthorizationRequest = S['DesktopAuthorizationRequest'];

/** Parâmetros do pedido (RFC 6749 e RFC 7636) e o nome de cada um no corpo enviado à API. */
const PARAMS: Record<string, keyof DesktopAuthorizationRequest> = {
  response_type: 'responseType',
  client_id: 'clientId',
  redirect_uri: 'redirectUri',
  state: 'state',
  code_challenge: 'codeChallenge',
  code_challenge_method: 'codeChallengeMethod',
  scope: 'scope',
};

/**
 * Lê o pedido da URL com que o aplicativo abriu o navegador. Exige cada parâmetro UMA vez e nenhum outro; senão, não há
 * pedido (`null`). O conteúdo é validado pela API — aqui só se recusa o que é ambíguo.
 */
export function parseDesktopRequest(search: string): DesktopAuthorizationRequest | null {
  const query = new URLSearchParams(search);
  const body: Record<string, string> = {};
  for (const key of new Set(query.keys())) {
    const target = PARAMS[key];
    const values = query.getAll(key);
    if (!target || values.length !== 1 || !values[0]) return null;
    body[target] = values[0];
  }
  if (Object.keys(body).length !== Object.keys(PARAMS).length) return null;
  return body as unknown as DesktopAuthorizationRequest;
}

const LOOPBACK_RETURN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/callback\?[A-Za-z0-9_.~%=&-]+$/;

/** O retorno só pode ser o endereço local do aplicativo, com a consulta montada pela API. Fora disso: erro, sem navegar. */
export function loopbackReturn(url: unknown): string {
  if (typeof url !== 'string' || !LOOPBACK_RETURN.test(url)) throw new ApiError('unexpected', 200);
  const port = Number(LOOPBACK_RETURN.exec(url)![1]);
  if (port < 1024 || port > 65535) throw new ApiError('unexpected', 200);
  return url;
}

async function send<T>(operationId: OperationId, path: string, options: Parameters<typeof request>[1] = {}): Promise<T> {
  const { status, data } = await request<unknown>(path, options);
  return validated<T>(operationId, data, status);
}

/** Entrega o pedido à API (com ou sem sessão). 204: o pedido fica no servidor; o navegador guarda só o cookie dele. */
export async function startDesktopAuthorization(body: DesktopAuthorizationRequest): Promise<void> {
  const { status, data } = await preAuthPost<unknown>('/api/v1/desktop/authorizations', body);
  validated('desktopAuthorizationStart', data, status);
}

export interface DesktopPending {
  application: string;
  email: string;
}

/** Pedido vivo e a conta que vai autorizar. 401: sem sessão; 403: sessão restrita; 404: sem pedido (expirou ou já foi usado). */
export async function pendingDesktopAuthorization(): Promise<DesktopPending> {
  const data = await send<S['DesktopAuthorizationPending']>('desktopAuthorizationPending', '/api/v1/desktop/authorization');
  return { application: data.application, email: data.account.email };
}

/** Autoriza com a sessão de identidade. Devolve o retorno local do aplicativo, já conferido. */
export async function approveDesktopAuthorization(): Promise<string> {
  const csrf = await identityCsrf();
  const data = await send<S['DesktopRedirect']>('desktopAuthorizationApprove', '/api/v1/desktop/authorization/approve', { method: 'POST', csrf });
  return loopbackReturn(data.redirectTo);
}

/** Recusa (com ou sem sessão). Devolve o retorno local do aplicativo, com o aviso de recusa. */
export async function denyDesktopAuthorization(): Promise<string> {
  const { status, data } = await preAuthPost<unknown>('/api/v1/desktop/authorization/deny', undefined);
  return loopbackReturn(validated<S['DesktopRedirect']>('desktopAuthorizationDeny', data, status).redirectTo);
}
