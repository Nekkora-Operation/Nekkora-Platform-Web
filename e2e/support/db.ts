import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * Fixtures declaradas no banco da stack E2E (superusuário, pelo socket local do container — sem senha em disco).
 * Simulam o que, em produção, chega por processos fora deste frontend: provisionamento da conta e o e-mail
 * transacional (o sender local da API só registra a intenção; o link é montado aqui com um token conhecido,
 * do qual o banco guarda apenas o SHA-256, exatamente como a API faz).
 */
const CONTAINER = `${process.env.E2E_PROJETO ?? 'nekkora-web'}-postgres-1`;

export const PASSWORD = 'Senha-E2E-Nekkora-2026';
// Argon2id do PASSWORD com o perfil vigente da API (m=65536,t=3,p=1). Senha exclusiva de teste.
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$vlroiQF8m4D0dbxX4nAlwQ$fYBRvAd/EVjwuug6A/sTHquChkwNo0wuhaVIqa+T4Zo';

export function sql(query: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'nekkora', '-d', 'nekkora'],
    { input: query, encoding: 'utf8' },
  ).trim();
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

export interface Account {
  org: string;
  userId: string;
  email: string;
}

export function createOrganization(status = 1): string {
  const org = randomUUID();
  sql(`INSERT INTO organizations (organization_id, name, status) VALUES (${q(org)}, 'Org Web E2E', ${status});`);
  return org;
}

/** Conta interna com vínculo ativo; `verified: false` deixa o e-mail pendente de confirmação. */
export function createAccount(org: string, { verified = true } = {}): Account {
  const userId = randomUUID();
  const email = `web-${userId.slice(0, 8)}@e2e.test`;
  sql(`
    INSERT INTO users (user_id, organization_id, account_type, email, email_verified_at, status, display_name)
      VALUES (${q(userId)}, ${q(org)}, 1, ${q(email)}, ${verified ? 'now()' : 'NULL'}, 2, 'Pessoa E2E');
    INSERT INTO organization_memberships (membership_id, organization_id, user_id, account_type, status)
      VALUES (${q(randomUUID())}, ${q(org)}, ${q(userId)}, 1, 2);
    INSERT INTO user_credentials (user_id, password_hash) VALUES (${q(userId)}, ${q(PASSWORD_HASH)});
  `);
  return { org, userId, email };
}

const newToken = () => randomBytes(32).toString('base64url'); // 43 caracteres, como a API
const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

/** "Envia" o e-mail de redefinição: devolve o token do link. `expired` cria um token já vencido. */
export function issuePasswordResetToken(userId: string, { expired = false } = {}): string {
  const token = newToken();
  const times = expired ? "now() - interval '1 hour', now() - interval '30 minutes'" : "now(), now() + interval '30 minutes'";
  sql(`INSERT INTO password_reset_tokens (user_id, token_hash, created_at, expires_at)
       VALUES (${q(userId)}, ${q(sha256(token))}, ${times});`);
  return token;
}

export function issueEmailVerificationToken(account: Account, { expired = false } = {}): string {
  const token = newToken();
  const times = expired ? "now() - interval '2 days', now() - interval '1 day'" : "now(), now() + interval '24 hours'";
  sql(`INSERT INTO email_verification_tokens (user_id, target_email, token_hash, created_at, expires_at)
       VALUES (${q(account.userId)}, ${q(account.email)}, ${q(sha256(token))}, ${times});`);
  return token;
}

export function countPasswordResetTokens(userId: string): number {
  return Number(sql(`SELECT count(*) FROM password_reset_tokens WHERE user_id = ${q(userId)};`));
}

/** Encerra as sessões no servidor (equivale a expiração absoluta/inatividade ou revogação administrativa). */
export function revokeSessions(userId: string): void {
  sql(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = ${q(userId)} AND revoked_at IS NULL;`);
}
