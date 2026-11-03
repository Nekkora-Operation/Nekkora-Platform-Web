/**
 * Como a sessão em uso prova a pessoa nas ações sensíveis (API 029, `stepUpMethod`): `totp` (código do autenticador) ou
 * `password` (senha reconfirmada, SÓ para quem nunca ativou a autenticação em duas etapas). A API decide e informa em
 * `GET /api/v1/me/session` (identidade) e `GET /api/v1/o/{org}/me` (organização); aqui só se guarda a última resposta,
 * em memória, para o diálogo mostrar o campo certo e o cliente chamar a rota certa. Na dúvida, `totp`: a API recusa a
 * senha de quem tem fator, então o padrão nunca relaxa nada.
 */
import { csrfStore } from './csrf';

export type StepUpMethod = 'totp' | 'password';

const IDENTITY = '';
const methods = new Map<string, StepUpMethod>();

export const stepUpMethods = {
  /** `org` ausente = sessão de identidade. Valor fora do contrato ou ausente apaga o registro (volta a `totp`). */
  set(org: string | undefined, method: unknown): void {
    if (method === 'totp' || method === 'password') methods.set(org ?? IDENTITY, method);
    else methods.delete(org ?? IDENTITY);
  },
  get(org?: string): StepUpMethod {
    return methods.get(org ?? IDENTITY) ?? 'totp';
  },
  clear(): void {
    methods.clear();
  },
};

// saída ou expiração (nesta aba ou em outra): o método da sessão encerrada não vale para a próxima
csrfStore.onSessionEnd(() => methods.clear());
