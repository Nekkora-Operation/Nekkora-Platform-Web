/**
 * Cliente HTTP do contrato 8.7 (Nekkora Platform API v1).
 *
 * - Origem única (sem CORS): cookies HttpOnly (`__Host-…`) vão sozinhos; o JavaScript nunca vê token de sessão.
 * - Erros chegam como `{"error":"<código>"}` (§5.2). Nada do corpo, da URL ou do payload é registrado em log.
 */

export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  /** O estado atual impede o ato (409). */
  | 'conflict'
  /** Convite (409): já membro ativo; conta da organização com o e-mail, não ligada (vinculação); conta indisponível. */
  | 'already_member'
  | 'account_exists'
  | 'account_unavailable'
  /** Pacote recusado pela conferência da API (422), com motivo de vocabulário fechado em `reason`. */
  | 'package_rejected'
  | 'rate_limited'
  | 'internal_error'
  | 'service_unavailable'
  /**
   * 502/503/504 SEM o corpo de erro da API (proxy/gateway): não se sabe se o pedido chegou à API. Leituras tratam como
   * indisponibilidade; uma escrita com esse erro tem resultado DESCONHECIDO (nunca "nada foi gravado").
   */
  | 'gateway'
  /** Sem resposta (rede, gateway fora). */
  | 'network'
  /** Resposta fora do contrato. */
  | 'unexpected';

const KNOWN: ReadonlySet<string> = new Set([
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'already_member',
  'account_exists',
  'account_unavailable',
  'package_rejected',
  'rate_limited',
  'internal_error',
  'service_unavailable',
]);

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Segundos do cabeçalho Retry-After (429/503), se houver. */
  readonly retryAfterSeconds?: number;
  /** Correlação segura devolvida pela API (X-Request-Id) — pode ser mostrada discretamente. */
  readonly requestId?: string;
  /** Motivo de vocabulário fechado (só em `package_rejected`); nunca texto livre da API. */
  readonly reason?: string;

  constructor(code: ApiErrorCode, status: number, retryAfterSeconds?: number, requestId?: string, reason?: string) {
    // a mensagem é só o código: nunca payload, URL ou token
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.requestId = requestId;
    this.reason = reason;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Token sincronizador do contexto atual (pré-autenticação, desafio ou sessão). */
  csrf?: string;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

const REQUEST_ID = /^[0-9a-fA-F-]{8,64}$/;

export async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.csrf) headers['X-CSRF-Token'] = options.csrf;

  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError('network', 0);
  }

  const rawId = res.headers.get('X-Request-Id') ?? undefined;
  const requestId = rawId && REQUEST_ID.test(rawId) ? rawId : undefined;

  if (res.ok) {
    if (res.status === 204 || res.status === 202) return { status: res.status, data: undefined as T };
    try {
      return { status: res.status, data: (await res.json()) as T };
    } catch {
      throw new ApiError('unexpected', res.status, undefined, requestId);
    }
  }

  let code: ApiErrorCode = res.status >= 500 ? 'internal_error' : 'unexpected';
  let reason: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; reason?: unknown };
    if (typeof body?.error === 'string' && KNOWN.has(body.error)) code = body.error as ApiErrorCode;
    if (code === 'package_rejected' && typeof body.reason === 'string' && /^[a-z_]{1,64}$/.test(body.reason)) reason = body.reason;
  } catch {
    // gateway sem corpo JSON (ex.: 502 do proxy)
    if (res.status === 502 || res.status === 503 || res.status === 504) code = 'gateway';
  }
  const retry = Number(res.headers.get('Retry-After'));
  throw new ApiError(code, res.status, Number.isFinite(retry) && retry > 0 ? retry : undefined, requestId, reason);
}

export function isApiError(e: unknown, ...codes: ApiErrorCode[]): e is ApiError {
  return e instanceof ApiError && (codes.length === 0 || codes.includes(e.code));
}
