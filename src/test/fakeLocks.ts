/** Gerenciador de locks compartilhado entre "abas" (como navigator.locks na mesma origem). */
export function fakeLocks() {
  const held = new Map<string, () => void>();
  return {
    async request(name: string, _o: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | void) {
      if (held.has(name)) return cb(null);
      let release!: () => void;
      const gone = new Promise<void>((r) => (release = r));
      held.set(name, release);
      const work = Promise.resolve(cb({ name }));
      await Promise.race([work, gone]);
      held.delete(name);
    },
    async query() {
      return { held: [...held.keys()].map((name) => ({ name })) };
    },
    /** A aba dona fechou (recarga, queda): o navegador solta os locks dela. */
    dropAll() {
      for (const r of held.values()) r();
      held.clear();
    },
  };
}
