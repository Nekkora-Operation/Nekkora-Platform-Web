/**
 * AMBIENTE-PYTHON-001 — "Dependências gerenciadas por execução" (CONTRATO.md §2), lado das PESSOAS. O modo padrão continua
 * sendo o Python preparado da máquina; o ambiente por execução só existe com a chave ligada na Platform
 * (`me.managedEnvironmentAvailable`), a capacidade da máquina e um aceite vigente para a versão e a máquina.
 *
 * - a máquina resolve a lista completa (lock) só com wheels do PyPI público;
 * - a pessoa aceita ESSE lock (confirmação reforçada), e cada execução instala exatamente ele num venv temporário;
 * - lock diferente exige aceite novo.
 *
 * Nada aqui instala coisa alguma: o navegador só lê, pede a resolução e grava o aceite.
 */
import { sessionCsrf } from './auth';
import { ApiError, apiErrorFrom, request, safeRequestId, type RequestOptions } from './http';
import { validated, type OperationId } from './validate';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type ManagedEnvironment = S['ManagedEnvironment'];
export type ManagedResolution = NonNullable<ManagedEnvironment['resolution']>;
export type ManagedAuthorization = NonNullable<ManagedEnvironment['authorization']>;
export type ManagedLockItem = S['ManagedEnvironmentLockItem'];
export type ManagedFailure = S['ManagedEnvironmentFailure'];
export type ManagedPrerequisite = ManagedEnvironment['externalPrerequisites'][number];
export type RemoteAttemptEnvironment = S['RemoteAttemptEnvironment'];
export type EnvironmentMode = 'PREPARED' | 'MANAGED';

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);
const machine = (automationId: string, agentId: string) => `/automations/${id(automationId)}/remote-machines/${id(agentId)}/managed-environment`;

async function send<T>(org: string, operationId: OperationId, path: string, options: RequestOptions = {}): Promise<T> {
  const write = options.method && options.method !== 'GET';
  const { status, data } = await request<unknown>(`${base(org)}${path}`, write ? { ...options, csrf: await sessionCsrf(org) } : options);
  return validated<T>(operationId, data, status);
}

/** 2.1 — a base, a lista efetiva da versão (A1), a resolução mais recente, o catálogo de dependências externas e o aceite. */
export function getManagedEnvironment(org: string, automationId: string, agentId: string, versionId: string): Promise<ManagedEnvironment> {
  return send(org, 'getManagedEnvironment', `${machine(automationId, agentId)}?versionId=${id(versionId)}`);
}

/** 2.2 — pede à máquina a lista completa. Não autoriza nada (sem confirmação reforçada). A resposta chega depois, no GET. */
export function requestManagedEnvironmentResolution(org: string, automationId: string, agentId: string, versionId: string): Promise<ManagedEnvironment> {
  return send(org, 'requestManagedEnvironmentResolution', `${machine(automationId, agentId)}/resolutions`, { method: 'POST', body: { versionId } });
}

/**
 * 2.3 — o aceite (step-up). `acknowledge` vai sempre `true`: a tela só deixa confirmar depois de a pessoa marcar. O corpo da
 * resposta não é usado: a tela relê a situação pelo GET (a resposta exata do aceite ainda não está fixada no contrato).
 */
export async function authorizeManagedEnvironment(
  org: string,
  automationId: string,
  agentId: string,
  body: { versionId: string; resolutionId: string; lockSha256: string; checks: string[] },
): Promise<void> {
  await request<unknown>(`${base(org)}${machine(automationId, agentId)}/authorizations`, {
    method: 'POST',
    body: { ...body, acknowledge: true },
    csrf: await sessionCsrf(org),
  });
}

/** 2.4 — revoga o aceite (step-up): a máquina volta ao Python preparado. */
export async function revokeManagedEnvironmentAuthorization(org: string, automationId: string, agentId: string, versionId: string): Promise<void> {
  await request<unknown>(`${base(org)}${machine(automationId, agentId)}/authorizations/current?versionId=${id(versionId)}`, {
    method: 'DELETE',
    csrf: await sessionCsrf(org),
  });
}

/** O registro do preparo foi removido pela retenção (30 dias contados do relatório). */
export class EnvironmentLogExpired extends Error {
  constructor() {
    super('managed_environment_log_expired');
  }
}

/**
 * 2.5 — o registro do preparo de uma tentativa (texto, já sem segredos). 410 → `EnvironmentLogExpired`. O texto é mostrado
 * como texto: o navegador não interpreta nada dele.
 */
export async function getRemoteAttemptEnvironmentLog(org: string, remoteExecutionId: string, attemptId: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${base(org)}/remote-executions/${id(remoteExecutionId)}/attempts/${id(attemptId)}/environment-log`, {
      method: 'GET',
      headers: { Accept: 'text/plain, application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError('network', 0);
  }
  if (res.status === 410) throw new EnvironmentLogExpired();
  const requestId = safeRequestId(res.headers.get('X-Request-Id'));
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw apiErrorFrom(res.status, body, res.headers.get('Retry-After'), requestId);
  }
  const type = res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'text/plain') throw new ApiError('unexpected', res.status, undefined, requestId);
  return res.text();
}
