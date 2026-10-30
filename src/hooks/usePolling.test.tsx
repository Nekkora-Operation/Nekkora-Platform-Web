import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from './usePolling';

describe('usePolling — "desatualizado" só enquanto o acompanhamento continua', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('acompanhamento encerrado (keepGoing falso): sem nova consulta e sem "desatualizado" com o passar do tempo', async () => {
    const fetcher = vi.fn(() => Promise.resolve('fim'));
    const { result } = renderHook(() => usePolling(fetcher, { intervalMs: 1000, keepGoing: () => false, deps: [], onUnauthenticated: () => {} }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.following).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.stale).toBe(false);
  });

  it('acompanhamento em curso: consulta presa por mais de 2 intervalos deixa o dado "desatualizado"', async () => {
    let n = 0;
    const fetcher = vi.fn(() => (n++ === 0 ? Promise.resolve('a') : new Promise<string>(() => {})));
    const { result } = renderHook(() => usePolling(fetcher, { intervalMs: 1000, keepGoing: () => true, deps: [], onUnauthenticated: () => {} }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.stale).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(3500));
    expect(result.current.following).toBe(true);
    expect(result.current.stale).toBe(true);
  });
});
