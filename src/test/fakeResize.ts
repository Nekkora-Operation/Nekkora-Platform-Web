import { vi } from 'vitest';

/**
 * Dublê de medida para o ResponsiveTable (o jsdom não mede): a região `.pw-rtable` mede `width`; com uma tabela dentro,
 * ela pede `needed` de largura; os cartões sempre cabem. `resize(w)` avisa os observadores como uma janela que muda.
 * Devolve `restore` para o afterEach.
 */
export function fakeResize(needed = 1100, initial = 600) {
  let width = initial;
  let observers: (() => void)[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
        observers.push(cb);
      }
      observe() {}
      disconnect() {
        observers = observers.filter((o) => o !== this.cb);
      }
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains('pw-rtable') ? width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      const el = this as HTMLElement;
      if (!el.classList.contains('pw-rtable')) return 0;
      return el.querySelector('table') ? Math.max(needed, width) : width;
    },
  });
  return {
    resize(w: number) {
      width = w;
      for (const o of [...observers]) o();
    },
    restore() {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
      vi.unstubAllGlobals();
    },
  };
}
