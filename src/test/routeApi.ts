/**
 * Respostas por rota para testes de componente (ISOLADOS, identificados como tais): cada resposta 2xx e cada corpo de
 * erro é conferido contra o contrato (operationId/status, modo estrito) antes de chegar à tela — a fixture não pode
 * divergir da API. A prova de comportamento real fica nos E2E contra o laboratório (e2e-real/).
 */
import { vi } from 'vitest';
import { responseViolations, type OperationId } from '../api/validate';

export interface Call {
  method: string;
  path: string;
  body?: unknown;
  csrf?: string;
}

export type Reply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | 'network'
  /** Fica pendente até `release()` (testa corridas e resposta atrasada). */
  | { hold: Promise<{ status: number; body?: unknown }> };

type Handler = (call: Call, n: number) => Reply;

interface Route {
  method: string;
  path: string | RegExp;
  operationId: OperationId;
  handler: Handler;
  count: number;
}

export class RouteApi {
  calls: Call[] = [];
  private routes: Route[] = [];

  on(method: string, path: string | RegExp, operationId: OperationId, handler: Handler | Reply) {
    this.routes.unshift({ method, path, operationId, handler: typeof handler === 'function' ? handler : () => handler, count: 0 });
    return this;
  }

  install() {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => this.handle(String(input), init)));
    return this;
  }

  sent(method: string, path: string | RegExp) {
    return this.calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)));
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const path = url.split('?')[0];
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const call: Call = {
      method,
      path,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      csrf: headers.get('X-CSRF-Token') ?? undefined,
    };
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)));
    if (!route) throw new Error(`rota não preparada no teste: ${method} ${path}`);
    let reply = route.handler(call, route.count++);
    if (reply === 'network') throw new TypeError('Failed to fetch');
    if ('hold' in reply) reply = await reply.hold;
    const { status, body } = reply;
    const json = body === undefined ? null : JSON.stringify(body);
    const contentType = json === null ? null : 'application/json';
    const list = responseViolations(route.operationId, { status, contentType, body }, { strict: true });
    if (list.length) throw new Error(`fixture fora do contrato (${route.operationId} ${status}): ${JSON.stringify(list)}`);
    return new Response(json, {
      status,
      headers: { ...(contentType ? { 'Content-Type': contentType } : {}), ...(('headers' in reply && reply.headers) || {}) },
    });
  }
}
