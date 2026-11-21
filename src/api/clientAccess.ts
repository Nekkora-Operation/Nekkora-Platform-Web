/**
 * PLATFORM-FLUXO-002 (070): clientes e acessos de cliente, lado da administração. Convite de Cliente para UMA automação
 * (exceção à D-GRANT-1, só administradora, com step-up), cadastro de clientes, concessões por automação (pedido →
 * aprovação por OUTRA pessoa), vínculo de cliente e as leituras de "Acessos e histórico". O servidor confere tudo de novo:
 * a interface só apresenta e pede.
 */
import { sessionCsrf } from './auth';
import { request, type RequestOptions } from './http';
import { queryString } from './query';
import { validated, type OperationId } from './validate';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type ClientInvitationRequest = S['ClientInvitationRequest'];
export type ClientInvitationCreated = S['ClientInvitationCreated'];
export type ClientRecord = S['Client'];
export type ClientDetail = S['ClientDetail'];
export type ClientShareOption = S['ClientShareOption'];
export type ClientAutomationGrant = S['ClientAutomationGrant'];
export type ClientMembershipState = S['ClientMembershipState'];
export type AccessGrant = S['AccessGrant'];
export type AccessGrantPage = S['AccessGrantPage'];
export type AccessGrantSituation = S['AccessGrantSituation'];
export type AccessHistoryEvent = S['AccessHistoryEvent'];
export type AccessHistoryPage = S['AccessHistoryPage'];
export type AccessHistoryCategory = S['AccessHistoryCategory'];
export type PersonClient = S['PersonClient'];
export type PersonClientScope = S['PersonClientScope'];

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

async function send<T>(org: string, operationId: OperationId, path: string, options: RequestOptions = {}): Promise<T> {
  const write = options.method && options.method !== 'GET';
  const { status, data } = await request<unknown>(`${base(org)}${path}`, write ? { ...options, csrf: await sessionCsrf(org) } : options);
  return validated<T>(operationId, data, status);
}

// ------------------------------------------------------------------ convite de Cliente

/** Step-up. Nada é concedido antes do aceite; no aceite o servidor revalida o escopo. */
export function inviteClient(org: string, body: ClientInvitationRequest): Promise<ClientInvitationCreated> {
  return send(org, 'inviteClient', '/client-invitations', { method: 'POST', body });
}

// ------------------------------------------------------------------ cadastro de clientes

export function createClient(org: string, name: string): Promise<ClientRecord> {
  return send(org, 'createClient', '/clients', { method: 'POST', body: { name } });
}

export function updateClient(org: string, clientId: string, body: { name?: string; status?: ClientRecord['status'] }): Promise<ClientRecord> {
  return send(org, 'updateClient', `/clients/${id(clientId)}`, { method: 'PATCH', body });
}

export function getClientDetail(org: string, clientId: string): Promise<ClientDetail> {
  return send(org, 'getClientDetail', `/clients/${id(clientId)}`);
}

export function listClientShareOptions(org: string): Promise<S['ClientShareOptions']> {
  return send(org, 'listClientShareOptions', '/client-share-options');
}

// ------------------------------------------------------------------ concessões por automação (D-GRANT-1)

/** Nasce PENDENTE; só vale com a aprovação de outra pessoa. */
export function requestClientAutomationGrant(
  org: string,
  body: { clientMembershipId: string; automationId: string; workerId: string | null; canReadLogs: boolean; canDownloadResults: boolean },
): Promise<ClientAutomationGrant> {
  return send(org, 'requestClientAutomationGrant', '/client-automation-grants', { method: 'POST', body });
}

/** Step-up; outra pessoa (quem pediu: 403). */
export function approveClientAutomationGrant(org: string, grantId: string): Promise<ClientAutomationGrant> {
  return send(org, 'approveClientAutomationGrant', `/client-automation-grants/${id(grantId)}/approve`, { method: 'POST' });
}

/** Só desliga permissões; ligar exige outro pedido. */
export function reduceClientAutomationGrant(org: string, grantId: string, body: { canReadLogs: boolean; canDownloadResults: boolean }): Promise<ClientAutomationGrant> {
  return send(org, 'reduceClientAutomationGrant', `/client-automation-grants/${id(grantId)}/reduce`, { method: 'POST', body });
}

/** Revoga a ativa ou cancela o pedido; idempotente. */
export function revokeClientAutomationGrant(org: string, grantId: string): Promise<void> {
  return send(org, 'revokeClientAutomationGrant', `/client-automation-grants/${id(grantId)}/revoke`, { method: 'POST' });
}

// ------------------------------------------------------------------ vínculo de cliente (org.manage)

export function suspendClientMembership(org: string, membershipId: string): Promise<ClientMembershipState> {
  return send(org, 'suspendClientMembership', `/client-memberships/${id(membershipId)}/suspend`, { method: 'POST' });
}

/** Step-up. */
export function reactivateClientMembership(org: string, membershipId: string): Promise<ClientMembershipState> {
  return send(org, 'reactivateClientMembership', `/client-memberships/${id(membershipId)}/reactivate`, { method: 'POST' });
}

export function retireClientMembership(org: string, membershipId: string): Promise<ClientMembershipState> {
  return send(org, 'retireClientMembership', `/client-memberships/${id(membershipId)}/retire`, { method: 'POST' });
}

// ------------------------------------------------------------------ acessos e histórico

export type AccessFilters = {
  personId?: string;
  clientId?: string;
  workspaceId?: string;
  automationId?: string;
  workerId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
};

export function listAccessGrants(org: string, q: AccessFilters & { situation?: AccessGrantSituation[] } = {}): Promise<AccessGrantPage> {
  return send(org, 'listAccessGrants', `/access-grants${queryString(q)}`);
}

export function listAccessHistory(org: string, q: AccessFilters & { grantId?: string; category?: AccessHistoryCategory[] } = {}): Promise<AccessHistoryPage> {
  return send(org, 'listAccessHistory', `/access-history${queryString(q)}`);
}
