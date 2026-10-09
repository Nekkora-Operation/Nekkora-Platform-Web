/**
 * Tokens CSRF sincronizadores (contrato 8.7 §5.1), SOMENTE em memória — nunca localStorage/sessionStorage.
 * Recarregar a página perde os tokens de propósito: o de sessão é recuperado do servidor (GET …/auth/csrf);
 * o de desafio MFA não tem recuperação (novo login).
 */
let pre: string | undefined;
const challenge = new Map<string, string>();
const session = new Map<string, string>();
/**
 * Avisados a cada fronteira de sessão: nesta aba (login que emite sessão nova, logout, sessão expirada) ou em OUTRA aba
 * da mesma origem (`remote`). O cookie de sessão é um só por origem: a troca feita em outra aba vale para esta.
 */
const boundaryListeners = new Set<(remote: boolean) => void>();

/**
 * Aviso entre abas (F6a-2-R2): só o fato "a sessão mudou", sem token, cookie nem identidade. Sem BroadcastChannel no
 * ambiente, só as fronteiras locais valem (limitação registrada).
 */
const SESSION_CHANNEL = 'nekkora-sessao';
const channel: BroadcastChannel | undefined = typeof BroadcastChannel === 'function' ? new BroadcastChannel(SESSION_CHANNEL) : undefined;

const forget = () => {
  pre = undefined;
  challenge.clear();
  session.clear();
};

const boundary = (remote: boolean) => {
  if (!remote) channel?.postMessage({ tipo: 'sessao-alterada' });
  for (const l of boundaryListeners) l(remote);
};

channel?.addEventListener('message', (e: MessageEvent) => {
  if ((e.data as { tipo?: unknown } | null)?.tipo !== 'sessao-alterada') return;
  // a sessão desta aba deixou de valer: esquece os tokens (sem reenviar o aviso) e avisa quem guarda estado da sessão
  forget();
  boundary(true);
});

export const csrfStore = {
  pre: () => pre,
  setPre: (t: string | undefined) => {
    pre = t;
  },
  challenge: (org: string) => challenge.get(org),
  setChallenge: (org: string, t: string | undefined) => {
    if (t) challenge.set(org, t);
    else challenge.delete(org);
  },
  session: (org: string) => session.get(org),
  setSession: (org: string, t: string | undefined) => {
    if (t) session.set(org, t);
    else session.delete(org);
  },
  /**
   * Sessão NOVA emitida por login (MFA verificado ou cadastrado): fronteira de sessão. Diferente de `setSession`, usado
   * quando o token da MESMA sessão é só recuperado do servidor.
   */
  beginSession: (org: string, t: string) => {
    session.set(org, t);
    boundary(false);
  },
  /** Esquece tudo (logout, sessão expirada, testes): também é fronteira de sessão. */
  clear: () => {
    forget();
    boundary(false);
  },
  /**
   * Estado mantido em memória que pertence a UMA sessão (ex.: registro de escritas, área autenticada) se zera nas
   * fronteiras. `remote` = a troca veio de outra aba.
   */
  onSessionBoundary: (listener: (remote: boolean) => void) => {
    boundaryListeners.add(listener);
    return () => {
      boundaryListeners.delete(listener);
    };
  },
};
