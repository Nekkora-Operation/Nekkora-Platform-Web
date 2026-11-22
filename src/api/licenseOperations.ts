/**
 * Atos do OPERADOR DE LICENÇAS da Nekkora (PLATFORM-LICENCIAMENTO-001). `org` é a organização interna da Nekkora (a da sessão
 * do operador); `target` é a organização do cliente. Fora da organização interna estas rotas não existem (404), e quem não
 * está no cadastro de operadores recebe 403. Toda decisão é da API: a tela só apresenta e envia.
 */
import { sessionCsrf } from './auth';
import { request, type RequestOptions } from './http';
import { validated, type OperationId } from './validate';
import type { components, operations } from './generated/nekkora-api-v1';

type S = components['schemas'];
type Ok<K extends keyof operations> = operations[K]['responses'] extends { 200: { content: { 'application/json': infer T } } } ? T : never;

export type EnforcementPreview = S['LicenseEnforcementPreview'];
export type OperatorOrganization = Ok<'getLicenseOperatorOrganization'>;
export type OperatorLicense = OperatorOrganization['licenses'][number];
export type PreviousAgentSession = Ok<'listUnresolvedPreviousAgentSessions'>['items'][number];

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}/license-operations`;
const id = (v: string) => encodeURIComponent(v);

async function send<T>(org: string, operationId: OperationId, path: string, options: RequestOptions = {}): Promise<T> {
  const write = options.method && options.method !== 'GET';
  const { status, data } = await request<unknown>(`${base(org)}${path}`, write ? { ...options, csrf: await sessionCsrf(org) } : options);
  return validated<T>(operationId, data, status);
}

const knownOperator = new Set<string>();

/**
 * A sessão é de um operador de licenças? Qualquer recusa (404 fora da organização interna, 403 sem cadastro) = não. Só o
 * "sim" é lembrado, em memória, enquanto a página está aberta. Não decide acesso: a API confere cada ato.
 */
export async function isLicenseOperator(org: string): Promise<boolean> {
  if (knownOperator.has(org)) return true;
  try {
    const r = await send<{ operator: boolean }>(org, 'getLicenseOperatorStatus', '');
    if (r.operator === true) knownOperator.add(org);
    return r.operator === true;
  } catch {
    return false;
  }
}

/** Só para os testes: esquece o que foi lembrado. */
export function forgetLicenseOperatorForTest() {
  knownOperator.clear();
}

export function getOperatorOrganization(org: string, target: string): Promise<OperatorOrganization> {
  return send(org, 'getLicenseOperatorOrganization', `/organizations/${id(target)}`);
}

export function previewEnforcement(org: string, target: string): Promise<EnforcementPreview> {
  return send(org, 'previewLicenseEnforcement', `/organizations/${id(target)}/enforcement-preview`);
}

export function listUnresolvedSessions(org: string, target: string): Promise<{ items: PreviousAgentSession[] }> {
  return send(org, 'listUnresolvedPreviousAgentSessions', `/organizations/${id(target)}/previous-agent-sessions`);
}

export function grantLicenses(org: string, target: string, body: { count: number; startsAt: string; endsAt: string; justification: string }): Promise<unknown> {
  return send(org, 'grantLicenses', `/organizations/${id(target)}/licenses`, { method: 'POST', body });
}

export function renewLicense(org: string, target: string, licenseId: string, body: { startsAt?: string; endsAt: string; justification: string }): Promise<unknown> {
  return send(org, 'renewLicense', `/organizations/${id(target)}/licenses/${id(licenseId)}/renewal`, { method: 'POST', body });
}

export function endLicense(org: string, target: string, licenseId: string, justification: string): Promise<void> {
  return send(org, 'endLicense', `/organizations/${id(target)}/licenses/${id(licenseId)}/end`, { method: 'POST', body: { justification } });
}

export function transferLicense(
  org: string,
  target: string,
  licenseId: string,
  body: { toAutomationId: string; requesterEmail: string; ticketReference: string; identityVerification: string; justification: string },
): Promise<unknown> {
  return send(org, 'transferLicense', `/organizations/${id(target)}/licenses/${id(licenseId)}/transfer`, { method: 'POST', body });
}

/** Liga (`licensed`, com o `previewToken` da prévia conferida) ou desliga (`legacy`) a exigência de licença. */
export function setEnforcement(
  org: string,
  target: string,
  body: { model: 'licensed' | 'legacy'; confirmPreview?: string; justification: string },
): Promise<unknown> {
  return send(org, 'setLicenseEnforcement', `/organizations/${id(target)}/enforcement`, { method: 'POST', body });
}

/** Reconciliação pelo suporte: registra a justificativa e a verificação realizada. Não altera a sessão. */
export function reconcileSession(org: string, target: string, sessionId: string, body: { justification: string; verification: string }): Promise<unknown> {
  return send(org, 'reconcilePreviousAgentSession', `/organizations/${id(target)}/previous-agent-sessions/${id(sessionId)}/reconciliation`, {
    method: 'POST',
    body,
  });
}

/** Criação excepcional: a pessoa responsável é indicada explicitamente pelo e-mail verificado dela. */
export function createOrganizationByOperator(
  org: string,
  body: { responsibleEmail: string; name: string; legalName: string; justification: string; exceedEmptyLimit?: boolean; limitJustification?: string },
): Promise<{ organizationId: string; emptyLimitExceeded: boolean }> {
  return send(org, 'createOrganizationByOperator', '/organizations', { method: 'POST', body });
}
