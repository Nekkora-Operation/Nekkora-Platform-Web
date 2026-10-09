/**
 * Organização vem da URL: /o/{organizationId}/… (decisão 8.1 da API: o identificador público na v1 é o
 * organization_id, um UUID — slug/subdomínio ficaram para depois).
 *
 * A validação aqui é só de FORMATO, para responder "organização não encontrada" a endereços claramente
 * errados sem consultar a API. Se a organização existe/está ativa, só a API sabe — e ela não revela isso
 * antes da autenticação (resposta genérica).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidOrganizationId(value: string | undefined): value is string {
  return !!value && UUID.test(value);
}

/** Identificador curto para exibição discreta (ex.: 3f2a1c9e…91c0). */
export function shortOrganizationId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/** Todas as rotas preservam o contexto: nunca montar caminho de autenticação sem a organização. */
export const orgPath = {
  login: (org: string) => `/o/${org}/login`,
  mfa: (org: string) => `/o/${org}/mfa`,
  mfaSetup: (org: string) => `/o/${org}/mfa/setup`,
  forgotPassword: (org: string) => `/o/${org}/forgot-password`,
  resetPassword: (org: string) => `/o/${org}/reset-password`,
  resendVerification: (org: string) => `/o/${org}/resend-verification`,
  verifyEmail: (org: string) => `/o/${org}/verify-email`,
  home: (org: string) => `/o/${org}`,
  /** Área interna (F4): lista de execuções. */
  executions: (org: string) => `/o/${org}/execucoes`,
  /** F5: leituras de detalhe (os identificadores vão codificados no caminho). */
  execution: (org: string, id: string) => `/o/${org}/execucoes/${encodeURIComponent(id)}`,
  workspaces: (org: string) => `/o/${org}/workspaces`,
  workspace: (org: string, id: string) => `/o/${org}/workspaces/${encodeURIComponent(id)}`,
  automation: (org: string, id: string) => `/o/${org}/automacoes/${encodeURIComponent(id)}`,
  /** F6a-1: administração (só leitura). */
  members: (org: string) => `/o/${org}/administracao/membros`,
  clients: (org: string) => `/o/${org}/administracao/clientes`,
  grants: (org: string) => `/o/${org}/administracao/concessoes`,
};

/**
 * Nome humano da organização, quando o contrato o fornecer. A API v1 não expõe o nome antes do login nem em
 * /me (identificador público = UUID, decisão 8.1 — divergências D1/D7): hoje devolve sempre undefined e a
 * interface mostra o identificador abreviado. Quando houver resolução pública, ela entra aqui.
 */
export function organizationName(_org: string): string | undefined {
  return undefined;
}
