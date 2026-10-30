/**
 * Acessos da organização (contrato de 2026-10-27; 023/024): convites, papéis, retirada de vínculo, concessões e
 * auditoria. Escritas com sessão de organização + CSRF + Origin; as marcadas exigem step-up de até 5 min NA MESMA sessão
 * (`stepUp` em auth.ts), pedido imediatamente antes pela tela. Cada resposta é conferida contra o esquema do status.
 * O backend é a autoridade: a interface só apresenta.
 */
import { sessionCsrf } from './auth';
import { request, type RequestOptions } from './http';
import { queryString } from './query';
import { validated, type OperationId } from './validate';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type Invitation = S['InvitationList']['items'][number];
export type InvitationCreated = S['InvitationCreated'];
export type RoleCode = S['RoleCode'];
export type MemberRoles = S['MemberRoles'];
export type RoleAssignment = S['RoleAssignment'];
export type GrantState = S['GrantState'];
export type AccessEvent = S['AccessEventPage']['items'][number];
export type LifecycleWorkspace = S['LifecycleWorkspace'];

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

async function send<T>(org: string, operationId: OperationId, path: string, options: RequestOptions = {}): Promise<T> {
  const write = options.method && options.method !== 'GET';
  const { status, data } = await request<unknown>(`${base(org)}${path}`, write ? { ...options, csrf: await sessionCsrf(org) } : options);
  return validated<T>(operationId, data, status);
}

// ------------------------------------------------------------------ workspaces (workspace.lifecycle)

/** Cria workspace interno (nasce ACTIVE). Sem step-up. */
export function createWorkspace(org: string, name: string, description?: string): Promise<LifecycleWorkspace> {
  return send(org, 'createWorkspace', '/workspaces', { method: 'POST', body: description ? { name, description } : { name } });
}

// ------------------------------------------------------------------ convites (org.manage)

export function listInvitations(org: string, state: 'pending' | 'all' = 'pending'): Promise<S['InvitationList']> {
  return send(org, 'listInvitations', `/invitations${queryString({ state })}`);
}

/** Step-up. 409 = convite aberto para o e-mail (use o reenvio) ou destinatária já cadastrada. Sem token na resposta. */
export function issueInvitation(org: string, email: string, role?: RoleCode, workspaceId?: string): Promise<InvitationCreated> {
  return send(org, 'issueInvitation', '/invitations', {
    method: 'POST',
    body: { email, ...(role ? { role } : {}), ...(workspaceId ? { workspaceId } : {}) },
  });
}

/** Step-up. Revoga o aberto (REENVIADO) e emite outro; o link anterior deixa de valer. */
export function resendInvitation(org: string, invitationId: string): Promise<InvitationCreated> {
  return send(org, 'resendInvitation', `/invitations/${id(invitationId)}/resend`, { method: 'POST' });
}

/** Sem step-up; idempotente (já revogado: 204). Aceito: 409. */
export function revokeInvitation(org: string, invitationId: string): Promise<void> {
  return send(org, 'revokeInvitation', `/invitations/${id(invitationId)}/revoke`, { method: 'POST' });
}

// ------------------------------------------------------------------ papéis e vínculo

export function listMemberRoles(org: string, userId: string): Promise<MemberRoles> {
  return send(org, 'listMemberRoles', `/users/${id(userId)}/roles`);
}

/** Step-up. Repetição devolve a atribuição existente (200). Nunca o próprio ator (403). */
export function assignRole(org: string, userId: string, role: RoleCode, workspaceId?: string): Promise<RoleAssignment> {
  return send(org, 'assignRole', `/users/${id(userId)}/roles`, { method: 'POST', body: workspaceId ? { role, workspaceId } : { role } });
}

/** Step-up. Mesmo escopo; papel novo já ativo: 409. */
export function replaceRole(org: string, assignmentId: string, role: RoleCode): Promise<RoleAssignment> {
  return send(org, 'replaceRole', `/role-assignments/${id(assignmentId)}/replace`, { method: 'POST', body: { role } });
}

/** Sem step-up; idempotente. Último ORG_ADMIN ou o próprio ator: 403. */
export function revokeRole(org: string, assignmentId: string): Promise<void> {
  return send(org, 'revokeRole', `/role-assignments/${id(assignmentId)}/revoke`, { method: 'POST' });
}

/** Sem step-up; idempotente. Papéis revogados e sessões da organização encerradas; a identidade não muda. */
export function revokeMembership(org: string, userId: string): Promise<void> {
  return send(org, 'revokeMembership', `/users/${id(userId)}/membership/revoke`, { method: 'POST' });
}

// ------------------------------------------------------------------ concessões (external_access.manage)

export function createClientGrant(
  org: string,
  body: { clientMembershipId: string; workspaceId: string; startsAt?: string; expiresAt?: string; nextReviewAt: string },
): Promise<GrantState> {
  return send(org, 'createClientGrant', '/client-grants', { method: 'POST', body });
}

/** Step-up; outra pessoa; valores iguais aos pedidos (senão 409). */
export function approveClientGrant(org: string, grantId: string, values: { nextReviewAt: string; expiresAt?: string; justification?: string }): Promise<GrantState> {
  return send(org, 'approveClientGrant', `/client-grants/${id(grantId)}/approve`, { method: 'POST', body: values });
}

/** Sem step-up; grava o pedido (202) sem mudar o acesso. `expiresAt` ausente = sem prazo. */
export function requestClientGrantRenewal(org: string, grantId: string, values: { nextReviewAt: string; expiresAt?: string; justification: string }): Promise<GrantState> {
  return send(org, 'requestClientGrantRenewal', `/client-grants/${id(grantId)}/renew`, { method: 'POST', body: values });
}

/** Step-up; outra pessoa; valores iguais aos do pedido. */
export function approveClientGrantRenewal(org: string, grantId: string, values: { nextReviewAt: string; expiresAt?: string }): Promise<GrantState> {
  return send(org, 'approveClientGrantRenewal', `/client-grants/${id(grantId)}/renew/approve`, { method: 'POST', body: values });
}

/**
 * KEEP (step-up): sem `nextReviewAt` (ou a mesma data) só registra a revisão e PRESERVA o prazo; data mais cedo reduz;
 * mais tarde → 409 (use a renovação). SUSPEND e REVOKE descartam o pedido de renovação pendente.
 */
export function reviewClientGrant(org: string, grantId: string, review: { decision: 'KEEP' | 'SUSPEND' | 'REVOKE'; notes?: string; nextReviewAt?: string }): Promise<GrantState> {
  return send(org, 'reviewClientGrant', `/client-grants/${id(grantId)}/review`, { method: 'POST', body: review });
}

// ------------------------------------------------------------------ auditoria

export function listAccessEvents(org: string, page: { cursor?: string; limit?: number } = {}): Promise<S['AccessEventPage']> {
  return send(org, 'listAccessEvents', `/access-events${queryString(page)}`);
}
