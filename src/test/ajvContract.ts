/**
 * Validador INDEPENDENTE para os testes de contrato: Ajv 8 (JSON Schema 2020-12, dialeto do OpenAPI 3.1) com
 * ajv-formats, sobre os mesmos esquemas gerados do OpenAPI. Serve de referência para conferir o validador próprio do
 * cliente (src/api/validate.ts): os dois têm de concordar em todas as respostas do mock e nos controles negativos.
 *
 * Modo estrito (nenhum campo fora do contrato) = `unevaluatedProperties: false` em todo objeto com propriedades; em
 * `allOf`, a palavra-chave fica no esquema que combina as partes (as partes ficam abertas no nível de cima), que é a
 * semântica correta do 2020-12. Só para testes: não entra no bundle.
 */
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import contract from '../api/generated/nekkora-api-v1.schemas.json' with { type: 'json' };

type Node = Record<string, unknown>;
const ID = 'https://nekkora.test/contrato';
const REF = /^#\/components\/schemas\/(.+)$/;

function transform(node: unknown, strict: boolean, topOpen = false): unknown {
  if (Array.isArray(node)) return node.map((n) => transform(n, strict));
  if (!node || typeof node !== 'object') return node;
  const src = node as Node;
  const out: Node = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === '$ref' && typeof v === 'string') {
      const name = REF.exec(v)?.[1];
      if (!name) throw new Error(`referência não suportada: ${v}`);
      out.$ref = `${ID}#/$defs/${name}${strict ? (topOpen ? '__aberto' : '__estrito') : ''}`;
    } else if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v as Node).map(([name, s]) => [name, transform(s, strict)]));
    } else if (k === 'allOf') {
      out.allOf = (v as unknown[]).map((part) => transform(part, strict, true));
    } else {
      out[k] = transform(v, strict);
    }
  }
  if (strict && !topOpen && (src.properties !== undefined || src.allOf !== undefined)) {
    out.unevaluatedProperties = false;
    // exigência do modo estrito do Ajv; já implícito (as partes do allOf são objetos)
    if (src.type === undefined) out.type = 'object';
  }
  return out;
}

const $defs: Node = {};
for (const [name, s] of Object.entries(contract.schemas)) {
  $defs[name] = transform(s, false);
  $defs[`${name}__estrito`] = transform(s, true);
  $defs[`${name}__aberto`] = transform(s, true, true);
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv, ['uuid', 'date-time']);
ajv.addFormat('password', true); // só aparece em esquemas de requisição; sem regra de conteúdo
ajv.addSchema({ $id: ID, $defs });

const cache = new Map<string, ValidateFunction>();

export interface AjvResult {
  valid: boolean;
  errors: string[];
}

/** Valida o corpo da resposta `status` de `operationId` com o Ajv (modo estrito opcional). */
export function ajvValidate(operationId: keyof typeof contract.operations, status: number, body: unknown, { strict = true } = {}): AjvResult {
  const r = (contract.operations[operationId].responses as Record<string, { schema: unknown }>)[String(status)];
  if (!r) return { valid: false, errors: [`status ${status} não documentado`] };
  const key = `${operationId}:${status}:${strict}`;
  let fn = cache.get(key);
  if (!fn) cache.set(key, (fn = ajv.compile(transform(r.schema, strict) as object)));
  const valid = fn(body) as boolean;
  return { valid, errors: (fn.errors ?? []).map((e: ErrorObject) => `${e.instancePath || '$'} ${e.keyword}`) };
}

export const AJV_VERSIONS = { ajv: '8.20.0', 'ajv-formats': '3.0.1' };
