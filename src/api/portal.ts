/**
 * Portal externo (013), para contas externas (`accountType = external`): somente GET, sob /portal/api/v1.
 * Diferenças da rota interna que a interface respeita: cursor NÃO assinado, `workspaceId` omitido quando a conta
 * tem um único workspace autorizado, eventos de execução sem acesso → lista vazia (não 404).
 */
import { readJson } from './validate';
import { queryString } from './query';
import type { Page, PortalEvent, PortalExecution, PortalWorkspace, Query } from './v1';

const base = (org: string) => `/portal/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

export type PortalExecutionQuery = Query<'portalListExecutions'>;

export async function portalListWorkspaces(org: string): Promise<PortalWorkspace[]> {
  return (await readJson<{ items: PortalWorkspace[] }>('portalListWorkspaces', `${base(org)}/workspaces`)).items;
}

export async function portalListExecutions(org: string, q: PortalExecutionQuery = {}): Promise<Page<PortalExecution>> {
  return readJson<Page<PortalExecution>>('portalListExecutions', `${base(org)}/executions${queryString(q)}`);
}

export async function portalGetExecution(org: string, executionId: string): Promise<PortalExecution> {
  return readJson<PortalExecution>('portalGetExecution', `${base(org)}/executions/${id(executionId)}`);
}

export async function portalListExecutionEvents(org: string, executionId: string): Promise<PortalEvent[]> {
  return (await readJson<{ items: PortalEvent[] }>('portalListExecutionEvents', `${base(org)}/executions/${id(executionId)}/events`)).items;
}
