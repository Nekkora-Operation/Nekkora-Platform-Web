import { DEV_PASSWORD } from '../../mock/contract';

/**
 * Fixtures pela API simulada (mock/, endpoints de controle em /__mock/): provisionam contas e simulam o e-mail
 * transacional — o link é montado com um token emitido pelo simulador, no formato proposto (D4).
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173';

export const PASSWORD = DEV_PASSWORD;

export interface Account {
  org: string;
  userId: string;
  email: string;
}

async function control<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`controle da API simulada falhou: ${path} (${res.status})`);
  return (await res.json()) as T;
}

export async function createOrganization(): Promise<string> {
  return (await control<{ org: string }>('organizations', {})).org;
}

/** Conta interna com vínculo ativo; `verified: false` deixa o e-mail pendente de confirmação. */
export async function createAccount(org?: string, { verified = true } = {}): Promise<Account> {
  return control<Account>('accounts', { org, verified });
}

export async function issuePasswordResetToken(userId: string, { expired = false } = {}): Promise<string> {
  return (await control<{ token: string }>('password-reset-tokens', { userId, expired })).token;
}

export async function issueEmailVerificationToken(account: Account, { expired = false } = {}): Promise<string> {
  return (await control<{ token: string }>('email-verification-tokens', { userId: account.userId, expired })).token;
}

export async function countPasswordResetTokens(userId: string): Promise<number> {
  return (await control<{ count: number }>(`password-reset-tokens?userId=${encodeURIComponent(userId)}`)).count;
}

/** Encerra as sessões no servidor (equivale a inatividade, limite absoluto ou revogação). */
export async function revokeSessions(userId: string): Promise<void> {
  await control('revoke-sessions', { userId });
}
