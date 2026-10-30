import { describe, expect, it } from 'vitest';
import { fakeLocks } from '../test/fakeLocks';
import { createOperationRegistry, opKey, UNKNOWN_REVIEW, type RegistryDeps } from './pendingOps';

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

  it('o registro não guarda nada em claro', async () => {
    localStorage.clear();
    const reg = tab(localStorage, fakeLocks());
    const key = await opKey({ ...scope, target: 'alvo-secreto@empresa.com' });
    const begun = await reg.begin(key);
    if (begun.ok) begun.finish('unknown');
    const dump = JSON.stringify({ ...localStorage });
    for (const plain of [scope.subject, scope.org, scope.operation, 'alvo-secreto', 'empresa.com', '00000000-0000-4000-8000-000000000001']) expect(dump).not.toContain(plain);
    expect(Object.keys(JSON.parse(localStorage.getItem(key)!)).sort()).toEqual(['at', 'exp', 's', 'v']);
    expect(key).toMatch(/^nk\.op\.1\.[0-9a-f]{32}$/);
  });

  it('FRONT-V1-003: 72 h depois a incerteza CONTINUA bloqueando — após recarga e em outra aba; só a liberação explícita solta', async () => {
    localStorage.clear();
    const clock = { t: 9_000_000 };
    const locks = fakeLocks();
    const key = await opKey(scope);
    const first = tab(localStorage, locks, clock);
    const begun = await first.begin(key);
    if (begun.ok) begun.finish('unknown');
    await new Promise((r) => setTimeout(r, 0)); // a soltura do lock é assíncrona (como nos Web Locks)
    clock.t += UNKNOWN_REVIEW + 60 * 60_000; // 73 h

    // recarga: registro novo, mesma origem; a limpeza do carregamento não remove a incerteza
    const reloaded = tab(localStorage, locks, clock);
    reloaded.sweep();
    expect(await reloaded.inspect(key)).toMatchObject({ state: 'unknown', old: true });
    expect(await reloaded.begin(key)).toMatchObject({ ok: false, reason: 'unknown' });

    // segunda aba (depois de o lock da recusa acima ser solto: logo antes disso a resposta seria "busy", também recusa)
    await new Promise((r) => setTimeout(r, 0));
    const other = tab(localStorage, locks, clock);
    expect(await other.begin(key)).toMatchObject({ ok: false, reason: 'unknown' });

    // envio em curso de uma aba que morreu há 73 h também vira incerteza, não "nada aconteceu"
    const key2 = await opKey({ ...scope, operation: 'automation.create' });
    const crashed = tab(localStorage, locks, clock);
    expect((await crashed.begin(key2)).ok).toBe(true);
    locks.dropAll();
    clock.t += UNKNOWN_REVIEW + 1;
    const later = tab(localStorage, locks, clock);
    later.sweep();
    expect(await later.inspect(key2)).toMatchObject({ state: 'unknown', old: true });

    // outra pessoa e outra organização continuam sem ver nada
    expect(await later.inspect(await opKey({ ...scope, subject: 'm:00000000-0000-4000-8000-000000000002' }))).toBeNull();
    expect(await later.inspect(await opKey({ ...scope, org: '11111111-3b2d-4c5e-8f71-2a9b3c4d5e6f' }))).toBeNull();

    // só a decisão explícita libera
    expect(other.acknowledge(key)).toBe(true);
    expect(await reloaded.inspect(key)).toBeNull();
    expect((await reloaded.begin(key)).ok).toBe(true);
  });

  it('confirmado e recusado (que não bloqueiam) somem na limpeza depois de 10 min', async () => {
    localStorage.clear();
    const clock = { t: 9_000_000 };
    const reg = tab(localStorage, fakeLocks(), clock);
    const key = await opKey(scope);
    const begun = await reg.begin(key);
    if (begun.ok) begun.finish('confirmed');
    expect(await reg.inspect(key)).toMatchObject({ state: 'confirmed' });
    clock.t += 10 * 60_000 + 1;
    reg.sweep();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('escopo diferente (outra pessoa, organização, operação ou alvo) = outra chave', async () => {
    const base = await opKey(scope);
    expect(await opKey({ ...scope, subject: 'm:00000000-0000-4000-8000-000000000002' })).not.toBe(base);
    expect(await opKey({ ...scope, org: '11111111-3b2d-4c5e-8f71-2a9b3c4d5e6f' })).not.toBe(base);
    expect(await opKey({ ...scope, operation: 'automation.create' })).not.toBe(base);
    expect(await opKey({ ...scope, target: 'x' })).not.toBe(base);
  });
});
