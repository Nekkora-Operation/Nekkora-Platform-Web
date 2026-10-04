import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '../api/http';
import { listWorkspaces } from '../api/product';
import type { Workspace } from '../api/v1';

/** Itens por página de workspaces (máximo do contrato). */
export const WORKSPACE_PAGE_LIMIT = 100;

export type VisibleWorkspaces =
  | { status: 'loading'; items: Workspace[] }
  /**
   * `complete` = o cursor acabou (a lista carregada é a lista inteira); senão, há mais páginas a pedir.
   * `cursorRejected` = a API recusou a continuação (400: lista mudou, chave rotacionada…): o cursor foi descartado e só
   * o recomeço (nova primeira página, por ação da pessoa) continua a lista.
   */
  | { status: 'ready'; items: Workspace[]; complete: boolean; loadingMore: boolean; moreError?: unknown; cursorRejected?: boolean }
  | { status: 'error'; items: Workspace[]; error: unknown };

/**
 * Workspaces visíveis da pessoa = `listWorkspaces` (GAP-06: `automation.read` efetivo, papel organizacional OU
 * atribuição no workspace). NÃO usa a P02 para isso: a P02 lista só atribuições explícitas e um ORG_ADMIN pode tê-la
 * vazia com acesso global.
 *
 * Paginação SOB DEMANDA: ao entrar carrega só a primeira página; `loadMore` pede a seguinte pelo cursor enquanto houver
 * (uma de cada vez). Enquanto não acabar, a lista é PARCIAL (`complete` = false) e nenhuma contagem dela é total. Falha
 * na primeira página → `error`. Ao pedir mais:
 * - falha transitória (rede, 5xx…) → mantém o carregado e o cursor, expõe `moreError`; nova tentativa reaproveita o cursor;
 * - cursor recusado (400) → mantém o carregado, DESCARTA o cursor e marca `cursorRejected`; nada é repetido
 *   automaticamente e o cursor recusado nunca é reenviado; `restart` pede uma nova primeira página sem cursor.
 * 401 → `onUnauthenticated`.
 */
export function useVisibleWorkspaces(org: string, onUnauthenticated: () => void) {
  const [state, setState] = useState<VisibleWorkspaces>({ status: 'loading', items: [] });
  const generation = useRef(0);
  const cursor = useRef<string | null>(null);
  const busy = useRef(false);
  const unauth = useRef(onUnauthenticated);
  unauth.current = onUnauthenticated;

  const fail = (gen: number, e: unknown, apply: () => void) => {
    if (gen !== generation.current) return;
    busy.current = false;
    if (isApiError(e, 'unauthenticated')) return unauth.current();
    apply();
  };

  const load = useCallback(async () => {
    const gen = ++generation.current;
    busy.current = true;
    cursor.current = null;
    setState({ status: 'loading', items: [] });
    try {
      const res = await listWorkspaces(org, { limit: WORKSPACE_PAGE_LIMIT });
      if (gen !== generation.current) return;
      busy.current = false;
      cursor.current = res.nextCursor;
      setState({ status: 'ready', items: res.items, complete: res.nextCursor === null, loadingMore: false });
    } catch (e) {
      fail(gen, e, () => setState({ status: 'error', items: [], error: e }));
    }
  }, [org]);

  const loadMore = useCallback(async () => {
    const next = cursor.current;
    if (!next || busy.current) return;
    busy.current = true;
    const gen = generation.current;
    setState((s) => (s.status === 'ready' ? { ...s, loadingMore: true, moreError: undefined } : s));
    try {
      const res = await listWorkspaces(org, { limit: WORKSPACE_PAGE_LIMIT, cursor: next });
      if (gen !== generation.current) return;
      busy.current = false;
      cursor.current = res.nextCursor;
      setState((s) => {
        const seen = new Set(s.items.map((w) => w.workspaceId));
        const items = [...s.items, ...res.items.filter((w) => !seen.has(w.workspaceId))];
        return { status: 'ready', items, complete: res.nextCursor === null, loadingMore: false };
      });
    } catch (e) {
      fail(gen, e, () => {
        if (isApiError(e, 'invalid_request')) {
          cursor.current = null; // continuação recusada: nunca reenviar
          setState((s) => (s.status === 'ready' ? { ...s, loadingMore: false, moreError: undefined, cursorRejected: true } : s));
        } else {
          setState((s) => (s.status === 'ready' ? { ...s, loadingMore: false, moreError: e } : s));
        }
      });
    }
  }, [org]);

  /** Recomeço por ação da pessoa: nova primeira página SEM cursor; o carregado continua visível até a resposta. */
  const restart = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const gen = generation.current;
    setState((s) => (s.status === 'ready' ? { ...s, loadingMore: true, moreError: undefined } : s));
    try {
      const res = await listWorkspaces(org, { limit: WORKSPACE_PAGE_LIMIT });
      if (gen !== generation.current) return;
      busy.current = false;
      cursor.current = res.nextCursor;
      setState({ status: 'ready', items: res.items, complete: res.nextCursor === null, loadingMore: false });
    } catch (e) {
      fail(gen, e, () => setState((s) => (s.status === 'ready' ? { ...s, loadingMore: false, moreError: e } : s)));
    }
  }, [org]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  return { workspaces: state, reloadWorkspaces: load, loadMoreWorkspaces: loadMore, restartWorkspaces: restart };
}
