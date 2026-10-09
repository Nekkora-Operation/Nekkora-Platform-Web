/**
 * F6a-4: a redefinição de MFA tem registro próprio (tipo `mfa`), separado da suspensão da MESMA conta; falha que
 * comprovadamente aconteceu antes do efeito (`NotApplied`: a confirmação de identidade falhou) é recusa, nunca
 * incerteza, qualquer que seja a causa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { csrfStore } from '../api/csrf';
import { ApiError } from '../api/http';
import {
  classify,
  clearSettled,
  isMemberEntry,
  isMfaEntry,
  NotApplied,
  resetWriteStore,
  rootError,
  startWrite,
  writeEntry,
  type MemberTarget,
  type MfaTarget,
} from './writeStore';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const member: MemberTarget = { userId: USER, membershipId: 'm1', displayName: 'Pessoa' };
const mfa: MfaTarget = { kind: 'mfa', userId: USER, membershipId: 'm1', displayName: 'Pessoa', email: 'p@x.dev' };
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  resetWriteStore();
  csrfStore.clear();
});

describe('NotApplied: falha antes do efeito', () => {
  it('é recusa para qualquer causa (rede, 5xx, fora do contrato, 403, 401); rootError devolve a causa', () => {
    for (const cause of [new ApiError('network', 0), new ApiError('unexpected', 502), new ApiError('unexpected', 200), new ApiError('forbidden', 403), new ApiError('unauthenticated', 401)]) {
      expect(classify(new NotApplied('step-up', cause))).toBe('refused');
      expect(rootError(new NotApplied('step-up', cause))).toBe(cause);
    }
    // sem o envoltório, a mesma falha de transporte continua INCERTA
    expect(classify(new ApiError('network', 0))).toBe('uncertain');
    expect(rootError(new ApiError('network', 0))).toBeInstanceOf(ApiError);
  });

  it('no registro: step-up sem resposta = recusado; nova tentativa com NotApplied depois de incerto MANTÉM a incerteza', async () => {
    startWrite(ORG, 'mfa-reset', mfa, () => Promise.reject(new NotApplied('step-up', new ApiError('network', 0))));
    await flush();
    expect(writeEntry(ORG, USER, 'mfa')?.phase).toBe('refused');
    startWrite(ORG, 'mfa-reset', mfa, () => Promise.reject(new ApiError('network', 0))); // a redefinição ficou sem resposta
    await flush();
    expect(writeEntry(ORG, USER, 'mfa')?.phase).toBe('uncertain');
    startWrite(ORG, 'mfa-reset', mfa, () => Promise.reject(new NotApplied('step-up', new ApiError('forbidden', 403))), { retry: true });
    await flush();
    const e = writeEntry(ORG, USER, 'mfa')!;
    expect(e.phase).toBe('uncertain');
    expect(e.refusedRetry).toBeInstanceOf(NotApplied);
  });
});

describe('tipo mfa separado do membro', () => {
  it('suspensão e redefinição da MESMA conta: travas, resultados e limpeza independentes', async () => {
    let releaseMember!: () => void;
    const memberSend = new Promise<void>((r) => (releaseMember = r));
    expect(startWrite(ORG, 'suspend', member, () => memberSend)).not.toBeNull();
    expect(startWrite(ORG, 'mfa-reset', mfa, () => Promise.resolve())).not.toBeNull();
    await flush();
    expect(writeEntry(ORG, USER, 'mfa')?.phase).toBe('done');
    expect(writeEntry(ORG, USER, 'member')?.phase).toBe('sending');
    expect(isMfaEntry(writeEntry(ORG, USER, 'mfa')!)).toBe(true);
    expect(isMemberEntry(writeEntry(ORG, USER, 'mfa')!)).toBe(false);
    expect(isMemberEntry(writeEntry(ORG, USER, 'member')!)).toBe(true);
    releaseMember();
    await flush();
    clearSettled(ORG, 'member');
    expect(writeEntry(ORG, USER, 'member')).toBeUndefined();
    expect(writeEntry(ORG, USER, 'mfa')?.phase).toBe('done');
    clearSettled(ORG, 'mfa');
    expect(writeEntry(ORG, USER, 'mfa')).toBeUndefined();
  });
});
