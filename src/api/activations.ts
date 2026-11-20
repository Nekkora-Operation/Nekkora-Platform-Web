/**
 * PLATFORM-FLUXO-002 — ativação unificada da automação ("Licenças e automações"), só para quem administra a organização
 * (`org.manage`). Um passo vincula a licença (se a automação ainda não tem) e emite, para os Workers ESCOLHIDOS, as
 * autorizações de execução da versão publicada atual e de monitoramento. A API decide tudo e reconfere cada ato.
 */
import { sessionCsrf } from './auth';
import { request, type RequestOptions } from './http';
import { validated, type OperationId } from './validate';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type AutomationActivation = S['AutomationActivation'];
export type AutomationActivationList = S['AutomationActivationList'];
export type AutomationActivationOptions = S['AutomationActivationOptions'];
export type AutomationActivationOutcome = S['AutomationActivationOutcome'];
export type ActivationResult = AutomationActivationOutcome['results'][number];
export type ActivationState = AutomationActivation['state'];
export type ActivationPending = AutomationActivation['pending'][number];

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

async function send<T>(org: string, operationId: OperationId, path: string, options: RequestOptions = {}): Promise<T> {
  const write = options.method && options.method !== 'GET';
  const { status, data } = await request<unknown>(`${base(org)}${path}`, write ? { ...options, csrf: await sessionCsrf(org) } : options);
  return validated<T>(operationId, data, status);
}

export function listActivations(org: string): Promise<AutomationActivationList> {
  return send(org, 'listAutomationActivations', '/automation-activations');
}

export function getActivationOptions(org: string, workspaceId: string): Promise<AutomationActivationOptions> {
  return send(org, 'getAutomationActivationOptions', `/automation-activations/options?workspaceId=${id(workspaceId)}`);
}

/** Ativar, concluir ou acrescentar Workers (o mesmo ato; nada é consumido de novo). {@code validUntil}: só no modelo anterior. */
export function activateAutomation(org: string, automationId: string, workerIds: string[], validUntil?: string): Promise<AutomationActivationOutcome> {
  return send(org, 'activateAutomation', '/automation-activations', {
    method: 'POST',
    body: { automationId, workerIds, ...(validUntil ? { validUntil } : {}) },
  });
}

export function acceptActivationVersion(org: string, automationId: string, automationVersionId: string, validUntil?: string): Promise<AutomationActivationOutcome> {
  return send(org, 'acceptAutomationActivationVersion', `/automation-activations/${id(automationId)}/version`, {
    method: 'POST',
    body: { automationVersionId, ...(validUntil ? { validUntil } : {}) },
  });
}

export function renewActivation(org: string, automationId: string): Promise<AutomationActivationOutcome> {
  return send(org, 'renewAutomationActivation', `/automation-activations/${id(automationId)}/renewal`, { method: 'POST' });
}
