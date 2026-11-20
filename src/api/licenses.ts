/**
 * Licenças, capacidade e pedidos de criação de organização (PLATFORM-LICENCIAMENTO-001), lado de quem ADMINISTRA a
 * organização (`org.manage`). O navegador só lê e vincula uma licença disponível a uma automação; conceder, renovar,
 * encerrar, transferir e ligar a exigência são atos do suporte da Nekkora. Capacidade é separada das licenças: atingir um
 * limite de capacidade nunca consome nem libera licença. Toda decisão é da API.
 */
import { sessionCsrf } from './auth';
import { request, type RequestOptions } from './http';
import { validated, type OperationId } from './validate';
import type { components, operations } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type LicenseSummary = S['LicenseSummary'];
export type OrganizationLicense = S['OrganizationLicense'];
export type LicenseAssignment = S['LicenseAssignment'];
export type OrganizationCapacity = operations['getOrganizationCapacity']['responses']['200']['content']['application/json'];
export type OrganizationRequest = S['OrganizationRequest'];
export type OrganizationRequestDecision = S['OrganizationRequestDecision'];
export type Responsible = 'APPROVER' | 'REQUESTER';

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

async function send<T>(org: string, operationId: OperationId, path: string, options: RequestOptions = {}): Promise<T> {
  const write = options.method && options.method !== 'GET';
  const { status, data } = await request<unknown>(`${base(org)}${path}`, write ? { ...options, csrf: await sessionCsrf(org) } : options);
  return validated<T>(operationId, data, status);
}

/** A conta das licenças, feita no servidor sobre todas elas (nunca a soma de uma página). */
export function getLicenseSummary(org: string): Promise<LicenseSummary> {
  return send(org, 'getLicenseSummary', '/licenses/summary');
}

/** Todas as licenças da organização, página a página, na ordem do número. */
export async function listAllLicenses(org: string): Promise<OrganizationLicense[]> {
  const all: OrganizationLicense[] = [];
  let cursor: string | null = null;
  // teto de páginas: uma lista que não termina é resposta fora do contrato, não motivo para travar a tela
  for (let page = 0; page < 20; page++) {
    const data: S['OrganizationLicensePage'] = await send(
      org,
      'listOrganizationLicenses',
      `/licenses?limit=100${cursor ? `&cursor=${id(cursor)}` : ''}`,
    );
    all.push(...data.items);
    cursor = data.nextCursor;
    if (!cursor) break;
  }
  return all;
}

/** Ocupação e limites TÉCNICOS de capacidade. Não tem relação com a quantidade de licenças. */
export function getCapacity(org: string): Promise<OrganizationCapacity> {
  return send(org, 'getOrganizationCapacity', '/capacity');
}

/** Vincula uma licença disponível a uma automação (confirmação reforçada). O vínculo não é desfeito por aqui. */
export function assignLicense(org: string, licenseId: string, automationId: string): Promise<LicenseAssignment> {
  return send(org, 'assignLicense', `/licenses/${id(licenseId)}/assignment`, { method: 'POST', body: { automationId } });
}

/** Pedidos de criação de organização feitos a esta organização. */
export function listOrganizationRequests(org: string): Promise<{ items: OrganizationRequest[] }> {
  return send(org, 'listOrganizationRequests', '/organization-requests');
}

/**
 * Aprova escolhendo o responsável pela nova organização. A escolha concede a administração da nova organização e decide de
 * quem é contado o limite de organizações vazias; o servidor reconfere esse limite na hora.
 */
export function approveOrganizationRequest(org: string, requestId: string, responsible: Responsible): Promise<OrganizationRequestDecision> {
  return send(org, 'approveOrganizationRequest', `/organization-requests/${id(requestId)}/approve`, { method: 'POST', body: { responsible } });
}

export function refuseOrganizationRequest(org: string, requestId: string, reason: string): Promise<OrganizationRequestDecision> {
  return send(org, 'refuseOrganizationRequest', `/organization-requests/${id(requestId)}/refuse`, { method: 'POST', body: { reason } });
}
