/**
 * Tokens CSRF sincronizadores (contrato 8.7 §5.1), SOMENTE em memória — nunca localStorage/sessionStorage.
 * Recarregar a página perde os tokens de propósito: o de sessão é recuperado do servidor (GET …/auth/csrf);
 * o de desafio MFA não tem recuperação (novo login).
 */
let pre: string | undefined;
const challenge = new Map<string, string>();
const session = new Map<string, string>();
/** Entrada geral (identidade, fora de /o/{org}): desafio de login e sessão de identidade (cookie __Host-nekkora_id). */
let identityChallenge: string | undefined;
let identitySession: string | undefined;
/**
 * Avisados a cada fronteira de sessão: nesta aba (login que emite sessão nova, logout, sessão expirada) ou em OUTRA aba
 * da mesma origem (`remote`). O cookie de sessão é um só por origem: a troca feita em outra aba vale para esta.
 */
const boundaryListeners = new Set<(remote: boolean, scope: SessionScope) => void>();

/**
 * Alcance da fronteira: `organization` = só a sessão de organização mudou (entrar numa organização emite outro cookie de
 * organização; a sessão de identidade, cookie próprio, continua valendo); `all` = identidade nova, logout ou expiração.
 */
export type SessionScope = 'organization' | 'all';

/**
 * Aviso entre abas (F6a-2-R2): só o fato "a sessão mudou", sem token, cookie nem identidade. Sem BroadcastChannel no
 * ambiente, só as fronteiras locais valem (limitação registrada).
 */
const SESSION_CHANNEL = 'nekkora-sessao';
const channel: BroadcastChannel | undefined = typeof BroadcastChannel === 'function' ? new BroadcastChannel(SESSION_CHANNEL) : undefined;

const forgetOrganization = () => {
  pre = undefined;
  challenge.clear();
  session.clear();
};

const forget = () => {
  forgetOrganization();
  identityChallenge = undefined;
  identitySession = undefined;
};

const boundary = (remote: boolean, scope: SessionScope) => {
  if (!remote) channel?.postMessage(scope === 'organization' ? { tipo: 'sessao-alterada', alcance: 'organizacao' } : { tipo: 'sessao-alterada' });
  for (const l of boundaryListeners) l(remote, scope);
};

channel?.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { tipo?: unknown; alcance?: unknown } | null;
  if (data?.tipo !== 'sessao-alterada') return;
  // a sessão desta aba deixou de valer: esquece os tokens (sem reenviar o aviso) e avisa quem guarda estado da sessão;
  // só a de organização mudou → a identidade desta aba (desafio MFA em curso, sessão) continua
  const scope: SessionScope = data.alcance === 'organizacao' ? 'organization' : 'all';
  if (scope === 'organization') forgetOrganization();
  else forget();
  boundary(true, scope);
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
    boundary(false, 'organization');
  },
  /** Desafio da entrada geral (5 min; perdido ao recarregar a página: só um novo login continua). */
  identityChallenge: () => identityChallenge,
  setIdentityChallenge: (t: string | undefined) => {
    identityChallenge = t;
  },
  /** CSRF da sessão de identidade (memória; recuperado de GET /api/v1/me/session depois de recarregar). */
  identitySession: () => identitySession,
  setIdentitySession: (t: string | undefined) => {
    identitySession = t;
  },
  /**
   * Sessão de identidade NOVA (MFA verificado ou primeiro fator confirmado): fronteira de sessão. As sessões de
   * organização desta origem passam a depender dela.
   */
  beginIdentitySession: (t: string) => {
    identityChallenge = undefined;
    identitySession = t;
    boundary(false, 'all');
  },
  /** Esquece tudo (logout, sessão expirada, testes): também é fronteira de sessão. */
  clear: () => {
    forget();
    boundary(false, 'all');
  },
  /**
   * Estado mantido em memória que pertence a UMA sessão (ex.: registro de escritas, área autenticada) se zera nas
   * fronteiras. `remote` = a troca veio de outra aba.
   */
  onSessionBoundary: (listener: (remote: boolean, scope: SessionScope) => void) => {
    boundaryListeners.add(listener);
    return () => {
      boundaryListeners.delete(listener);
    };
  },
};
