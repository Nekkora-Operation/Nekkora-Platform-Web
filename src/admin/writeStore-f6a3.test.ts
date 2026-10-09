/**
 * F6a-3: o tipo do recurso faz parte da chave do registro de escritas. Membro e concessão com o MESMO identificador
 * nunca colidem: trava, resultado, conferência, dispensa e limpeza são de cada um.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { csrfStore } from '../api/csrf';
import { ApiError } from '../api/http';
import {
  beginCheck,
  clearSettled,
  dismissWrite,
  finishCheck,
  isGrantEntry,
  isMemberEntry,
  resetWriteStore,
  startWrite,
  writeEntry,
  type GrantTarget,
  type MemberTarget,
} from './writeStore';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** O mesmo identificador nos dois tipos: o pior caso para uma chave sem tipo. */
const SAME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const member: MemberTarget = { userId: SAME, membershipId: 'm1', displayName: 'Pessoa' };
const grant: GrantTarget = { kind: 'grant', grantId: SAME, displayName: 'Conta externa', email: 'x@example.dev', clientName: 'Acme', workspaceName: 'Logística' };
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetWriteStore();
  csrfStore.clear();
});

describe('chave com o tipo do recurso', () => {
  it('membro em envio não trava a concessão de mesmo id (e vice-versa); cada envio conclui no seu registro', async () => {
    const m = deferred();
    const g = deferred();
    const mid = startWrite(ORG, 'suspend', member, () => m.promise);
    const gid = startWrite(ORG, 'revoke', grant, () => g.promise);
    expect(mid).not.toBeNull();
    expect(gid).not.toBeNull();
    // a trava de cada um continua valendo para o próprio tipo
    expect(startWrite(ORG, 'suspend', member, () => Promise.resolve())).toBeNull();
    expect(startWrite(ORG, 'revoke', grant, () => Promise.resolve())).toBeNull();
    g.resolve();
    m.reject(new ApiError('network', 0));
    await flush();
    expect(writeEntry(ORG, SAME, 'grant')).toMatchObject({ phase: 'done', action: 'revoke', id: gid });
    expect(writeEntry(ORG, SAME, 'member')).toMatchObject({ phase: 'uncertain', action: 'suspend', id: mid });
  });

  it('conferência, dispensa e limpeza são de cada tipo', async () => {
    startWrite(ORG, 'suspend', member, () => Promise.reject(new ApiError('network', 0)));
    startWrite(ORG, 'revoke', grant, () => Promise.reject(new ApiError('network', 0)));
    await flush();
    const gEntry = writeEntry(ORG, SAME, 'grant')!;
    const mEntry = writeEntry(ORG, SAME, 'member')!;
    expect(isGrantEntry(gEntry) && !isMemberEntry(gEntry)).toBe(true);
    expect(isMemberEntry(mEntry) && !isGrantEntry(mEntry)).toBe(true);

    // o id do envio da concessão não abre conferência no membro
    expect(beginCheck(ORG, SAME, gEntry.id, 'member')).toBeNull();
    const token = beginCheck(ORG, SAME, gEntry.id, 'grant')!;
    expect(token).not.toBeNull();
    expect(writeEntry(ORG, SAME, 'member')!.check).toBeUndefined();
    finishCheck(ORG, SAME, { status: 'found', token, grantStatus: 'revoked', at: 1 }, 'member');
    expect(writeEntry(ORG, SAME, 'member')!.check).toBeUndefined();
    finishCheck(ORG, SAME, { status: 'found', token, grantStatus: 'revoked', at: 1 }, 'grant');
    expect(writeEntry(ORG, SAME, 'grant')!.check).toMatchObject({ status: 'found', grantStatus: 'revoked' });

    dismissWrite(ORG, SAME, 'member');
    expect(writeEntry(ORG, SAME, 'member')).toBeUndefined();
    expect(writeEntry(ORG, SAME, 'grant')?.phase).toBe('uncertain');
  });

  it('reler membros não apaga a revogação concluída (e reler concessões não apaga a suspensão concluída)', async () => {
    startWrite(ORG, 'suspend', member, () => Promise.resolve());
    startWrite(ORG, 'revoke', grant, () => Promise.resolve());
    await flush();
    clearSettled(ORG, 'member');
    expect(writeEntry(ORG, SAME, 'member')).toBeUndefined();
    expect(writeEntry(ORG, SAME, 'grant')?.phase).toBe('done');
    startWrite(ORG, 'suspend', member, () => Promise.resolve());
    await flush();
    clearSettled(ORG, 'grant');
    expect(writeEntry(ORG, SAME, 'grant')).toBeUndefined();
    expect(writeEntry(ORG, SAME, 'member')?.phase).toBe('done');
  });

  it('troca de sessão zera os dois tipos; respostas pendentes não reaparecem', async () => {
    const m = deferred();
    const g = deferred();
    startWrite(ORG, 'suspend', member, () => m.promise);
    startWrite(ORG, 'revoke', grant, () => g.promise);
    csrfStore.clear();
    m.resolve();
    g.resolve();
    await flush();
    expect(writeEntry(ORG, SAME, 'member')).toBeUndefined();
    expect(writeEntry(ORG, SAME, 'grant')).toBeUndefined();
  });

  it('nova tentativa da concessão: só com retry; recusada mantém a incerteza anterior', async () => {
    startWrite(ORG, 'revoke', grant, () => Promise.reject(new ApiError('network', 0)));
    await flush();
    expect(startWrite(ORG, 'revoke', grant, () => Promise.resolve())).toBeNull();
    startWrite(ORG, 'revoke', grant, () => Promise.reject(new ApiError('not_found', 404)), { retry: true });
    await flush();
    const e = writeEntry(ORG, SAME, 'grant')!;
    expect(e.phase).toBe('uncertain');
    expect(e.refusedRetry).toBeInstanceOf(ApiError);
  });
});
