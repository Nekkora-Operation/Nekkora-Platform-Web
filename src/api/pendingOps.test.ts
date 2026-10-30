import { describe, expect, it } from 'vitest';
import { fakeLocks } from '../test/fakeLocks';
import { createOperationRegistry, opKey, UNKNOWN_TTL, type RegistryDeps } from './pendingOps';

function tab(storage: Storage, locks: ReturnType<typeof fakeLocks> | null, clock = { t: 1_000_000 }) {
  const deps: RegistryDeps = { storage: () => storage, locks: () => locks, now: () => clock.t };
  return createOperationRegistry(deps);
}

const scope = { subject: 'm:00000000-0000-4000-8000-000000000001', org: '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f', operation: 'workspace.create' };

describe('registro de operações incertas (pendingOps)', () => {
  it('grava pending ANTES do envio; outra aba fica impedida enquanto o envio está em curso', async () => {
    localStorage.clear();
    const locks = fakeLocks();
    const a = tab(localStorage, locks);
    const b = tab(localStorage, locks);
    const key = await opKey(scope);
    const begun = await a.begin(key);
    expect(begun.ok).toBe(true);
    expect(JSON.parse(localStorage.getItem(key)!).s).toBe('pending');
    expect(await b.begin(key)).toMatchObject({ ok: false, reason: 'busy' });
    expect(await b.inspect(key)).toMatchObject({ state: 'pending' });
    // a mesma aba também não começa outro envio
    expect(await a.begin(key)).toMatchObject({ ok: false, reason: 'busy' });
    if (begun.ok) begun.finish('confirmed');
    expect(await b.inspect(key)).toMatchObject({ state: 'confirmed' });
  });

  it('dono que some no meio do envio (recarga, aba fechada) deixa resultado DESCONHECIDO, que bloqueia nova tentativa', async () => {
    localStorage.clear();
    const locks = fakeLocks();
    const key = await opKey(scope);
    const before = tab(localStorage, locks);
    expect((await before.begin(key)).ok).toBe(true);
    locks.dropAll();
    const after = tab(localStorage, locks);
    expect(await after.inspect(key)).toMatchObject({ state: 'unknown' });
    expect(await after.begin(key)).toMatchObject({ ok: false, reason: 'unknown' });
    // só a decisão explícita libera
    expect(after.acknowledge(key)).toBe(true);
    expect(await after.inspect(key)).toBeNull();
  });

  it('sem Web Locks: o sinal do envio em curso decide; sinal parado vira desconhecido', async () => {
    localStorage.clear();
    const clock = { t: 5_000_000 };
    const key = await opKey(scope);
    const a = tab(localStorage, null, clock);
    const b = tab(localStorage, null, clock);
    expect((await a.begin(key)).ok).toBe(true);
    expect(await b.begin(key)).toMatchObject({ ok: false, reason: 'busy' });
    clock.t += 60_000; // a aba dona parou de sinalizar
    expect(await b.inspect(key)).toMatchObject({ state: 'unknown' });
  });

  it('falha do armazenamento: begin recusa (quem chama não envia)', async () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {},
      key: () => null,
      length: 0,
      clear: () => {},
    } as Storage;
    const reg = tab(broken, fakeLocks());
    expect(await reg.begin(await opKey(scope))).toMatchObject({ ok: false, reason: 'storage' });
    const none = createOperationRegistry({ storage: () => null, locks: () => null, now: () => 0 });
    expect(await none.begin(await opKey(scope))).toMatchObject({ ok: false, reason: 'storage' });
  });

  it('expiração remove sem declarar nada; o registro não guarda nada em claro', async () => {
    localStorage.clear();
    const clock = { t: 9_000_000 };
    const locks = fakeLocks();
    const reg = tab(localStorage, locks, clock);
    const key = await opKey({ ...scope, target: 'alvo-secreto@empresa.com' });
    const begun = await reg.begin(key);
    if (begun.ok) begun.finish('unknown');
    const dump = JSON.stringify({ ...localStorage });
    for (const plain of [scope.subject, scope.org, scope.operation, 'alvo-secreto', 'empresa.com', '00000000-0000-4000-8000-000000000001']) expect(dump).not.toContain(plain);
    expect(Object.keys(JSON.parse(localStorage.getItem(key)!)).sort()).toEqual(['at', 'exp', 's', 'v']);
    expect(key).toMatch(/^nk\.op\.1\.[0-9a-f]{32}$/);
    clock.t += UNKNOWN_TTL + 1;
    reg.sweep();
    expect(localStorage.getItem(key)).toBeNull();
    expect(await reg.inspect(key)).toBeNull();
  });

  it('escopo diferente (outra pessoa, organização, operação ou alvo) = outra chave', async () => {
    const base = await opKey(scope);
    expect(await opKey({ ...scope, subject: 'm:00000000-0000-4000-8000-000000000002' })).not.toBe(base);
    expect(await opKey({ ...scope, org: '11111111-3b2d-4c5e-8f71-2a9b3c4d5e6f' })).not.toBe(base);
    expect(await opKey({ ...scope, operation: 'automation.create' })).not.toBe(base);
    expect(await opKey({ ...scope, target: 'x' })).not.toBe(base);
  });
});
