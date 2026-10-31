/**
 * Identidade Nekkora (cadastro web, entrada geral, sessão de identidade, organizações da identidade, troca, vinculação e
 * convites): rotas FORA de /o/{org}. Contrato: OpenAPI fixado em contract/SOURCE.json, tags "Cadastro web" e "Entrada
 * geral". Cada resposta é conferida contra o esquema do status recebido. Toda decisão é da API; aqui só se envia,
 * recebe e interpreta.
 *
 * Sessões: a de identidade (cookie __Host-nekkora_id, 12 h) autentica estas rotas; a de organização (cookie
 * __Host-nekkora_session) nasce da troca e serve as rotas /api/v1/o/{org}/…. Os tokens CSRF ficam só em memória.
 */
import { csrfStore } from './csrf';
import { preAuthPost } from './auth';
import { ApiError, isApiError, request, type RequestOptions } from './http';
import { validated, validatedAs, type OperationId } from './validate';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type IdentityOrganizationList = S['IdentityOrganizationList'];
export type IdentityOrganization = IdentityOrganizationList['organizations'][number];
export type OrganizationActivationState = S['OrganizationActivationState'];

/** Próximo passo depois da senha: a entrada geral sempre exige o segundo fator. */
export type IdentityNextStep = 'mfa' | 'mfa-setup';

async function send<T>(operationId: OperationId, path: string, options: RequestOptions = {}): Promise<T> {
  const { status, data } = await request<unknown>(path, options);
  return validated<T>(operationId, data, status);
}

/** Pré-autenticação com o esquema do status: 202/204 sem corpo, o resto conferido. */
async function preAuth<T>(operationId: OperationId, path: string, body: unknown): Promise<T> {
  const { status, data } = await preAuthPost<unknown>(path, body);
  return validated<T>(operationId, data, status);
}

// ------------------------------------------------------------------ cadastro (chave nekkora.cadastro.enabled)

/** Sempre 202, sem corpo e sem revelar se o e-mail existe. 404 = cadastro indisponível. */
export async function signup(email: string): Promise<void> {
  await preAuth('signup', '/api/v1/signup', { email });
}

/** Conclui com o token do link, a senha e o nome. 400 = link inválido (vencido, usado, revogado, substituído) ou dados fora da política. */
export async function confirmSignup(token: string, password: string, displayName: string): Promise<void> {
  await preAuth('confirmSignup', '/api/v1/signup/confirm', { token, password, displayName });
}

/** Reenvio: sempre 202 (só identidade pendente recebe nova mensagem; a anterior deixa de valer). */
export async function resendSignupConfirmation(email: string): Promise<void> {
  await preAuth('resendSignupConfirmation', '/api/v1/signup/confirmation/resend', { email });
}

// ------------------------------------------------------------------ entrada geral

export async function identityLogin(email: string, password: string): Promise<IdentityNextStep> {
  const data = await preAuth<S['LoginResponse']>('identityLogin', '/api/v1/auth/login', { email, password });
  csrfStore.setPre(undefined);
  csrfStore.setIdentityChallenge(data.csrfToken);
  return data.status === 'mfa_required' ? 'mfa' : 'mfa-setup';
}

function challengeCsrf(): string {
  const t = csrfStore.identityChallenge();
  // sem o token do desafio em memória (recarregou, outra aba) o desafio não continua: novo login
  if (!t) throw new ApiError('unauthenticated', 401);
  return t;
}

/** Sessão de identidade atual: restrita ou não, e o CSRF dela (recarregar a página não perde a sessão). */
export async function identitySession(): Promise<{ restricted: boolean }> {
  const data = await send<S['IdentitySessionState']>('identitySessionState', '/api/v1/me/session');
  csrfStore.setIdentitySession(data.csrfToken);
  return { restricted: data.restricted };
}

export async function identityCsrf(): Promise<string> {
  const cached = csrfStore.identitySession();
  if (cached) return cached;
  await identitySession();
  return csrfStore.identitySession()!;
}

/**
 * Fator TOTP, passo 1. Modo `challenge`: primeiro fator no desafio de login. Modo `session`: substituição na sessão de
 * identidade (step-up de até 5 min ou sessão restrita nascida de código de recuperação). O segredo chega uma vez.
 */
export async function startIdentityEnrollment(mode: 'challenge' | 'session'): Promise<string> {
  const csrf = mode === 'challenge' ? challengeCsrf() : await identityCsrf();
  const data = await send<S['OtpauthUri']>('identityStartMfaEnrollment', '/api/v1/auth/mfa/enroll/start', { method: 'POST', csrf });
  if (!data.otpauthUri.startsWith('otpauth://')) throw new ApiError('unexpected', 200);
  return data.otpauthUri;
}

/** Fator TOTP, passo 2: no desafio emite a sessão de identidade; na sessão troca o fator. Devolve os códigos novos (uma vez). */
export async function confirmIdentityEnrollment(mode: 'challenge' | 'session', code: string): Promise<string[]> {
  const csrf = mode === 'challenge' ? challengeCsrf() : await identityCsrf();
  const { status, data: raw } = await request<unknown>('/api/v1/auth/mfa/enroll/confirm', { method: 'POST', body: { code }, csrf });
  // o oneOf do contrato é ambíguo (a resposta do desafio também satisfaz a da substituição — D-API-01): o ramo é o do
  // modo da requisição, conferido pelo esquema exato
  if (mode === 'challenge') {
    const data = validatedAs<S['IdentityEnrollmentConfirmation']>('identityConfirmMfaEnrollment', 'IdentityEnrollmentConfirmation', raw, status);
    csrfStore.beginIdentitySession(data.csrfToken);
    return data.recoveryCodes;
  }
  const data = validatedAs<S['IdentityFactorReplacement']>('identityConfirmMfaEnrollment', 'IdentityFactorReplacement', raw, status);
  return data.recoveryCodes;
}

/** TOTP ou código de recuperação (exatamente um). Código de recuperação → sessão RESTRITA até trocar o fator. */
export async function verifyIdentityMfa(secondFactor: { code: string } | { recoveryCode: string }): Promise<{ restricted: boolean }> {
  const data = await send<S['IdentitySessionIssued']>('identityVerifyMfa', '/api/v1/auth/mfa/verify', {
    method: 'POST',
    body: secondFactor,
    csrf: challengeCsrf(),
  });
  csrfStore.beginIdentitySession(data.csrfToken);
  return { restricted: data.restricted };
}

/**
 * Encerra a sessão de identidade (idempotente; disponível mesmo com as chaves desligadas). As sessões de organização
 * derivadas caem na requisição seguinte. A memória local é limpa em qualquer desfecho.
 */
export async function identityLogout(): Promise<void> {
  try {
    let csrf = csrfStore.identitySession();
    if (!csrf) {
      try {
        await identitySession();
        csrf = csrfStore.identitySession();
      } catch (e) {
        if (isApiError(e, 'unauthenticated')) return; // sem sessão de identidade: nada a encerrar
        if (!(e instanceof ApiError && e.status === 404)) throw e; // chave desligada: o logout continua disponível
      }
    }
    await send('identityLogout', '/api/v1/auth/logout', { method: 'POST', csrf });
  } finally {
    csrfStore.clear();
  }
}

/** Step-up da sessão de identidade: TOTP do fator da identidade, vale 5 min só nesta sessão. Só o 204 confirma. */
export async function identityStepUp(code: string): Promise<void> {
  const csrf = await identityCsrf();
  const res = await request('/api/v1/auth/step-up', { method: 'POST', body: { code }, csrf });
  if (res.status !== 204) throw new ApiError('unexpected', res.status);
}

/** Troca de senha (step-up recente). Senha atual errada, sem step-up ou sessão restrita: 403. Demais sessões revogadas. */
export async function changeIdentityPassword(currentPassword: string, newPassword: string): Promise<void> {
  await send('identityChangePassword', '/api/v1/auth/password', {
    method: 'POST',
    body: { currentPassword, newPassword },
    csrf: await identityCsrf(),
  });
}

/** Novo conjunto de códigos de recuperação (step-up recente); o anterior deixa de valer. Mostrado uma única vez. */
export async function regenerateRecoveryCodes(): Promise<string[]> {
  const data = await send<S['RecoveryCodes']>('identityRegenerateRecoveryCodes', '/api/v1/auth/mfa/recovery-codes', {
    method: 'POST',
    csrf: await identityCsrf(),
  });
  return data.recoveryCodes;
}

// ------------------------------------------------------------------ recuperação de senha (chave nekkora.recuperacao-senha.enabled)

/** Sempre 202, com o mesmo tempo, exista ou não a identidade. */
export async function requestIdentityPasswordReset(email: string): Promise<void> {
  await preAuth('identityRequestPasswordReset', '/api/v1/auth/password-reset/request', { email });
}

/** 204 = senha trocada; nenhuma sessão criada e o MFA continua exigido. 400 = link inválido ou senha fora da política. */
export async function confirmIdentityPasswordReset(token: string, newPassword: string): Promise<void> {
  await preAuth('identityConfirmPasswordReset', '/api/v1/auth/password-reset/confirm', { token, newPassword });
}

// ------------------------------------------------------------------ organizações da identidade

/** Organizações em que a identidade pode entrar. Lista vazia é legítima. Sessão restrita: 403. */
export async function myOrganizations(): Promise<IdentityOrganizationList> {
  return send<IdentityOrganizationList>('identityOrganizations', '/api/v1/me/organizations');
}

/** Cria a organização com a identidade como ORG_ADMIN (step-up de até 5 min). Nasce AGUARDANDO_ATIVACAO. */
export async function createOrganization(name: string, legalName?: string): Promise<string> {
  const data = await send<S['OrganizationCreated']>('identityCreateOrganization', '/api/v1/organizations', {
    method: 'POST',
    body: legalName ? { name, legalName } : { name },
    csrf: await identityCsrf(),
  });
  return data.organizationId;
}

/**
 * Troca a sessão de identidade por uma sessão de organização. `sem_acesso` é a resposta única para qualquer recusa. O
 * cookie de organização é um por origem: a sessão de outra organização (inclusive em outra aba) deixa de valer.
 */
export async function enterOrganization(organizationId: string): Promise<'entered' | 'no_access'> {
  const data = await send<S['OrganizationSessionResult']>('exchangeOrganizationSession', '/api/v1/sessions/organization', {
    method: 'POST',
    body: { organizationId },
    csrf: await identityCsrf(),
  });
  if (data.status === 'sem_acesso') return 'no_access';
  if (!data.csrfToken) throw new ApiError('unexpected', 200);
  csrfStore.beginSession(organizationId, data.csrfToken);
  return 'entered';
}

// ------------------------------------------------------------------ vinculação de conta antiga (chave nekkora.vinculacao.enabled)

/** Etapa 1: prova da conta antiga (senha + TOTP ou código de recuperação DELA). Qualquer recusa: o mesmo 401. */
export async function startAccountLink(
  organizationId: string,
  password: string,
  secondFactor: { code: string } | { recoveryCode: string },
): Promise<void> {
  await send('identityLinkStart', '/api/v1/links/start', {
    method: 'POST',
    body: { organizationId, password, ...secondFactor },
    csrf: await identityCsrf(),
  });
}

/** Etapa 2: prova da identidade (step-up) e consumo do desafio. Recusa genérica: 403. */
export async function confirmAccountLink(organizationId: string): Promise<void> {
  await send('identityLinkConfirm', '/api/v1/links/confirm', { method: 'POST', body: { organizationId }, csrf: await identityCsrf() });
}

// ------------------------------------------------------------------ convites (chave nekkora.convites.enabled)

/** Aceite pela identidade (step-up). 404 único = convite inválido para esta identidade; 409 = already_member, account_exists, account_unavailable. */
export async function acceptInvitation(organizationId: string, token: string): Promise<string> {
  const data = await send<S['InvitationAccepted']>('acceptInvitation', '/api/v1/invitations/accept', {
    method: 'POST',
    body: { organizationId, token },
    csrf: await identityCsrf(),
  });
  return data.organizationId;
}
