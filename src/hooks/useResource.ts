import { useCallback, useEffect, useRef, useState } from 'react';

export type ResourceState<T> =
  | { status: 'loading'; refreshing: false }
  | { status: 'ready'; data: T; refreshing: boolean }
  | { status: 'error'; error: unknown; refreshing: false };

/**
 * Leitura de UM recurso (detalhe). Regras:
 * - mudar `deps` (organização, identificador) descarta o conteúdo na hora (`loading`, sem dado anterior) e ignora
 *   respostas atrasadas da leitura anterior (contador de geração);
 * - `refresh` (Atualizar) refaz a leitura mesmo com os mesmos parâmetros; o dado exibido continua até a resposta, que o
 *   SUBSTITUI. Erro (inclusive 404) apaga o dado: nunca se mostra conteúdo carregado antes junto de "não encontrado";
 * - nada é repetido automaticamente; nova tentativa só por `refresh`.
 */
export function useResource<T>(fetcher: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading', refreshing: false });
  const generation = useRef(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const run = useCallback((keepData: boolean) => {
    const gen = ++generation.current;
    setState((s) => (keepData && s.status === 'ready' ? { ...s, refreshing: true } : { status: 'loading', refreshing: false }));
    fetchRef.current().then(
      (data) => {
        if (gen === generation.current) setState({ status: 'ready', data, refreshing: false });
      },
      (error: unknown) => {
        if (gen === generation.current) setState({ status: 'error', error, refreshing: false });
      },
    );
  }, []);

  useEffect(() => {
    run(false);
    return () => {
      generation.current++;
    };
  }, deps);

  const refresh = useCallback(() => run(true), [run]);
  return { ...state, refresh };
}
