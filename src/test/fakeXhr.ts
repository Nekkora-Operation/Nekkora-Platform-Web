import { vi } from 'vitest';
import { responseViolations } from '../api/validate';

/**
 * Dublê do XMLHttpRequest do envio do pacote (PUT do rascunho da automação, T09). Cada resposta 2xx e cada corpo de erro é
 * conferido contra o contrato (putAutomationDraftPackage, modo estrito), como no RouteApi. `hold` deixa o envio pendente
 * até a promessa resolver (corridas e duplo clique).
 */
export type XhrAnswer = { status: number; body?: unknown } | 'network' | { hold: Promise<{ status: number; body?: unknown } | 'network'> };

export interface XhrPut {
  url: string;
  /** Caminho sem a query. */
  path: string;
  query: URLSearchParams;
  file: Blob;
}

export function installFakeXhr() {
  const state = { handler: ((): XhrAnswer => 'network') as (put: XhrPut) => XhrAnswer, puts: [] as XhrPut[] };
  class FakeXhr {
    status = 0;
    responseText = '';
    upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    withCredentials = false;
    private url = '';
    open(_m: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    getResponseHeader() {
      return null;
    }
    abort() {
      this.onabort?.();
    }
    send(file: Blob) {
      const [path, qs = ''] = this.url.split('?');
      const put = { url: this.url, path, query: new URLSearchParams(qs), file };
      state.puts.push(put);
      const first = state.handler(put);
      void (async () => {
        const a = typeof first === 'object' && 'hold' in first ? await first.hold : first;
        await new Promise((r) => setTimeout(r, 0));
        this.upload.onprogress?.({ loaded: file.size, total: file.size, lengthComputable: true });
        if (a === 'network') return this.onerror?.();
        const list = responseViolations('putAutomationDraftPackage', { status: a.status, contentType: a.body === undefined ? null : 'application/json', body: a.body }, { strict: true });
        if (list.length) throw new Error(`fixture fora do contrato (putAutomationDraftPackage ${a.status}): ${JSON.stringify(list)}`);
        this.status = a.status;
        this.responseText = a.body === undefined ? '' : JSON.stringify(a.body);
        this.onload?.();
      })();
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return state;
}

export async function sha256(b: Blob) {
  const d = await crypto.subtle.digest('SHA-256', await b.arrayBuffer());
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function zip(name = 'pacote.zip', content = 'PK conteudo') {
  return new File([content], name, { type: 'application/zip' });
}
