import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * API simulada da leitura interna (GAP-02 permissões e GAP-06 produto), com a semântica do backend
 * (nekkora-platform 80f67faa; OpenAPI definitivo da API v1):
 *
 * - ordem das respostas: 401 (sem sessão) → 400 (parâmetros, cursor) → 403 (conta externa) → 404 (sem acesso);
 * - visibilidade: workspace visível = `automation.read` efetivo (papel organizacional OU atribuição no workspace),
 *   qualquer que seja o status do workspace; inexistente, de outra organização ou sem acesso → o mesmo 404;
 * - paginação keyset com cursor opaco assinado (HMAC), vinculado a rota, organização, vínculo, recurso pai, filtros
 *   (sem limit) e ordenação; qualquer divergência → 400. A rotação da chave invalida os cursores (DC-15);
 * - ordenações: nome pelos 48 primeiros pontos de código (COLLATE "C") + id; execuções createdAt desc + id desc;
 *   versões versionNumber desc; eventos sequence asc; P02 workspaceId asc;
 * - permissões por papel: as das migrations 003/004/005/008/009/014.
 *
 * Os dados são sintéticos e determinísticos (mesmos ids a cada reinício); os horários são relativos ao momento em
 * que o mock sobe, para os filtros de período terem sentido.
 */

// ------------------------------------------------------------------ catálogo (migrations)

export type OrgRole = 'ORG_ADMIN';
export type WorkspaceRole = 'WORKSPACE_ADMIN' | 'OPERATOR' | 'VIEWER';

export const WORKSPACE_PERMISSIONS = [
  'workspace.configure', 'role.assign_operator_viewer', 'automation.read', 'automation.execute', 'logs.read',
  'automation.manage', 'automation.publish', 'workspace_parameter.read', 'workspace_parameter.manage',
  'workspace_secret.read', 'workspace_secret.manage', 'automation_schedule.read', 'automation_schedule.manage',
];
export const ORGANIZATION_ONLY_PERMISSIONS = [
  'org.manage', 'workspace.lifecycle', 'role.assign_admin_roles', 'external_access.manage', 'worker.manage',
  'agent.manage', 'agent_credential.manage', 'worker_agent.assign', 'worker_workspace.authorize', 'identity.mfa.reset',
];
export const ROLE_PERMISSIONS: Record<OrgRole | WorkspaceRole, string[]> = {
  ORG_ADMIN: [...ORGANIZATION_ONLY_PERMISSIONS, ...WORKSPACE_PERMISSIONS],
  WORKSPACE_ADMIN: [...WORKSPACE_PERMISSIONS],
  OPERATOR: ['automation.read', 'automation.execute', 'logs.read'],
  VIEWER: ['automation.read'],
};
const READ = 'automation.read';

export type ResourceStatus = 'active' | 'suspended' | 'archived';
export type ExecutionStatus = 'pending' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled';
type StatusReason =
  | 'process_completed' | 'start_failed' | 'process_failed' | 'cancelled_before_dispatch' | 'cancel_confirmed'
  | 'queue_deadline_exceeded' | null;
type EventType = 'process_started' | 'process_succeeded' | 'process_failed' | 'process_start_failed' | 'process_cancelled';

export const RESOURCE_STATUS: ResourceStatus[] = ['active', 'suspended', 'archived'];
const EXECUTION_STATUS: ExecutionStatus[] = ['pending', 'starting', 'running', 'succeeded', 'failed', 'cancelled'];

// ------------------------------------------------------------------ modelo

export interface ClientRow { clientId: string; org: string; name: string; status: ResourceStatus; createdAt: number; updatedAt: number }
interface WorkspaceRow {
  workspaceId: string; org: string; name: string; description: string | null; status: ResourceStatus;
  clientId: string | null; createdAt: number; updatedAt: number;
}
interface AutomationRow {
  automationId: string; org: string; workspaceId: string; name: string; description: string | null;
  status: ResourceStatus; createdAt: number; updatedAt: number;
}
interface VersionRow {
  automationVersionId: string; automationId: string; versionNumber: number; status: 'draft' | 'published';
  publishedAt: number | null; createdAt: number;
}
interface ExecutionRow {
  executionId: string; org: string; workspaceId: string; automationId: string; versionId: string; versionNumber: number;
  origin: 'manual' | 'scheduled'; status: ExecutionStatus; statusReason: StatusReason; createdAt: number;
  startedAt: number | null; finishedAt: number | null; cancelRequestedAt: number | null;
  retryOf: string | null; requestedBy: string | null;
}
interface EventRow { sequence: number; type: EventType; occurredAt: number; receivedAt: number }
export interface Membership {
  membershipId: string; org: string; displayName: string; orgRoles: OrgRole[];
  /** workspaceId → papéis de workspace ativos */
  workspaceRoles: Map<string, WorkspaceRole[]>;
}

export interface Principal { membershipId: string; accountType: 'internal' | 'external' }
export interface ProductRequest {
  method: string;
  /** caminho depois de /api/v1/o/{org} */
  route: string;
  query: URLSearchParams;
  org: string;
  /** resolve a sessão só se a rota for desta API (atualiza a atividade da sessão) */
  principal: () => Principal | undefined;
}
export interface ProductResponse { status: number; body: unknown }

// ------------------------------------------------------------------ utilitários determinísticos

function prng(seedText: string) {
  let a = createHash('sha256').update(seedText).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UUID v4 derivado de um rótulo (estável entre reinícios). */
export function stableUuid(label: string): string {
  const h = createHash('sha256').update(`nekkora-mock:${label}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const codePoints = (s: string) => Array.from(s);
export const name48 = (s: string) => codePoints(s).slice(0, 48);
/** COLLATE "C" = ordem dos bytes UTF-8 = ordem dos pontos de código. */
function cmpCodePoints(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i].codePointAt(0)! - b[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
// OffsetDateTime.parse: data e hora ISO-8601 COM fuso; segundos e fração opcionais
const OFFSET_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_PERIOD_MS = 366 * 24 * 3600 * 1000;

export class BadRequest extends Error {}

// ------------------------------------------------------------------ cursor (§1.5; DC-15)

export interface Scope { route: string; org: string; membership: string; parent: string | null; filters: string; sort: string }

export class CursorKeys {
  private key = randomBytes(32);
  private keyId = randomBytes(8).toString('base64url');

  /** Simula a rotação da chave de serviço: todos os cursores emitidos passam a ser recusados (DC-15). */
  rotate() {
    this.key = randomBytes(32);
    this.keyId = randomBytes(8).toString('base64url');
  }

  encode(scope: Scope, position: (string | number)[]): string {
    const payload = Buffer.from(JSON.stringify({ k: this.keyId, ...scope, pos: position })).toString('base64url');
    return `${payload}.${createHmac('sha256', this.key).update(payload).digest('base64url')}`;
  }

  decode(cursor: string, scope: Scope): (string | number)[] {
    if (cursor.length > 1024 || !CURSOR_RE.test(cursor)) throw new BadRequest('cursor');
    const [payload, tag] = cursor.split('.');
    const expected = createHmac('sha256', this.key).update(payload).digest('base64url');
    if (tag !== expected) throw new BadRequest('cursor');
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequest('cursor');
    }
    const same = p.k === this.keyId && (Object.keys(scope) as (keyof Scope)[]).every((k) => p[k] === scope[k]);
    if (!same || !Array.isArray(p.pos)) throw new BadRequest('cursor');
    return p.pos as (string | number)[];
  }
}

// ------------------------------------------------------------------ dados

export class ProductData {
  readonly cursors = new CursorKeys();
  clients = new Map<string, ClientRow>();
  workspaces = new Map<string, WorkspaceRow>();
  automations = new Map<string, AutomationRow>();
  versions = new Map<string, VersionRow[]>();
  executions = new Map<string, ExecutionRow>();
  events = new Map<string, EventRow[]>();
  memberships = new Map<string, Membership>();

  constructor(private readonly now: () => number = Date.now) {}

  clear() {
    for (const m of [this.clients, this.workspaces, this.automations, this.versions, this.executions, this.events, this.memberships]) m.clear();
  }

  addMembership(m: { membershipId: string; org: string; displayName: string; orgRoles?: OrgRole[]; workspaceRoles?: [string, WorkspaceRole[]][] }) {
    const row: Membership = {
      membershipId: m.membershipId,
      org: m.org,
      displayName: m.displayName,
      orgRoles: m.orgRoles ?? [],
      workspaceRoles: new Map(m.workspaceRoles ?? []),
    };
    this.memberships.set(m.membershipId, row);
    return row;
  }

  /** Papéis legíveis (painel). */
  describe(membershipId: string): string {
    const m = this.memberships.get(membershipId);
    if (!m) return '—';
    const parts: string[] = [...m.orgRoles];
    for (const [w, roles] of m.workspaceRoles) parts.push(`${roles.join('+')} em ${this.workspaces.get(w)?.name ?? w}`);
    return parts.length ? parts.join(' · ') : 'sem atribuições';
  }

  /**
   * Catálogo de exemplo de uma organização. `key` separa os ids entre organizações; `scale` controla o volume de
   * execuções.
   */
  seedOrganization(org: string, key: string, scale = 0.25): Record<string, string> {
    const rnd = prng(`${key}:dados`);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const now = Math.floor(this.now() / 60_000) * 60_000;
    const DAY = 86_400_000;
    const ids: Record<string, string> = {};

    // F6a-1: estados e datas dos clientes (listClients); "Ômega" (não ASCII) ordena depois dos ASCII por ponto de código
    const clientDefs: [string, string, ResourceStatus][] =
      key === 'dev'
        ? [['acme', 'ACME Logística', 'active'], ['banco', 'Banco Exemplo S.A.', 'active'], ['clinica', 'Clínica Exemplo', 'suspended'], ['omega', 'Ômega Indústria', 'archived']]
        : [['vizinho', 'Cliente Vizinho', 'active']];
    // sequência própria: não desloca a massa já existente (workspaces, automações e execuções seguem iguais)
    const crnd = prng(`${key}:clientes`);
    for (const [k, name, status] of clientDefs) {
      const clientId = stableUuid(`${key}:client:${k}`);
      const createdAt = now - (300 + Math.floor(crnd() * 60)) * DAY;
      this.clients.set(clientId, { clientId, org, name, status, createdAt, updatedAt: createdAt + Math.floor(crnd() * 200) * DAY });
      ids[`client:${k}`] = clientId;
    }

    type WsDef = [k: string, name: string, status: ResourceStatus, client: string | null, description: string | null];
    const wsDefs: WsDef[] =
      key === 'dev'
        ? [
            ['financeiro', 'Financeiro — Conciliação', 'active', 'banco', 'Conciliação bancária e relatórios de fechamento.'],
            ['operacoes', 'Operações', 'active', null, 'Rotinas operacionais internas.'],
            ['logistica', 'Logística', 'active', 'acme', 'Integração com transportadoras e rastreio.'],
            ['atendimento', 'Atendimento', 'active', null, null],
            ['legado', 'Integrações legadas', 'archived', null, 'Mantido só para consulta do histórico.'],
            ['piloto', 'Projeto piloto', 'suspended', 'acme', 'Suspenso até a revisão do contrato.'],
            // mesmo prefixo de 48 pontos de código: a ordem entre os dois é pelo id (documentado no contrato)
            ['relatorios-sul', 'Relatórios regulatórios consolidados do semestre — Sul', 'active', 'banco', null],
            ['relatorios-norte', 'Relatórios regulatórios consolidados do semestre — Norte', 'active', 'banco', null],
            ['vazio', 'Sandbox da equipe', 'active', null, 'Ainda sem automações.'],
          ]
        : [['vizinho', 'Workspace da organização vizinha', 'active', 'vizinho', null]];

    for (const [k, name, status, client, description] of wsDefs) {
      const workspaceId = stableUuid(`${key}:ws:${k}`);
      const createdAt = now - (200 + Math.floor(rnd() * 100)) * DAY;
      this.workspaces.set(workspaceId, {
        workspaceId, org, name, description, status,
        clientId: client ? ids[`client:${client}`] : null,
        createdAt, updatedAt: createdAt + Math.floor(rnd() * 100) * DAY,
      });
      ids[`ws:${k}`] = workspaceId;
    }

    type AutoDef = [ws: string, k: string, name: string, status: ResourceStatus, versions: number, published: number, perDay: number, scheduled: boolean];
    const autoDefs: AutoDef[] =
      key === 'dev'
        ? [
            ['financeiro', 'conciliacao', 'Conciliação bancária diária', 'active', 4, 3, 1, true],
            ['financeiro', 'fechamento', 'Fechamento mensal', 'active', 2, 2, 0.05, true],
            ['financeiro', 'rascunho', 'Exportação para auditoria (rascunho)', 'active', 1, 0, 0, false],
            ['operacoes', 'backup', 'Backup dos arquivos de operação', 'active', 3, 3, 2, true],
            ['operacoes', 'limpeza', 'Limpeza de temporários', 'active', 1, 1, 0.5, false],
            ['operacoes', 'relatorio', 'Relatório de capacidade', 'suspended', 2, 1, 0.2, false],
            ['logistica', 'rastreio', 'Atualização de rastreio de entregas', 'active', 5, 5, 3, true],
            ['logistica', 'notas', 'Importação de notas fiscais', 'active', 2, 2, 0.7, false],
            ['atendimento', 'pesquisa', 'Envio da pesquisa de satisfação', 'active', 1, 1, 0.3, true],
            ['legado', 'ftp', 'Transferência FTP (descontinuada)', 'archived', 3, 2, 0.4, true],
            ['piloto', 'piloto', 'Coleta de indicadores do piloto', 'active', 1, 1, 0.2, false],
            ['relatorios-sul', 'reg-sul', 'Geração do relatório regulatório', 'active', 2, 2, 0.4, true],
            ['relatorios-norte', 'reg-norte', 'Geração do relatório regulatório', 'active', 2, 1, 0.4, true],
            // nomes longos, não ASCII, com os MESMOS 48 primeiros pontos de código: a ordem entre eles é pelo id
            ['atendimento', 'cobranca-a', 'Ação de cobrança automática para clientes em atraso — carteira A', 'active', 1, 1, 0, false],
            ['atendimento', 'cobranca-b', 'Ação de cobrança automática para clientes em atraso — carteira B', 'active', 1, 1, 0, false],
            // ordem por ponto de código ≠ ordem UTF-16: U+FF5A (ｚ) < U+1D538 (𝔸), mas em UTF-16 o 𝔸 (D835…) vem antes
            ['atendimento', 'export-astral', 'Exportação 𝔸', 'active', 1, 1, 0, false],
            ['atendimento', 'export-bmp', 'Exportação ｚ', 'active', 1, 1, 0, false],
          ]
        : [['vizinho', 'vizinha', 'Rotina da organização vizinha', 'active', 1, 1, 1, true]];

    const memberships = [...this.memberships.values()].filter((m) => m.org === org);
    const executors = (workspaceId: string) =>
      memberships.filter((m) => m.orgRoles.includes('ORG_ADMIN') || (m.workspaceRoles.get(workspaceId) ?? []).some((r) => r !== 'VIEWER'));

    for (const [ws, k, name, status, nVersions, nPublished, perDay, scheduled] of autoDefs) {
      const workspaceId = ids[`ws:${ws}`];
      const automationId = stableUuid(`${key}:auto:${k}`);
      const createdAt = now - 150 * DAY - Math.floor(rnd() * 30) * DAY;
      this.automations.set(automationId, {
        automationId, org, workspaceId, name, status, createdAt,
        description: rnd() < 0.7 ? `${name}: rotina sintética do ambiente de desenvolvimento.` : null,
        updatedAt: createdAt + 10 * DAY,
      });
      ids[`auto:${k}`] = automationId;

      // versões: as nPublished primeiras publicadas em datas crescentes; as demais em rascunho
      const versions: VersionRow[] = [];
      for (let n = 1; n <= nVersions; n++) {
        const vCreated = createdAt + (n - 1) * 30 * DAY;
        const published = n <= nPublished;
        versions.push({
          automationVersionId: stableUuid(`${key}:ver:${k}:${n}`),
          automationId, versionNumber: n, status: published ? 'published' : 'draft',
          publishedAt: published ? vCreated + DAY : null, createdAt: vCreated,
        });
      }
      this.versions.set(automationId, versions);
      const publishedVersions = versions.filter((v) => v.publishedAt !== null);
      if (!publishedVersions.length || perDay === 0) continue;

      // execuções nos últimos 120 dias
      const total = Math.max(1, Math.round(perDay * 120 * scale));
      const span = 120 * DAY;
      let lastFailed: ExecutionRow | null = null;
      const times = Array.from({ length: total }, () => now - Math.floor(rnd() * span)).sort((a, b) => a - b);
      times.forEach((createdAtExec, i) => {
        const version = [...publishedVersions].reverse().find((v) => v.publishedAt! <= createdAtExec);
        if (!version) return;
        const recent = now - createdAtExec < 20 * 60_000 || i === times.length - 1;
        const origin: 'manual' | 'scheduled' = scheduled && rnd() < 0.8 ? 'scheduled' : 'manual';
        let st: ExecutionStatus;
        let reason: StatusReason;
        const r = rnd();
        if (recent && status === 'active') {
          st = pick<ExecutionStatus>(['pending', 'starting', 'running', 'running']);
          reason = null;
        } else if (r < 0.78) [st, reason] = ['succeeded', 'process_completed'];
        else if (r < 0.88) [st, reason] = ['failed', 'process_failed'];
        else if (r < 0.92) [st, reason] = ['failed', 'start_failed'];
        else if (r < 0.96) [st, reason] = ['cancelled', 'cancel_confirmed'];
        else if (r < 0.98) [st, reason] = ['cancelled', 'cancelled_before_dispatch'];
        else [st, reason] = ['cancelled', 'queue_deadline_exceeded'];

        const startDelay = 1_000 + Math.floor(rnd() * 20_000);
        const runFor = 4_000 + Math.floor(rnd() * 600_000);
        const started = st === 'running' || reason === 'process_completed' || reason === 'process_failed' || reason === 'cancel_confirmed';
        const finished = st === 'succeeded' || st === 'failed' || st === 'cancelled';
        const startedAt = started ? Math.min(createdAtExec + startDelay, now) : null;
        const finishedAt = finished ? (startedAt ?? createdAtExec) + (startedAt ? runFor : startDelay) : null;
        const cancelRequestedAt =
          reason === 'cancel_confirmed' ? finishedAt! - 2_000 : reason === 'cancelled_before_dispatch' ? createdAtExec + 500 : null;
        const people = executors(workspaceId);
        const retryOf = origin === 'manual' && lastFailed && createdAtExec - lastFailed.createdAt < 3 * DAY ? lastFailed.executionId : null;

        const exec: ExecutionRow = {
          executionId: stableUuid(`${key}:exec:${k}:${i}`), org, workspaceId, automationId,
          versionId: version.automationVersionId, versionNumber: version.versionNumber, origin, status: st,
          statusReason: reason, createdAt: createdAtExec, startedAt, finishedAt, cancelRequestedAt, retryOf,
          requestedBy: origin === 'manual' && people.length ? pick(people).membershipId : null,
        };
        this.executions.set(exec.executionId, exec);
        lastFailed = st === 'failed' ? exec : retryOf ? null : lastFailed;

        const ev: EventRow[] = [];
        const push = (type: EventType, at: number) => ev.push({ sequence: ev.length + 1, type, occurredAt: at, receivedAt: at + Math.floor(rnd() * 1500) });
        if (startedAt !== null) push('process_started', startedAt);
        if (reason === 'process_completed') push('process_succeeded', finishedAt!);
        if (reason === 'process_failed') push('process_failed', finishedAt!);
        if (reason === 'start_failed') push('process_start_failed', finishedAt!);
        if (reason === 'cancel_confirmed') push('process_cancelled', finishedAt!);
        this.events.set(exec.executionId, ev);
      });
    }

    // empates exatos de createdAt (mesma data, ids diferentes): a ordem tem de cair no desempate por id desc
    if (key === 'dev') {
      const automationId = ids['auto:backup'];
      const version = this.versions.get(automationId)!.filter((v) => v.publishedAt !== null).at(-1)!;
      const createdAt = now - 2 * DAY;
      for (let i = 0; i < 4; i++) {
        const exec: ExecutionRow = {
          executionId: stableUuid(`${key}:exec:empate:${i}`), org, workspaceId: ids['ws:operacoes'], automationId,
          versionId: version.automationVersionId, versionNumber: version.versionNumber, origin: 'scheduled',
          status: 'succeeded', statusReason: 'process_completed', createdAt, startedAt: createdAt + 1_000,
          finishedAt: createdAt + 61_000, cancelRequestedAt: null, retryOf: null, requestedBy: null,
        };
        this.executions.set(exec.executionId, exec);
        this.events.set(exec.executionId, [
          { sequence: 1, type: 'process_started', occurredAt: createdAt + 1_000, receivedAt: createdAt + 1_200 },
          { sequence: 2, type: 'process_succeeded', occurredAt: createdAt + 61_000, receivedAt: createdAt + 61_300 },
        ]);
      }
    }
    return ids;
  }

  // ------------------------------------------------------------------ fixtures controladas (só testes/painel)

  /** Revoga a atribuição de um vínculo num workspace (simula perda de acesso entre duas páginas). */
  revokeWorkspaceRole(membershipId: string, workspaceId: string) {
    this.memberships.get(membershipId)?.workspaceRoles.delete(workspaceId);
  }

  /** Revoga os papéis organizacionais de um vínculo. */
  revokeOrganizationRoles(membershipId: string) {
    const m = this.memberships.get(membershipId);
    if (m) m.orgRoles = [];
  }

  // ------------------------------------------------------------------ acesso (WorkspaceAccess)

  private orgPermissions(m: Membership): Set<string> {
    return new Set(m.orgRoles.flatMap((r) => ROLE_PERMISSIONS[r]));
  }

  private canRead(m: Membership, ws: WorkspaceRow): boolean {
    if (ws.org !== m.org) return false;
    if (this.orgPermissions(m).has(READ)) return true;
    return (m.workspaceRoles.get(ws.workspaceId) ?? []).some((r) => ROLE_PERMISSIONS[r].includes(READ));
  }

  private requireWorkspace(m: Membership, workspaceId: string): WorkspaceRow {
    const ws = this.workspaces.get(workspaceId.toLowerCase());
    if (!ws || !this.canRead(m, ws)) throw new NotFound();
    return ws;
  }

  private requireAutomation(m: Membership, automationId: string): AutomationRow {
    const a = this.automations.get(automationId.toLowerCase());
    if (!a || a.org !== m.org) throw new NotFound();
    this.requireWorkspace(m, a.workspaceId);
    return a;
  }

  private requireExecution(m: Membership, executionId: string): ExecutionRow {
    const e = this.executions.get(executionId.toLowerCase());
    if (!e || e.org !== m.org) throw new NotFound();
    this.requireWorkspace(m, e.workspaceId);
    return e;
  }

  // ------------------------------------------------------------------ representação (campos exatos do contrato)

  private workspaceJson(w: WorkspaceRow) {
    const c = w.clientId ? this.clients.get(w.clientId)! : null;
    return {
      workspaceId: w.workspaceId, name: w.name, description: w.description, status: w.status,
      client: c ? { clientId: c.clientId, name: c.name } : null,
      createdAt: iso(w.createdAt), updatedAt: iso(w.updatedAt),
    };
  }

  private automationJson(a: AutomationRow) {
    const latest = (this.versions.get(a.automationId) ?? []).filter((v) => v.status === 'published').sort((x, y) => y.versionNumber - x.versionNumber)[0];
    return {
      automationId: a.automationId, workspaceId: a.workspaceId, name: a.name, description: a.description, status: a.status,
      latestPublishedVersion: latest
        ? { automationVersionId: latest.automationVersionId, versionNumber: latest.versionNumber, publishedAt: iso(latest.publishedAt) }
        : null,
      createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt),
    };
  }

  private executionJson(e: ExecutionRow) {
    const a = this.automations.get(e.automationId)!;
    return {
      executionId: e.executionId, workspaceId: e.workspaceId,
      automation: { automationId: a.automationId, name: a.name },
      automationVersion: { automationVersionId: e.versionId, versionNumber: e.versionNumber },
      origin: e.origin, status: e.status, statusReason: e.statusReason,
      createdAt: iso(e.createdAt), startedAt: iso(e.startedAt), finishedAt: iso(e.finishedAt),
      // finishedAt - startedAt; nulo se algum for nulo; nunca contra o relógio atual
      durationMs: e.startedAt !== null && e.finishedAt !== null ? e.finishedAt - e.startedAt : null,
      cancelRequestedAt: iso(e.cancelRequestedAt),
    };
  }

  // ------------------------------------------------------------------ rotas

  static readonly ROUTES = [
    /^\/me\/permissions$/, /^\/me\/permissions\/workspaces$/, /^\/workspaces$/, /^\/workspaces\/[^/]+$/,
    /^\/workspaces\/[^/]+\/automations$/, /^\/automations\/[^/]+$/, /^\/automations\/[^/]+\/versions$/,
    /^\/executions$/, /^\/executions\/[^/]+$/, /^\/executions\/[^/]+\/events$/,
  ];

  static isRoute(route: string): boolean {
    return ProductData.ROUTES.some((r) => r.test(route));
  }

  /** `undefined` = rota que não é desta API. */
  handle(req: ProductRequest): ProductResponse | undefined {
    if (req.method !== 'GET' || !ProductData.isRoute(req.route)) return undefined;
    const principal = req.principal();
    if (!principal) return { status: 401, body: { error: 'unauthenticated' } };
    try {
      return { status: 200, body: this.route(req, principal) };
    } catch (e) {
      if (e instanceof BadRequest) return { status: 400, body: { error: 'invalid_request' } };
      if (e instanceof Forbidden) return { status: 403, body: { error: 'forbidden' } };
      if (e instanceof NotFound) return { status: 404, body: { error: 'not_found' } };
      throw e;
    }
  }

  private route(req: ProductRequest, p: Principal): unknown {
    const q = req.query;
    const seg = req.route.split('/').slice(1);
    const m = this.memberships.get(p.membershipId);
    // conta externa → 403, depois das validações de parâmetros (ordem 401 → 400 → 403 → 404)
    const internal = () => {
      if (p.accountType !== 'internal' || !m || m.org !== req.org) throw new Forbidden();
      return m;
    };
    const scope = (route: string, parent: string | null, filters: string, sort: string): Scope => ({
      route, org: req.org, membership: p.membershipId, parent, filters, sort,
    });

    if (seg[0] === 'me' && seg.length === 2) {
      const mm = internal();
      const orgPerms = [...this.orgPermissions(mm)].sort(cmp);
      return {
        organizationId: req.org,
        membershipId: mm.membershipId,
        organization: { roles: [...mm.orgRoles].sort(cmp), permissions: orgPerms },
        allWorkspaces: { permissions: orgPerms.filter((x) => WORKSPACE_PERMISSIONS.includes(x)) },
        hasWorkspaceAssignments: mm.workspaceRoles.size > 0,
      };
    }

    if (seg[0] === 'me') {
      const limit = parseLimit(q);
      const sc = scope('listMyWorkspacePermissions', null, '', 'workspaceId.asc');
      const after = q.get('cursor') !== null ? (this.cursors.decode(q.get('cursor')!, sc)[0] as string) : null;
      const mm = internal();
      const rows = [...mm.workspaceRoles.entries()]
        .filter(([w]) => this.workspaces.get(w)?.org === mm.org)
        .sort(([a], [b]) => cmp(a, b))
        .filter(([w]) => after === null || w > after)
        .map(([workspaceId, roles]) => ({
          workspaceId,
          roles: [...roles].sort(cmp),
          permissions: [...new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r]))].sort(cmp),
        }));
      return this.page(rows, limit, (last) => this.cursors.encode(sc, [last.workspaceId]));
    }

    if (seg[0] === 'workspaces' && seg.length === 1) {
      const limit = parseLimit(q);
      const status = parseStatus(q, RESOURCE_STATUS, 3);
      const sc = scope('listWorkspaces', null, canonical({ status }), 'name48.asc+id.asc');
      const after = q.get('cursor') !== null ? this.cursors.decode(q.get('cursor')!, sc) : null;
      const mm = internal();
      const rows = [...this.workspaces.values()]
        .filter((w) => this.canRead(mm, w) && (!status || status.includes(w.status)))
        .sort(byName48((w) => w.name, (w) => w.workspaceId))
        .filter((w) => !after || afterName48(w.name, w.workspaceId, after));
      return this.page(rows, limit, (last) => this.cursors.encode(sc, [name48(last.name).join(''), last.workspaceId]), (w) => this.workspaceJson(w));
    }

    if (seg[0] === 'workspaces' && seg.length === 2) {
      const id = parseUuid(seg[1]);
      const mm = internal();
      return this.workspaceJson(this.requireWorkspace(mm, id));
    }

    if (seg[0] === 'workspaces' && seg.length === 3) {
      const workspaceId = parseUuid(seg[1]);
      const limit = parseLimit(q);
      const status = parseStatus(q, RESOURCE_STATUS, 3);
      const sc = scope('listAutomations', workspaceId.toLowerCase(), canonical({ status }), 'name48.asc+id.asc');
      const after = q.get('cursor') !== null ? this.cursors.decode(q.get('cursor')!, sc) : null;
      const mm = internal();
      this.requireWorkspace(mm, workspaceId);
      const rows = [...this.automations.values()]
        .filter((a) => a.workspaceId === workspaceId.toLowerCase() && (!status || status.includes(a.status)))
        .sort(byName48((a) => a.name, (a) => a.automationId))
        .filter((a) => !after || afterName48(a.name, a.automationId, after));
      return this.page(rows, limit, (last) => this.cursors.encode(sc, [name48(last.name).join(''), last.automationId]), (a) => this.automationJson(a));
    }

    if (seg[0] === 'automations' && seg.length === 2) {
      const id = parseUuid(seg[1]);
      const mm = internal();
      return this.automationJson(this.requireAutomation(mm, id));
    }

    if (seg[0] === 'automations' && seg.length === 3) {
      const automationId = parseUuid(seg[1]);
      const limit = parseLimit(q);
      const sc = scope('listAutomationVersions', automationId.toLowerCase(), '', 'versionNumber.desc');
      const before = q.get('cursor') !== null ? (this.cursors.decode(q.get('cursor')!, sc)[0] as number) : null;
      const mm = internal();
      const a = this.requireAutomation(mm, automationId);
      const rows = [...(this.versions.get(a.automationId) ?? [])]
        .sort((x, y) => y.versionNumber - x.versionNumber)
        .filter((v) => before === null || v.versionNumber < before);
      return this.page(rows, limit, (last) => this.cursors.encode(sc, [last.versionNumber]), (v) => ({
        automationVersionId: v.automationVersionId, versionNumber: v.versionNumber, status: v.status,
        publishedAt: iso(v.publishedAt), createdAt: iso(v.createdAt),
      }));
    }

    if (seg[0] === 'executions' && seg.length === 1) {
      const workspaceId = q.get('workspaceId') !== null ? parseUuid(q.get('workspaceId')!).toLowerCase() : null;
      const automationId = q.get('automationId') !== null ? parseUuid(q.get('automationId')!).toLowerCase() : null;
      const limit = parseLimit(q);
      const status = parseStatus(q, EXECUTION_STATUS, 6);
      const from = parseInstant(q.get('from'));
      const to = parseInstant(q.get('to'));
      if (from !== null && to !== null && (to < from || to - from > MAX_PERIOD_MS)) throw new BadRequest('periodo');
      const sc = scope('listExecutions', null, canonical({ workspaceId, automationId, status, from, to }), 'createdAt.desc+id.desc');
      const after = q.get('cursor') !== null ? this.cursors.decode(q.get('cursor')!, sc) : null;
      const mm = internal();
      if (workspaceId) this.requireWorkspace(mm, workspaceId);
      if (automationId) this.requireAutomation(mm, automationId);
      const rows = [...this.executions.values()]
        .filter((e) => {
          const ws = this.workspaces.get(e.workspaceId)!;
          return (
            this.canRead(mm, ws) &&
            (!workspaceId || e.workspaceId === workspaceId) &&
            (!automationId || e.automationId === automationId) &&
            (!status || status.includes(e.status)) &&
            (from === null || e.createdAt >= from) &&
            (to === null || e.createdAt < to)
          );
        })
        .sort((x, y) => y.createdAt - x.createdAt || cmp(y.executionId, x.executionId))
        .filter((e) => !after || e.createdAt < (after[0] as number) || (e.createdAt === after[0] && e.executionId < (after[1] as string)));
      return this.page(rows, limit, (last) => this.cursors.encode(sc, [last.createdAt, last.executionId]), (e) => this.executionJson(e));
    }

    if (seg[0] === 'executions' && seg.length === 2) {
      const id = parseUuid(seg[1]);
      const mm = internal();
      const e = this.requireExecution(mm, id);
      const by = e.requestedBy ? this.memberships.get(e.requestedBy) : undefined;
      return {
        ...this.executionJson(e),
        retryOfExecutionId: e.retryOf,
        requestedBy: by ? { membershipId: by.membershipId, displayName: by.displayName } : null,
      };
    }

    if (seg[0] === 'executions' && seg.length === 3) {
      const executionId = parseUuid(seg[1]);
      const limit = parseLimit(q);
      const sc = scope('listExecutionEvents', executionId.toLowerCase(), '', 'sequence.asc');
      const after = q.get('cursor') !== null ? (this.cursors.decode(q.get('cursor')!, sc)[0] as number) : null;
      const mm = internal();
      const e = this.requireExecution(mm, executionId);
      const rows = (this.events.get(e.executionId) ?? []).filter((ev) => after === null || ev.sequence > after);
      return this.page(rows, limit, (last) => this.cursors.encode(sc, [last.sequence]), (ev) => ({
        sequence: ev.sequence, type: ev.type, occurredAt: iso(ev.occurredAt), receivedAt: iso(ev.receivedAt),
      }));
    }
    throw new NotFound();
  }

  private page<R>(rows: R[], limit: number, next: (last: R) => string, view: (r: R) => unknown = (r) => r) {
    const items = rows.slice(0, limit);
    return { items: items.map(view), nextCursor: rows.length > limit ? next(items[items.length - 1]) : null };
  }
}

export class Forbidden extends Error {}
export class NotFound extends Error {}

// ------------------------------------------------------------------ parâmetros (mesmas regras do backend)

export function parseUuid(v: string): string {
  if (!UUID_RE.test(v)) throw new BadRequest('uuid');
  return v;
}

export function parseLimit(q: URLSearchParams): number {
  const raw = q.get('limit');
  if (raw === null) return 25;
  if (!/^[+-]?\d+$/.test(raw)) throw new BadRequest('limit');
  const n = Number(raw);
  if (n < 1 || n > 100) throw new BadRequest('limit');
  return n;
}

export function parseStatus<T extends string>(q: URLSearchParams, allowed: T[], max: number): T[] | null {
  if (!q.has('status')) return null;
  const values = q.getAll('status');
  if (values.length === 0 || values.length > max || new Set(values).size !== values.length) throw new BadRequest('status');
  for (const v of values) if (!allowed.includes(v as T)) throw new BadRequest('status');
  return values as T[];
}

function parseInstant(v: string | null): number | null {
  if (v === null) return null;
  const m = OFFSET_DATE_TIME.exec(v);
  if (!m) throw new BadRequest('data');
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d || +h > 23 || +mi > 59 || +(s ?? 0) > 59) {
    throw new BadRequest('data');
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new BadRequest('data');
  return t;
}

/** Impressão canônica dos filtros: coleções sem repetição e ordenadas; datas como instantes. */
export function canonical(f: Record<string, string | number | string[] | null>): string {
  return JSON.stringify(Object.entries(f).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort(cmp) : v]));
}

export function byName48<T>(name: (r: T) => string, id: (r: T) => string) {
  return (a: T, b: T) => cmpCodePoints(name48(name(a)), name48(name(b))) || cmp(id(a), id(b));
}

export function afterName48(name: string, id: string, after: (string | number)[]): boolean {
  const d = cmpCodePoints(name48(name), codePoints(after[0] as string));
  return d > 0 || (d === 0 && id > (after[1] as string));
}
