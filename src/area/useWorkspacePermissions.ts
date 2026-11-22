import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '../api/http';
import { effectiveInWorkspace, listMyWorkspacePermissions } from '../api/permissions';
import type { PermissionCode, WorkspacePermissions } from '../api/v1';
import { useInternalArea } from './InternalShell';
import { useSession } from './session';

/** Páginas de P02 lidas no máximo para achar um workspace (100 por página). Além disso, a tela não oferece a ação. */
const MAX_PAGES = 10;

/**
 * PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T06 — depois de uma falha passageira (429 do limitador ou rede) a conferência é
 * repetida SOZINHA, no máximo estas vezes e com estas esperas; a tela já mostra o aviso e o botão desde a primeira falha.
 * Esgotadas, fica só o botão. É um objeto para os testes encurtarem a espera.
 */
export const permissionsAutoRetry = { delaysMs: [3_000, 10_000] };

export type WorkspacePermissionState =
  | { status: 'loading' }
  | { status: 'ready'; has: (p: PermissionCode) => boolean }
  /** Não foi possível conferir (429, rede, falha das permissões da organização): NÃO quer dizer "sem permissão". */
  | { status: 'unknown'; retry: () => void };

/**
 * Permissões EFETIVAS num workspace = P01.allWorkspaces ∪ P02 (atribuição explícita daquele workspace). Só decide o que
 * a tela OFERECE: cada rota autoriza no backend. Sem P01 ou com falha: `unknown`, com `retry` — a tela não oferece a
 * ação, mas diz que não conseguiu conferir e permite tentar de novo (R1); o endereço direto continua com a API decidindo.
 */
export function useWorkspacePermissions(workspaceId: string | undefined): WorkspacePermissionState {
  const { org, expired } = useSession();
  const { permissions, reloadPermissions } = useInternalArea();
  const [state, setState] = useState<WorkspacePermissionState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // falha nas permissões da organização: relê P01 (o efeito roda de novo quando ela voltar); falha só em P02: relê P02
  const retry = useCallback(() => (permissions.status === 'error' ? reloadPermissions() : setAttempt((n) => n + 1)), [permissions.status, reloadPermissions]);
  // quantas repetições automáticas já foram feitas para ESTE workspace desde a última conferência que deu certo
  const automatic = useRef({ workspace: workspaceId, done: 0 });
  if (automatic.current.workspace !== workspaceId) automatic.current = { workspace: workspaceId, done: 0 };

  useEffect(() => {
    if (!workspaceId || permissions.status === 'loading') return setState({ status: 'loading' });
    if (permissions.status === 'error') return setState({ status: 'unknown', retry });
    // outro workspace (ou P01 relido): a resposta anterior não vale até a nova leitura terminar
    setState({ status: 'loading' });
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
      automatic.current.done = 0;
      setState({ status: 'ready', has: (p) => set.has(p) });
    })().catch((e) => {
      if (!alive) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      // a tela diz logo que não conseguiu conferir; e, se a falha é passageira, confere de novo sozinha depois de esperar
      setState({ status: 'unknown', retry });
      const wait = permissionsAutoRetry.delaysMs[automatic.current.done];
      if (wait != null && (isApiError(e, 'rate_limited') || isApiError(e, 'network'))) {
        timer = setTimeout(() => {
          if (!alive) return;
          automatic.current.done++;
          setAttempt((n) => n + 1);
        }, wait);
      }
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [org, workspaceId, permissions, expired, retry, attempt]);

  return state;
}
