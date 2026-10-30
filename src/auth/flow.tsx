import { createContext, useContext, useMemo, type ReactNode } from 'react';
import * as orgAuth from '../api/auth';
import { csrfStore } from '../api/csrf';
import * as identity from '../api/identity';
import { orgPath } from './organization';

/**
 * Fluxo de autenticação de uma tela de entrada. As mesmas telas (senha, segundo fator, primeiro fator, recuperação de
 * senha) servem às duas portas que a API oferece, sem cópia:
 *
 * - `identity`: entrada geral da identidade Nekkora (fora de /o/{org}); depois dela a pessoa escolhe a organização;
 * - `organization`: entrada por conta de organização (contrato 8.7, /o/{org}/login), mantida para conta NÃO vinculada.
 *   Conta vinculada recebe o mesmo 401 genérico e entra pela identidade.
 */
export interface AuthFlow {
  kind: 'identity' | 'organization';
  /** Organização exibida no contexto da tela (só na entrada por organização). */
  org?: string;
  login(email: string, password: string): Promise<'mfa' | 'mfa-setup'>;
  hasChallenge(): boolean;
  clearChallenge(): void;
  startEnrollment(): Promise<string>;
  confirmEnrollment(code: string): Promise<string[]>;
  /** `restricted`: sessão nascida de código de recuperação (só trocar o fator e sair). */
  verify(secondFactor: { code: string } | { recoveryCode: string }): Promise<{ restricted: boolean }>;
  requestPasswordReset(email: string): Promise<void>;
  confirmPasswordReset(token: string, newPassword: string): Promise<void>;
  paths: { login: string; mfa: string; mfaSetup: string; forgotPassword: string };
  /** Destino depois da sessão emitida. */
  home(restricted: boolean): string;
  /** Linha de contexto do arquivo de códigos de recuperação (nunca segredo). */
  codesContext: string;
}

/** Caminhos da identidade (fora de /o/{org}). Os de links de e-mail são contrato da API (MailTemplates). */
export const identityPath = {
  login: '/entrar',
  mfa: '/entrar/verificacao',
  mfaSetup: '/entrar/configurar-autenticador',
  /** Pedido (sem token) e conclusão (link do e-mail, #token=). */
  recoverPassword: '/recuperar-senha',
  signup: '/cadastro',
  /** Link do e-mail de cadastro (#token=). */
  signupConfirm: '/cadastro/confirmar',
  organizations: '/organizacoes',
  newOrganization: '/organizacoes/nova',
  account: '/conta',
  /** Troca do fator: obrigatória na sessão restrita. */
  replaceFactor: '/conta/fator',
  linkAccount: '/vincular-conta',
};

export function identityFlow(): AuthFlow {
  return {
    kind: 'identity',
    login: (email, password) => identity.identityLogin(email, password),
    hasChallenge: () => !!csrfStore.identityChallenge(),
    clearChallenge: () => csrfStore.setIdentityChallenge(undefined),
    startEnrollment: () => identity.startIdentityEnrollment('challenge'),
    confirmEnrollment: (code) => identity.confirmIdentityEnrollment('challenge', code),
    verify: (f) => identity.verifyIdentityMfa(f),
    requestPasswordReset: (email) => identity.requestIdentityPasswordReset(email),
    confirmPasswordReset: (token, pw) => identity.confirmIdentityPasswordReset(token, pw),
    paths: {
      login: identityPath.login,
      mfa: identityPath.mfa,
      mfaSetup: identityPath.mfaSetup,
      forgotPassword: identityPath.recoverPassword,
    },
    home: (restricted) => (restricted ? identityPath.replaceFactor : identityPath.organizations),
    codesContext: 'Identidade Nekkora',
  };
}

export function organizationFlow(org: string): AuthFlow {
  return {
    kind: 'organization',
    org,
    login: (email, password) => orgAuth.login(org, email, password),
    hasChallenge: () => !!csrfStore.challenge(org),
    clearChallenge: () => csrfStore.setChallenge(org, undefined),
    startEnrollment: () => orgAuth.startMfaEnrollment(org),
    confirmEnrollment: (code) => orgAuth.confirmMfaEnrollment(org, code),
    verify: async (f) => {
      await orgAuth.verifyMfa(org, f);
      return { restricted: false };
    },
    requestPasswordReset: (email) => orgAuth.requestPasswordReset(org, email),
    confirmPasswordReset: (token, pw) => orgAuth.confirmPasswordReset(org, token, pw),
    paths: { login: orgPath.login(org), mfa: orgPath.mfa(org), mfaSetup: orgPath.mfaSetup(org), forgotPassword: orgPath.forgotPassword(org) },
    home: () => orgPath.home(org),
    codesContext: `Organização: ${org}`,
  };
}

const FlowContext = createContext<AuthFlow | null>(null);

export function useAuthFlow(): AuthFlow {
  const flow = useContext(FlowContext);
  if (!flow) throw new Error('useAuthFlow fora de um fluxo de autenticação');
  return flow;
}

export function OrganizationFlowProvider({ org, children }: { org: string; children: ReactNode }) {
  const flow = useMemo(() => organizationFlow(org), [org]);
  return <FlowContext.Provider value={flow}>{children}</FlowContext.Provider>;
}

export function IdentityFlowProvider({ children }: { children: ReactNode }) {
  const flow = useMemo(() => identityFlow(), []);
  return <FlowContext.Provider value={flow}>{children}</FlowContext.Provider>;
}
