/**
 * Dependências de execução declaradas para uma automação (PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T01c). A leitura do texto é
 * estática e feita pela API, com as mesmas regras do aplicativo: nada é instalado. Declarar não muda o pacote publicado e
 * não autoriza execução.
 */
import { sessionCsrf } from './auth';
import { request, type RequestOptions } from './http';
import { validated, type OperationId } from './validate';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type RuntimeRequirements = S['RuntimeRequirements'];
export type RuntimeRequirementsAnalysis = S['RuntimeRequirementsAnalysis'];
export type RequirementLine = RuntimeRequirementsAnalysis['lines'][number];
export type RequirementSource = S['RuntimeRequirementsDeclaration']['source'];

const path = (org: string, automationId: string) => `/api/v1/o/${encodeURIComponent(org)}/automations/${encodeURIComponent(automationId)}/runtime-requirements`;

async function send<T>(org: string, operationId: OperationId, url: string, options: RequestOptions = {}): Promise<T> {
  const write = options.method && options.method !== 'GET';
  const { status, data } = await request<unknown>(url, write ? { ...options, csrf: await sessionCsrf(org) } : options);
  return validated<T>(operationId, data, status);
}

export function getRuntimeRequirements(org: string, automationId: string): Promise<RuntimeRequirements> {
  return send(org, 'getRuntimeRequirements', path(org, automationId));
}

/** Lê um texto e diz, por linha, o que é. Nada é gravado. */
export function analyzeRuntimeRequirements(org: string, automationId: string, text: string): Promise<RuntimeRequirementsAnalysis> {
  return send(org, 'analyzeRuntimeRequirements', `${path(org, automationId)}/analysis`, { method: 'POST', body: { text } });
}

/**
 * Cria a revisão seguinte. `text` só com FILE ou TEXT. `expectedRevision`: a revisão que a pessoa viu (ausente = nenhuma).
 * Linha com problema: 409 conflict + reason runtime_requirements_unresolved; outra pessoa declarou antes: 409 +
 * runtime_requirements_changed. Nos dois casos nada é gravado.
 */
export function declareRuntimeRequirements(
  org: string,
  automationId: string,
  body: { source: RequirementSource; text?: string; expectedRevision?: number },
): Promise<RuntimeRequirements> {
  return send(org, 'declareRuntimeRequirements', path(org, automationId), { method: 'PUT', body });
}
