import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http';
import { RATE_LIMITED_READ_RETRIES, useResource } from './useResource';

/**
 * A1 (LICENCIAMENTO-002): leitura de detalhe recusada pelo limite da API (429 com Retry-After) é refeita depois do tempo
 * informado, mantendo o que estava na tela; sem Retry-After (limite do gateway) ou depois das repetições, o erro aparece
 * e a nova tentativa é da pessoa.
 */
afterEach(() => {
  vi.useRealTimers();
});

const limited = (s?: number) => new ApiError('rate_limited', 429, s);

describe('useResource com 429', () => {
  it('releitura (Atualizar) com 429: o dado anterior continua e a leitura é refeita depois do Retry-After', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    const fetcher = vi.fn(async () => {
      n++;
      if (n === 2) throw limited(1);
      return `v${n}`;
    });
    const { result } = renderHook(() => useResource(fetcher, ['x']));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.status === 'ready' && result.current.data).toBe('v1');
    act(() => result.current.refresh());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    // recusado pelo limite: nada de erro na tela, o dado anterior fica (atualizando)
    expect(result.current.status).toBe('ready');
    expect(result.current.status === 'ready' && result.current.data).toBe('v1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_300);
    });
    await waitFor(() => expect(result.current.status === 'ready' && result.current.data).toBe('v3'));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('primeira leitura com 429: continua carregando e lê de novo depois do tempo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    const fetcher = vi.fn(async () => {
      n++;
      if (n === 1) throw limited(2);
      return 'ok';
    });
    const { result } = renderHook(() => useResource(fetcher, ['x']));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe('loading');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_300);
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it(`429 que continua: depois de ${RATE_LIMITED_READ_RETRIES} repetições, o erro aparece (a próxima é da pessoa)`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = vi.fn(async () => {
      throw limited(1);
    });
    const { result } = renderHook(() => useResource(fetcher, ['x']));
    for (let i = 0; i < RATE_LIMITED_READ_RETRIES; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_300);
      });
    }
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(fetcher).toHaveBeenCalledTimes(1 + RATE_LIMITED_READ_RETRIES);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1 + RATE_LIMITED_READ_RETRIES);
  });

  it('429 sem Retry-After (gateway): erro na hora, sem repetir sozinho', async () => {
    const fetcher = vi.fn(async () => {
      throw limited();
    });
    const { result } = renderHook(() => useResource(fetcher, ['x']));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sair da tela durante a espera: nada é lido depois', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = vi.fn(async () => {
      throw limited(1);
    });
    const { unmount } = renderHook(() => useResource(fetcher, ['x']));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('troca de organização durante a espera: a releitura da anterior é descartada e nada dela aparece', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reads: string[] = [];
    let aCalls = 0;
    const fetchFor = (org: string) => async () => {
      reads.push(org);
      if (org === 'A') {
        aCalls++;
        if (aCalls === 2) throw limited(1);
        return 'dado de A';
      }
      return 'dado de B';
    };
    const { result, rerender } = renderHook(({ org }) => useResource(fetchFor(org), [org]), { initialProps: { org: 'A' } });
    await waitFor(() => expect(result.current.status === 'ready' && result.current.data).toBe('dado de A'));
    act(() => result.current.refresh());
    await waitFor(() => expect(reads).toEqual(['A', 'A']));
    // releitura de A agendada (429); a pessoa troca para B antes do tempo
    rerender({ org: 'B' });
    expect(result.current.status).toBe('loading'); // nada de A na tela
    await waitFor(() => expect(result.current.status === 'ready' && result.current.data).toBe('dado de B'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(reads).toEqual(['A', 'A', 'B']); // a releitura agendada de A nunca saiu
    expect(result.current.status === 'ready' && result.current.data).toBe('dado de B');
  });

  it('troca de organização com a leitura anterior ainda pendente: a resposta atrasada é ignorada', async () => {
    let resolveA: (v: string) => void = () => {};
    const fetchFor = (org: string) => () =>
      org === 'A' ? new Promise<string>((r) => (resolveA = r)) : Promise.resolve('dado de B');
    const { result, rerender } = renderHook(({ org }) => useResource(fetchFor(org), [org]), { initialProps: { org: 'A' } });
    rerender({ org: 'B' });
    await waitFor(() => expect(result.current.status === 'ready' && result.current.data).toBe('dado de B'));
    await act(async () => {
      resolveA('dado de A');
    });
    expect(result.current.status === 'ready' && result.current.data).toBe('dado de B');
  });
});
