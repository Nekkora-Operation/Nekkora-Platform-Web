/**
 * Contrato de autenticação da Platform (docs/relatorios/2026-09-26-decisoes-8-6-8-7-8-10.md, §5.3), mapeado
 * sem inventar estados. Toda decisão de acesso é da API; aqui só se envia, recebe e interpreta.
 */
import { csrfStore } from './csrf';
import { ApiError, isApiError, request } from './http';

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;

/** Próximo passo depois da senha. A API v1 sempre exige MFA: não há sucesso direto sem segundo fator. */
export type LoginNextStep = 'mfa' | 'mfa-setup';

export interface Me {
  accountType: 'internal' | 'external';
  displayName: string;
  email: string;
  organizationId: string;
}

// ------------------------------------------------------------------ CSRF de pré-autenticação

async function preCsrf(fresh = false): Promise<string> {
  if (!fresh && csrfStore.pre()) return csrfStore.pre()!;
  const { data } = await request<{ csrfToken?: string }>('/api/v1/csrf');
  if (!data?.csrfToken) throw new ApiError('unexpected', 200);
  csrfStore.setPre(data.csrfToken);
  return data.csrfToken;
}

/**
 * Escrita de pré-autenticação. Se o token pré-autenticação expirou (30 min) a API responde 403: pede um novo
 * UMA vez e repete — rotação prevista no contrato, não uma regra de segurança nova.
 */
async function preAuthPost<T>(path: string, body: unknown) {
  try {
    return await request<T>(path, { method: 'POST', body, csrf: await preCsrf() });
  } catch (e) {
    if (!isApiError(e, 'forbidden')) throw e;
    return request<T>(path, { method: 'POST', body, csrf: await preCsrf(true) });
  }
}

// ------------------------------------------------------------------ login e MFA

export async function login(org: string, email: string, password: string): Promise<LoginNextStep> {
  const { data } = await preAuthPost<{ status?: string; csrfToken?: string }>(`${base(org)}/auth/login`, { email, password });
  csrfStore.setPre(undefined); // o contrato descarta o estado pré-autenticação ao criar o desafio
  if (!data?.csrfToken) throw new ApiError('unexpected', 200);
  const next: LoginNextStep | undefined =
    data.status === 'mfa_required' ? 'mfa' : data.status === 'mfa_enrollment_required' ? 'mfa-setup' : undefined;
  if (!next) throw new ApiError('unexpected', 200);
  csrfStore.setChallenge(org, data.csrfToken);
  return next;
}

function challengeCsrf(org: string): string {
  const t = csrfStore.challenge(org);
  // sem token do desafio em memória (recarregou a página, abriu outra aba) o desafio não pode continuar
  if (!t) throw new ApiError('unauthenticated', 401);
  return t;
}

/** Cadastro de MFA, passo 1: o SEGREDO vem do servidor, como URI otpauth://, uma única vez. */
export async function startMfaEnrollment(org: string): Promise<string> {
  const { data } = await request<{ otpauthUri?: string }>(`${base(org)}/auth/mfa/enroll/start`, {
    method: 'POST',
    csrf: challengeCsrf(org),
  });
  if (!data?.otpauthUri?.startsWith('otpauth://')) throw new ApiError('unexpected', 200);
  return data.otpauthUri;
}

/** Cadastro de MFA, passo 2: confirma um código; a API cria a sessão e devolve os códigos de recuperação. */
export async function confirmMfaEnrollment(org: string, code: string): Promise<string[]> {
  const { data } = await request<{ recoveryCodes?: unknown; csrfToken?: string }>(`${base(org)}/auth/mfa/enroll/confirm`, {
    method: 'POST',
    body: { code },
    csrf: challengeCsrf(org),
  });
  if (!Array.isArray(data?.recoveryCodes) || !data.csrfToken) throw new ApiError('unexpected', 200);
  csrfStore.setChallenge(org, undefined);
  csrfStore.beginSession(org, data.csrfToken);
  return data.recoveryCodes.filter((c): c is string => typeof c === 'string');
}

/** Verificação com TOTP ou com código de recuperação (exatamente um dos dois — contrato §5.3). */
export async function verifyMfa(org: string, secondFactor: { code: string } | { recoveryCode: string }): Promise<void> {
  const { data } = await request<{ csrfToken?: string }>(`${base(org)}/auth/mfa/verify`, {
    method: 'POST',
    body: secondFactor,
    csrf: challengeCsrf(org),
  });
  if (!data?.csrfToken) throw new ApiError('unexpected', 200);
  csrfStore.setChallenge(org, undefined);
  csrfStore.beginSession(org, data.csrfToken);
}

// ------------------------------------------------------------------ sessão

/** Quem está autenticado — a API é a autoridade (401 = sem sessão válida: expirada, revogada ou inexistente). */
export async function me(org: string): Promise<Me> {
  const { data } = await request<Me>(`${base(org)}/me`);
  return data;
}

/** CSRF da sessão atual (memória; recuperado de GET …/auth/csrf depois de recarregar a página). */
export async function sessionCsrf(org: string): Promise<string> {
  const cached = csrfStore.session(org);
  if (cached) return cached;
  const { data } = await request<{ csrfToken?: string }>(`${base(org)}/auth/csrf`);
  if (!data?.csrfToken) throw new ApiError('unexpected', 200);
  csrfStore.setSession(org, data.csrfToken);
  return data.csrfToken;
}

/**
 * Step-up com TOTP na sessão atual (exigido pelo reset administrativo de MFA). Só `code`: o código de recuperação
 * não é alternativa aqui (a API o ignora). Código errado → 403.
 */
export async function stepUp(org: string, code: string): Promise<void> {
  await request(`${base(org)}/auth/mfa/step-up`, { method: 'POST', body: { code }, csrf: await sessionCsrf(org) });
}

/** Logout idempotente; o estado local é limpo mesmo se a sessão já não existir. */
export async function logout(org: string): Promise<void> {
  try {
    await request(`${base(org)}/auth/logout`, { method: 'POST', csrf: await sessionCsrf(org) });
  } catch (e) {
    if (!isApiError(e, 'unauthenticated')) throw e;
  } finally {
    csrfStore.clear();
  }
}

// ------------------------------------------------------------------ senha e e-mail

/** Sempre 202 (resposta idêntica exista ou não a conta). */
export async function requestPasswordReset(org: string, email: string): Promise<void> {
  await preAuthPost(`${base(org)}/auth/password-reset/request`, { email });
}

/** 204 = senha trocada. 400 invalid_request = token inválido, expirado ou já usado (ou senha fora da política). */
export async function confirmPasswordReset(org: string, token: string, newPassword: string): Promise<void> {
  await preAuthPost(`${base(org)}/auth/password-reset/confirm`, { token, newPassword });
}

/** 204 = e-mail confirmado. 400 invalid_request = token inválido, expirado ou já usado (a API não distingue). */
export async function confirmEmail(org: string, token: string): Promise<void> {
  await preAuthPost(`${base(org)}/auth/email-verification/confirm`, { token });
}

/**
 * Reenvio de verificação de e-mail — NÃO EXISTE no contrato v1 (divergência D2 em docs/DIVERGENCIAS.md).
 * Mantido atrás de `features.resendVerification` (desligado). O caminho abaixo é só a PROPOSTA registrada.
 */
export async function requestEmailVerification(org: string, email: string): Promise<void> {
  await preAuthPost(`${base(org)}/auth/email-verification/request`, { email });
}
