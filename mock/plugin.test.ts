// @vitest-environment node
/**
 * Seletor de falhas do painel /__mock/ exercitado pelo caminho real (middleware do plugin, HTTP de verdade numa porta
 * efêmera de 127.0.0.1): a falha simulada só aparece nas operações que documentam o status; nas demais a chamada segue
 * normal. Toda resposta é conferida contra o contrato (status documentado, content-type e corpo).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { responseViolations } from '../src/api/validate';
import { DEV_ORG, MockApi, operationFor, simulatedFailureStatus } from './contract';
import { mockMiddleware } from './plugin';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
let api: MockApi;
let server: Server;
let base = '';
let session = '';

beforeAll(async () => {
  api = new MockApi(() => NOW);
  const handler = mockMiddleware(api, 0);
  server = createServer((req, res) => handler(req as never, res as never, () => {
    res.statusCode = 404;
    res.end();
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ana = [...api.accounts.values()].find((a) => a.email === 'ana@nekkora.dev')!;
  session = api.openSession(ana.userId);
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function selectFailure(failure: string) {
  const res = await fetch(`${base}/__mock/failure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ failure }) });
  expect(res.status).toBe(200);
}

async function call(method: 'GET' | 'POST', path: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Cookie: `__Host-nekkora_session=${session}`, Origin: base, 'Content-Type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  const op = operationFor(method, path)!;
  expect(op, path).toBeDefined();
  expect(responseViolations(op.operationId as never, { status: res.status, contentType: res.headers.get('content-type'), body }), `${method} ${path} ${res.status}`).toEqual([]);
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

const READS = ['/me/permissions', '/me/permissions/workspaces', '/workspaces', '/executions'].map((r) => `/api/v1/o/${DEV_ORG}${r}`);

describe('seletor de falhas real (POST /__mock/failure)', () => {
  it('503 selecionado: leituras do produto e /me seguem normais (503 não documentado); login e /api/v1/csrf respondem 503', async () => {
    await selectFailure('service_unavailable');
    for (const path of READS) expect((await call('GET', path)).status, path).toBe(200);
    expect((await call('GET', `/api/v1/o/${DEV_ORG}/me`)).status).toBe(200);
    expect((await call('GET', `/api/v1/o/${DEV_ORG}/auth/csrf`)).status).toBe(200);
    expect(await call('POST', `/api/v1/o/${DEV_ORG}/auth/login`)).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
    expect((await call('GET', '/api/v1/csrf')).status).toBe(503);
    await selectFailure('none');
  });

  it('429 e 500 selecionados: valem nas leituras do produto, onde são documentados', async () => {
    await selectFailure('rate_limited');
    for (const path of READS) {
      const r = await call('GET', path);
      expect(r, path).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
      expect(r.retryAfter).toBe('120');
    }
    await selectFailure('internal_error');
    for (const path of READS) expect(await call('GET', path), path).toMatchObject({ status: 500, body: { error: 'internal_error' } });
    // /me não documenta 500: segue normal
    expect((await call('GET', `/api/v1/o/${DEV_ORG}/me`)).status).toBe(200);
    await selectFailure('none');
  });

  it('sem falha selecionada: controle positivo (tudo 200)', async () => {
    await selectFailure('none');
    for (const path of READS) expect((await call('GET', path)).status).toBe(200);
  });
});

describe('regra derivada do contrato', () => {
  it('nenhuma das 10 leituras novas pode receber 503; todas podem receber 429 e 500', () => {
    for (const route of ['/me/permissions', '/me/permissions/workspaces', '/workspaces', '/workspaces/x', '/workspaces/x/automations', '/automations/x', '/automations/x/versions', '/executions', '/executions/x', '/executions/x/events']) {
      const path = `/api/v1/o/${DEV_ORG}${route}`;
      expect(simulatedFailureStatus('service_unavailable', 'GET', path), route).toBeUndefined();
      expect(simulatedFailureStatus('rate_limited', 'GET', path), route).toBe(429);
      expect(simulatedFailureStatus('internal_error', 'GET', path), route).toBe(500);
    }
    expect(simulatedFailureStatus('service_unavailable', 'GET', `/api/v1/o/${DEV_ORG}/nao-existe`)).toBeUndefined();
  });
});
