/**
 * F1: paginação por cursor genérica (carregar mais, fim da lista, troca de filtro, cursor recusado, falhas).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http';
import type { Page } from '../api/v1';
import { useCursorList } from './useCursorList';

type Item = { id: string };
const page = (ids: string[], next: string | null): Page<Item> => ({ items: ids.map((id) => ({ id })), nextCursor: next });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useCursorList', () => {
  it('carrega a primeira página, depois mais, até nextCursor nulo', async () => {
    const fetchPage = vi.fn(async (cursor?: string) => (cursor === undefined ? page(['a', 'b'], 'c1') : page(['c'], null)));
    const { result } = renderHook(() => useCursorList(fetchPage, (i) => i.id, []));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(fetchPage).toHaveBeenLastCalledWith('c1');
  });

  it('não duplica chaves já exibidas (repetição possível sob mudança concorrente)', async () => {
    const fetchPage = vi.fn(async (cursor?: string) => (cursor === undefined ? page(['a', 'b'], 'c1') : page(['b', 'c'], null)));
    const { result } = renderHook(() => useCursorList(fetchPage, (i) => i.id, []));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('troca de filtro com lista antiga carregada: os itens antigos somem antes de a nova página chegar', async () => {
    const pending = deferred<Page<Item>>();
    const fetchPage = vi.fn((filter: string) => (filter === 'velho' ? Promise.resolve(page(['v1', 'v2'], 'cv')) : pending.promise));
    const { result, rerender } = renderHook(({ f }) => useCursorList(() => fetchPage(f), (i) => i.id, [f]), { initialProps: { f: 'velho' } });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['v1', 'v2']));
    expect(result.current.hasMore).toBe(true);
    rerender({ f: 'novo' });
    // nova página ainda pendente: nada da lista antiga continua visível nem utilizável
    expect(result.current.items).toEqual([]);
    expect(result.current.status).toBe('loading');
    expect(result.current.hasMore).toBe(false);
    act(() => result.current.loadMore()); // sem cursor do filtro novo: não pede página com o cursor antigo
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(page(['n1'], null)));
    expect(result.current.items.map((i) => i.id)).toEqual(['n1']);
  });

  it('duas chamadas de loadMore antes do render fazem UMA requisição', async () => {
    const more = deferred<Page<Item>>();
    const fetchPage = vi.fn((cursor?: string) => (cursor === undefined ? Promise.resolve(page(['a'], 'c1')) : more.promise));
    const { result } = renderHook(() => useCursorList(fetchPage, (i) => i.id, []));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2); // primeira página + uma única página seguinte
    expect(fetchPage).toHaveBeenLastCalledWith('c1');
    await act(async () => more.resolve(page(['b'], 'c2')));
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b']);
    act(() => result.current.loadMore());
    expect(fetchPage).toHaveBeenLastCalledWith('c2');
  });

  it('resposta antiga de loadMore depois de reload não altera a lista nem o cursor', async () => {
    const oldMore = deferred<Page<Item>>();
    let firstCalls = 0;
    const fetchPage = vi.fn((cursor?: string) => {
      if (cursor === undefined) return Promise.resolve(++firstCalls === 1 ? page(['a'], 'c1') : page(['r1'], 'r-next'));
      if (cursor === 'c1') return oldMore.promise;
      return Promise.resolve(page(['r2'], null));
    });
    const { result } = renderHook(() => useCursorList(fetchPage, (i) => i.id, []));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.loadMore()); // fica pendente com o cursor c1
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['r1']));
    await act(async () => oldMore.resolve(page(['velho'], 'cursor-velho')));
    expect(result.current.items.map((i) => i.id)).toEqual(['r1']);
    expect(result.current.status).toBe('ready');
    act(() => result.current.loadMore()); // usa o cursor da lista recarregada, não o da resposta antiga
    expect(fetchPage).toHaveBeenLastCalledWith('r-next');
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['r1', 'r2']));
  });

  it('resposta antiga de loadMore depois de troca de contexto não altera a lista nem o cursor', async () => {
    const oldMore = deferred<Page<Item>>();
    const fetchPage = vi.fn((filter: string, cursor?: string) => {
      if (filter === 'org-a') return cursor === undefined ? Promise.resolve(page(['a'], 'ca')) : oldMore.promise;
      return Promise.resolve(cursor === undefined ? page(['b'], 'cb') : page(['b2'], null));
    });
    const { result, rerender } = renderHook(({ f }) => useCursorList((c) => fetchPage(f, c), (i) => i.id, [f]), {
      initialProps: { f: 'org-a' },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.loadMore()); // pendente na org-a
    rerender({ f: 'org-b' });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['b']));
    await act(async () => oldMore.resolve(page(['a2'], 'ca2')));
    expect(result.current.items.map((i) => i.id)).toEqual(['b']);
    act(() => result.current.loadMore());
    expect(fetchPage).toHaveBeenLastCalledWith('org-b', 'cb');
  });

  it('troca de filtro descarta a lista e ignora a resposta atrasada da lista anterior', async () => {
    const slow = deferred<Page<Item>>();
    const fetchPage = vi.fn((filter: string) => (filter === 'velho' ? slow.promise : Promise.resolve(page(['novo'], null))));
    const { result, rerender } = renderHook(({ f }) => useCursorList(() => fetchPage(f), (i) => i.id, [f]), { initialProps: { f: 'velho' } });
    rerender({ f: 'novo' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    slow.resolve(page(['atrasado'], 'x'));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.items.map((i) => i.id)).toEqual(['novo']);
    expect(result.current.hasMore).toBe(false);
  });

  it('cursor recusado (400) mantém a lista, desliga "carregar mais" e só recomeça quando pedido', async () => {
    let firstCalls = 0;
    const fetchPage = vi.fn(async (cursor?: string) => {
      if (cursor === undefined) return ++firstCalls === 1 ? page(['a'], 'velho') : page(['a2'], null);
      throw new ApiError('invalid_request', 400);
    });
    const { result } = renderHook(() => useCursorList(fetchPage, (i) => i.id, []));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.cursorRejected).toBe(true));
    expect(result.current.items.map((i) => i.id)).toEqual(['a']);
    expect(result.current.hasMore).toBe(false);
    act(() => result.current.loadMore()); // sem próxima página: não chama de novo
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['a2']));
    expect(result.current.cursorRejected).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('falha na primeira página → error; falha ao carregar mais mantém a lista e permite nova tentativa', async () => {
    const failing = renderHook(() => useCursorList(() => Promise.reject(new ApiError('service_unavailable', 503)), (i: Item) => i.id, []));
    await waitFor(() => expect(failing.result.current.status).toBe('error'));

    let attempt = 0;
    const fetchPage = vi.fn(async (cursor?: string) => {
      if (cursor === undefined) return page(['a'], 'c1');
      attempt++;
      if (attempt === 1) throw new ApiError('network', 0);
      return page(['b'], null);
    });
    const { result } = renderHook(() => useCursorList(fetchPage, (i) => i.id, []));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.status).toBe('ready');
    expect(result.current.items.map((i) => i.id)).toEqual(['a']);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.current.error).toBeUndefined();
  });
});
