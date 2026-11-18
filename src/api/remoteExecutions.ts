/**
 * Execução remota (PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T02), lado das PESSOAS: solicitar que uma versão publicada rode numa
 * máquina habilitada, acompanhar, pedir o cancelamento e executar novamente em outra máquina. O canal da máquina
 * (/agent/api/v1/*) NUNCA é chamado pelo navegador. Solicitar não prova início: o estado vem do que a máquina informar.
 */
import { sessionCsrf } from './auth';
import { ApiError, apiErrorFrom, request, safeRequestId, type RequestOptions } from './http';
import { localSha256 } from './lifecycle';
import { validated, type OperationId } from './validate';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type RemoteExecution = S['RemoteExecution'];
export type RemoteAttempt = RemoteExecution['attempts'][number];
export type RemoteAttemptState = S['RemoteAttemptState'];
export type RemoteCandidate = S['RemoteExecutionCandidateList']['items'][number];
export type RemoteMissing = RemoteCandidate['missing'][number];
export type RemotePythonChoice = S['RemotePythonChoice'];
export type RemoteDependencyCheck = S['RemoteDependencyCheck'];
export type RemoteAttemptResults = S['RemoteAttemptResults'];
export type RemoteAttemptLogs = S['RemoteAttemptLogs'];

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

/**
 * As solicitações mais recentes dos workspaces VISÍVEIS para a pessoa (telas Execuções e Supervisão). É a mesma solicitação
 * das outras leituras, com as suas tentativas. Filtros opcionais: workspace, automação e período da solicitação.
 */
export function listVisibleRemoteExecutions(
  org: string,
  q: { workspaceId?: string; automationId?: string; from?: string; to?: string; limit?: number } = {},
): Promise<{ items: RemoteExecution[] }> {
  const sp = new URLSearchParams();
  if (q.workspaceId) sp.set('workspaceId', q.workspaceId);
  if (q.automationId) sp.set('automationId', q.automationId);
  if (q.from) sp.set('from', q.from);
  if (q.to) sp.set('to', q.to);
  sp.set('limit', String(q.limit ?? 25));
  return send(org, 'listVisibleRemoteExecutions', `/remote-executions?${sp.toString()}`);
}

/** Uma solicitação, com as suas tentativas. */
export function getRemoteExecution(org: string, remoteExecutionId: string): Promise<RemoteExecution> {
  return send(org, 'getRemoteExecution', `/remote-executions/${id(remoteExecutionId)}`);
}

/**
 * Escolhe o ambiente Python de uma automação NUMA máquina habilitada (T01c parte 3). Só um ambiente do inventário atual da
 * máquina; vai o identificador opaco que ela publicou, nunca um caminho. A escolha de uma máquina não vale para outra.
 */
export function selectRemoteMachinePython(org: string, automationId: string, agentId: string, environmentId: string): Promise<RemotePythonChoice> {
  return send(org, 'selectRemoteMachinePython', `/automations/${id(automationId)}/remote-machines/${id(agentId)}/python-selection`, {
    method: 'PUT',
    body: { environmentId },
  });
}

/**
 * Pede à máquina que confira, agora, as dependências declaradas da automação no Python escolhido para ela (plano 5.9). O
 * resultado chega depois, em `dependencyCheck`, na lista de máquinas. É informação: nada é instalado, e a conferência que vale
 * para executar continua sendo a da máquina, antes de iniciar. No máximo um pedido por minuto por máquina e automação (429).
 */
export function checkRemoteMachineDependencies(org: string, automationId: string, agentId: string): Promise<RemoteDependencyCheck> {
  return send(org, 'checkRemoteMachineDependencies', `/automations/${id(automationId)}/remote-machines/${id(agentId)}/dependency-check`, { method: 'POST' });
}

/**
 * As linhas da saída do processo de uma tentativa, a partir da sequência `after` (exclusiva), e o fechamento do envio (T05).
 * Exige logs.read. Só existem linhas de tentativa remota.
 */
export function listRemoteAttemptLogs(org: string, remoteExecutionId: string, attemptId: string, after: number, limit = 500): Promise<RemoteAttemptLogs> {
  return send(org, 'listRemoteAttemptLogs', `/remote-executions/${id(remoteExecutionId)}/attempts/${id(attemptId)}/logs?after=${Math.max(0, Math.trunc(after))}&limit=${limit}`);
}

/** Os arquivos de resultado de uma tentativa e o fechamento do envio (T03 parte b). Exige logs.read. */
export function listRemoteAttemptResults(org: string, remoteExecutionId: string, attemptId: string): Promise<RemoteAttemptResults> {
  return send(org, 'listRemoteAttemptResults', `/remote-executions/${id(remoteExecutionId)}/attempts/${id(attemptId)}/results`);
}

/**
 * Bytes de um arquivo de resultado (exige logs.read; o download fica na trilha da automação). A API relê e confere os bytes;
 * aqui o SHA-256 recebido é conferido de novo contra o da lista antes de entregar o arquivo à pessoa. Não executa nada.
 */
export async function downloadRemoteAttemptResult(org: string, remoteExecutionId: string, attemptId: string, number: number, expectedSha256: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${base(org)}/remote-executions/${id(remoteExecutionId)}/attempts/${id(attemptId)}/results/${number}/content`, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream, application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError('network', 0);
  }
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
  const blob = await res.blob();
  const sha = await localSha256(blob);
  // sem como conferir (navegador sem crypto.subtle) ou conteúdo diferente do registrado: não entrega o arquivo
  if (!sha || sha !== expectedSha256 || res.headers.get('Nekkora-Result-Sha256') !== expectedSha256) throw new ApiError('unexpected', res.status, undefined, requestId);
  // sempre como dado opaco: o navegador não interpreta o conteúdo
  return new Blob([blob], { type: 'application/octet-stream' });
}

/** Pede o cancelamento (step-up). O que a máquina já recebeu só para quando ela disser. */
export function cancelRemoteExecution(org: string, remoteExecutionId: string): Promise<RemoteExecution> {
  return send(org, 'cancelRemoteExecution', `/remote-executions/${id(remoteExecutionId)}/cancel`, { method: 'POST' });
}

/**
 * Executar novamente em outra máquina (step-up). Só depois que a tentativa anterior terminou — e, se ela terminou com resultado
 * não confirmado, só depois de reconciliada (pela máquina ou declarada): até lá a Platform recusa
 * (`remote_previous_result_unconfirmed`).
 */
export function retryRemoteExecution(org: string, remoteExecutionId: string, agentId: string): Promise<RemoteExecution> {
  return send(org, 'retryRemoteExecution', `/remote-executions/${id(remoteExecutionId)}/attempts`, { method: 'POST', body: { agentId } });
}

export type ReconciliationReason = 'MACHINE_OFF_OUT_OF_OPERATION' | 'PROCESS_ENDED_BY_ADMINISTRATOR' | 'OTHER_VERIFIED';

/**
 * Reconciliação DECLARADA por quem administra a organização (step-up): para quando não é possível obter a confirmação da
 * máquina. Não executa nada e não muda o resultado da tentativa; libera uma nova tentativa da solicitação. `acknowledgePartialEffects`
 * vai sempre `true`: a tela só deixa confirmar depois de a pessoa marcar.
 */
export function reconcileRemoteAttempt(
  org: string,
  remoteExecutionId: string,
  attemptId: string,
  reason: ReconciliationReason,
  verification: string,
): Promise<RemoteExecution> {
  return send(org, 'reconcileRemoteAttempt', `/remote-executions/${id(remoteExecutionId)}/attempts/${id(attemptId)}/reconciliation`, {
    method: 'POST',
    body: { reason, verification, acknowledgePartialEffects: true },
  });
}
