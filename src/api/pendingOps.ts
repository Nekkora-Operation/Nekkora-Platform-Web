/**
 * Registro de operações com resultado possivelmente desconhecido (FRONT-V1-002). Sobrevive a navegação, recarga e
 * outras abas da mesma origem, para que nenhuma delas transforme uma operação incerta numa nova tentativa silenciosa.
 *
 * O que fica guardado (localStorage, um item por operação) é o MÍNIMO e não identifica nada em claro:
 *   chave  = `nk.op.1.` + SHA-256(versão | sujeito | organização | operação | alvo)  (hex, 32 primeiros caracteres)
 *   valor  = { v: 1, s: estado, at: quando, exp: limpeza (só confirmado/recusado; 0 = nunca) }
 * Sem senha, TOTP, token, código de recuperação ou de pareamento, ZIP, corpo da requisição, nome, e-mail ou id em claro.
 * Não estar em claro NÃO é anonimização: o resumo não tem segredo, e quem tem acesso a este navegador pode testar valores
 * candidatos contra as chaves (ex.: o e-mail de um convite, ver InvitationsPage).
 * O sujeito é o vínculo da organização (membershipId) ou, na identidade, um resumo do CSRF da sessão de identidade
 * (nunca o CSRF): outra pessoa ou outra organização calcula outra chave e não encontra o registro anterior.
 *
 * Estados: `pending` (em andamento: gravado ANTES do envio), `confirmed`, `refused` e `unknown`. Um `pending` sem dono
 * vivo (aba fechada, recarga, queda no meio do envio) passa a `unknown`: a resposta pode ter se perdido depois de o
 * servidor aplicar. `unknown` só some por decisão explícita da pessoa (`acknowledge`, depois de conferir): ele NÃO
 * expira (FRONT-V1-003). Depois de `UNKNOWN_REVIEW` (72 h) a tela só avisa que o registro é antigo e continua sem
 * confirmação; o prazo nunca libera uma nova tentativa. Liberar também não confirma nada: só permite enviar de novo.
 * Confirmado e recusado (que não bloqueiam nada) somem em 10 min.
 *
 * Concorrência entre abas: Web Locks (`navigator.locks`) — quem envia segura o lock da chave até o fim. SEM Web Locks o
 * envio protegido NÃO começa (`no-locks`, FRONT-V1-004): o localStorage não tem leitura-e-gravação atômica entre abas
 * (o padrão HTML não exige exclusão entre processos), e marca + espera + conferência só funcionava quando a gravação de
 * uma aba chegava à outra antes do fim da espera, o que nenhum navegador garante. O registro NÃO substitui idempotência
 * nem reconciliação no servidor: só impede que este navegador repita sem a pessoa decidir.
 */

export type OpState = 'pending' | 'confirmed' | 'refused' | 'unknown';

export interface OpScope {
  /** Sujeito: `m:<membershipId>` (organização) ou `i:<resumo da sessão de identidade>`. */
  subject: string;
  org?: string;
  /** Nome estável da operação (ex.: `workspace.create`). */
  operation: string;
  /** Alvo, quando a operação é sobre um recurso existente (ex.: id da versão). */
  target?: string;
}

export interface OpView {
  state: OpState;
  at: number;
  /** Incerteza registrada há mais de `UNKNOWN_REVIEW`: continua bloqueando; a tela avisa que é antiga. */
  old?: boolean;
}

interface StoredOp {
  v: 1;
  s: OpState;
  at: number;
  exp: number;
}

/** `no-locks`: o navegador não oferece Web Locks; nada é gravado nem enviado (sem exclusão comprovada entre abas). */
export type BeginRefusal = 'busy' | 'unknown' | 'storage' | 'no-locks';

/** Texto único para o bloqueio sem Web Locks (diálogos e escritas administrativas). */
export const NO_TAB_LOCK_TEXT =
  'Este navegador não oferece bloqueio entre abas (Web Locks). Para não arriscar um envio duplicado entre abas, esta operação fica indisponível aqui e nada foi enviado. Use um navegador atualizado.';

export type BeginResult =
  | { ok: true; finish: (state: 'confirmed' | 'refused' | 'unknown' | 'not-sent') => void }
  | { ok: false; reason: BeginRefusal; at?: number };

interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | void): Promise<unknown>;
  query?(): Promise<{ held?: { name?: string }[] }>;
}

export interface RegistryDeps {
  storage: () => Storage | null;
  locks: () => LockManagerLike | null;
  now: () => number;
}

const PREFIX = 'nk.op.1.';
const MINUTE = 60_000;
/** Incerteza há mais de 72 h: a tela avisa que o registro é antigo. NÃO libera nada (o registro não expira). */
export const UNKNOWN_REVIEW = 72 * 60 * MINUTE;
const SETTLED_TTL = 10 * MINUTE;
/** `exp` de incerteza e de envio em curso: nunca expiram sozinhos. */
const NEVER = 0;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Chave do registro (resumo; nada do escopo fica em claro). */
export async function opKey(scope: OpScope): Promise<string> {
  const parts = ['nk-op/1', scope.subject, scope.org ?? '', scope.operation, scope.target ?? ''];
  return PREFIX + (await sha256Hex(parts.map((p) => `${p.length}:${p}`).join('|'))).slice(0, 32);
}

/**
 * Sujeito da identidade: resumo do CSRF da sessão (o CSRF em si nunca é gravado).
 *
 * LACUNA ABERTA (FRONT-V1-004), não limitação aceita: a garantia é por pessoa, mas a API (e04a57c) não expõe um
 * identificador estável da identidade (`IdentitySessionState` só tem `restricted` e `csrfToken`). A proteção da área de
 * identidade (criar organização, aceitar convite, vincular conta, novos códigos de recuperação, trocar a senha)
 * sobrevive à recarga e às abas da MESMA sessão de identidade, mas NÃO à troca da sessão (sair e entrar, expiração):
 * a chave muda e a incerteza deixa de ser encontrada. A tela avisa isso na hora. E-mail não é usado como substituto
 * (dado pessoal e testável contra o resumo). Correção pedida: Nekkora-Platform-API#40 (D-API-04). Na área da
 * organização o sujeito é o vínculo (membershipId), estável.
 */
export async function identitySubject(csrf: string): Promise<string> {
  return `i:${(await sha256Hex(`nk-op-subject/1|${csrf}`)).slice(0, 32)}`;
}

export function createOperationRegistry(deps: RegistryDeps) {
  const listeners = new Set<() => void>();
  /** Chaves com envio em curso NESTA aba (pedidos repetidos na mesma aba antes de o lock responder). */
  const local = new Set<string>();
  const emit = () => listeners.forEach((l) => l());

  /** Só confirmado e recusado têm prazo de limpeza; incerteza e envio em curso nunca expiram. */
  const expired = (op: StoredOp, now: number) => (op.s === 'confirmed' || op.s === 'refused') && op.exp <= now;
  const unknownAt = (at: number): StoredOp => ({ v: 1, s: 'unknown', at, exp: NEVER });

  const parse = (raw: string | null): StoredOp | null => {
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as StoredOp;
      if (o?.v !== 1 || !['pending', 'confirmed', 'refused', 'unknown'].includes(o.s) || typeof o.at !== 'number' || typeof o.exp !== 'number') return null;
      return o;
    } catch {
      return null;
    }
  };
  const readRaw = (key: string): StoredOp | null => {
    try {
      return parse(deps.storage()?.getItem(key) ?? null);
    } catch {
      return null;
    }
  };
  /** Grava e confere; falha do armazenamento devolve false (nunca é ignorada em silêncio por quem chama). */
  const write = (key: string, op: StoredOp | null): boolean => {
    try {
      const s = deps.storage();
      if (!s) return false;
      if (op === null) s.removeItem(key);
      else {
        const text = JSON.stringify(op);
        s.setItem(key, text);
        if (s.getItem(key) !== text) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  async function heldElsewhere(key: string): Promise<boolean | null> {
    const locks = deps.locks();
    if (!locks?.query) return null;
    try {
      const q = await locks.query();
      return (q.held ?? []).some((l) => l.name === key);
    } catch {
      return null;
    }
  }

  /** Estado atual da operação. `pending` sem dono vivo vira `unknown` (e fica gravado assim). Expirado: some. */
  async function inspect(key: string): Promise<OpView | null> {
    const op = readRaw(key);
    if (!op) return null;
    const now = deps.now();
    if (expired(op, now)) {
      write(key, null);
      return null;
    }
    if (op.s === 'unknown') return { state: 'unknown', at: op.at, old: now - op.at > UNKNOWN_REVIEW };
    if (op.s !== 'pending') return { state: op.s, at: op.at };
    if (local.has(key)) return { state: 'pending', at: op.at };
    const held = await heldElsewhere(key);
    // sem conseguir consultar os locks, o envio é tratado como vivo (nunca vira "desconhecido" por falta de informação;
    // `begin` continua barrado pelo próprio lock). Sem Web Locks nenhum envio desta origem começa: o `pending` é de uma
    // tentativa interrompida e vira desconhecido
    const alive = held ?? !!deps.locks();
    if (alive) return { state: 'pending', at: op.at };
    write(key, unknownAt(op.at));
    return { state: 'unknown', at: op.at, old: now - op.at > UNKNOWN_REVIEW };
  }

  /** Há exclusão entre abas neste navegador (Web Locks)? Sem ela, `begin` recusa com `no-locks`. */
  const exclusive = () => !!deps.locks();

  /**
   * Antes do envio: trava a chave nesta aba e entre abas, recusa se houver incerteza registrada ou envio em curso, e
   * GRAVA `pending` antes de devolver. Sem conseguir gravar: `storage`; sem Web Locks: `no-locks` — quem chama não envia.
   */
  async function begin(key: string): Promise<BeginResult> {
    const locks = deps.locks();
    if (!locks) return { ok: false, reason: 'no-locks' };
    if (local.has(key)) return { ok: false, reason: 'busy' };
    local.add(key);
    let releaseLock: (() => void) | null = null;
    const got = await new Promise<boolean>((resolve) => {
      locks
        .request(key, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          resolve(true);
          return new Promise<void>((done) => (releaseLock = done));
        })
        .catch(() => resolve(false));
    });
    if (!got) {
      local.delete(key);
      return { ok: false, reason: 'busy' };
    }
    const fail = (reason: 'busy' | 'unknown' | 'storage', at?: number): BeginResult => {
      local.delete(key);
      (releaseLock as (() => void) | null)?.();
      return { ok: false, reason, at };
    };
    const current = readRaw(key);
    const now = deps.now();
    if (current && !expired(current, now)) {
      if (current.s === 'unknown') return fail('unknown', current.at);
      if (current.s === 'pending') {
        // o lock foi obtido: o dono anterior morreu no meio do envio
        write(key, unknownAt(current.at));
        return fail('unknown', current.at);
      }
    }
    if (!write(key, { v: 1, s: 'pending', at: now, exp: NEVER })) return fail('storage');
    emit();
    let finished = false;
    return {
      ok: true,
      finish: (state) => {
        if (finished) return;
        finished = true;
        const at = deps.now();
        if (state === 'not-sent') write(key, null);
        else if (state === 'unknown') write(key, unknownAt(now));
        else write(key, { v: 1, s: state, at, exp: at + SETTLED_TTL });
        local.delete(key);
        (releaseLock as (() => void) | null)?.();
        emit();
      },
    };
  }

  /**
   * A pessoa conferiu o estado atual e decidiu liberar uma nova tentativa. Não confirma o resultado anterior nem garante
   * ausência de duplicidade: só deixa enviar de novo. É a ÚNICA forma de uma incerteza sumir.
   */
  function acknowledge(key: string): boolean {
    const op = readRaw(key);
    if (op?.s === 'pending') return false;
    const ok = write(key, null);
    emit();
    return ok;
  }

  /**
   * Remove confirmados/recusados vencidos e registros ilegíveis de qualquer sujeito (as chaves são resumos: nada é lido em
   * claro). Incerteza e envio em curso nunca são removidos aqui.
   */
  function sweep() {
    try {
      const s = deps.storage();
      if (!s) return;
      const now = deps.now();
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k?.startsWith(PREFIX)) keys.push(k);
      }
      for (const k of keys) {
        const op = parse(s.getItem(k));
        if (!op || expired(op, now)) s.removeItem(k);
      }
    } catch {
      /* armazenamento indisponível: nada a limpar */
    }
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith(PREFIX)) listener();
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(listener);
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
  }

  return { inspect, begin, acknowledge, sweep, subscribe, exclusive };
}

export type OperationRegistry = ReturnType<typeof createOperationRegistry>;

export const browserDeps: RegistryDeps = {
  storage: () => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  },
  locks: () => (typeof navigator !== 'undefined' && 'locks' in navigator ? (navigator.locks as unknown as LockManagerLike) : null),
  now: () => Date.now(),
};

let registry = createOperationRegistry(browserDeps);
registry.sweep();

/** Registro desta aba. */
export const operations = (): OperationRegistry => registry;

/** Só para testes: troca o registro (outra "aba", recarga ou armazenamento com falha). */
export function setOperationRegistryForTest(next: OperationRegistry | null) {
  registry = next ?? createOperationRegistry(browserDeps);
}
