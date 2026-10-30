import { useEffect, useState } from 'react';
import { isApiError } from '../api/http';
import { effectiveInWorkspace, listMyWorkspacePermissions } from '../api/permissions';
import type { PermissionCode, WorkspacePermissions } from '../api/v1';
import { useInternalArea } from './InternalShell';
import { useSession } from './session';

/** Páginas de P02 lidas no máximo para achar um workspace (100 por página). Além disso, a tela não oferece a ação. */
const MAX_PAGES = 10;

export type WorkspacePermissionState = { status: 'loading' } | { status: 'ready'; has: (p: PermissionCode) => boolean } | { status: 'unknown' };

/**
 * Permissões EFETIVAS num workspace = P01.allWorkspaces ∪ P02 (atribuição explícita daquele workspace). Só decide o que
 * a tela OFERECE: cada rota autoriza no backend. Sem P01 ou com falha: `unknown` — a tela não oferece a ação (o endereço
 * direto continua com a API decidindo).
 */
export function useWorkspacePermissions(workspaceId: string | undefined): WorkspacePermissionState {
  const { org, expired } = useSession();
  const { permissions } = useInternalArea();
  const [state, setState] = useState<WorkspacePermissionState>({ status: 'loading' });

  useEffect(() => {
    if (!workspaceId || permissions.status === 'loading') return setState({ status: 'loading' });
    if (permissions.status === 'error') return setState({ status: 'unknown' });
    let alive = true;
    (async () => {
      let explicit: WorkspacePermissions | undefined;
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await listMyWorkspacePermissions(org, { limit: 100, cursor });
        explicit = data.items.find((w) => w.workspaceId === workspaceId);
        if (explicit || !data.nextCursor) break;
        cursor = data.nextCursor;
      }
      if (!alive) return;
      const set = effectiveInWorkspace(permissions.data, explicit);
      setState({ status: 'ready', has: (p) => set.has(p) });
    })().catch((e) => {
      if (!alive) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      setState({ status: 'unknown' });
    });
    return () => {
      alive = false;
    };
  }, [org, workspaceId, permissions, expired]);

  return state;
}
