/**
 * Leitura interna do produto (GAP-06): workspaces, automações, versões, execuções e eventos.
 * Inexistente, de outra organização ou sem acesso → 404 sem distinção; conta externa → 403.
 */
import { request } from './http';
import { queryString } from './query';
import type { Automation, AutomationVersion, Execution, ExecutionDetail, ExecutionEvent, Page, Query, Workspace } from './v1';

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

export type WorkspaceQuery = Query<'listWorkspaces'>;
export type AutomationQuery = Query<'listAutomations'>;
export type ExecutionQuery = Query<'listExecutions'>;
export type PageQuery = { cursor?: string; limit?: number };

export async function listWorkspaces(org: string, q: WorkspaceQuery = {}): Promise<Page<Workspace>> {
  return (await request<Page<Workspace>>(`${base(org)}/workspaces${queryString(q)}`)).data;
}

export async function getWorkspace(org: string, workspaceId: string): Promise<Workspace> {
  return (await request<Workspace>(`${base(org)}/workspaces/${id(workspaceId)}`)).data;
}

export async function listAutomations(org: string, workspaceId: string, q: AutomationQuery = {}): Promise<Page<Automation>> {
  return (await request<Page<Automation>>(`${base(org)}/workspaces/${id(workspaceId)}/automations${queryString(q)}`)).data;
}

export async function getAutomation(org: string, automationId: string): Promise<Automation> {
  return (await request<Automation>(`${base(org)}/automations/${id(automationId)}`)).data;
}

export async function listAutomationVersions(org: string, automationId: string, q: PageQuery = {}): Promise<Page<AutomationVersion>> {
  return (await request<Page<AutomationVersion>>(`${base(org)}/automations/${id(automationId)}/versions${queryString(q)}`)).data;
}

/**
 * Execuções de todos os workspaces visíveis. Período [from, to): `from` inclusivo, `to` exclusivo, ambos com fuso.
 * `workspaceId` ou `automationId` sem acesso → 404 (regra geral, sem a exceção de /client-grants).
 */
export async function listExecutions(org: string, q: ExecutionQuery = {}): Promise<Page<Execution>> {
  return (await request<Page<Execution>>(`${base(org)}/executions${queryString(q)}`)).data;
}

export async function getExecution(org: string, executionId: string): Promise<ExecutionDetail> {
  return (await request<ExecutionDetail>(`${base(org)}/executions/${id(executionId)}`)).data;
}

/** Eventos sem payload; execução inexistente ou sem acesso → 404 (diferente do portal, que devolve lista vazia). */
export async function listExecutionEvents(org: string, executionId: string, q: PageQuery = {}): Promise<Page<ExecutionEvent>> {
  return (await request<Page<ExecutionEvent>>(`${base(org)}/executions/${id(executionId)}/events${queryString(q)}`)).data;
}
