/**
 * PLATFORM-FLUXO-002 (070): área do cliente. Lê SÓ o Portal (/portal/api/v1), pela sessão de identidade: a pessoa entra com a
 * conta Nekkora e vê, em cada organização, só o que foi compartilhado com ela. O Portal reconfere vínculo e concessões a cada
 * chamada (revogar ou suspender vale na próxima consulta). Somente GET.
 */
import { readJson } from './validate';
import { queryString } from './query';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type ClientOrganization = S['PortalClientOrganization'];
export type SharedAutomation = S['PortalSharedAutomation'];
export type SharedExecution = S['PortalSharedExecution'];
export type SharedExecutionPage = S['PortalSharedExecutionPage'];
export type SharedExecutionDetail = S['PortalSharedExecutionDetail'];
export type SharedAttempt = S['PortalSharedAttempt'];
export type SharedLogs = S['PortalSharedLogs'];
export type SharedResults = S['PortalSharedResults'];
export type ExecutionKind = S['PortalExecutionKind'];

const root = '/portal/api/v1';
const base = (org: string) => `${root}/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

export async function listClientOrganizations(): Promise<ClientOrganization[]> {
  return (await readJson<{ items: ClientOrganization[] }>('portalClientOrganizations', `${root}/me/client-organizations`)).items;
}

export async function listSharedAutomations(org: string): Promise<SharedAutomation[]> {
  return (await readJson<{ items: SharedAutomation[] }>('portalSharedAutomations', `${base(org)}/shared-automations`)).items;
}

export function listSharedExecutions(org: string, automationId: string, q: { cursor?: string; limit?: number } = {}): Promise<SharedExecutionPage> {
  return readJson<SharedExecutionPage>('portalSharedExecutions', `${base(org)}/shared-automations/${id(automationId)}/executions${queryString(q)}`);
}

export function getSharedExecution(org: string, kind: ExecutionKind, executionId: string): Promise<SharedExecutionDetail> {
  return readJson<SharedExecutionDetail>('portalSharedExecution', `${base(org)}/shared-executions/${id(kind)}/${id(executionId)}`);
}

export function getSharedLogs(org: string, executionId: string, attemptId: string, after = 0): Promise<SharedLogs> {
  return readJson<SharedLogs>('portalSharedLogs',
    `${base(org)}/shared-executions/remote/${id(executionId)}/attempts/${id(attemptId)}/logs${queryString({ after })}`);
}

export function getSharedResults(org: string, executionId: string, attemptId: string): Promise<SharedResults> {
  return readJson<SharedResults>('portalSharedResults', `${base(org)}/shared-executions/remote/${id(executionId)}/attempts/${id(attemptId)}/results`);
}

/** Endereço do arquivo (o navegador baixa como anexo; a permissão é conferida pelo Portal nessa chamada). */
export function sharedResultHref(org: string, executionId: string, attemptId: string, number: number): string {
  return `${base(org)}/shared-executions/remote/${id(executionId)}/attempts/${id(attemptId)}/results/${number}/content`;
}
