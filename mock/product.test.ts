/**
 * F2: a API simulada de permissões e produto confere com o contrato e com as regras do backend.
 *
 * TODA resposta obtida nestes testes (sucesso e erro) é conferida pelo par operationId/status/content-type com DOIS
 * validadores que precisam concordar: o próprio do cliente (src/api/validate.ts, modo estrito) e o Ajv 2020-12
 * (src/test/ajvContract.ts, modo estrito por unevaluatedProperties). Relógio fixo: a massa não envelhece.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { responseViolations, type OperationId } from '../src/api/validate';
import { ajvValidate } from '../src/test/ajvContract';
import { DEV_ORG, MockApi, OTHER_ORG } from './contract';
import { stableUuid } from './product';

/** 2026-10-03T12:00:00Z: todos os horários da massa são relativos a este instante. */
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 86_400_000;

let api: MockApi;
const cookie: Record<string, string> = {};
const ws = (k: string) => stableUuid(`dev:ws:${k}`);
const auto = (k: string) => stableUuid(`dev:auto:${k}`);
const membership = (email: string) => [...api.accounts.values()].find((a) => a.email === email)!.membershipId;

const OPS: [RegExp, OperationId][] = [
  [/^\/me\/permissions$/, 'getMyPermissions'],
  [/^\/me\/permissions\/workspaces$/, 'listMyWorkspacePermissions'],
  [/^\/workspaces$/, 'listWorkspaces'],
  [/^\/workspaces\/[^/]+$/, 'getWorkspace'],
  [/^\/workspaces\/[^/]+\/automations$/, 'listAutomations'],
  [/^\/automations\/[^/]+$/, 'getAutomation'],
  [/^\/automations\/[^/]+\/versions$/, 'listAutomationVersions'],
  [/^\/executions$/, 'listExecutions'],
  [/^\/executions\/[^/]+$/, 'getExecution'],
  [/^\/executions\/[^/]+\/events$/, 'listExecutionEvents'],
];
const opFor = (route: string) => OPS.find(([re]) => re.test(route))![1];
let checked = 0;

function session(email: string) {
  const a = [...api.accounts.values()].find((x) => x.email === email)!;
  return api.openSession(a.userId);
}

/** GET na API simulada; a resposta é SEMPRE conferida contra o contrato pelos dois validadores. */
function get(who: string | null, path: string, org = DEV_ORG) {
  const [p, qs] = path.split('?');
  const res = api.handle({
    method: 'GET',
    path: `/api/v1/o/${org}${p}`,
    expectedOrigin: 'http://localhost',
    cookies: who ? { '__Host-nekkora_session': cookie[who] } : {},
    body: undefined,
    query: new URLSearchParams(qs ?? ''),
  });
  const op = opFor(p);
  const own = responseViolations(op, { status: res.status, contentType: res.headers['Content-Type'], body: res.body });
  const ajv = ajvValidate(op, res.status, res.body);
  expect(own, `${op} ${res.status} ${path} (validador do cliente)`).toEqual([]);
  expect(ajv.errors, `${op} ${res.status} ${path} (Ajv)`).toEqual([]);
  checked++;
  return { status: res.status, body: res.body as any };
}

function ok(who: string, path: string, org = DEV_ORG) {
  const r = get(who, path, org);
  expect(r.status, path).toBe(200);
  return r.body;
}

/** Percorre todas as páginas com `limit`. */
function all(who: string, path: string, limit: number, org = DEV_ORG) {
  const out: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const body = ok(who, `${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, org);
    expect(body.items.length).toBeLessThanOrEqual(limit);
    out.push(...body.items);
    cursor = body.nextCursor;
    expect(++pages).toBeLessThan(500);
  } while (cursor);
  return out;
}

const ERROR = (code: string) => ({ error: code });

beforeEach(() => {
  api = new MockApi(() => NOW);
  for (const [k, email] of Object.entries({
    admin: 'ana@nekkora.dev',
    gestora: 'gestora@nekkora.dev',
    operador: 'operador@nekkora.dev',
    leitora: 'leitora@nekkora.dev',
    sem: 'sematribuicao@nekkora.dev',
    portal: 'portal@nekkora.dev',
    vizinha: 'vizinha@nekkora.dev',
  })) {
    cookie[k] = session(email);
  }
});

describe('contrato: todas as rotas, papéis e organizações', () => {
  it('percorre as dez operações para cada perfil (incluindo a organização vizinha)', () => {
    const before = checked;
    for (const [who, org] of [['admin', DEV_ORG], ['gestora', DEV_ORG], ['operador', DEV_ORG], ['leitora', DEV_ORG], ['sem', DEV_ORG], ['vizinha', OTHER_ORG]]) {
      ok(who, '/me/permissions', org);
      all(who, '/me/permissions/workspaces', 1, org);
      for (const w of all(who, '/workspaces', 3, org)) {
        ok(who, `/workspaces/${w.workspaceId}`, org);
        for (const a of all(who, `/workspaces/${w.workspaceId}/automations`, 2, org)) {
          ok(who, `/automations/${a.automationId}`, org);
          all(who, `/automations/${a.automationId}/versions`, 2, org);
        }
      }
      for (const e of all(who, '/executions', 100, org)) {
        ok(who, `/executions/${e.executionId}`, org);
        all(who, `/executions/${e.executionId}/events`, 1, org);
      }
    }
    expect(checked - before).toBeGreaterThan(500);
  });

  it('massa cobre os estados, origens, nulos e reexecução previstos (controle positivo das negativas)', () => {
    const ex = all('admin', '/executions', 100);
    expect(new Set(ex.map((e) => e.status))).toEqual(new Set(['pending', 'starting', 'running', 'succeeded', 'failed', 'cancelled']));
    expect(new Set(ex.map((e) => e.statusReason))).toEqual(
      new Set([null, 'process_completed', 'process_failed', 'start_failed', 'cancel_confirmed', 'cancelled_before_dispatch', 'queue_deadline_exceeded']),
    );
    expect(new Set(ex.map((e) => e.origin))).toEqual(new Set(['manual', 'scheduled']));
    const details = ex.map((e) => ok('admin', `/executions/${e.executionId}`));
    expect(details.some((d) => d.requestedBy === null)).toBe(true);
    expect(details.some((d) => d.requestedBy !== null)).toBe(true);
    expect(details.some((d) => d.retryOfExecutionId !== null)).toBe(true);
    expect(ex.filter((e) => e.createdAt >= new Date(NOW - 30 * DAY).toISOString()).length).toBeGreaterThan(10);
    expect(ex.filter((e) => e.createdAt < new Date(NOW - 30 * DAY).toISOString()).length).toBeGreaterThan(10);
    expect(ex.length).toBeLessThan(400); // massa pequena
  });
});

describe('controles negativos: os dois validadores recusam respostas adulteradas do próprio mock', () => {
  const mutate = (op: OperationId, body: any) => ({
    own: responseViolations(op, { status: 200, contentType: 'application/json', body }).map((v) => v.rule.split(' ')[0]),
    ajv: ajvValidate(op, 200, body).valid,
  });

  it('obrigatório ausente, tipo errado, enum desconhecido, nulo indevido, campo proibido, data inválida', () => {
    const e = ok('admin', `/executions/${all('admin', '/executions', 100).find((x) => x.status === 'succeeded')!.executionId}`);
    const { durationMs: _d, ...semDuracao } = e;
    const cases: [string, any][] = [
      ['required', semDuracao],
      ['type', { ...e, durationMs: '60000' }],
      ['enum', { ...e, status: 'finished' }],
      ['type', { ...e, createdAt: null }],
      ['additionalProperties', { ...e, errorSummary: 'stack trace' }],
      ['additionalProperties', { ...e, automation: { ...e.automation, commandJson: '{}' } }],
      ['format', { ...e, startedAt: '2026-10-03T12:00:00' }],
      ['format', { ...e, createdAt: '2026-02-30T00:00:00Z' }], // dia inexistente (Date.parse aceitaria)
      ['format', { ...e, finishedAt: '2026-04-31T00:00:00Z' }], // abril tem 30 dias
      ['format', { ...e, executionId: 'nao-e-uuid' }],
      ['minimum', { ...e, durationMs: -1 }],
      ['oneOf', { ...e, requestedBy: { displayName: 'sem id' } }],
    ];
    for (const [rule, body] of cases) {
      const r = mutate('getExecution', body);
      expect(r.own, rule).toContain(rule);
      expect(r.ajv, rule).toBe(false);
    }
    // controle positivo: o original passa nos dois
    expect(mutate('getExecution', e)).toEqual({ own: [], ajv: true });
  });

  it('página: nextCursor ausente/numérico, items não lista, permissão fora do catálogo', () => {
    const p = ok('admin', '/workspaces?limit=2');
    expect(mutate('listWorkspaces', { items: p.items }).own).toContain('required');
    expect(mutate('listWorkspaces', { ...p, nextCursor: 3 }).ajv).toBe(false);
    expect(mutate('listWorkspaces', { ...p, items: {} }).own).toContain('type');
    const me = ok('admin', '/me/permissions');
    const bad = { ...me, organization: { ...me.organization, permissions: [...me.organization.permissions, 'super.admin'] } };
    expect(mutate('getMyPermissions', bad).own.length).toBeGreaterThan(0);
    expect(mutate('getMyPermissions', bad).ajv).toBe(false);
  });

  it('status não documentado e content-type errado', () => {
    expect(responseViolations('listWorkspaces', { status: 404, contentType: 'application/json', body: ERROR('not_found') })).toEqual([
      { path: '$', rule: 'status 404 não documentado' },
    ]);
    expect(responseViolations('getWorkspace', { status: 404, contentType: 'text/html', body: ERROR('not_found') })[0].rule).toMatch(/^content-type/);
    expect(responseViolations('getWorkspace', { status: 404, contentType: 'application/json', body: ERROR('nao_achei') })[0].rule).toBe('enum');
  });
});

describe('permissões por papel (migrations 003/004/005/008/009/014)', () => {
  it('ORG_ADMIN: 23 organizacionais, 13 em todos os workspaces, P02 vazia (P02 não lista os workspaces visíveis)', () => {
    const me = ok('admin', '/me/permissions');
    expect(me.organization.roles).toEqual(['ORG_ADMIN']);
    expect(me.organization.permissions).toHaveLength(23);
    expect(me.allWorkspaces.permissions).toHaveLength(13);
    expect(me.hasWorkspaceAssignments).toBe(false);
    expect(ok('admin', '/me/permissions/workspaces').items).toEqual([]);
    expect(all('admin', '/workspaces', 100).length).toBeGreaterThan(0);
  });

  it('papéis de workspace: só P02, com as permissões de cada papel', () => {
    const me = ok('gestora', '/me/permissions');
    expect(me.organization).toEqual({ roles: [], permissions: [] });
    expect(me.allWorkspaces.permissions).toEqual([]);
    expect(me.hasWorkspaceAssignments).toBe(true);
    const p02 = all('gestora', '/me/permissions/workspaces', 1);
    const byWs = Object.fromEntries(p02.map((x) => [x.workspaceId, x]));
    expect(byWs[ws('financeiro')].roles).toEqual(['WORKSPACE_ADMIN']);
    expect(byWs[ws('financeiro')].permissions).toHaveLength(13);
    expect(byWs[ws('operacoes')]).toEqual({ workspaceId: ws('operacoes'), roles: ['OPERATOR'], permissions: ['automation.execute', 'automation.read', 'logs.read'] });
    expect(p02.map((x) => x.workspaceId)).toEqual([...p02.map((x) => x.workspaceId)].sort());
    expect(ok('leitora', '/me/permissions/workspaces').items.every((x: any) => x.roles.join() === 'VIEWER' && x.permissions.join() === 'automation.read')).toBe(true);
  });

  it('sem atribuições: tudo vazio e listas 200 vazias (não 403)', () => {
    expect(ok('sem', '/me/permissions')).toMatchObject({ organization: { roles: [], permissions: [] }, allWorkspaces: { permissions: [] }, hasWorkspaceAssignments: false });
    expect(ok('sem', '/workspaces').items).toEqual([]);
    expect(ok('sem', '/executions').items).toEqual([]);
  });
});

describe('visibilidade, isolamento e revogação', () => {
  it('cada papel vê só os workspaces com automation.read efetivo, qualquer que seja o status', () => {
    const ids = (who: string) => all(who, '/workspaces', 100).map((w) => w.workspaceId).sort();
    expect(ids('admin')).toHaveLength(9);
    expect(ids('gestora')).toEqual([ws('financeiro'), ws('operacoes')].sort());
    expect(ids('operador')).toEqual([ws('operacoes'), ws('logistica')].sort());
    expect(ids('leitora')).toEqual([ws('atendimento'), ws('legado')].sort()); // legado está arquivado
    const leitoraExec = all('leitora', '/executions', 100);
    expect(leitoraExec.length).toBeGreaterThan(0);
    expect(new Set(leitoraExec.map((e) => e.workspaceId))).toEqual(new Set([ws('atendimento'), ws('legado')]));
    expect(ok('admin', `/workspaces/${ws('vazio')}/automations`).items).toEqual([]); // workspace vazio
  });

  it('sem acesso, inexistente ou de outra organização: o mesmo 404 (com controle positivo de existência)', () => {
    const other = [...api.product.workspaces.values()].find((w) => w.org === OTHER_ORG)!;
    const exec = [...api.product.executions.values()].find((e) => e.workspaceId === ws('financeiro'))!;
    const paths = [
      `/workspaces/${ws('financeiro')}`,
      `/workspaces/${stableUuid('inexistente')}`,
      `/workspaces/${other.workspaceId}`,
      `/automations/${auto('conciliacao')}`,
      `/automations/${auto('conciliacao')}/versions`,
      `/workspaces/${ws('financeiro')}/automations`,
      `/executions?workspaceId=${ws('financeiro')}`,
      `/executions?automationId=${auto('conciliacao')}`,
      `/executions/${exec.executionId}`,
      `/executions/${exec.executionId}/events`,
    ];
    for (const path of paths) expect(get('operador', path), path).toEqual({ status: 404, body: ERROR('not_found') });
    // controle positivo: os recursos existem e a gestora (com acesso) os vê
    for (const path of paths.filter((p) => !p.includes(stableUuid('inexistente')) && !p.includes(other.workspaceId))) {
      expect(get('gestora', path).status, path).toBe(200);
    }
  });

  it('isolamento: sessão de uma organização não vale na outra; ids da outra organização → 404', () => {
    expect(get('admin', '/workspaces', OTHER_ORG).status).toBe(401);
    const vizinhas = ok('vizinha', '/workspaces', OTHER_ORG).items;
    expect(vizinhas.length).toBeGreaterThan(0);
    const dev = all('admin', '/workspaces', 100).map((w) => w.workspaceId);
    expect(vizinhas.some((w: any) => dev.includes(w.workspaceId))).toBe(false);
    expect(get('vizinha', `/workspaces/${ws('financeiro')}`, OTHER_ORG).status).toBe(404);
    expect(get('admin', `/workspaces/${vizinhas[0].workspaceId}`).status).toBe(404);
  });

  it('autorização é recalculada a cada página: perder o acesso entre páginas tira os itens da página seguinte', () => {
    const p1 = ok('operador', '/executions?limit=5');
    const all1 = all('operador', '/executions', 100);
    expect(all1.some((e) => e.workspaceId === ws('logistica'))).toBe(true); // controle positivo
    api.product.revokeWorkspaceRole(membership('operador@nekkora.dev'), ws('logistica'));
    const rest = all('operador', `/executions?cursor=${p1.nextCursor}`, 100);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.some((e) => e.workspaceId === ws('logistica'))).toBe(false);
    expect(get('operador', `/workspaces/${ws('logistica')}`).status).toBe(404);
    expect(get('operador', `/executions/${all1.find((e) => e.workspaceId === ws('logistica'))!.executionId}`).status).toBe(404);
  });

  it('revogação de ORG_ADMIN entre páginas: a página seguinte fica vazia (sem acesso) e P01 reflete', () => {
    const p1 = ok('admin', '/workspaces?limit=2');
    api.product.revokeOrganizationRoles(membership('ana@nekkora.dev'));
    expect(ok('admin', `/workspaces?limit=2&cursor=${p1.nextCursor}`)).toEqual({ items: [], nextCursor: null });
    expect(ok('admin', '/me/permissions').organization.roles).toEqual([]);
  });
});

describe('ordem 401 → 400 → 403 → 404', () => {
  it('sem sessão: 401 mesmo com parâmetro inválido; org malformada: 401', () => {
    expect(get(null, '/workspaces?limit=0').status).toBe(401);
    expect(get('admin', '/workspaces', 'nao-e-uuid').status).toBe(401);
  });

  it('conta externa: 400 se o parâmetro é inválido, senão 403 (inclusive em recurso inexistente)', () => {
    expect(get('portal', '/workspaces?limit=101').status).toBe(400);
    expect(get('portal', '/workspaces/nao-e-uuid').status).toBe(400);
    for (const p of ['/me/permissions', '/me/permissions/workspaces', '/workspaces', `/workspaces/${stableUuid('x')}`, '/executions']) {
      expect(get('portal', p), p).toEqual({ status: 403, body: ERROR('forbidden') });
    }
  });

  it('interna: parâmetro inválido antes do 404', () => {
    expect(get('operador', `/workspaces/${ws('financeiro')}/automations?limit=abc`).status).toBe(400);
    expect(get('operador', `/workspaces/${ws('financeiro')}/automations`).status).toBe(404);
  });
});

describe('parâmetros', () => {
  it('limit: 1–100 inteiro; padrão 25', () => {
    expect(ok('admin', '/executions').items).toHaveLength(25);
    expect(ok('admin', '/executions?limit=100').items).toHaveLength(100);
    for (const bad of ['0', '101', '-1', '1.5', 'abc', '']) expect(get('admin', `/executions?limit=${bad}`).status, bad).toBe(400);
  });

  it('status: valores do catálogo, sem repetição, até o máximo da rota', () => {
    const items = all('admin', '/executions?status=failed&status=cancelled', 100);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((e) => e.status === 'failed' || e.status === 'cancelled')).toBe(true);
    expect(get('admin', '/executions?status=failed&status=failed').status).toBe(400);
    expect(get('admin', '/executions?status=FAILED').status).toBe(400);
    expect(get('admin', '/executions?status=').status).toBe(400);
    expect(get('admin', '/workspaces?status=active&status=suspended&status=archived').status).toBe(200);
    expect(ok('admin', '/workspaces?status=archived').items.map((w: any) => w.name)).toEqual(['Integrações legadas']);
  });

  it('UUID malformado em caminho ou filtro → 400', () => {
    expect(get('admin', '/executions/123').status).toBe(400);
    expect(get('admin', '/executions?workspaceId=abc').status).toBe(400);
    expect(get('admin', '/automations/xyz/versions').status).toBe(400);
  });

  it('período [from, to): limites exatos, vazio, inválidos e máximo de 366 dias', () => {
    const to = new Date(NOW).toISOString();
    const from = new Date(NOW - 30 * DAY).toISOString();
    const last30 = all('admin', `/executions?from=${from}&to=${to}`, 100);
    const total = all('admin', '/executions', 100);
    expect(last30.every((e) => e.createdAt >= from && e.createdAt < to)).toBe(true);
    expect(last30.length).toBe(total.filter((e) => e.createdAt >= from && e.createdAt < to).length);
    expect(last30.length).toBeLessThan(total.length);

    // limite exato: from inclusivo, to exclusivo (usa o createdAt de uma execução real)
    const pivot = total[10].createdAt;
    expect(all('admin', `/executions?from=${pivot}`, 100).some((e) => e.createdAt === pivot)).toBe(true);
    expect(all('admin', `/executions?to=${pivot}`, 100).some((e) => e.createdAt === pivot)).toBe(false);

    expect(get('admin', `/executions?from=${to}&to=${from}`).status).toBe(400); // to < from
    expect(ok('admin', `/executions?from=${to}&to=${to}`).items).toEqual([]); // to = from
    const d366 = new Date(NOW - 366 * DAY).toISOString();
    const d366plus = new Date(NOW - 366 * DAY - 1).toISOString();
    expect(get('admin', `/executions?from=${d366}&to=${to}`).status).toBe(200);
    expect(get('admin', `/executions?from=${d366plus}&to=${to}`).status).toBe(400);
    expect(get('admin', '/executions?from=2026-10-01T00:00:00').status).toBe(400); // sem fuso
    expect(get('admin', '/executions?from=2026-02-30T00:00:00Z').status).toBe(400);
    expect(get('admin', `/executions?from=${encodeURIComponent('2026-10-01T00:00-03:00')}`).status).toBe(200);
  });

  it('workspaceId e automationId acessíveis mas incompatíveis → lista vazia', () => {
    expect(ok('admin', `/executions?workspaceId=${ws('logistica')}&automationId=${auto('conciliacao')}`).items).toEqual([]);
    const only = all('admin', `/executions?automationId=${auto('rastreio')}`, 100);
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((e) => e.automation.automationId === auto('rastreio'))).toBe(true);
  });
});

describe('paginação e ordenação', () => {
  it('percorrer com qualquer limit dá a mesma lista completa, sem repetição', () => {
    const full = all('admin', '/executions', 100).map((e) => e.executionId);
    expect(new Set(full).size).toBe(full.length);
    expect(all('admin', '/executions', 7).map((e) => e.executionId)).toEqual(full);
    const wsFull = all('admin', '/workspaces', 100).map((w) => w.workspaceId);
    for (const l of [1, 2, 4]) expect(all('admin', '/workspaces', l).map((w) => w.workspaceId)).toEqual(wsFull);
  });

  it('nextCursor nulo na última página e limit pode mudar entre páginas', () => {
    const p1 = ok('admin', '/executions?limit=5');
    const p2 = ok('admin', `/executions?limit=50&cursor=${p1.nextCursor}`);
    expect(p2.items).toHaveLength(50);
    expect(p2.items[0].executionId).not.toBe(p1.items[4].executionId);
    expect(ok('admin', '/workspaces?limit=100').nextCursor).toBeNull();
  });

  it('execuções: createdAt desc e id desc (empates exatos atravessando páginas de 1)', () => {
    const ex = all('admin', '/executions', 1);
    for (let i = 1; i < ex.length; i++) {
      const [a, b] = [ex[i - 1], ex[i]];
      expect(a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.executionId > b.executionId), `${i}`).toBe(true);
    }
    const tie = new Date(NOW - 2 * DAY).toISOString();
    const tied = ex.filter((e) => e.createdAt === tie).map((e) => e.executionId);
    expect(tied).toHaveLength(4);
    expect(tied).toEqual([...tied].sort().reverse());
  });

  it('versões desc; eventos sequence asc', () => {
    expect(all('admin', `/automations/${auto('rastreio')}/versions`, 2).map((v) => v.versionNumber)).toEqual([5, 4, 3, 2, 1]);
    const done = all('admin', '/executions', 100).find((e) => e.statusReason === 'process_completed')!;
    const evs = all('admin', `/executions/${done.executionId}/events`, 1);
    expect(evs.map((e) => [e.sequence, e.type])).toEqual([[1, 'process_started'], [2, 'process_succeeded']]);
  });

  it('nome: 48 primeiros pontos de código + id, inclusive não ASCII e fora do plano básico', () => {
    const names = all('leitora', `/workspaces/${ws('atendimento')}/automations`, 1).map((a) => a.automationId);
    // mesmo prefixo de 48 pontos de código ("Ação de cobrança automática para clientes em atr…"): ordem pelo id
    const cobranca = [auto('cobranca-a'), auto('cobranca-b')].sort();
    expect(names.filter((id) => cobranca.includes(id))).toEqual(cobranca);
    // U+FF5A (ｚ) antes de U+1D538 (𝔸) por ponto de código; a comparação UTF-16 daria a ordem inversa
    expect(names.indexOf(auto('export-bmp'))).toBeLessThan(names.indexOf(auto('export-astral')));
    expect('Exportação 𝔸' < 'Exportação ｚ').toBe(true); // a armadilha que o mock evita
    const rel = all('admin', '/workspaces', 1).filter((w) => w.name.startsWith('Relatórios regulatórios'));
    expect(rel.map((w) => w.workspaceId)).toEqual(rel.map((w) => w.workspaceId).sort());
  });
});

describe('cursor (§1.5, DC-15)', () => {
  const first = (who = 'admin', path = '/executions?limit=3') => ok(who, path).nextCursor as string;

  it('adulterado, de outro filtro, rota, recurso, vínculo ou organização → 400', () => {
    const c = first();
    const [payload, tag] = c.split('.');
    const flipped = payload.slice(0, -1) + (payload.endsWith('A') ? 'B' : 'A');
    expect(get('admin', `/executions?cursor=${flipped}.${tag}`).status).toBe(400);
    expect(get('admin', `/executions?cursor=${c}&status=failed`).status).toBe(400);
    expect(get('admin', `/workspaces?cursor=${c}`).status).toBe(400);
    expect(get('gestora', `/executions?cursor=${c}`).status).toBe(400);
    expect(get('admin', '/executions?cursor=sem-ponto').status).toBe(400);
    expect(get('admin', `/executions?cursor=${'a'.repeat(1020)}.bbbb`).status).toBe(400);
    const vc = ok('vizinha', '/executions?limit=1', OTHER_ORG).nextCursor;
    expect(get('admin', `/executions?cursor=${vc}`).status).toBe(400);
    // recurso pai diferente: cursor de versões de uma automação usado em outra
    const vcur = ok('admin', `/automations/${auto('rastreio')}/versions?limit=1`).nextCursor;
    expect(get('admin', `/automations/${auto('rastreio')}/versions?cursor=${vcur}`).status).toBe(200);
    expect(get('admin', `/automations/${auto('backup')}/versions?cursor=${vcur}`).status).toBe(400);
  });

  it('filtros na mesma impressão canônica (ordem de status diferente) continuam válidos', () => {
    const c = ok('admin', '/executions?limit=2&status=failed&status=succeeded').nextCursor;
    expect(get('admin', `/executions?cursor=${c}&status=succeeded&status=failed`).status).toBe(200);
  });

  it('rotação da chave invalida os cursores emitidos (DC-15); a primeira página continua funcionando', () => {
    const c = first();
    api.product.cursors.rotate();
    expect(get('admin', `/executions?cursor=${c}`)).toEqual({ status: 400, body: ERROR('invalid_request') });
    expect(get('admin', '/executions?limit=3').status).toBe(200);
  });
});

describe('campos derivados e determinismo', () => {
  it('durationMs = finishedAt − startedAt; nulo se algum for nulo; em andamento sem finishedAt', () => {
    for (const e of all('admin', '/executions', 100)) {
      if (e.startedAt && e.finishedAt) expect(e.durationMs).toBe(Date.parse(e.finishedAt) - Date.parse(e.startedAt));
      else expect(e.durationMs).toBeNull();
      if (['pending', 'starting', 'running'].includes(e.status)) expect(e.finishedAt).toBeNull();
    }
  });

  it('automação sem versão publicada tem latestPublishedVersion nulo', () => {
    expect(ok('admin', `/automations/${auto('rascunho')}`).latestPublishedVersion).toBeNull();
  });

  it('mesmos ids e horários depois de restaurar (relógio fixo)', () => {
    const before = all('admin', '/executions', 100);
    api.reset();
    cookie.admin = session('ana@nekkora.dev');
    expect(all('admin', '/executions', 100)).toEqual(before);
  });
});
