/**
 * F6a-2-R1: o registro de escritas pertence a UMA sessão da aba; nova tentativa recusada não resolve a incerteza anterior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyMfa } from '../api/auth';
import { csrfStore } from '../api/csrf';
import { ApiError } from '../api/http';
import { beginCheck, clearSettled, finishCheck, resetWriteStore, sessionEpoch, startWrite, writeEntry } from './writeStore';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const t = (userId: string) => ({ userId, membershipId: `m-${userId}`, displayName: userId });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

async function uncertain(userId = 'u1') {
  startWrite(ORG, 'suspend', t(userId), () => Promise.reject(new ApiError('network', 0)));
  await flush();
  expect(writeEntry(ORG, userId)?.phase).toBe('uncertain');
}

beforeEach(() => {
  resetWriteStore();
  csrfStore.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registro por sessão', () => {
  it('logout ou sessão expirada (csrfStore.clear) e login com sessão nova (beginSession) zeram o registro e mudam a época', async () => {
    await uncertain();
    const e0 = sessionEpoch();
    csrfStore.clear();
    expect(writeEntry(ORG, 'u1')).toBeUndefined();
    expect(sessionEpoch()).toBe(e0 + 1);
    await uncertain();
    csrfStore.beginSession(ORG, 'token-da-nova-sessao');
    expect(writeEntry(ORG, 'u1')).toBeUndefined();
    expect(sessionEpoch()).toBe(e0 + 2);
  });

  it('login real (verifyMfa emite sessão nova) é fronteira: o registro da sessão anterior some', async () => {
    await uncertain();
    csrfStore.setChallenge(ORG, 'csrf-do-desafio');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ csrfToken: 'csrf-da-sessao-nova' }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await verifyMfa(ORG, { code: '123456' });
    expect(csrfStore.session(ORG)).toBe('csrf-da-sessao-nova');
    expect(writeEntry(ORG, 'u1')).toBeUndefined();
  });

  it('recuperar o token da MESMA sessão (setSession) não é fronteira: a incerteza continua', async () => {
    await uncertain();
    csrfStore.setSession(ORG, 'token-recuperado');
    expect(writeEntry(ORG, 'u1')?.phase).toBe('uncertain');
  });

  it('conclusão atrasada de um envio da sessão anterior não recria nem altera o registro da sessão nova', async () => {
    const old = deferred();
    startWrite(ORG, 'suspend', t('u1'), () => old.promise);
    csrfStore.clear(); // troca de sessão com o envio pendente
    const now = deferred();
    const id = startWrite(ORG, 'reactivate', t('u1'), () => now.promise)!;
    old.reject(new ApiError('network', 0));
    await flush();
    expect(writeEntry(ORG, 'u1')).toMatchObject({ id, action: 'reactivate', phase: 'sending' });
    csrfStore.clear();
    now.resolve();
    await flush();
    expect(writeEntry(ORG, 'u1')).toBeUndefined();
  });

  it('conclusão atrasada de uma conferência da sessão anterior é ignorada', async () => {
    await uncertain();
    const tok = beginCheck(ORG, 'u1', writeEntry(ORG, 'u1')!.id)!;
    csrfStore.clear();
    await uncertain();
    finishCheck(ORG, 'u1', { status: 'found', token: tok, accountStatus: 'suspended', at: 1 });
    expect(writeEntry(ORG, 'u1')?.check).toBeUndefined();
  });
});

describe('nova tentativa recusada depois de resultado incerto', () => {
  it('403 na nova tentativa: continua INCERTO, com a recusa registrada à parte; a releitura não remove; só 204 ou dispensa resolvem', async () => {
    await uncertain();
    startWrite(ORG, 'suspend', t('u1'), () => Promise.reject(new ApiError('forbidden', 403)), { retry: true });
    await flush();
    const e = writeEntry(ORG, 'u1')!;
    expect(e.phase).toBe('uncertain');
    expect(e.refusedRetry).toBeInstanceOf(ApiError);
    expect((e.refusedRetry as ApiError).code).toBe('forbidden');
    clearSettled(ORG);
    expect(writeEntry(ORG, 'u1')?.phase).toBe('uncertain');
    // nova tentativa incerta: a recusa anterior deixa de ser a última informação
    startWrite(ORG, 'suspend', t('u1'), () => Promise.reject(new ApiError('network', 0)), { retry: true });
    await flush();
    expect(writeEntry(ORG, 'u1')).toMatchObject({ phase: 'uncertain', refusedRetry: undefined });
    startWrite(ORG, 'suspend', t('u1'), () => Promise.resolve(), { retry: true });
    await flush();
    expect(writeEntry(ORG, 'u1')?.phase).toBe('done');
  });

  it('envio comum (sem incerteza anterior) recusado continua recusado e sai na releitura', async () => {
    startWrite(ORG, 'suspend', t('u2'), () => Promise.reject(new ApiError('forbidden', 403)));
    await flush();
    expect(writeEntry(ORG, 'u2')?.phase).toBe('refused');
    clearSettled(ORG);
    expect(writeEntry(ORG, 'u2')).toBeUndefined();
  });
});
