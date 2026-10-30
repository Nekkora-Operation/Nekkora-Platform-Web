import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isApiError } from '../api/http';

/** Teto do intervalo depois de falhas seguidas (backoff exponencial). */
const MAX_BACKOFF_MS = 120_000;

export interface Polling<T> {
  data: T | undefined;
  /** Erro da ÚLTIMA consulta (o dado anterior, se houver, continua exibido como desatualizado). */
  error: unknown;
  /** Instante da última consulta bem-sucedida. */
  lastSuccessAt: number | undefined;
  /** A última consulta falhou ou o dado passou de 2 intervalos sem renovação. */
  stale: boolean;
  /** O acompanhamento automático continua (a regra `keepGoing` ainda pede). */
  following: boolean;
  /** Aba oculta: consultas pausadas até ela voltar a aparecer. */
  paused: boolean;
  loading: boolean;
  refresh: () => void;
}

/**
 * Consulta periódica MODERADA (supervisão): nunca sobrepõe requisições (a próxima só é agendada depois que a anterior
 * terminar), pausa com a aba oculta e consulta assim que ela volta, aplica backoff exponencial em falhas e respeita o
 * Retry-After de 429/503, para ao sair da tela e quando `keepGoing` responder falso (o "Atualizar" manual continua).
 * Sem SSE/WebSocket: o dado é tão recente quanto a última consulta bem-sucedida, que é exposta.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  { intervalMs, keepGoing, deps, onUnauthenticated }: { intervalMs: number; keepGoing: (data: T) => boolean; deps: readonly unknown[]; onUnauthenticated: () => void },
): Polling<T> {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>();
  const [lastSuccessAt, setLastSuccessAt] = useState<number>();
  const [following, setFollowing] = useState(true);
  const [paused, setPaused] = useState(typeof document !== 'undefined' && document.hidden);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef(false);
  const failures = useRef(0);
  const generation = useRef(0);
  const followingRef = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keepRef = useRef(keepGoing);
  keepRef.current = keepGoing;
  const unauthRef = useRef(onUnauthenticated);
  unauthRef.current = onUnauthenticated;

  const run = useCallback(async () => {
    if (inFlight.current) return;
    window.clearTimeout(timer.current);
    const gen = generation.current;
    inFlight.current = true;
    setLoading(true);
    let delay = intervalMs;
    try {
      const result = await fetcherRef.current();
      if (gen !== generation.current) return;
      failures.current = 0;
      setData(result);
      setError(undefined);
      setLastSuccessAt(Date.now());
      followingRef.current = keepRef.current(result);
      setFollowing(followingRef.current);
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) {
        followingRef.current = false;
        unauthRef.current();
        return;
      }
      failures.current++;
      setError(e);
      const retryAfter = e instanceof ApiError && e.retryAfterSeconds ? e.retryAfterSeconds * 1000 : 0;
      delay = Math.max(retryAfter, Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures.current));
    } finally {
      if (gen === generation.current) {
        inFlight.current = false;
        setLoading(false);
        // próxima consulta só depois desta, e só com a aba visível e o acompanhamento ainda pedido
        if (followingRef.current && !document.hidden) timer.current = window.setTimeout(() => void run(), delay);
      }
    }
  }, [intervalMs]);

  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    failures.current = 0;
    followingRef.current = true;
    setFollowing(true);
    setData(undefined);
    setError(undefined);
    setLastSuccessAt(undefined);
    void run();
    return () => {
      generation.current++;
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const onVisibility = () => {
      setPaused(document.hidden);
      if (document.hidden) window.clearTimeout(timer.current);
      else if (followingRef.current) void run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [run]);

  // o "desatualizado" depende do relógio: reavalia a cada intervalo
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);

  const stale = error !== undefined || (lastSuccessAt !== undefined && Date.now() - lastSuccessAt > 2 * intervalMs);

  return {
    data,
    error,
    lastSuccessAt,
    stale,
    following,
    paused,
    loading,
    // manual: consulta agora; a regra `keepGoing` decide de novo se o acompanhamento automático continua
    refresh: () => void run(),
  };
}
