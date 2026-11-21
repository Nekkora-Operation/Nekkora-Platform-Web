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
  /** Minha conta (dados da conta nesta organização e a versão em execução). */
  account: (org: string) => `/o/${org}/conta`,
  /** Reentrada pela identidade (troca por gesto explícito). */
  entry: (org: string) => `/o/${org}/entrar`,
  /** Área interna (F4): lista de execuções. */
  executions: (org: string) => `/o/${org}/execucoes`,
  /** F5: leituras de detalhe (os identificadores vão codificados no caminho). */
  execution: (org: string, id: string) => `/o/${org}/execucoes/${encodeURIComponent(id)}`,
  workspaces: (org: string) => `/o/${org}/workspaces`,
  workspace: (org: string, id: string) => `/o/${org}/workspaces/${encodeURIComponent(id)}`,
  automation: (org: string, id: string) => `/o/${org}/automacoes/${encodeURIComponent(id)}`,
  /** T04: criar automação (só o nome, ou com a primeira versão e o ZIP). */
  newAutomation: (org: string, workspaceId: string) => `/o/${org}/workspaces/${encodeURIComponent(workspaceId)}/nova-automacao`,
  /** T09 (PLATFORM-AGENT-V2-002): formulário de nova versão; nada é gravado até a Platform aceitar o ZIP. */
  newVersion: (org: string, automationId: string) => `/o/${org}/automacoes/${encodeURIComponent(automationId)}/nova-versao`,
  /** M3: versão (ciclo de vida: pacote, conferência, publicação). */
  version: (org: string, id: string) => `/o/${org}/versoes/${encodeURIComponent(id)}`,
  /** M4: execução local (Agents, Workers) e supervisão das execuções registradas pelo Agent. */
  /** Endereço antigo (compatibilidade, T07): leva a Workers, a entrada única. */
  agents: (org: string) => `/o/${org}/agents`,
  workers: (org: string) => `/o/${org}/workers`,
  remoteExecution: (org: string, id: string) => `/o/${org}/execucoes-remotas/${encodeURIComponent(id)}`,
  /** PLATFORM-FLUXO-002: o acompanhamento ficou em Execuções; /supervisao redireciona para lá (compatibilidade). */
  agentRuns: (org: string) => `/o/${org}/execucoes`,
  /** Detalhe da execução do Agent anterior (antes /supervisao/:id, que redireciona para cá). */
  agentRun: (org: string, id: string) => `/o/${org}/execucoes-locais/${encodeURIComponent(id)}`,
  /** Máquinas com o foco numa máquina (de uma execução para a sua máquina). */
  machine: (org: string, workerId: string) => `/o/${org}/workers?maquina=${encodeURIComponent(workerId)}`,
  /** Execuções de uma máquina ("Ver atividade"). */
  machineActivity: (org: string, workerId: string) => `/o/${org}/execucoes?maquina=${encodeURIComponent(workerId)}`,
  /** F6a-1: administração (só leitura). */
  /** PLATFORM-FLUXO-002: membros e convites numa página só ("Pessoas e acessos"). */
  people: (org: string) => `/o/${org}/administracao/pessoas`,
  /** O modal "Gerenciar acessos" de um membro, aberto pelo endereço (vale depois de recarregar). */
  personAccess: (org: string, userId: string) => `/o/${org}/administracao/pessoas?acessos=${encodeURIComponent(userId)}`,
  /** O modal de acessos de um cliente (vínculo de cliente), aberto pelo endereço. */
  personClientAccess: (org: string, clientMembershipId: string) =>
    `/o/${org}/administracao/pessoas?cliente=${encodeURIComponent(clientMembershipId)}`,
  /** PLATFORM-FLUXO-002 (070): cadastro de clientes dentro de "Pessoas e acessos" ("Gerenciar clientes"). */
  clientsManage: (org: string, clientId?: string) =>
    `/o/${org}/administracao/pessoas/clientes${clientId ? `?cliente=${encodeURIComponent(clientId)}` : ''}`,
  /** PLATFORM-FLUXO-002 (070): "Acessos e histórico" (abas Concessões e Histórico), com os filtros no endereço. */
  accessHistory: (org: string, params?: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v) q.set(k, v);
    const s = q.toString();
    return `/o/${org}/administracao/pessoas/acessos${s ? `?${s}` : ''}`;
  },
  /** As concessões por ambiente inteiro (modelo anterior), com as decisões de antes (aprovar, renovar, revisar, revogar). */
  workspaceGrants: (org: string) => `/o/${org}/administracao/pessoas/acessos/ambientes`,
  /** Endereço antigo (redireciona para "Pessoas e acessos"). */
  members: (org: string) => `/o/${org}/administracao/membros`,
  /** Endereços antigos (redirecionam para "Gerenciar clientes" e "Acessos e histórico"). */
  clients: (org: string) => `/o/${org}/administracao/clientes`,
  grants: (org: string) => `/o/${org}/administracao/concessoes`,
  /** M2: acessos (convites, papéis, vínculo, auditoria) e convite recebido. */
  memberAccess: (org: string, userId: string) => `/o/${org}/administracao/membros/${encodeURIComponent(userId)}`,
  invitations: (org: string) => `/o/${org}/administracao/convites`,
  accessEvents: (org: string) => `/o/${org}/administracao/auditoria`,
  /** PLATFORM-LICENCIAMENTO-001: licenças e capacidade da organização; pedidos de criação de organização. */
  licenses: (org: string) => `/o/${org}/administracao/licencas`,
  organizationRequests: (org: string) => `/o/${org}/administracao/pedidos-de-organizacao`,
  licenseOperator: (org: string) => `/o/${org}/operador-de-licencas`,
  invitation: (org: string) => `/o/${org}/convite`,
};

/**
 * PLATFORM-FLUXO-002 (070): área do cliente, fora da sessão de organização (lê só o Portal, pela identidade Nekkora). A
 * organização vai no caminho; a pessoa só vê o que aquela organização compartilhou com ela.
 */
export const clientPath = {
  home: () => '/cliente',
  organization: (org: string) => `/cliente/o/${encodeURIComponent(org)}`,
  automation: (org: string, automationId: string) => `/cliente/o/${encodeURIComponent(org)}/automacoes/${encodeURIComponent(automationId)}`,
  execution: (org: string, kind: string, id: string) =>
    `/cliente/o/${encodeURIComponent(org)}/execucoes/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
};

/**
 * Nome humano da organização, quando o contrato o fornecer. A API v1 não expõe o nome antes do login nem em
 * /me (identificador público = UUID, decisão 8.1 — divergências D1/D7): hoje devolve sempre undefined e a
 * interface mostra o identificador abreviado. Quando houver resolução pública, ela entra aqui.
 */
export function organizationName(_org: string): string | undefined {
  return undefined;
}
