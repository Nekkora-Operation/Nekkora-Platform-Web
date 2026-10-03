/**
 * Permissões do usuário interno autenticado (GAP-02). SÓ para a interface decidir o que APRESENTAR: cada rota
 * autoriza no backend por conta própria. Conta externa recebe 403.
 */
import { request } from './http';
import { queryString } from './query';
import type { MyPermissions, Page, WorkspacePermissions } from './v1';

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;

/** P01: papéis e permissões organizacionais e as que valem em todos os workspaces (ORG_ADMIN). */
export async function getMyPermissions(org: string): Promise<MyPermissions> {
  return (await request<MyPermissions>(`${base(org)}/me/permissions`)).data;
}

/** P02: atribuições EXPLÍCITAS por workspace (ORG_ADMIN sem atribuições recebe lista vazia, embora veja todos). */
export async function listMyWorkspacePermissions(org: string, page: { cursor?: string; limit?: number } = {}): Promise<Page<WorkspacePermissions>> {
  return (await request<Page<WorkspacePermissions>>(`${base(org)}/me/permissions/workspaces${queryString(page)}`)).data;
}

/** Efetivo em um workspace = allWorkspaces.permissions ∪ permissões explícitas daquele workspace. */
export function effectiveInWorkspace(me: MyPermissions, explicit: WorkspacePermissions | undefined): Set<string> {
  return new Set<string>([...me.allWorkspaces.permissions, ...(explicit?.permissions ?? [])]);
}
