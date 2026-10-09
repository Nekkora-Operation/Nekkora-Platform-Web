/**
 * Administração (contrato 8.7 + GAP-03). Leituras: membros (org.manage), concessões (external_access.manage),
 * clientes (org.manage OU external_access.manage). Escritas exigem sessão + CSRF de sessão + Origin.
 * O backend é a autoridade: a interface só apresenta.
 */
import { sessionCsrf } from './auth';
import { ApiError, request } from './http';
import { readJson } from './validate';
import { queryString } from './query';
import type { Client, ClientGrant, Member, MfaResetReason, Page, Query } from './v1';

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

export type MemberQuery = Query<'listMembers'>;
export type ClientGrantQuery = Query<'listClientGrants'>;
export type ClientQuery = Query<'listClients'>;

export async function listMembers(org: string, q: MemberQuery = {}): Promise<Page<Member>> {
  return readJson<Page<Member>>('listMembers', `${base(org)}/members${queryString(q)}`);
}

/** Filtro clientId/workspaceId inexistente ou de outra organização → lista vazia (exceção documentada, DC-05). */
export async function listClientGrants(org: string, q: ClientGrantQuery = {}): Promise<Page<ClientGrant>> {
  return readJson<Page<ClientGrant>>('listClientGrants', `${base(org)}/client-grants${queryString(q)}`);
}

export async function listClients(org: string, q: ClientQuery = {}): Promise<Page<Client>> {
  return readJson<Page<Client>>('listClients', `${base(org)}/clients${queryString(q)}`);
}

/**
 * Escrita administrativa: o contrato documenta só 204 como sucesso. Qualquer outro 2xx é resposta fora do contrato
 * (`unexpected`) — quem chama trata como resultado INCERTO, nunca como sucesso.
 */
async function sessionPost(org: string, path: string, body?: unknown, beforeSend?: () => void): Promise<void> {
  const csrf = await sessionCsrf(org);
  beforeSend?.(); // F6a-4-R1: conferência de quem chama DEPOIS da espera pelo CSRF e ANTES de o POST sair
  const res = await request(`${base(org)}${path}`, { method: 'POST', body, csrf });
  if (res.status !== 204) throw new ApiError('unexpected', res.status);
}

/** Idempotente: concessão já revogada → 204. */
export async function revokeClientGrant(org: string, grantId: string): Promise<void> {
  await sessionPost(org, `/client-grants/${id(grantId)}/revoke`);
}

export async function suspendUser(org: string, userId: string): Promise<void> {
  await sessionPost(org, `/users/${id(userId)}/suspend`);
}

export async function reactivateUser(org: string, userId: string): Promise<void> {
  await sessionPost(org, `/users/${id(userId)}/reactivate`);
}

/** Exige step-up TOTP recente NA MESMA sessão (`stepUp` em auth.ts); sem ele → 403. */
export async function resetUserMfa(org: string, userId: string, reason: MfaResetReason, { beforeSend }: { beforeSend?: () => void } = {}): Promise<void> {
  await sessionPost(org, `/users/${id(userId)}/mfa/reset`, { reason }, beforeSend);
}
