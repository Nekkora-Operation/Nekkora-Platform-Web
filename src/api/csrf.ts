/**
 * Tokens CSRF sincronizadores (contrato 8.7 §5.1), SOMENTE em memória — nunca localStorage/sessionStorage.
 * Recarregar a página perde os tokens de propósito: o de sessão é recuperado do servidor (GET …/auth/csrf);
 * o de desafio MFA não tem recuperação (novo login).
 */
let pre: string | undefined;
const challenge = new Map<string, string>();
const session = new Map<string, string>();

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
  /** Esquece tudo (logout, sessão expirada, testes). */
  clear: () => {
    pre = undefined;
    challenge.clear();
    session.clear();
  },
};
