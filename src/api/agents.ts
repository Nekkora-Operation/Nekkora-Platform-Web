/**
 * Canal do Agent — lado das PESSOAS (contrato Platform-Agent 1.0; 025): pareamento, credencial, Worker no workspace,
 * autorização de execução local e consultas das execuções registradas pelo Agent. O lado da máquina
 * (/agent/api/v1/*) NUNCA é chamado pelo navegador.
 *
 * Não há cancelamento remoto nem download automático do pacote. AGENT-PYTHON-001 (030): a autorização pode ser de
 * MONITORAMENTO de Python externo (sem versão e sem impressão) e uma pessoa pode PEDIR uma execução de versão autorizada
 * (pedido de execução): a máquina puxa, decide e inicia; entregar ou aceitar não prova início.
 */
import { sessionCsrf } from './auth';
import { request, type RequestOptions } from './http';
import { queryString } from './query';
import { validated, type OperationId } from './validate';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type Agent = S['AgentList']['items'][number];
export type Worker = S['WorkerList']['items'][number];
export type AgentCode = S['AgentCode'];
export type LocalRunAuthorization = S['LocalRunAuthorization'];
export type AgentRun = S['AgentRun'];
export type AgentRunEvent = S['AgentRunEventPage']['items'][number];
export type AgentSupervisorState = S['AgentSupervisorState'];
export type SourceKind = S['SourceKind'];
export type RunRequest = S['RunRequest'];
export type RunRequestState = RunRequest['state'];

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

async function send<T>(org: string, operationId: OperationId, path: string, options: RequestOptions = {}): Promise<T> {
  const write = options.method && options.method !== 'GET';
  const { status, data } = await request<unknown>(`${base(org)}${path}`, write ? { ...options, csrf: await sessionCsrf(org) } : options);
  return validated<T>(operationId, data, status);
}

// ------------------------------------------------------------------ Agents e códigos

export function listAgents(org: string): Promise<S['AgentList']> {
  return send(org, 'listAgents', '/agents');
}

/**
 * Código de pareamento (step-up). `workerId` (Worker existente) OU `workerName` (cria o Worker; exige worker.manage e
 * capacidade da organização ativada). O código aparece SÓ nesta resposta; a listagem nunca o devolve.
 */
export function createPairingCode(
  org: string,
  body: { agentName: string; workerId?: string; workerName?: string; expiresInMinutes?: number },
): Promise<AgentCode> {
  return send(org, 'createAgentPairingCode', '/agent-enrollments', { method: 'POST', body });
}

/** Cancela um código ainda não usado (consumido ou já cancelado: 409). */
export function cancelAgentCode(org: string, enrollmentId: string): Promise<void> {
  return send(org, 'cancelAgentCode', `/agent-enrollments/${id(enrollmentId)}/cancel`, { method: 'POST' });
}

/** Código de rotação da credencial (step-up). A credencial anterior cai quando o Agent resgatar o código. */
export function createRotationCode(org: string, agentId: string, expiresInMinutes?: number): Promise<AgentCode> {
  return send(org, 'createAgentRotationCode', `/agents/${id(agentId)}/credential-rotations`, {
    method: 'POST',
    body: expiresInMinutes ? { expiresInMinutes } : {},
  });
}

/** Revoga (step-up). Efeito imediato no canal; NÃO prova que um processo desconectado parou. */
export function revokeAgent(org: string, agentId: string, reason: 'COMPROMISED' | 'ADMINISTRATIVE'): Promise<void> {
  return send(org, 'revokeAgent', `/agents/${id(agentId)}/revoke`, { method: 'POST', body: { reason } });
}

// ------------------------------------------------------------------ Workers

export function listWorkers(org: string): Promise<S['WorkerList']> {
  return send(org, 'listWorkers', '/workers');
}

/**
 * PLATFORM-AGENT-V2-002, T07 — cria um Worker ATIVO sem Agent (worker.manage, sem step-up). Não emite código nem inicia
 * execução; o Agent é vinculado depois com `createPairingCode({ workerId })`. Limite atingido (zero antes da ativação):
 * 409 conflict + worker_limit_reached, nada gravado.
 */
export function createWorker(org: string, name: string): Promise<S['WorkerCreated']> {
  return send(org, 'createWorker', '/workers', { method: 'POST', body: { name } });
}

/** Autoriza o Worker no workspace (step-up). Idempotente: 200 (já autorizado) ou 201. */
export function authorizeWorkerInWorkspace(org: string, workerId: string, workspaceId: string): Promise<S['WorkerWorkspace']> {
  return send(org, 'authorizeWorkerInWorkspace', `/workers/${id(workerId)}/workspaces/${id(workspaceId)}`, { method: 'PUT' });
}

/** Retira o Worker do workspace: as autorizações de execução local dele ali deixam de ser entregues ao Agent. */
export function revokeWorkerInWorkspace(org: string, workerId: string, workspaceId: string): Promise<void> {
  return send(org, 'revokeWorkerInWorkspace', `/workers/${id(workerId)}/workspaces/${id(workspaceId)}`, { method: 'DELETE' });
}

// ------------------------------------------------------------------ autorizações de execução local

export function listLocalRunAuthorizations(org: string, workspaceId: string): Promise<S['LocalRunAuthorizationList']> {
  return send(org, 'listLocalRunAuthorizations', `/workspaces/${id(workspaceId)}/local-run-authorizations`);
}

/** Autoriza a execução LOCAL de uma versão publicada num Worker autorizado (step-up). Não inicia nada. */
export function createLocalRunAuthorization(
  org: string,
  workspaceId: string,
  body: { workerId: string; automationVersionId: string; validUntil: string },
): Promise<LocalRunAuthorization> {
  return send(org, 'createLocalRunAuthorization', `/workspaces/${id(workspaceId)}/local-run-authorizations`, { method: 'POST', body });
}

/**
 * Autoriza o MONITORAMENTO de um Python externo (030): automação cadastrada + Worker + validade, sem versão nem impressão
 * (step-up). O vínculo com o interpretador, o script e a pasta é feito NA máquina e nunca chega à Platform.
 */
export function createMonitoringAuthorization(
  org: string,
  workspaceId: string,
  body: { workerId: string; automationId: string; validUntil: string },
): Promise<LocalRunAuthorization> {
  return send(org, 'createLocalRunAuthorization', `/workspaces/${id(workspaceId)}/local-run-authorizations`, {
    method: 'POST',
    body: { sourceKind: 'EXTERNAL_MONITORED', ...body },
  });
}

/** Revoga. Máquina desconectada só vê a revogação no próximo download das autorizações. */
export function revokeLocalRunAuthorization(org: string, workspaceId: string, authorizationId: string): Promise<void> {
  return send(org, 'revokeLocalRunAuthorization', `/workspaces/${id(workspaceId)}/local-run-authorizations/${id(authorizationId)}/revoke`, {
    method: 'POST',
  });
}

// ------------------------------------------------------------------ pedido de execução (030)

/**
 * Pede que a versão da autorização rode no Agent escolhido (step-up). `requestKey` é gerado UMA vez por clique: a repetição
 * (resposta perdida) devolve o mesmo pedido. Nenhum comando, caminho ou segredo vai na requisição.
 */
export function createRunRequest(
  org: string,
  workspaceId: string,
  body: { authorizationId: string; agentId: string; validForSeconds?: number; requestKey: string },
): Promise<RunRequest> {
  return send(org, 'createRunRequest', `/workspaces/${id(workspaceId)}/run-requests`, { method: 'POST', body });
}

export function listRunRequests(org: string, workspaceId: string, limit = 20): Promise<S['RunRequestList']> {
  return send(org, 'listRunRequests', `/workspaces/${id(workspaceId)}/run-requests${queryString({ limit })}`);
}

export function getRunRequest(org: string, runRequestId: string): Promise<RunRequest> {
  return send(org, 'getRunRequest', `/run-requests/${id(runRequestId)}`);
}

/** Revoga antes da decisão da máquina (step-up). Depois dela: 409 (cancelar fica fora). */
export function revokeRunRequest(org: string, runRequestId: string): Promise<RunRequest> {
  return send(org, 'revokeRunRequest', `/run-requests/${id(runRequestId)}/revoke`, { method: 'POST' });
}

// ------------------------------------------------------------------ supervisão (execuções registradas pelo Agent)

export type AgentRunQuery = { workspaceId?: string; automationId?: string; state?: AgentSupervisorState[]; cursor?: string; limit?: number };

export function listAgentRuns(org: string, q: AgentRunQuery = {}): Promise<S['AgentRunPage']> {
  return send(org, 'listAgentRuns', `/agent-runs${queryString(q)}`);
}

export function getAgentRun(org: string, runId: string): Promise<AgentRun> {
  return send(org, 'getAgentRun', `/agent-runs/${id(runId)}`);
}

/** Eventos em ordem de `sequence` (observação do Agent), cursor opaco; `limit` 1–100 (padrão 25). */
export function listAgentRunEvents(org: string, runId: string, page: { cursor?: string; limit?: number } = {}): Promise<S['AgentRunEventPage']> {
  return send(org, 'listAgentRunEvents', `/agent-runs/${id(runId)}/events${queryString(page)}`);
}
