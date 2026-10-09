/**
 * F6a-2: registro de escritas — trava síncrona, nova tentativa só com decisão explícita, classificação do resultado,
 * isolamento por alvo e por organização, conclusões antigas ignoradas e conferência com token.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/http';
import { ContractViolation } from '../api/validate';
import {
  beginCheck,
  classify,
  clearSettled,
  dismissWrite,
  finishCheck,
  resetWriteStore,
  startWrite,
  writeEntry,
} from './writeStore';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const t = (userId: string) => ({ userId, membershipId: `m-${userId}`, displayName: userId.slice(0, 4) });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

beforeEach(() => resetWriteStore());

describe('registro de escritas', () => {
  it('trava síncrona: dois inícios no mesmo instante → um envio só', () => {
    const d = deferred();
    let calls = 0;
    const send = () => {
      calls++;
      return d.promise;
    };
    expect(startWrite(A, 'suspend', t('u1'), send)).not.toBeNull();
    expect(startWrite(A, 'suspend', t('u1'), send)).toBeNull();
    expect(startWrite(A, 'reactivate', t('u1'), send)).toBeNull();
    expect(calls).toBe(1);
  });

  it('classificação: recusa só com status documentado que não aplica; o resto é incerto', () => {
    for (const code of ['forbidden', 'not_found', 'invalid_request', 'rate_limited', 'unauthenticated'] as const) {
      expect(classify(new ApiError(code, 400)), code).toBe('refused');
    }
    for (const e of [
      new ApiError('network', 0),
      new ApiError('unexpected', 200),
      new ApiError('internal_error', 500),
      new ApiError('service_unavailable', 502),
      new ContractViolation('suspendUser', [], 200),
      new TypeError('Failed to fetch'),
    ]) {
      expect(classify(e), String(e)).toBe('uncertain');
    }
  });

  it('resultado incerto: nova tentativa só com retry explícito; dispensar é decisão explícita; não dispensa durante o envio', async () => {
    const d = deferred();
    startWrite(A, 'suspend', t('u1'), () => d.promise);
    d.reject(new ApiError('network', 0));
    await flush();
    expect(writeEntry(A, 'u1')?.phase).toBe('uncertain');
    expect(startWrite(A, 'suspend', t('u1'), () => Promise.resolve())).toBeNull();
    clearSettled(A);
    expect(writeEntry(A, 'u1')?.phase).toBe('uncertain');
    const d2 = deferred();
    expect(startWrite(A, 'suspend', t('u1'), () => d2.promise, { retry: true })).not.toBeNull();
    expect(writeEntry(A, 'u1')).toMatchObject({ phase: 'sending', retry: true });
    dismissWrite(A, 'u1');
    expect(writeEntry(A, 'u1')?.phase).toBe('sending');
    d2.resolve();
    await flush();
    expect(writeEntry(A, 'u1')?.phase).toBe('done');
    clearSettled(A);
    expect(writeEntry(A, 'u1')).toBeUndefined();
  });

  it('isolamento: alvos e organizações independentes; a conclusão de um não altera outro', async () => {
    const d1 = deferred();
    const d2 = deferred();
    startWrite(A, 'suspend', t('u1'), () => d1.promise);
    startWrite(A, 'suspend', t('u2'), () => d2.promise);
    startWrite(B, 'suspend', t('u1'), () => Promise.reject(new ApiError('network', 0)));
    d2.resolve();
    await flush();
    expect(writeEntry(A, 'u2')?.phase).toBe('done');
    expect(writeEntry(A, 'u1')?.phase).toBe('sending');
    expect(writeEntry(B, 'u1')?.phase).toBe('uncertain');
    d1.reject(new ApiError('forbidden', 403));
    await flush();
    expect(writeEntry(A, 'u1')?.phase).toBe('refused');
    expect(writeEntry(B, 'u1')?.phase).toBe('uncertain');
  });

  it('conclusão antiga ignorada: depois de o registro ser substituído, a resposta do envio anterior não o altera', async () => {
    const d1 = deferred();
    const id1 = startWrite(A, 'suspend', t('u1'), () => d1.promise)!;
    // substituição forçada (o mesmo que acontece se o registro for recriado por outra via): limpa e começa outro
    resetWriteStore();
    const d2 = deferred();
    const id2 = startWrite(A, 'reactivate', t('u1'), () => d2.promise)!;
    expect(id2).not.toBe(id1);
    d1.resolve();
    await flush();
    expect(writeEntry(A, 'u1')).toMatchObject({ id: id2, action: 'reactivate', phase: 'sending' });
  });

  it('conferência com token: só o resultado da conferência atual vale; só para registro incerto', async () => {
    startWrite(A, 'suspend', t('u1'), () => Promise.reject(new ApiError('network', 0)));
    await flush();
    const id = writeEntry(A, 'u1')!.id;
    const tok1 = beginCheck(A, 'u1', id)!;
    const tok2 = beginCheck(A, 'u1', id)!;
    finishCheck(A, 'u1', { status: 'absent', token: tok1, at: 1 });
    expect(writeEntry(A, 'u1')?.check).toEqual({ status: 'checking', token: tok2 });
    finishCheck(A, 'u1', { status: 'found', token: tok2, accountStatus: 'suspended', at: 2 });
    expect(writeEntry(A, 'u1')?.check).toMatchObject({ status: 'found', accountStatus: 'suspended' });
    expect(writeEntry(A, 'u1')?.phase).toBe('uncertain');
    expect(beginCheck(A, 'u1', id + 999)).toBeNull();
  });
});
