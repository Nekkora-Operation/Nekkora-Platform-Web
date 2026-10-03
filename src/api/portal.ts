/**
 * Portal externo (013), para contas externas (`accountType = external`): somente GET, sob /portal/api/v1.
 * Diferenças da rota interna que a interface respeita: cursor NÃO assinado, `workspaceId` omitido quando a conta
 * tem um único workspace autorizado, eventos de execução sem acesso → lista vazia (não 404).
 */
import { request } from './http';
import { queryString } from './query';
import type { Page, PortalEvent, PortalExecution, PortalWorkspace, Query } from './v1';

const base = (org: string) => `/portal/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

export type PortalExecutionQuery = Query<'portalListExecutions'>;

export async function portalListWorkspaces(org: string): Promise<PortalWorkspace[]> {
  return (await request<{ items: PortalWorkspace[] }>(`${base(org)}/workspaces`)).data.items;
}

export async function portalListExecutions(org: string, q: PortalExecutionQuery = {}): Promise<Page<PortalExecution>> {
  return (await request<Page<PortalExecution>>(`${base(org)}/executions${queryString(q)}`)).data;
}

export async function portalGetExecution(org: string, executionId: string): Promise<PortalExecution> {
  return (await request<PortalExecution>(`${base(org)}/executions/${id(executionId)}`)).data;
}

export async function portalListExecutionEvents(org: string, executionId: string): Promise<PortalEvent[]> {
  return (await request<{ items: PortalEvent[] }>(`${base(org)}/executions/${id(executionId)}/events`)).data.items;
}
