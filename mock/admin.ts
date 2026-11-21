import {
  afterName48,
  BadRequest,
  byName48,
  canonical,
  cmp,
  Forbidden,
  iso,
  name48,
  NotFound,
  parseLimit,
  parseStatus,
  parseUuid,
  RESOURCE_STATUS,
  ROLE_PERMISSIONS,
  type ProductData,
  type ProductRequest,
  type ProductResponse,
  type Scope,
} from './product.ts';

/**
 * API simulada da leitura administrativa (GAP-03: M01 membros, M02 concessões, M03 clientes), com a semântica do
 * backend (AdminReadController, nekkora-platform 80f67faa; OpenAPI definitivo da API v1):
 *
 * - ordem das respostas: 401 (sem sessão) → 400 (parâmetros, cursor) → 403 (conta externa ou sem a permissão);
 * - permissões: membros = `org.manage`; concessões = `external_access.manage`; clientes = `org.manage` OU
 *   `external_access.manage` (matriz da 003, por papel organizacional);
 * - concessões: `clientId`/`workspaceId` são FILTROS de rota organizacional — inexistente ou de outra organização dá
 *   200 com lista vazia (exceção documentada DC-05); UUID malformado → 400;
 * - ordenações: membros createdAt asc + membershipId asc; concessões createdAt desc + grantId desc; clientes pelos 48
 *   primeiros pontos de código do nome + id;
 * - cursor assinado pela mesma chave do produto (a rotação invalida todos, DC-15).
 *
 * Só leitura: as escritas administrativas (suspender, reativar, revogar, redefinir MFA) ficam para a F6a-2 em diante.
 */

export type MembershipStatus = 'pending' | 'active' | 'suspended' | 'revoked';
export type AccountStatus = 'pending' | 'active' | 'suspended' | 'closed';
export type GrantStatus = 'pending' | 'active' | 'suspended' | 'revoked';
const MEMBERSHIP_STATUS: MembershipStatus[] = ['pending', 'active', 'suspended', 'revoked'];
const GRANT_STATUS: GrantStatus[] = ['pending', 'active', 'suspended', 'revoked'];

/** O que a leitura de membros precisa de cada conta interna (vem do MockApi). */
export interface MemberSource {
  userId: string;
  membershipId: string;
  org: string;
  email: string;
  displayName: string;
  accountType: 'internal' | 'external';
  verified: boolean;
  active: boolean;
  closed?: boolean;
  mfaConfigured: boolean;
  createdAt: number;
  membershipStatus: MembershipStatus;
}

export interface GrantRow {
  grantId: string;
  org: string;
  status: GrantStatus;
  clientId: string;
  workspaceId: string;
  externalAccount: { clientMembershipId: string; userId: string; displayName: string; email: string; membershipStatus: MembershipStatus };
  approvedAt: number | null;
  startsAt: number;
  expiresAt: number | null;
  nextReviewAt: number | null;
  lastAccessAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

const ROUTES = [
  /^\/members$/, /^\/client-grants$/, /^\/clients$/, /^\/people$/,
  // PLATFORM-FLUXO-002 (070): leituras de "Clientes e acessos" (o simulador não tem concessões por automação nem convites de cliente)
  /^\/access-grants$/, /^\/access-history$/, /^\/client-share-options$/, /^\/clients\/[^/]+$/,
];
/** PLATFORM-FLUXO-002: situações de "Pessoas e acessos". O simulador não tem convites (a funcionalidade fica desligada). */
const PERSON_SITUATIONS = [
  'invitation_pending', 'invitation_expired', 'invitation_revoked', 'invitation_accepted', 'member_pending', 'member_active', 'member_suspended',
  'member_revoked', 'client_active', 'client_suspended', 'client_revoked',
] as const;
const ACCESS_GRANT_SITUATIONS = ['pending', 'active', 'suspended', 'revoked'] as const;

export class AdminData {
  grants = new Map<string, GrantRow>();

  constructor(
    private readonly product: ProductData,
    private readonly members: () => Iterable<MemberSource>,
  ) {}

  clear() {
    this.grants.clear();
  }

  static isRoute(route: string): boolean {
    return ROUTES.some((r) => r.test(route));
  }

  /** `undefined` = rota que não é desta API. */
  handle(req: ProductRequest): ProductResponse | undefined {
    if (req.method !== 'GET' || !AdminData.isRoute(req.route)) return undefined;
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

  private route(req: ProductRequest, p: { membershipId: string; accountType: 'internal' | 'external' }): unknown {
    const q = req.query;
    const scope = (route: string, filters: string, sort: string): Scope => ({
      route, org: req.org, membership: p.membershipId, parent: null, filters, sort,
    });
    /** Conta interna da organização da rota com ao menos uma das permissões (depois das validações: 401 → 400 → 403). */
    const authorize = (...anyOf: string[]) => {
      const m = this.product.memberships.get(p.membershipId);
      if (p.accountType !== 'internal' || !m || m.org !== req.org) throw new Forbidden();
      const perms = new Set(m.orgRoles.flatMap((r) => ROLE_PERMISSIONS[r]));
      if (!anyOf.some((x) => perms.has(x))) throw new Forbidden();
    };

    if (req.route === '/members') {
      const limit = parseLimit(q);
      const status = parseStatus(q, MEMBERSHIP_STATUS, 4);
      const sc = scope('listMembers', canonical({ status }), 'createdAt.asc+membershipId.asc');
      const after = q.get('cursor') !== null ? this.product.cursors.decode(q.get('cursor')!, sc) : null;
      authorize('org.manage');
      const rows = [...this.members()]
        .filter((m) => m.org === req.org && m.accountType === 'internal' && (!status || status.includes(m.membershipStatus)))
        .sort((a, b) => a.createdAt - b.createdAt || cmp(a.membershipId, b.membershipId))
        .filter((m) => !after || m.createdAt > (after[0] as number) || (m.createdAt === after[0] && m.membershipId > (after[1] as string)));
      return page(rows, limit, (last) => this.product.cursors.encode(sc, [last.createdAt, last.membershipId]), (m) => this.memberJson(m));
    }

    if (req.route === '/people') {
      // a mesma semântica da API (PeopleController): sem situação, pendentes e membros; membros da entrada mais recente
      const limit = parseLimit(q);
      const situation = parseStatus(q, [...PERSON_SITUATIONS], 11, 'situation');
      const text = q.get('q');
      if (text !== null && (text.trim() === '' || text.trim().length > 120)) throw new BadRequest('q');
      const needle = text?.trim().toLowerCase() ?? null;
      const sc = scope('listPeople', canonical({ situation, q: needle }), 'group.asc+at.desc+id.desc');
      const after = q.get('cursor') !== null ? this.product.cursors.decode(q.get('cursor')!, sc) : null;
      authorize('org.manage');
      const wanted = situation ?? ['invitation_pending', 'member_pending', 'member_active', 'member_suspended', 'member_revoked'];
      const rows = [...this.members()]
        .filter((m) => m.org === req.org && m.accountType === 'internal' && wanted.includes(`member_${m.membershipStatus}`))
        .filter((m) => !needle || m.email.toLowerCase().includes(needle) || m.displayName.toLowerCase().includes(needle))
        .sort((a, b) => b.createdAt - a.createdAt || cmp(b.membershipId, a.membershipId))
        .filter((m) => !after || m.createdAt < (after[1] as number) || (m.createdAt === after[1] && m.membershipId < (after[2] as string)));
      return {
        ...page(rows, limit, (last) => this.product.cursors.encode(sc, [1, last.createdAt, last.membershipId]), (m) => this.personJson(m)),
        invitationsEnabled: false,
      };
    }

    if (req.route === '/access-grants') {
      // as concessões por ambiente inteiro do simulador, na forma unificada (070)
      const limit = parseLimit(q);
      const situation = parseStatus(q, [...ACCESS_GRANT_SITUATIONS], 4, 'situation');
      const clientId = q.get('clientId') !== null ? parseUuid(q.get('clientId')!).toLowerCase() : null;
      const workspaceId = q.get('workspaceId') !== null ? parseUuid(q.get('workspaceId')!).toLowerCase() : null;
      const personId = q.get('personId') !== null ? parseUuid(q.get('personId')!).toLowerCase() : null;
      const automationId = q.get('automationId') !== null ? parseUuid(q.get('automationId')!).toLowerCase() : null;
      const workerId = q.get('workerId') !== null ? parseUuid(q.get('workerId')!).toLowerCase() : null;
      const sc = scope('listAccessGrants', canonical({ situation, clientId, workspaceId, personId, automationId, workerId }), 'createdAt.desc+id.desc');
      const after = q.get('cursor') !== null ? this.product.cursors.decode(q.get('cursor')!, sc) : null;
      authorize('external_access.manage');
      const rows = [...this.grants.values()]
        .filter(
          (g) =>
            g.org === req.org &&
            !automationId &&
            !workerId &&
            (!situation || situation.includes(g.status)) &&
            (!clientId || g.clientId === clientId) &&
            (!workspaceId || g.workspaceId === workspaceId) &&
            (!personId || g.externalAccount.userId === personId),
        )
        .sort((a, b) => b.createdAt - a.createdAt || cmp(b.grantId, a.grantId))
        .filter((g) => !after || g.createdAt < (after[0] as number) || (g.createdAt === after[0] && g.grantId < (after[1] as string)));
      return page(rows, limit, (last) => this.product.cursors.encode(sc, [last.createdAt, last.grantId]), (g) => this.accessGrantJson(g));
    }

    if (req.route === '/access-history') {
      parseLimit(q);
      const m = this.product.memberships.get(p.membershipId);
      authorize('org.manage', 'external_access.manage');
      const all = !!m && m.orgRoles.flatMap((r) => ROLE_PERMISSIONS[r]).includes('org.manage');
      return { items: [], nextCursor: null, scope: all ? 'all' : 'client_access' };
    }

    if (req.route === '/client-share-options') {
      authorize('external_access.manage');
      return { automations: [] };
    }

    if (req.route.startsWith('/clients/')) {
      authorize('org.manage', 'external_access.manage');
      const id = req.route.slice('/clients/'.length).toLowerCase();
      const c = this.product.clients.get(id);
      if (!c || c.org !== req.org) throw new NotFound();
      return {
        clientId: c.clientId, name: c.name, status: c.status, createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt),
        people: [], pendingInvitations: [], sharedAutomations: [],
      };
    }

    if (req.route === '/client-grants') {
      const limit = parseLimit(q);
      const status = parseStatus(q, GRANT_STATUS, 4);
      const clientId = q.get('clientId') !== null ? parseUuid(q.get('clientId')!).toLowerCase() : null;
      const workspaceId = q.get('workspaceId') !== null ? parseUuid(q.get('workspaceId')!).toLowerCase() : null;
      const sc = scope('listClientGrants', canonical({ status, clientId, workspaceId }), 'createdAt.desc+grantId.desc');
      const after = q.get('cursor') !== null ? this.product.cursors.decode(q.get('cursor')!, sc) : null;
      authorize('external_access.manage');
      // filtro inexistente ou de outra organização: simplesmente não casa nenhuma linha (200, lista vazia)
      const rows = [...this.grants.values()]
        .filter(
          (g) =>
            g.org === req.org &&
            (!status || status.includes(g.status)) &&
            (!clientId || g.clientId === clientId) &&
            (!workspaceId || g.workspaceId === workspaceId),
        )
        .sort((a, b) => b.createdAt - a.createdAt || cmp(b.grantId, a.grantId))
        .filter((g) => !after || g.createdAt < (after[0] as number) || (g.createdAt === after[0] && g.grantId < (after[1] as string)));
      return page(rows, limit, (last) => this.product.cursors.encode(sc, [last.createdAt, last.grantId]), (g) => this.grantJson(g));
    }

    // /clients
    const limit = parseLimit(q);
    const status = parseStatus(q, RESOURCE_STATUS, 3);
    const sc = scope('listClients', canonical({ status }), 'name48.asc+id.asc');
    const after = q.get('cursor') !== null ? this.product.cursors.decode(q.get('cursor')!, sc) : null;
    authorize('org.manage', 'external_access.manage');
    const rows = [...this.product.clients.values()]
      .filter((c) => c.org === req.org && (!status || status.includes(c.status)))
      .sort(byName48((c) => c.name, (c) => c.clientId))
      .filter((c) => !after || afterName48(c.name, c.clientId, after));
    return page(rows, limit, (last) => this.product.cursors.encode(sc, [name48(last.name).join(''), last.clientId]), (c) => ({
      clientId: c.clientId, name: c.name, status: c.status, createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt),
    }));
  }

  private memberJson(m: MemberSource) {
    const roles = this.product.memberships.get(m.membershipId)?.orgRoles ?? [];
    const accountStatus: AccountStatus = m.closed ? 'closed' : !m.active ? 'suspended' : !m.verified ? 'pending' : 'active';
    return {
      membershipId: m.membershipId, userId: m.userId, displayName: m.displayName, email: m.email, emailVerified: m.verified,
      accountStatus, membershipStatus: m.membershipStatus, mfaConfigured: m.mfaConfigured,
      organizationRoles: [...roles].sort(cmp), createdAt: iso(m.createdAt),
    };
  }

  private personJson(m: MemberSource) {
    const base = this.memberJson(m);
    const ms = this.product.memberships.get(m.membershipId);
    const roles = [
      ...(ms?.orgRoles ?? []).map((role) => ({ role, workspaceId: null, workspaceName: null })),
      ...[...(ms?.workspaceRoles ?? new Map<string, string[]>())].flatMap(([w, rs]) =>
        rs.map((role) => ({ role, workspaceId: w, workspaceName: this.product.workspaces.get(w)?.name ?? null })),
      ),
    ];
    const { organizationRoles: _o, createdAt, ...rest } = base;
    return { kind: 'member', id: m.membershipId, member: { ...rest, joinedAt: createdAt, roles }, invitation: null, client: null };
  }

  private accessGrantJson(g: GrantRow) {
    const c = this.product.clients.get(g.clientId)!;
    const w = this.product.workspaces.get(g.workspaceId)!;
    return {
      kind: 'workspace', grantId: g.grantId, situation: g.status,
      person: { userId: g.externalAccount.userId, name: g.externalAccount.displayName, email: g.externalAccount.email },
      clientMembershipId: g.externalAccount.clientMembershipId, membershipStatus: g.externalAccount.membershipStatus,
      client: { clientId: c.clientId, name: c.name }, workspace: { workspaceId: w.workspaceId, name: w.name },
      automation: null, machine: null, canReadLogs: false, canDownloadResults: false, basis: 'second_person', requestedBy: null, approvedBy: null,
      createdAt: iso(g.createdAt), approvedAt: iso(g.approvedAt), revokedAt: iso(g.revokedAt), revokeReason: null, replacesGrantId: null,
      expiresAt: iso(g.expiresAt), nextReviewAt: iso(g.nextReviewAt),
    };
  }

  private grantJson(g: GrantRow) {
    const c = this.product.clients.get(g.clientId)!;
    const w = this.product.workspaces.get(g.workspaceId)!;
    return {
      grantId: g.grantId, status: g.status,
      client: { clientId: c.clientId, name: c.name },
      workspace: { workspaceId: w.workspaceId, name: w.name },
      externalAccount: { ...g.externalAccount },
      approvedAt: iso(g.approvedAt), startsAt: iso(g.startsAt), expiresAt: iso(g.expiresAt),
      nextReviewAt: iso(g.nextReviewAt), lastAccessAt: iso(g.lastAccessAt), revokedAt: iso(g.revokedAt),
      createdAt: iso(g.createdAt),
    };
  }
}

function page<R>(rows: R[], limit: number, next: (last: R) => string, view: (r: R) => unknown) {
  const items = rows.slice(0, limit);
  return { items: items.map(view), nextCursor: rows.length > limit ? next(items[items.length - 1]) : null };
}
