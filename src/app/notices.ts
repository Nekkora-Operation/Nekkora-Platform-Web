/**
 * Avisos passados entre telas pelo estado de navegação do roteador (memória do histórico) — nunca pela URL
 * nem por storage. Não carregam dado sensível.
 */
export type Notice = 'session-expired' | 'signed-out' | 'challenge-expired' | 'session-changed';

export interface NavState {
  notice?: Notice;
  /** A pessoa entrou usando um código de recuperação (aviso na área autenticada). */
  recoveryCodeUsed?: boolean;
}

export function readNavState(state: unknown): NavState {
  if (!state || typeof state !== 'object') return {};
  const s = state as Record<string, unknown>;
  const notice = s.notice;
  return {
    notice:
      notice === 'session-expired' || notice === 'signed-out' || notice === 'challenge-expired' || notice === 'session-changed' ? notice : undefined,
    recoveryCodeUsed: s.recoveryCodeUsed === true,
  };
}

/** Marca, só em memória, que esta aba teve uma sessão — para distinguir "expirou" de "nunca entrou". */
let hadSession = false;
export const sessionMemory = {
  markActive: () => {
    hadSession = true;
  },
  hadSession: () => hadSession,
  reset: () => {
    hadSession = false;
  },
};
