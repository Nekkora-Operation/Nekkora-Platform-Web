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
  | 'rate_limited'
  | 'internal_error'
  | 'service_unavailable'
  /** Sem resposta (rede, gateway fora). */
  | 'network'
  /** Resposta fora do contrato. */
  | 'unexpected';

const KNOWN: ReadonlySet<string> = new Set([
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'not_found',
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

  constructor(code: ApiErrorCode, status: number, retryAfterSeconds?: number, requestId?: string) {
    // a mensagem é só o código: nunca payload, URL ou token
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.requestId = requestId;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
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
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === 'string' && KNOWN.has(body.error)) code = body.error as ApiErrorCode;
  } catch {
    // gateway sem corpo JSON (ex.: 502 do proxy)
    if (res.status === 502 || res.status === 503 || res.status === 504) code = 'service_unavailable';
  }
  const retry = Number(res.headers.get('Retry-After'));
  throw new ApiError(code, res.status, Number.isFinite(retry) && retry > 0 ? retry : undefined, requestId);
}

export function isApiError(e: unknown, ...codes: ApiErrorCode[]): e is ApiError {
  return e instanceof ApiError && (codes.length === 0 || codes.includes(e.code));
}
