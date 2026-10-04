/**
 * F2: validação em execução das respostas (contrato da API v1). Os tipos gerados não validam nada em execução;
 * esta camada confere o que chega e recusa resposta fora do contrato sem expor valores.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import contract from './generated/nekkora-api-v1.schemas.json' with { type: 'json' };
import { ApiError } from './http';
import { getExecution, listExecutions, listWorkspaces } from './product';
import { getMyPermissions } from './permissions';
import { ContractViolation, isDateTime, readJson, validated, violations } from './validate';
import { ajvValidate } from '../test/ajvContract';
import * as fx from '../test/contractFixtures';

afterEach(() => vi.unstubAllGlobals());

const page = (items: unknown[]) => ({ items, nextCursor: null });

describe('validador', () => {
  it('aceita respostas conformes (inclusive nulos permitidos e oneOf com null)', () => {
    expect(violations('listWorkspaces', page([fx.workspace]))).toEqual([]);
    expect(violations('getWorkspace', { ...fx.workspace, client: { clientId: fx.IDS.org, name: 'ACME' } })).toEqual([]);
    expect(violations('getAutomation', { ...fx.automation, latestPublishedVersion: null })).toEqual([]);
    expect(violations('getExecution', fx.executionDetail)).toEqual([]);
    expect(violations('getExecution', { ...fx.executionDetail, requestedBy: { membershipId: fx.IDS.membership, displayName: 'Ana' } })).toEqual([]);
    expect(violations('getMyPermissions', fx.myPermissions)).toEqual([]);
    expect(violations('portalGetExecution', fx.portalExecution)).toEqual([]);
  });

  it('acusa cada tipo de violação com caminho e regra', () => {
    const bad = (op: Parameters<typeof violations>[0], data: unknown) => violations(op, data).map((v) => `${v.path} ${v.rule}`);
    const { name: _n, ...semNome } = fx.workspace;
    expect(bad('getWorkspace', semNome)).toEqual(['$ required name']);
    expect(bad('getWorkspace', { ...fx.workspace, status: 'deleted' })).toEqual(['$.status enum']);
    expect(bad('getWorkspace', { ...fx.workspace, workspaceId: 'w1' })).toEqual(['$.workspaceId format uuid']);
    expect(bad('getWorkspace', { ...fx.workspace, createdAt: '2026-10-01T00:00:00' })).toEqual(['$.createdAt format date-time']);
    expect(bad('getWorkspace', { ...fx.workspace, name: null })).toEqual(['$.name type string']);
    expect(bad('getWorkspace', { ...fx.workspace, client: { clientId: fx.IDS.org } })).toEqual(['$.client oneOf (nenhum)']);
    expect(bad('listExecutions', { items: [{ ...fx.execution, durationMs: -1 }], nextCursor: null })).toEqual(['$.items[0].durationMs minimum']);
    expect(bad('listExecutions', { items: [] })).toEqual(['$ required nextCursor']);
    expect(bad('listExecutions', { items: [], nextCursor: 7 })).toEqual(['$.nextCursor type string|null']);
    expect(bad('getMyPermissions', { ...fx.myPermissions, organization: { roles: ['ORG_ADMIN', 'ORG_ADMIN'], permissions: [] } })).toEqual([
      '$.organization.roles uniqueItems',
    ]);
    expect(bad('getMyPermissions', { ...fx.myPermissions, allWorkspaces: { permissions: ['org.manage'] } })).toEqual([
      '$.allWorkspaces.permissions[0] enum',
    ]);
    expect(bad('getExecution', { ...fx.execution })).toEqual(['$ required retryOfExecutionId', '$ required requestedBy']);
    expect(bad('listWorkspaces', [])).toEqual(['$ type object']);
  });

  it('modo normal tolera campo novo; modo estrito o acusa (também em allOf e em objeto aninhado)', () => {
    expect(violations('getWorkspace', { ...fx.workspace, novo: 1 })).toEqual([]);
    expect(violations('getWorkspace', { ...fx.workspace, novo: 1 }, { strict: true })).toEqual([{ path: '$', rule: 'additionalProperties novo' }]);
    expect(violations('getExecution', { ...fx.executionDetail, errorSummary: 'x' }, { strict: true })).toEqual([
      { path: '$', rule: 'additionalProperties errorSummary' },
    ]);
    expect(violations('getExecution', { ...fx.executionDetail, automation: { ...fx.execution.automation, commandJson: '{}' } }, { strict: true })).toEqual([
      { path: '$.automation', rule: 'additionalProperties commandJson' },
    ]);
    expect(violations('getExecution', fx.executionDetail, { strict: true })).toEqual([]);
  });

  it('todos os esquemas usam só palavras-chave que o validador implementa', () => {
    const supported = new Set(['type', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems',
      'uniqueItems', 'minimum', 'minLength', 'maxLength', 'pattern', 'format', '$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'default']);
    const found = new Set<string>();
    const walk = (s: unknown) => {
      if (Array.isArray(s)) return s.forEach(walk);
      if (!s || typeof s !== 'object') return;
      for (const [k, v] of Object.entries(s)) {
        found.add(k);
        if (k === 'properties') Object.values(v as object).forEach(walk);
        else if (typeof v === 'object') walk(v);
      }
    };
    walk(Object.values(contract.schemas));
    walk(Object.values(contract.operations).flatMap((o) => Object.values(o.responses).map((r) => r.schema)));
    expect([...found].filter((k) => !supported.has(k))).toEqual([]);
    expect(Object.keys(contract.operations)).toHaveLength(38); // todas as operações do OpenAPI (GET e POST)
  });

  it('validated: erro "unexpected" que leva só caminhos e regras, nunca valores', () => {
    const secret = 'valor-que-nao-pode-vazar';
    try {
      validated('getWorkspace', { ...fx.workspace, name: 42, workspaceId: secret });
      throw new Error('deveria falhar');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractViolation);
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ContractViolation;
      expect(err.code).toBe('unexpected');
      expect(err.message).toBe('unexpected');
      expect(err.operationId).toBe('getWorkspace');
      expect(JSON.stringify(err.violations)).not.toContain(secret);
      expect(err.violations.map((v) => v.path).sort()).toEqual(['$.name', '$.workspaceId']);
    }
  });
});

describe('date-time: calendário real, igual ao Ajv (ajv-formats 3.0.1)', () => {
  const VALID = [
    '2024-02-29T00:00:00Z', // bissexto
    '2000-02-29T12:00:00Z', // divisível por 400
    '2026-10-03T12:00:00.123456789Z',
    '2026-10-03T12:00:00-03:00',
    '2016-12-31T23:59:60Z', // segundo bissexto às 23:59 UTC
    '2016-12-31T20:59:60-03:00', // idem, com fuso
    '2026-10-03t12:00:00z', // minúsculas (RFC 3339)
  ];
  const INVALID = [
    '2026-02-30T00:00:00Z', // caso da revisão: Date.parse normaliza para 02/03
    '2026-04-31T00:00:00Z', // caso da revisão: abril tem 30 dias
    '2026-02-29T00:00:00Z', // não bissexto
    '1900-02-29T00:00:00Z', // divisível por 100 e não por 400
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-10-00T00:00:00Z',
    '2026-10-03T24:00:00Z',
    '2026-10-03T12:60:00Z',
    '2026-10-03T12:00:60Z', // segundo 60 fora de 23:59 UTC
    '2026-10-03T12:00:00+24:00',
    '2026-10-03T12:00:00', // sem fuso
    '2026-10-03T12:00Z', // sem segundos
    '2026-10-03',
  ];

  it('as duas datas da revisão passavam com Date.parse (registro do defeito) e agora são recusadas', () => {
    expect(Number.isNaN(Date.parse('2026-02-30T00:00:00Z'))).toBe(false);
    expect(Number.isNaN(Date.parse('2026-04-31T00:00:00Z'))).toBe(false);
    expect(isDateTime('2026-02-30T00:00:00Z')).toBe(false);
    expect(isDateTime('2026-04-31T00:00:00Z')).toBe(false);
  });

  it('cada caso: o validador do cliente e o Ajv dão o mesmo veredito, e o esperado', () => {
    for (const [value, expected] of [...VALID.map((v) => [v, true] as const), ...INVALID.map((v) => [v, false] as const)]) {
      const body = { ...fx.workspace, createdAt: value };
      const own = violations('getWorkspace', body).length === 0;
      const ajv = ajvValidate('getWorkspace', 200, body).valid;
      expect([value, own], 'cliente').toEqual([value, expected]);
      expect([value, ajv], 'Ajv').toEqual([value, expected]);
    }
  });

  it('pela chamada pública: data inválida numa resposta recebida vira erro de contrato', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(page([{ ...fx.workspace, updatedAt: '2026-04-31T00:00:00Z' }])), { status: 200 })));
    await expect(listWorkspaces(fx.IDS.org)).rejects.toMatchObject({ code: 'unexpected', violations: [{ path: '$.items[0].updatedAt', rule: 'format date-time' }] });
  });
});

describe('status recebido define o esquema', () => {
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })));

  it('sucesso não documentado (201 com corpo válido, 204 sem corpo) vira erro de protocolo, sem dados tipados', async () => {
    respond(201, page([fx.workspace]));
    await expect(listWorkspaces(fx.IDS.org)).rejects.toMatchObject({ code: 'unexpected', status: 201, violations: [{ path: '$', rule: 'status 201 não documentado' }] });
    respond(204, undefined);
    await expect(getExecution(fx.IDS.org, fx.IDS.execution)).rejects.toMatchObject({ code: 'unexpected', status: 204 });
    respond(200, page([fx.workspace])); // controle positivo
    expect((await listWorkspaces(fx.IDS.org)).items).toHaveLength(1);
  });

  it('validated encaminha o status ao validador', () => {
    expect(() => validated('listWorkspaces', page([fx.workspace]), 201)).toThrow(ContractViolation);
    expect(validated('listWorkspaces', page([fx.workspace]), 200)).toEqual(page([fx.workspace]));
  });
});

describe('cliente com validação em execução', () => {
  const respond = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));

  it('resposta conforme passa; fora do contrato vira ApiError("unexpected")', async () => {
    respond(page([fx.workspace]));
    expect((await listWorkspaces(fx.IDS.org)).items).toHaveLength(1);
    respond(page([{ ...fx.workspace, status: 'deleted' }]));
    await expect(listWorkspaces(fx.IDS.org)).rejects.toMatchObject({ code: 'unexpected', status: 200 });
    respond({ ...fx.executionDetail, requestedBy: undefined });
    await expect(getExecution(fx.IDS.org, fx.IDS.execution)).rejects.toBeInstanceOf(ContractViolation);
    respond({ ...fx.myPermissions, hasWorkspaceAssignments: 'sim' });
    await expect(getMyPermissions(fx.IDS.org)).rejects.toMatchObject({ code: 'unexpected' });
  });

  it('erros HTTP continuam como antes (não passam pela validação de sucesso)', async () => {
    respond({ error: 'not_found' }, 404);
    await expect(getExecution(fx.IDS.org, fx.IDS.execution)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    respond({ error: 'invalid_request' }, 400);
    await expect(listExecutions(fx.IDS.org, { cursor: 'a.b' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('readJson recusa operação desconhecida (erro de programação, não de contrato)', async () => {
    respond({});
    await expect(readJson('naoExiste' as never, '/x')).rejects.toThrow('operação sem esquema');
  });
});
