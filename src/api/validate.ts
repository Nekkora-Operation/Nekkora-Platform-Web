/**
 * Validação em execução das respostas da API v1 contra o OpenAPI (esquemas gerados em
 * generated/nekkora-api-v1.schemas.json por `npm run contract:gen`).
 *
 * Os tipos gerados só existem na compilação; esta validação confere o que de fato chega. Resposta fora do contrato →
 * `ApiError('unexpected')`, sem expor o corpo: o erro leva só os caminhos e as regras violadas (nunca valores).
 *
 * Implementa o subconjunto de JSON Schema que o OpenAPI usa: type (inclusive listas com 'null'), enum, required,
 * properties, additionalProperties (false ou esquema), items, minItems/maxItems, uniqueItems, minimum/maximum, minLength/maxLength,
 * pattern, format (uuid, date-time), $ref, oneOf, anyOf, allOf e not. Palavra-chave desconhecida → falha (o validador
 * não deixa passar o que não sabe conferir).
 *
 * Modo estrito (testes do mock): propriedade não declarada também é violação, mesmo sem additionalProperties: false.
 * Em execução, o cliente usa o modo normal: campos novos da API não quebram a interface.
 */
import contract from './generated/nekkora-api-v1.schemas.json' with { type: 'json' };
import { ApiError, request } from './http';

type Schema = Record<string, unknown>;
type ResponseSpec = { contentType: string | null; schema: Schema | null };
type Doc = { schemas: Record<string, Schema>; operations: Record<string, { path: string; responses: Record<string, ResponseSpec> }> };

const doc = contract as unknown as Doc;

export type OperationId = keyof typeof contract.operations;

export interface Violation {
  path: string;
  rule: string;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// date-time (RFC 3339 §5.6, fuso obrigatório) com a MESMA regra do ajv-formats 3.0.1 (validador de referência dos
// testes): calendário real (meses, ano bissexto), hora, minuto, segundo, fuso e segundo bissexto só às 23:59 UTC.
// Date.parse NÃO serve: normaliza 2026-02-30 para 2026-03-02.
const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
const TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeapYear = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

function isDate(str: string): boolean {
  const m = DATE.exec(str);
  if (!m) return false;
  const [year, month, day] = [+m[1], +m[2], +m[3]];
  return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]);
}

function isTime(str: string): boolean {
  const m = TIME.exec(str);
  if (!m || !m[4]) return false; // fuso obrigatório
  const [hr, min, sec] = [+m[1], +m[2], +m[3]];
  const sign = m[5] === '-' ? -1 : 1;
  const tzH = +(m[6] || 0);
  const tzM = +(m[7] || 0);
  if (tzH > 23 || tzM > 59) return false;
  if (hr <= 23 && min <= 59 && sec < 60) return true;
  const utcMin = min - tzM * sign;
  const utcHr = hr - tzH * sign - (utcMin < 0 ? 1 : 0);
  return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
}

export function isDateTime(str: string): boolean {
  const parts = str.split(/t|\s/i);
  return parts.length === 2 && isDate(parts[0]) && isTime(parts[1]);
}

const KNOWN = new Set([
  'type', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems',
  'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', '$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'default',
]);
const patterns = new Map<string, RegExp>();

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function resolve(s: Schema): Schema {
  const ref = s.$ref;
  if (typeof ref !== 'string') return s;
  const name = /^#\/components\/schemas\/(.+)$/.exec(ref)?.[1];
  const target = name ? doc.schemas[name] : undefined;
  if (!target) throw new Error(`referência desconhecida no contrato: ${ref}`);
  return resolve(target);
}

/** Propriedades declaradas por um esquema (inclui as de allOf), para o modo estrito. */
function declared(s: Schema, out = new Set<string>()): Set<string> {
  const r = resolve(s);
  if (r.properties) for (const k of Object.keys(r.properties as object)) out.add(k);
  if (Array.isArray(r.allOf)) for (const part of r.allOf as Schema[]) declared(part, out);
  return out;
}

/** `levelOpen`: não confere propriedades extras NESTE nível (parte de allOf; a união é conferida pelo pai). */
function check(s: Schema, v: unknown, path: string, strict: boolean, out: Violation[], levelOpen = false): void {
  const r = resolve(s);
  for (const k of Object.keys(r)) if (!KNOWN.has(k)) throw new Error(`palavra-chave não suportada no contrato: ${k}`);
  const fail = (rule: string): void => {
    out.push({ path: path || '$', rule });
  };

  if (r.type !== undefined) {
    const types = Array.isArray(r.type) ? (r.type as string[]) : [r.type as string];
    const t = typeOf(v);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) return fail(`type ${types.join('|')}`);
  }
  if (Array.isArray(r.enum) && !(r.enum as unknown[]).some((e) => e === v)) return fail('enum');

  if (typeof v === 'string') {
    if (typeof r.minLength === 'number' && [...v].length < r.minLength) fail('minLength');
    if (typeof r.maxLength === 'number' && [...v].length > r.maxLength) fail('maxLength');
    if (typeof r.pattern === 'string') {
      let re = patterns.get(r.pattern);
      if (!re) patterns.set(r.pattern, (re = new RegExp(r.pattern, 'u')));
      if (!re.test(v)) fail('pattern');
    }
    if (r.format === 'uuid' && !UUID.test(v)) fail('format uuid');
    if (r.format === 'date-time' && !isDateTime(v)) fail('format date-time');
  }
  if (typeof v === 'number' && typeof r.minimum === 'number' && v < r.minimum) fail('minimum');
  if (typeof v === 'number' && typeof r.maximum === 'number' && v > r.maximum) fail('maximum');

  if (Array.isArray(v)) {
    if (typeof r.minItems === 'number' && v.length < r.minItems) fail('minItems');
    if (typeof r.maxItems === 'number' && v.length > r.maxItems) fail('maxItems');
    if (r.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) fail('uniqueItems');
    if (r.items) v.forEach((item, i) => check(r.items as Schema, item, `${path}[${i}]`, strict, out));
  }

  if (typeOf(v) === 'object') {
    const obj = v as Record<string, unknown>;
    for (const k of (r.required as string[] | undefined) ?? []) if (!(k in obj)) fail(`required ${k}`);
    const props = (r.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, ps] of Object.entries(props)) if (k in obj) check(ps, obj[k], `${path}.${k}`, strict, out);
    // mapa (additionalProperties com esquema, ex.: contagens por código): cada valor não declarado segue o esquema
    if (r.additionalProperties && typeof r.additionalProperties === 'object') {
      for (const [k, item] of Object.entries(obj)) if (!(k in props)) check(r.additionalProperties as Schema, item, `${path}.${k}`, strict, out);
    }
    // mapa com esquema: as chaves não declaradas já foram conferidas acima e não são "propriedades extras"
    const isMap = typeof r.additionalProperties === 'object' && r.additionalProperties !== null;
    const closed = r.additionalProperties === false || (strict && !isMap && (r.properties !== undefined || r.allOf !== undefined));
    if (closed && r.type === 'object' && !levelOpen) {
      const known = declared(r);
      for (const k of Object.keys(obj)) if (!known.has(k)) fail(`additionalProperties ${k}`);
    }
  }

  if (Array.isArray(r.allOf)) {
    // cada parte é conferida (inclusive objetos aninhados, no modo estrito); propriedades extras deste nível são
    // conferidas uma vez contra a união das partes
    for (const part of r.allOf as Schema[]) check(part, v, path, strict, out, true);
    if (strict && typeOf(v) === 'object' && !levelOpen) {
      const known = declared(r);
      for (const k of Object.keys(v as object)) if (!known.has(k)) fail(`additionalProperties ${k}`);
    }
  }
  if (Array.isArray(r.anyOf)) {
    const ok = (r.anyOf as Schema[]).some((part) => valid(part, v, path, strict));
    if (!ok) fail('anyOf');
  }
  if (Array.isArray(r.oneOf)) {
    const n = (r.oneOf as Schema[]).filter((part) => valid(part, v, path, strict)).length;
    if (n !== 1) fail(n === 0 ? 'oneOf (nenhum)' : 'oneOf (mais de um)');
  }
  if (r.not && valid(r.not as Schema, v, path, false)) fail('not');
}

function valid(s: Schema, v: unknown, path: string, strict: boolean): boolean {
  const out: Violation[] = [];
  check(s, v, path, strict, out);
  return out.length === 0;
}

function spec(operationId: string, status: number): ResponseSpec | undefined {
  const op = doc.operations[operationId];
  if (!op) throw new Error(`operação sem esquema de resposta: ${operationId}`);
  return op.responses[String(status)];
}

/** Violações de um esquema avulso (testes do validador; o contrato real passa por `violations`). */
export function rawSchemaViolations(schema: Schema, data: unknown, strict = false): Violation[] {
  const out: Violation[] = [];
  check(schema, data, '$', strict, out);
  return out;
}

/** Violações do corpo da resposta `status` (padrão 200) de `operationId` (vazio = conforme). */
export function violations(operationId: OperationId, data: unknown, { strict = false, status = 200 } = {}): Violation[] {
  const s = spec(operationId, status);
  if (!s) return [{ path: '$', rule: `status ${status} não documentado` }];
  if (!s.schema) return data === undefined || data === null || data === '' ? [] : [{ path: '$', rule: 'corpo não previsto' }];
  const out: Violation[] = [];
  check(s.schema, data, '$', strict, out);
  return out;
}

/**
 * Conferência completa de uma resposta (testes): status documentado para a operação, tipo de conteúdo esperado
 * (ou ausência de corpo) e corpo conforme ao esquema daquele status.
 */
export function responseViolations(
  operationId: OperationId,
  res: { status: number; contentType?: string | null; body: unknown },
  { strict = true } = {},
): Violation[] {
  const s = spec(operationId, res.status);
  if (!s) return [{ path: '$', rule: `status ${res.status} não documentado` }];
  const out: Violation[] = [];
  const ct = res.contentType?.split(';')[0].trim().toLowerCase() ?? null;
  if (s.contentType !== null && ct !== s.contentType) out.push({ path: '$', rule: `content-type ${ct ?? 'ausente'} (esperado ${s.contentType})` });
  return [...out, ...violations(operationId, res.body, { strict, status: res.status })];
}

/** Erro de resposta fora do contrato: só caminhos e regras (sem valores). */
export class ContractViolation extends ApiError {
  readonly operationId: string;
  readonly violations: readonly Violation[];

  constructor(operationId: string, list: Violation[], status: number) {
    super('unexpected', status);
    this.operationId = operationId;
    this.violations = list;
  }
}

/** Violações de `data` contra um esquema nomeado de components.schemas (vazio = conforme). */
export function schemaViolations(name: string, data: unknown, { strict = false } = {}): Violation[] {
  const s = doc.schemas[name];
  if (!s) throw new Error(`esquema desconhecido: ${name}`);
  const out: Violation[] = [];
  check(s, data, '$', strict, out);
  return out;
}

/**
 * Como `validated`, mas contra UM esquema nomeado — para respostas cujo `oneOf` do contrato é ambíguo e cujo ramo é
 * determinado pela própria requisição (ver docs/DIVERGENCIAS.md, D-API-01). O status também precisa ser documentado.
 */
export function validatedAs<T>(operationId: OperationId, schemaName: string, data: unknown, status = 200): T {
  if (!spec(operationId, status)) throw new ContractViolation(operationId, [{ path: '$', rule: `status ${status} não documentado` }], status);
  const list = schemaViolations(schemaName, data);
  if (list.length) throw new ContractViolation(operationId, list.slice(0, 20), status);
  return data as T;
}

/** Devolve `data` tipado se estiver conforme; senão lança `ContractViolation` (código `unexpected`). */
export function validated<T>(operationId: OperationId, data: unknown, status = 200): T {
  // o esquema é o do status RECEBIDO: sucesso não documentado (ex.: 201, 204) é violação, nunca dado tipado
  const list = violations(operationId, data, { status });
  if (list.length) throw new ContractViolation(operationId, list.slice(0, 20), status);
  return data as T;
}

/** GET de leitura da API v1 com a resposta conferida contra o contrato da operação. */
export async function readJson<T>(operationId: OperationId, path: string): Promise<T> {
  const { data, status } = await request<unknown>(path);
  return validated<T>(operationId, data, status);
}
