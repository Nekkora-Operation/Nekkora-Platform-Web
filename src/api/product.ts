/**
 * Leitura interna do produto (GAP-06): workspaces, automações, versões, execuções e eventos.
 * Inexistente, de outra organização ou sem acesso → 404 sem distinção; conta externa → 403.
 */
import { readJson } from './validate';
import { queryString } from './query';
import type { Automation, AutomationVersion, Execution, ExecutionDetail, ExecutionEvent, Page, Query, Workspace } from './v1';

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

export type WorkspaceQuery = Query<'listWorkspaces'>;
export type AutomationQuery = Query<'listAutomations'>;
export type ExecutionQuery = Query<'listExecutions'>;
export type PageQuery = { cursor?: string; limit?: number };

export async function listWorkspaces(org: string, q: WorkspaceQuery = {}): Promise<Page<Workspace>> {
  return readJson<Page<Workspace>>('listWorkspaces', `${base(org)}/workspaces${queryString(q)}`);
}

export async function getWorkspace(org: string, workspaceId: string): Promise<Workspace> {
  return readJson<Workspace>('getWorkspace', `${base(org)}/workspaces/${id(workspaceId)}`);
}

export async function listAutomations(org: string, workspaceId: string, q: AutomationQuery = {}): Promise<Page<Automation>> {
  return readJson<Page<Automation>>('listAutomations', `${base(org)}/workspaces/${id(workspaceId)}/automations${queryString(q)}`);
}

export async function getAutomation(org: string, automationId: string): Promise<Automation> {
  return readJson<Automation>('getAutomation', `${base(org)}/automations/${id(automationId)}`);
}

export async function listAutomationVersions(org: string, automationId: string, q: PageQuery = {}): Promise<Page<AutomationVersion>> {
  return readJson<Page<AutomationVersion>>('listAutomationVersions', `${base(org)}/automations/${id(automationId)}/versions${queryString(q)}`);
}

/**
 * Execuções de todos os workspaces visíveis. Período [from, to): `from` inclusivo, `to` exclusivo, ambos com fuso.
 * `workspaceId` ou `automationId` sem acesso → 404 (regra geral, sem a exceção de /client-grants).
 */
export async function listExecutions(org: string, q: ExecutionQuery = {}): Promise<Page<Execution>> {
  return readJson<Page<Execution>>('listExecutions', `${base(org)}/executions${queryString(q)}`);
}

export async function getExecution(org: string, executionId: string): Promise<ExecutionDetail> {
  return readJson<ExecutionDetail>('getExecution', `${base(org)}/executions/${id(executionId)}`);
}

/** Eventos sem payload; execução inexistente ou sem acesso → 404 (diferente do portal, que devolve lista vazia). */
export async function listExecutionEvents(org: string, executionId: string, q: PageQuery = {}): Promise<Page<ExecutionEvent>> {
  return readJson<Page<ExecutionEvent>>('listExecutionEvents', `${base(org)}/executions/${id(executionId)}/events${queryString(q)}`);
}
