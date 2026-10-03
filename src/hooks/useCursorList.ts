import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError, type ApiError } from '../api/http';
import type { Page } from '../api/v1';

/**
 * Lista paginada por cursor opaco (contrato GAP-02/03/06, §1.4–§1.5).
 *
 * - Não há total nem número de página: a interface oferece "carregar mais" enquanto `nextCursor` não for nulo.
 * - Cada página é uma consulta nova sobre o estado ATUAL; mudanças entre páginas podem repetir ou omitir itens
 *   (documentado). A interface não tenta "corrigir" isso, só não duplica chaves já exibidas.
 * - Cursor recusado (400 ao pedir a página seguinte: adulterado, de outra rota ou filtro, ou assinado com chave
 *   desconhecida — por exemplo, depois da rotação da chave, que invalida os cursores emitidos, DC-15) → a lista
 *   exibida continua, "carregar mais" é desligado e `cursorRejected` fica verdadeiro: a tela OFERECE recomeçar
 *   (`reload`). Nada é repetido automaticamente. Limitação: qualquer 400 em "carregar mais" é tratado assim; hoje
 *   só o cursor muda entre as páginas.
 * - Uma página seguinte por vez: a trava é síncrona (ref), então duas chamadas antes do próximo render fazem uma só
 *   requisição, e o cursor usado é sempre o da última página aplicada.
 * - Mudar `deps` (filtros, organização) ou `reload` descarta a lista na hora; respostas da lista anterior (primeira
 *   página ou "carregar mais" em andamento) são ignoradas e não alteram itens nem cursor.
 * - Falha na PRIMEIRA página → status `error`. Falha ao carregar MAIS → a lista exibida continua, `error` é
 *   preenchido e "carregar mais" pode ser tentado de novo.
 */
export type CursorListStatus = 'loading' | 'ready' | 'loading-more' | 'error';

export interface CursorList<T> {
  items: T[];
  status: CursorListStatus;
  error?: ApiError | Error;
  hasMore: boolean;
  cursorRejected: boolean;
  loadMore: () => void;
  reload: () => void;
}

export function useCursorList<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  keyOf: (item: T) => string,
  deps: readonly unknown[],
): CursorList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [status, setStatus] = useState<CursorListStatus>('loading');
  const [error, setError] = useState<ApiError | Error | undefined>();
  const [next, setNext] = useState<string | null>(null);
  const [cursorRejected, setCursorRejected] = useState(false);
  // Estado síncrono (não espera render): geração da lista, cursor da última página aplicada e trava de requisição.
  const generation = useRef(0);
  const nextRef = useRef<string | null>(null);
  const busy = useRef(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;

  const applyNext = (cursor: string | null) => {
    nextRef.current = cursor;
    setNext(cursor);
  };

  const loadFirst = useCallback(() => {
    const gen = ++generation.current;
    busy.current = true;
    applyNext(null);
    setItems([]);
    setError(undefined);
    setStatus('loading');
    setCursorRejected(false);
    fetchRef.current(undefined).then(
      (page) => {
        if (gen !== generation.current) return;
        busy.current = false;
        setItems(page.items);
        applyNext(page.nextCursor);
        setStatus('ready');
      },
      (e: unknown) => {
        if (gen !== generation.current) return;
        busy.current = false;
        setError(e instanceof Error ? e : new Error(String(e)));
        setStatus('error');
      },
    );
  }, []);

  // recarrega da primeira página quando os filtros (deps) mudam
  useEffect(() => loadFirst(), deps);

  const loadMore = useCallback(() => {
    const cursor = nextRef.current;
    if (!cursor || busy.current) return;
    busy.current = true;
    const gen = generation.current;
    setError(undefined);
    setStatus('loading-more');
    fetchRef.current(cursor).then(
      (page) => {
        if (gen !== generation.current) return;
        busy.current = false;
        setItems((prev) => {
          const seen = new Set(prev.map((i) => keyRef.current(i)));
          return [...prev, ...page.items.filter((i) => !seen.has(keyRef.current(i)))];
        });
        applyNext(page.nextCursor);
        setStatus('ready');
      },
      (e: unknown) => {
        if (gen !== generation.current) return;
        busy.current = false;
        if (isApiError(e, 'invalid_request')) {
          // cursor recusado: não há próxima página utilizável; recomeçar é decisão de quem usa a tela
          applyNext(null);
          setCursorRejected(true);
          setStatus('ready');
          return;
        }
        // a lista já exibida continua; o erro fica exposto e "carregar mais" pode ser tentado de novo
        setError(e instanceof Error ? e : new Error(String(e)));
        setStatus('ready');
      },
    );
  }, []);

  const reload = useCallback(() => loadFirst(), [loadFirst]);

  return { items, status, error, hasMore: next !== null, cursorRejected, loadMore, reload };
}
