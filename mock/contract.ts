import { randomBytes, randomUUID } from 'node:crypto';
import contract from '../src/api/generated/nekkora-api-v1.schemas.json' with { type: 'json' };
import { AdminData, type MembershipStatus } from './admin.ts';
import { ProductData, ROLE_PERMISSIONS, stableUuid, type OrgRole, type WorkspaceRole } from './product.ts';
import { acceptedStep, newSecret } from './totp.ts';

/**
 * API simulada do Nekkora Platform — contrato 8.7 de autenticação, em memória, para trabalhar na interface sem
 * o backend. Reproduz o que o frontend enxerga: rotas, corpos, códigos de erro `{"error": ...}`, `X-Request-Id`,
 * cookies `__Host-` HttpOnly, CSRF sincronizador (pré-autenticação, desafio, sessão) com checagem de Origin,
 * TOTP real com anti-replay, 5 tentativas por desafio, códigos de recuperação de uso único, tokens de link de
 * uso único, inatividade/limite absoluto de sessão e respostas genéricas (sem enumeração).
 *
 * O e-mail transacional é simulado: mensagens vão para uma caixa de entrada em memória, visível em /__mock/.
 * As leituras de permissões e do produto (GAP-02/GAP-06) ficam em product.ts; aqui só a sessão é resolvida.
 * Nada daqui entra no build de produção (é só middleware dos servidores do Vite).
 */

export const DEV_ORG = 'b7e1c3a0-5d2f-4e8b-9a61-0c3d5e7f9a12';
/** Segunda organização, para conferir isolamento (ids de uma organização não valem na outra). */
export const OTHER_ORG = 'f3d9b2c4-7a1e-4c5b-8d2f-6e0a9b1c3d57';
export const DEV_PASSWORD = 'Nekkora-Dev-2026';
/** Segredo fixo da conta de exemplo com MFA, para cadastrar uma vez num autenticador de verdade. */
export const DEV_TOTP_SECRET = 'NEKKORADEVTOTPSECRETJBSWY3DPEHPK';

const MIN = 60_000;
const LIMITS = {
  pre: 30 * MIN,
  challenge: 5 * MIN,
  attempts: 5,
  inactivity: { internal: 30 * MIN, external: 15 * MIN },
  absolute: 12 * 60 * MIN,
  reset: 30 * MIN,
  verification: 24 * 60 * MIN,
};

const COOKIE = { pre: '__Host-nekkora_pre', challenge: '__Host-nekkora_mfa', session: '__Host-nekkora_session' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type Failure = 'none' | 'offline' | 'rate_limited' | 'service_unavailable' | 'internal_error';

/** Status HTTP de cada falha simulada (a queda de conexão não é resposta HTTP). */
const FAILURE_STATUS: Partial<Record<Failure, number>> = { rate_limited: 429, service_unavailable: 503, internal_error: 500 };

/** Operações do contrato (todas as do OpenAPI), para casar método + caminho com os status documentados. */
const OPERATIONS = Object.entries(contract.operations).map(([operationId, op]) => ({
  operationId,
  method: op.method,
  pattern: new RegExp(`^${op.path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
  statuses: new Set(Object.keys(op.responses)),
}));

/** Operação do OpenAPI correspondente à requisição (undefined = rota fora do contrato). */
export function operationFor(method: string, path: string) {
  return OPERATIONS.find((o) => o.method === method && o.pattern.test(path));
}

/**
 * A falha simulada só vale onde o contrato a documenta (ex.: 503 só nos POST de autenticação e em GET /api/v1/csrf;
 * nas leituras do produto, 429 e 500). Fora disso a requisição segue normalmente: o mock nunca produz um status que a
 * operação não prevê.
 */
export function simulatedFailureStatus(failure: Failure, method: string, path: string): number | undefined {
  const status = FAILURE_STATUS[failure];
  if (status === undefined) return undefined;
  return operationFor(method, path)?.statuses.has(String(status)) ? status : undefined;
}

export interface Account {
  userId: string;
  /** Vínculo com a organização (organization_memberships), usado pela leitura do produto. */
  membershipId: string;
  org: string;
  email: string;
  displayName: string;
  accountType: 'internal' | 'external';
  password: string;
  verified: boolean;
  active: boolean;
  totpSecret?: string;
  lastStep: number;
  recoveryCodes: string[];
  /** F6a-1 (listMembers): quando o vínculo foi criado e o seu estado. */
  createdAt: number;
  membershipStatus: MembershipStatus;
  /** Conta encerrada (accountStatus `closed`). */
  closed?: boolean;
}

interface Challenge {
  userId: string;
  csrf: string;
  purpose: 'verify' | 'enroll';
  attempts: number;
  expiresAt: number;
  pendingSecret?: string;
}

interface Session {
  userId: string;
  org: string;
  csrf: string;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
}

interface LinkToken {
  userId: string;
  expiresAt: number;
  used: boolean;
}

export interface MailMessage {
  id: number;
  at: string;
  to: string;
  kind: 'password-reset' | 'email-verification';
  link: string;
}

export interface MockRequest {
  method: string;
  path: string;
  origin?: string;
  expectedOrigin: string;
  csrf?: string;
  cookies: Record<string, string>;
  body: unknown;
  query?: URLSearchParams;
}

export interface MockResponse {
  status: number;
  body?: unknown;
  headers: Record<string, string>;
  cookies: string[];
}

const token = () => randomBytes(32).toString('base64url'); // 43 caracteres, como a API
const opaque = () => randomBytes(24).toString('base64url');

function recoveryCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const raw = Array.from(randomBytes(16), (b) => alphabet[b % 32]).join('');
  return raw.match(/.{4}/g)!.join('-');
}
const normalizeRecovery = (c: string) => c.replace(/[\s-]/g, '').toUpperCase();

export class MockApi {
  orgs = new Map<string, { name: string; active: boolean }>();
  accounts = new Map<string, Account>();
  inbox: MailMessage[] = [];
  failure: Failure = 'none';
  readonly product: ProductData;
  /** Leitura administrativa (GAP-03: membros, concessões, clientes). */
  readonly admin: AdminData;
  /** F6a-2: escritas administrativas APLICADAS (para os testes contarem efeitos, não requisições). */
  adminWrites: { org: string; action: 'suspend' | 'reactivate'; target: string; at: number }[] = [];
  private pre = new Map<string, { csrf: string; expiresAt: number }>();
  private challenges = new Map<string, Challenge>();
  private sessions = new Map<string, Session>();
  private resetTokens = new Map<string, LinkToken>();
  private verificationTokens = new Map<string, LinkToken & { email: string }>();
  private mailSeq = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.product = new ProductData(now);
    this.admin = new AdminData(this.product, () =>
      [...this.accounts.values()].map((a) => ({ ...a, mfaConfigured: !!a.totpSecret })),
    );
    this.seed();
  }

  // ------------------------------------------------------------------ dados de exemplo e controle

  reset() {
    this.orgs.clear();
    this.accounts.clear();
    this.inbox = [];
    this.failure = 'none';
    this.pre.clear();
    this.challenges.clear();
    this.sessions.clear();
    this.resetTokens.clear();
    this.verificationTokens.clear();
    this.product.clear();
    this.admin.clear();
    this.adminWrites = [];
    this.seed();
  }

  private seed() {
    this.createOrganization({ org: DEV_ORG, name: 'Organização de desenvolvimento' });
    const ws = (k: string) => stableUuid(`dev:ws:${k}`);
    // contas por papel (todas com MFA na chave fixa, para entrar rápido com o mesmo autenticador)
    const people: [email: string, name: string, org: OrgRole[], workspaces: [string, WorkspaceRole[]][]][] = [
      ['ana@nekkora.dev', 'Ana Souza', ['ORG_ADMIN'], []],
      ['gestora@nekkora.dev', 'Bruna Lima', [], [[ws('financeiro'), ['WORKSPACE_ADMIN']], [ws('operacoes'), ['OPERATOR']]]],
      ['operador@nekkora.dev', 'Caio Mendes', [], [[ws('operacoes'), ['OPERATOR']], [ws('logistica'), ['OPERATOR']]]],
      ['leitora@nekkora.dev', 'Dani Rocha', [], [[ws('atendimento'), ['VIEWER']], [ws('legado'), ['VIEWER']]]],
      ['sematribuicao@nekkora.dev', 'Edu Pires', [], []],
    ];
    for (const [email, displayName, orgRoles, workspaceRoles] of people) {
      const a = this.createAccount({ org: DEV_ORG, email, displayName, orgRoles, workspaceRoles });
      a.totpSecret = DEV_TOTP_SECRET;
      a.recoveryCodes = Array.from({ length: 10 }, recoveryCode);
    }
    this.createAccount({ org: DEV_ORG, email: 'novo@nekkora.dev', displayName: 'Pessoa Nova' });
    const pending = this.createAccount({ org: DEV_ORG, email: 'pendente@nekkora.dev', displayName: 'Pessoa Pendente', verified: false });
    this.sendVerification(pending);
    const portal = this.createAccount({ org: DEV_ORG, email: 'portal@nekkora.dev', displayName: 'Pessoa do Portal', accountType: 'external' });
    portal.totpSecret = DEV_TOTP_SECRET;
    portal.recoveryCodes = Array.from({ length: 10 }, recoveryCode);
    this.product.seedOrganization(DEV_ORG, 'dev');
    this.seedAdministration();

    this.createOrganization({ org: OTHER_ORG, name: 'Organização vizinha' });
    const vizinha = this.createAccount({ org: OTHER_ORG, email: 'vizinha@nekkora.dev', displayName: 'Vera Vizinha', orgRoles: ['ORG_ADMIN'] });
    vizinha.totpSecret = DEV_TOTP_SECRET;
    vizinha.recoveryCodes = Array.from({ length: 10 }, recoveryCode);
    this.product.seedOrganization(OTHER_ORG, 'vizinha', 0.3);
    const contato = this.createAccount({ org: OTHER_ORG, email: 'contato@vizinho.dev', displayName: 'Contato do Vizinho', accountType: 'external' });
    this.addGrant(OTHER_ORG, 'vizinha', 'g1', contato, 'vizinho', 'vizinho', 'active', 40);
  }

  /**
   * F6a-1: massa da leitura administrativa na organização de desenvolvimento — membros em todos os estados (e mais de
   * uma página de 25), clientes nos três estados (product.ts) e concessões nos quatro estados, com contas externas.
   */
  private seedAdministration() {
    const DAY = 86_400_000;
    const base = Math.floor(this.now() / 60_000) * 60_000;
    // os vínculos de exemplo ganham datas crescentes, na ordem em que foram criados (ordem da lista: createdAt asc)
    [...this.accounts.values()]
      .filter((a) => a.org === DEV_ORG)
      .forEach((a, i) => {
        a.createdAt = base - (400 - i * 5) * DAY;
      });
    const extra: [email: string, name: string, fill: (a: Account) => void][] = [
      ['suspensa@nekkora.dev', 'Flávia Suspensa', (a) => {
        a.active = false;
      }],
      ['desligado@nekkora.dev', 'Gil Desligado', (a) => {
        a.membershipStatus = 'revoked';
      }],
      ['convite@nekkora.dev', 'Helena Convidada', (a) => {
        a.verified = false;
        a.membershipStatus = 'pending';
      }],
      ['encerrada@nekkora.dev', 'Íris Encerrada', (a) => {
        a.closed = true;
        a.membershipStatus = 'suspended';
      }],
    ];
    extra.forEach(([email, displayName, fill], i) => {
      fill(this.createAccount({ org: DEV_ORG, email, displayName, createdAt: base - (300 - i * 3) * DAY }));
    });
    // equipe: completa mais de uma página de 25 membros
    for (let i = 1; i <= 24; i++) {
      const n = String(i).padStart(2, '0');
      const a = this.createAccount({ org: DEV_ORG, email: `equipe${n}@nekkora.dev`, displayName: `Pessoa da Equipe ${n}`, createdAt: base - (200 - i) * DAY });
      if (i % 3 === 0) a.totpSecret = DEV_TOTP_SECRET;
    }
    const portal = [...this.accounts.values()].find((a) => a.email === 'portal@nekkora.dev')!;
    const banco = this.createAccount({ org: DEV_ORG, email: 'financeiro@banco-exemplo.dev', displayName: 'Financeiro do Banco', accountType: 'external' });
    this.addGrant(DEV_ORG, 'dev', 'g1', portal, 'acme', 'logistica', 'active', 90);
    this.addGrant(DEV_ORG, 'dev', 'g2', portal, 'acme', 'piloto', 'suspended', 70);
    this.addGrant(DEV_ORG, 'dev', 'g3', portal, 'acme', 'logistica', 'revoked', 150);
    this.addGrant(DEV_ORG, 'dev', 'g4', banco, 'banco', 'financeiro', 'active', 60);
    this.addGrant(DEV_ORG, 'dev', 'g5', banco, 'banco', 'relatorios-sul', 'pending', 5);
    this.addGrant(DEV_ORG, 'dev', 'g6', banco, 'banco', 'relatorios-norte', 'active', 30, { expiresInDays: 20 });
  }

  /** Concessão de exemplo: conta externa × workspace do cliente, criada há `daysAgo` dias. */
  addGrant(
    org: string,
    key: string,
    k: string,
    external: Account,
    client: string,
    workspace: string,
    status: 'pending' | 'active' | 'suspended' | 'revoked',
    daysAgo: number,
    { expiresInDays }: { expiresInDays?: number } = {},
  ) {
    const DAY = 86_400_000;
    const base = Math.floor(this.now() / 60_000) * 60_000;
    const createdAt = base - daysAgo * DAY;
    const approved = status !== 'pending';
    const grantId = stableUuid(`${key}:grant:${k}`);
    this.admin.grants.set(grantId, {
      grantId,
      org,
      status,
      clientId: stableUuid(`${key}:client:${client}`),
      workspaceId: stableUuid(`${key}:ws:${workspace}`),
      externalAccount: {
        clientMembershipId: stableUuid(`clientmembership:${org}:${external.email}`),
        userId: external.userId,
        displayName: external.displayName,
        email: external.email,
        membershipStatus: 'active',
      },
      approvedAt: approved ? createdAt + DAY : null,
      startsAt: createdAt + DAY,
      expiresAt: expiresInDays !== undefined ? base + expiresInDays * DAY : null,
      nextReviewAt: approved && status !== 'revoked' ? base + 30 * DAY : null,
      lastAccessAt: status === 'active' ? base - 2 * DAY : null,
      revokedAt: status === 'revoked' ? createdAt + 40 * DAY : null,
      createdAt,
    });
    return grantId;
  }

  createOrganization({ org = randomUUID(), name = 'Organização de teste', active = true } = {}) {
    this.orgs.set(org, { name, active });
    return org;
  }

  createAccount(input: {
    org: string;
    email?: string;
    displayName?: string;
    verified?: boolean;
    accountType?: Account['accountType'];
    password?: string;
    orgRoles?: OrgRole[];
    workspaceRoles?: [string, WorkspaceRole[]][];
    createdAt?: number;
  }): Account {
    const userId = randomUUID();
    const account: Account = {
      userId,
      membershipId: input.email ? stableUuid(`membership:${input.org}:${input.email}`) : randomUUID(),
      org: input.org,
      email: input.email ?? `pessoa-${userId.slice(0, 8)}@nekkora.dev`,
      displayName: input.displayName ?? 'Pessoa de Teste',
      accountType: input.accountType ?? 'internal',
      password: input.password ?? DEV_PASSWORD,
      verified: input.verified ?? true,
      active: true,
      lastStep: 0,
      recoveryCodes: [],
      createdAt: input.createdAt ?? this.now(),
      membershipStatus: 'active',
    };
    this.accounts.set(userId, account);
    if (account.accountType === 'internal') {
      this.product.addMembership({
        membershipId: account.membershipId,
        org: account.org,
        displayName: account.displayName,
        orgRoles: input.orgRoles,
        workspaceRoles: input.workspaceRoles,
      });
    }
    return account;
  }

  /**
   * Abre uma sessão direto, sem o fluxo de login (só para testes e ferramentas; não é exposto por HTTP).
   * Devolve o valor do cookie de sessão.
   */
  openSession(userId: string): string {
    const account = this.accounts.get(userId)!;
    const id = opaque();
    this.sessions.set(id, { userId, org: account.org, csrf: opaque(), createdAt: this.now(), lastSeenAt: this.now(), revoked: false });
    return id;
  }

  issuePasswordResetToken(userId: string, { expired = false } = {}) {
    const t = token();
    this.resetTokens.set(t, { userId, expiresAt: this.now() + (expired ? -MIN : LIMITS.reset), used: false });
    return t;
  }

  issueEmailVerificationToken(userId: string, { expired = false } = {}) {
    const account = this.accounts.get(userId)!;
    const t = token();
    this.verificationTokens.set(t, {
      userId,
      email: account.email,
      expiresAt: this.now() + (expired ? -MIN : LIMITS.verification),
      used: false,
    });
    return t;
  }

  passwordResetTokenCount(userId: string) {
    return [...this.resetTokens.values()].filter((t) => t.userId === userId).length;
  }

  /** Encerra as sessões no "servidor" (equivale a inatividade, limite absoluto ou revogação). */
  revokeSessions(userId: string) {
    for (const s of this.sessions.values()) if (s.userId === userId) s.revoked = true;
  }

  activeSessions(userId: string) {
    return [...this.sessions.values()].filter((s) => s.userId === userId && this.sessionAlive(s)).length;
  }

  private sendVerification(account: Account) {
    const t = this.issueEmailVerificationToken(account.userId);
    this.mail(account.email, 'email-verification', `/o/${account.org}/verify-email#token=${t}`);
  }

  private mail(to: string, kind: MailMessage['kind'], link: string) {
    this.inbox.unshift({ id: ++this.mailSeq, at: new Date(this.now()).toISOString(), to, kind, link });
  }

  // ------------------------------------------------------------------ contrato

  handle(req: MockRequest): MockResponse {
    const res: MockResponse = { status: 200, headers: { 'X-Request-Id': randomUUID(), 'Cache-Control': 'no-store' }, cookies: [] };
    const json = (status: number, body?: unknown) => {
      if (body !== undefined) res.headers['Content-Type'] = 'application/json';
      return Object.assign(res, { status, body });
    };
    const error = (status: number, code: string) => json(status, { error: code });

    const simulated = simulatedFailureStatus(this.failure, req.method, req.path);
    if (simulated === 429) {
      res.headers['Retry-After'] = '120';
      return error(429, 'rate_limited');
    }
    if (simulated === 503) return error(503, 'service_unavailable');
    if (simulated === 500) return error(500, 'internal_error');

    const setCookie = (name: string, value: string, maxAgeMs: number, sameSite: 'Strict' | 'Lax') =>
      res.cookies.push(`${name}=${value}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; Secure; SameSite=${sameSite}`);
    const clearCookie = (name: string) => res.cookies.push(`${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

    if (req.method === 'GET' && req.path === '/api/v1/csrf') {
      const id = opaque();
      const csrf = opaque();
      this.pre.set(id, { csrf, expiresAt: this.now() + LIMITS.pre });
      setCookie(COOKIE.pre, id, LIMITS.pre, 'Strict');
      return json(200, { csrfToken: csrf });
    }

    const m = /^\/api\/v1\/o\/([^/]+)(\/.*)$/.exec(req.path);
    // {org} malformado nas leituras com sessão → 401 (nenhuma sessão é resolvida), como no backend
    if (m && !UUID.test(m[1]) && req.method === 'GET' && (ProductData.isRoute(m[2]) || AdminData.isRoute(m[2]))) return error(401, 'unauthenticated');
    if (!m || !UUID.test(m[1])) return error(404, 'not_found');
    const [, org, route] = m;
    const key = `${req.method} ${route}`;

    // CSRF (§5.1): toda operação que altera estado exige Origin da origem pública + token sincronizador.
    if (req.method === 'POST' && req.origin !== req.expectedOrigin) return error(403, 'forbidden');
    const preOk = () => {
      const p = this.pre.get(req.cookies[COOKIE.pre] ?? '');
      return !!p && p.expiresAt > this.now() && p.csrf === req.csrf;
    };
    const challenge = () => {
      const c = this.challenges.get(req.cookies[COOKIE.challenge] ?? '');
      return c && c.expiresAt > this.now() && c.attempts < LIMITS.attempts ? c : undefined;
    };
    const session = () => {
      const s = this.sessions.get(req.cookies[COOKIE.session] ?? '');
      return s && s.org === org && this.sessionAlive(s) ? s : undefined;
    };
    const eligible = (a: Account | undefined) =>
      !!a && a.org === org && a.active && !a.closed && a.verified && a.membershipStatus === 'active' && this.orgs.get(org)?.active === true;
    const createSession = (account: Account, extra: Record<string, unknown> = {}) => {
      this.challenges.delete(req.cookies[COOKIE.challenge] ?? '');
      clearCookie(COOKIE.challenge);
      const id = opaque();
      const s: Session = { userId: account.userId, org, csrf: opaque(), createdAt: this.now(), lastSeenAt: this.now(), revoked: false };
      this.sessions.set(id, s);
      // o cookie vive até o limite absoluto; inatividade é aplicada no servidor
      setCookie(COOKIE.session, id, LIMITS.absolute, 'Lax');
      return json(200, { ...extra, csrfToken: s.csrf });
    };
    const wrongCode = (c: Challenge) => {
      c.attempts += 1;
      return error(401, 'unauthenticated');
    };

    switch (key) {
      case 'POST /auth/login': {
        if (!preOk()) return error(403, 'forbidden');
        const email = str(body.email)?.trim().toLowerCase();
        const account = [...this.accounts.values()].find((a) => a.org === org && a.email === email);
        // conta inexistente, senha errada ou conta não elegível: a mesma resposta
        if (!eligible(account) || account!.password !== str(body.password)) return error(401, 'unauthenticated');
        this.pre.delete(req.cookies[COOKIE.pre]);
        clearCookie(COOKIE.pre);
        const id = opaque();
        const c: Challenge = {
          userId: account!.userId,
          csrf: opaque(),
          purpose: account!.totpSecret ? 'verify' : 'enroll',
          attempts: 0,
          expiresAt: this.now() + LIMITS.challenge,
        };
        this.challenges.set(id, c);
        setCookie(COOKIE.challenge, id, LIMITS.challenge, 'Strict');
        return json(200, { status: c.purpose === 'verify' ? 'mfa_required' : 'mfa_enrollment_required', csrfToken: c.csrf });
      }

      case 'POST /auth/mfa/enroll/start': {
        const c = challenge();
        if (!c || c.purpose !== 'enroll') return error(401, 'unauthenticated');
        if (c.csrf !== req.csrf) return error(403, 'forbidden');
        const account = this.accounts.get(c.userId)!;
        c.pendingSecret = newSecret();
        const label = encodeURIComponent(`Nekkora:${account.email}`);
        return json(200, { otpauthUri: `otpauth://totp/${label}?secret=${c.pendingSecret}&issuer=Nekkora&algorithm=SHA1&digits=6&period=30` });
      }

      case 'POST /auth/mfa/enroll/confirm': {
        const c = challenge();
        if (!c || c.purpose !== 'enroll' || !c.pendingSecret) return error(401, 'unauthenticated');
        if (c.csrf !== req.csrf) return error(403, 'forbidden');
        const code = str(body.code);
        if (!code || !/^\d{6}$/.test(code)) return error(400, 'invalid_request');
        const step = acceptedStep(c.pendingSecret, code, 0, this.now());
        if (step === null) return wrongCode(c);
        const account = this.accounts.get(c.userId)!;
        account.totpSecret = c.pendingSecret;
        account.lastStep = step;
        account.recoveryCodes = Array.from({ length: 10 }, recoveryCode);
        return createSession(account, { recoveryCodes: [...account.recoveryCodes] });
      }

      case 'POST /auth/mfa/verify': {
        const c = challenge();
        if (!c || c.purpose !== 'verify') return error(401, 'unauthenticated');
        if (c.csrf !== req.csrf) return error(403, 'forbidden');
        const code = str(body.code);
        const recovery = str(body.recoveryCode);
        if ((code === undefined) === (recovery === undefined)) return error(400, 'invalid_request');
        const account = this.accounts.get(c.userId)!;
        if (recovery !== undefined) {
          const i = account.recoveryCodes.findIndex((rc) => normalizeRecovery(rc) === normalizeRecovery(recovery));
          if (i < 0) return wrongCode(c);
          account.recoveryCodes.splice(i, 1);
          this.revokeSessions(account.userId); // usar código de recuperação encerra as demais sessões
          return createSession(account);
        }
        if (!/^\d{6}$/.test(code!)) return error(400, 'invalid_request');
        const step = acceptedStep(account.totpSecret!, code!, account.lastStep, this.now());
        if (step === null) return wrongCode(c);
        account.lastStep = step;
        return createSession(account);
      }

      case 'GET /me': {
        const s = session();
        if (!s) return error(401, 'unauthenticated');
        s.lastSeenAt = this.now();
        const a = this.accounts.get(s.userId)!;
        return json(200, { accountType: a.accountType, displayName: a.displayName, email: a.email, organizationId: a.org });
      }

      case 'GET /auth/csrf': {
        const s = session();
        if (!s) return error(401, 'unauthenticated');
        s.lastSeenAt = this.now();
        return json(200, { csrfToken: s.csrf });
      }

      case 'POST /auth/logout': {
        const s = session();
        if (s) {
          if (s.csrf !== req.csrf) return error(403, 'forbidden');
          s.revoked = true;
        }
        clearCookie(COOKIE.session);
        return json(204);
      }

      case 'POST /auth/password-reset/request': {
        if (!preOk()) return error(403, 'forbidden');
        const email = str(body.email)?.trim().toLowerCase();
        const account = [...this.accounts.values()].find((a) => a.org === org && a.email === email);
        if (eligible(account)) {
          const t = this.issuePasswordResetToken(account!.userId);
          this.mail(account!.email, 'password-reset', `/o/${org}/reset-password#token=${t}`);
        }
        return json(202); // idêntico exista ou não a conta
      }

      case 'POST /auth/password-reset/confirm': {
        if (!preOk()) return error(403, 'forbidden');
        const t = str(body.token) ?? '';
        const entry = TOKEN.test(t) ? this.resetTokens.get(t) : undefined;
        const password = str(body.newPassword) ?? '';
        const length = Array.from(password).length;
        if (!entry || entry.used || entry.expiresAt <= this.now() || length < 12 || length > 128) return error(400, 'invalid_request');
        entry.used = true;
        const account = this.accounts.get(entry.userId)!;
        account.password = password;
        this.revokeSessions(account.userId);
        return json(204);
      }

      case 'POST /auth/email-verification/confirm': {
        if (!preOk()) return error(403, 'forbidden');
        const t = str(body.token) ?? '';
        const entry = TOKEN.test(t) ? this.verificationTokens.get(t) : undefined;
        const account = entry && this.accounts.get(entry.userId);
        if (!entry || entry.used || entry.expiresAt <= this.now() || account?.email !== entry.email) return error(400, 'invalid_request');
        entry.used = true;
        account.verified = true;
        return json(204);
      }

      default: {
        // F6a-2: suspender/reativar (contrato 8.7 §5.3; AdminService): sessão → CSRF → UUID → permissão → alvo
        const write = /^\/users\/([^/]+)\/(suspend|reactivate)$/.exec(route);
        if (req.method === 'POST' && write) {
          const s = session();
          if (!s) return error(401, 'unauthenticated');
          if (s.csrf !== req.csrf) return error(403, 'forbidden');
          s.lastSeenAt = this.now();
          return this.adminWrite(org, s, write[1], write[2] as 'suspend' | 'reactivate', json, error);
        }
        const read = {
          method: req.method,
          route,
          query: req.query ?? new URLSearchParams(),
          org,
          principal: () => {
            const s = session();
            if (!s) return undefined;
            s.lastSeenAt = this.now();
            const a = this.accounts.get(s.userId)!;
            return { membershipId: a.membershipId, accountType: a.accountType };
          },
        };
        const out = this.product.handle(read) ?? this.admin.handle(read);
        if (out) return json(out.status, out.body);
        return error(404, 'not_found'); // inclui o reenvio de verificação, que não existe no contrato (D2)
      }
    }
  }

  /**
   * Suspensão e reativação administrativas, na ordem do AdminService: UUID malformado → 400; conta externa ou sem
   * `org.manage` → 403; alvo = ator → 403; alvo fora da organização → 404; deixar a organização sem ORG_ADMIN efetivo
   * → 403 (invariante da 003; pela API, provavelmente inalcançável: só o ORG_ADMIN tem org.manage e não pode ser alvo
   * de si mesmo). Efeitos: suspender = conta suspensa + sessões e desafios do alvo encerrados; reativar = conta ativa,
   * SEM restaurar sessões nem concessões. Idempotentes (repetir dá 204).
   */
  private adminWrite(
    org: string,
    s: Session,
    rawTarget: string,
    action: 'suspend' | 'reactivate',
    json: (status: number, body?: unknown) => MockResponse,
    error: (status: number, code: string) => MockResponse,
  ): MockResponse {
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(rawTarget)) return error(400, 'invalid_request');
    const actor = this.accounts.get(s.userId)!;
    const m = actor.accountType === 'internal' ? this.product.memberships.get(actor.membershipId) : undefined;
    const perms = new Set((m?.orgRoles ?? []).flatMap((r) => ROLE_PERMISSIONS[r]));
    if (!perms.has('org.manage')) return error(403, 'forbidden');
    const target = rawTarget.toLowerCase();
    if (target === actor.userId) return error(403, 'forbidden');
    const acc = this.accounts.get(target);
    if (!acc || acc.org !== org) return error(404, 'not_found');
    if (action === 'suspend') {
      const effectiveAdmin = (a: Account) =>
        a.org === org && a.accountType === 'internal' && a.active && !a.closed && a.membershipStatus === 'active' &&
        (this.product.memberships.get(a.membershipId)?.orgRoles ?? []).includes('ORG_ADMIN');
      if (effectiveAdmin(acc) && ![...this.accounts.values()].some((a) => a !== acc && effectiveAdmin(a))) return error(403, 'forbidden');
      acc.active = false;
      for (const [id, c] of this.challenges) if (c.userId === acc.userId) this.challenges.delete(id);
      this.revokeSessions(acc.userId);
    } else {
      acc.active = true;
    }
    this.adminWrites.push({ org, action, target, at: this.now() });
    return json(204);
  }

  private sessionAlive(s: Session) {
    if (s.revoked) return false;
    const account = this.accounts.get(s.userId);
    if (!account) return false;
    const now = this.now();
    return now - s.lastSeenAt < LIMITS.inactivity[account.accountType] && now - s.createdAt < LIMITS.absolute;
  }
}
