import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/http';

export type ResourceState<T> =
  | { status: 'loading'; refreshing: false }
  | { status: 'ready'; data: T; refreshing: boolean }
  | { status: 'error'; error: unknown; refreshing: false };

/**
 * A1 (LICENCIAMENTO-002): quantas vezes uma LEITURA recusada pelo limite da API (429 com Retry-After) é refeita sozinha,
 * cada uma depois do tempo informado. Só leitura; nenhuma escrita é repetida automaticamente.
 */
export const RATE_LIMITED_READ_RETRIES = 3;

/**
 * Leitura de UM recurso (detalhe). Regras:
 * - mudar `deps` (organização, identificador) descarta o conteúdo na hora (`loading`, sem dado anterior) e ignora
 *   respostas atrasadas da leitura anterior (contador de geração);
 * - `refresh` (Atualizar) refaz a leitura mesmo com os mesmos parâmetros; o dado exibido continua até a resposta, que o
 *   SUBSTITUI. Erro (inclusive 404) apaga o dado: nunca se mostra conteúdo carregado antes junto de "não encontrado";
 * - A1: leitura recusada pelo limite da API (429 com Retry-After) é refeita depois do tempo informado, até
 *   {@link RATE_LIMITED_READ_RETRIES} vezes, mantendo o estado em que estava (carregando, ou o dado anterior atualizando):
 *   ex. a releitura logo depois de publicar, com o balde da sessão vazio, não troca a página por "Muitas tentativas";
 * - fora isso, nada é repetido automaticamente; nova tentativa só por `refresh`.
 */
export function useResource<T>(fetcher: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading', refreshing: false });
  const generation = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const run = useCallback((keepData: boolean, retries = 0) => {
    window.clearTimeout(timer.current);
    const gen = ++generation.current;
    if (retries === 0) setState((s) => (keepData && s.status === 'ready' ? { ...s, refreshing: true } : { status: 'loading', refreshing: false }));
    fetchRef.current().then(
      (data) => {
        if (gen === generation.current) setState({ status: 'ready', data, refreshing: false });
      },
      (error: unknown) => {
        if (gen !== generation.current) return;
        const wait = error instanceof ApiError && error.code === 'rate_limited' ? error.retryAfterSeconds : undefined;
        if (wait && retries < RATE_LIMITED_READ_RETRIES) {
          timer.current = window.setTimeout(() => {
            if (gen === generation.current) run(keepData, retries + 1);
          }, wait * 1000 + 250);
          return;
        }
        setState({ status: 'error', error, refreshing: false });
      },
    );
  }, []);

  useEffect(() => {
    run(false);
    return () => {
      generation.current++;
      window.clearTimeout(timer.current);
    };
  }, deps);

  const refresh = useCallback(() => run(true), [run]);
  return { ...state, refresh };
}
