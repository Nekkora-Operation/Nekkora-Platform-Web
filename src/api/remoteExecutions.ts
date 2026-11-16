/**
 * Execução remota (PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T02), lado das PESSOAS: solicitar que uma versão publicada rode numa
 * máquina habilitada, acompanhar, pedir o cancelamento e executar novamente em outra máquina. O canal da máquina
 * (/agent/api/v1/*) NUNCA é chamado pelo navegador. Solicitar não prova início: o estado vem do que a máquina informar.
 */
import { sessionCsrf } from './auth';
import { request, type RequestOptions } from './http';
import { validated, type OperationId } from './validate';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type RemoteExecution = S['RemoteExecution'];
export type RemoteAttempt = RemoteExecution['attempts'][number];
export type RemoteAttemptState = S['RemoteAttemptState'];
export type RemoteCandidate = S['RemoteExecutionCandidateList']['items'][number];
export type RemoteMissing = RemoteCandidate['missing'][number];

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

async function send<T>(org: string, operationId: OperationId, path: string, options: RequestOptions = {}): Promise<T> {
  const write = options.method && options.method !== 'GET';
  const { status, data } = await request<unknown>(`${base(org)}${path}`, write ? { ...options, csrf: await sessionCsrf(org) } : options);
  return validated<T>(operationId, data, status);
}

/** As máquinas habilitadas do workspace para uma versão publicada, com o que falta em cada uma para solicitar. Indicativo. */
export function listRemoteExecutionCandidates(org: string, workspaceId: string, automationVersionId: string): Promise<S['RemoteExecutionCandidateList']> {
  return send(org, 'listRemoteExecutionCandidates', `/workspaces/${id(workspaceId)}/remote-executions/candidates?automationVersion=${id(automationVersionId)}`);
}

/**
 * Solicita (step-up). `requestKey` é gerada pelo navegador: repetir com a mesma chave devolve a mesma solicitação. Cada
 * exigência que falta responde 409 conflict com o seu `reason`; nada é gravado.
 */
export function requestRemoteExecution(org: string, workspaceId: string, body: { automationVersionId: string; agentId: string; requestKey: string }): Promise<RemoteExecution> {
  return send(org, 'requestRemoteExecution', `/workspaces/${id(workspaceId)}/remote-executions`, { method: 'POST', body });
}

export function listRemoteExecutions(org: string, workspaceId: string, limit = 25): Promise<{ items: RemoteExecution[] }> {
  return send(org, 'listRemoteExecutions', `/workspaces/${id(workspaceId)}/remote-executions?limit=${limit}`);
}

/** Pede o cancelamento (step-up). O que a máquina já recebeu só para quando ela disser. */
export function cancelRemoteExecution(org: string, remoteExecutionId: string): Promise<RemoteExecution> {
  return send(org, 'cancelRemoteExecution', `/remote-executions/${id(remoteExecutionId)}/cancel`, { method: 'POST' });
}

/** Executar novamente em outra máquina (step-up). Só depois que a tentativa anterior terminou. */
export function retryRemoteExecution(org: string, remoteExecutionId: string, agentId: string): Promise<RemoteExecution> {
  return send(org, 'retryRemoteExecution', `/remote-executions/${id(remoteExecutionId)}/attempts`, { method: 'POST', body: { agentId } });
}
