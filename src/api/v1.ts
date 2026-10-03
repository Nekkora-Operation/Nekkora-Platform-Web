/**
 * Tipos do contrato da API v1, derivados do OpenAPI definitivo (src/api/generated, gerado por `npm run contract:gen`).
 * Nada aqui é escrito à mão: só apelidos legíveis para os esquemas e os filtros das operações.
 */
import type { components, operations } from './generated/nekkora-api-v1';

type S = components['schemas'];

/** Página de lista com cursor opaco: `nextCursor` nulo = não havia mais itens no momento da consulta. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// permissões (GAP-02)
export type MyPermissions = S['MyPermissions'];
export type WorkspacePermissions = S['WorkspacePermissions'];
export type PermissionCode = S['PermissionCode'];

// administração (GAP-03)
export type Member = S['Member'];
export type ClientGrant = S['ClientGrant'];
export type Client = S['Client'];
export type MembershipStatus = S['MembershipStatus'];
export type GrantStatus = S['GrantStatus'];
export type ResourceStatus = S['ResourceStatus'];
export type MfaResetReason = S['MfaResetRequest']['reason'];

// produto (GAP-06)
export type Workspace = S['Workspace'];
export type Automation = S['Automation'];
export type AutomationVersion = S['AutomationVersion'];
export type Execution = S['Execution'];
export type ExecutionDetail = S['ExecutionDetail'];
export type ExecutionEvent = S['ExecutionEvent'];
export type ExecutionStatus = S['ExecutionStatus'];

// portal externo (013)
export type PortalWorkspace = S['PortalWorkspaceList']['items'][number];
export type PortalExecution = S['PortalExecution'];
export type PortalEvent = S['PortalEventList']['items'][number];

/** Filtros de query de cada operação, como o contrato os declara. */
export type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;
