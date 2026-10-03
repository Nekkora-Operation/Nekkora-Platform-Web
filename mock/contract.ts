import { randomBytes, randomUUID } from 'node:crypto';
import { acceptedStep, newSecret } from './totp.ts';

/**
 * API simulada do Nekkora Platform — contrato 8.7 de autenticação, em memória, para trabalhar na interface sem
 * o backend. Reproduz o que o frontend enxerga: rotas, corpos, códigos de erro `{"error": ...}`, `X-Request-Id`,
 * cookies `__Host-` HttpOnly, CSRF sincronizador (pré-autenticação, desafio, sessão) com checagem de Origin,
 * TOTP real com anti-replay, 5 tentativas por desafio, códigos de recuperação de uso único, tokens de link de
 * uso único, inatividade/limite absoluto de sessão e respostas genéricas (sem enumeração).
 *
 * O e-mail transacional é simulado: mensagens vão para uma caixa de entrada em memória, visível em /__mock/.
 * Nada daqui entra no build de produção (é só middleware dos servidores do Vite).
 */

export const DEV_ORG = 'b7e1c3a0-5d2f-4e8b-9a61-0c3d5e7f9a12';
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

export interface Account {
  userId: string;
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
  private pre = new Map<string, { csrf: string; expiresAt: number }>();
  private challenges = new Map<string, Challenge>();
  private sessions = new Map<string, Session>();
  private resetTokens = new Map<string, LinkToken>();
  private verificationTokens = new Map<string, LinkToken & { email: string }>();
  private mailSeq = 0;

  constructor(private readonly now: () => number = Date.now) {
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
    this.seed();
  }

  private seed() {
    this.createOrganization({ org: DEV_ORG, name: 'Organização de desenvolvimento' });
    const ana = this.createAccount({ org: DEV_ORG, email: 'ana@nekkora.dev', displayName: 'Ana Souza' });
    ana.totpSecret = DEV_TOTP_SECRET;
    ana.recoveryCodes = Array.from({ length: 10 }, recoveryCode);
    this.createAccount({ org: DEV_ORG, email: 'novo@nekkora.dev', displayName: 'Pessoa Nova' });
    const pending = this.createAccount({ org: DEV_ORG, email: 'pendente@nekkora.dev', displayName: 'Pessoa Pendente', verified: false });
    this.sendVerification(pending);
    const portal = this.createAccount({ org: DEV_ORG, email: 'portal@nekkora.dev', displayName: 'Pessoa do Portal', accountType: 'external' });
    portal.totpSecret = DEV_TOTP_SECRET;
    portal.recoveryCodes = Array.from({ length: 10 }, recoveryCode);
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
  }): Account {
    const userId = randomUUID();
    const account: Account = {
      userId,
      org: input.org,
      email: input.email ?? `pessoa-${userId.slice(0, 8)}@nekkora.dev`,
      displayName: input.displayName ?? 'Pessoa de Teste',
      accountType: input.accountType ?? 'internal',
      password: input.password ?? DEV_PASSWORD,
      verified: input.verified ?? true,
      active: true,
      lastStep: 0,
      recoveryCodes: [],
    };
    this.accounts.set(userId, account);
    return account;
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
    const json = (status: number, body?: unknown) => Object.assign(res, { status, body });
    const error = (status: number, code: string) => json(status, { error: code });

    if (this.failure === 'rate_limited') {
      res.headers['Retry-After'] = '120';
      return error(429, 'rate_limited');
    }
    if (this.failure === 'service_unavailable') return error(503, 'service_unavailable');
    if (this.failure === 'internal_error') return error(500, 'internal_error');

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
      !!a && a.org === org && a.active && a.verified && this.orgs.get(org)?.active === true;
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

      default:
        return error(404, 'not_found'); // inclui o reenvio de verificação, que não existe no contrato (D2)
    }
  }

  private sessionAlive(s: Session) {
    if (s.revoked) return false;
    const account = this.accounts.get(s.userId);
    if (!account) return false;
    const now = this.now();
    return now - s.lastSeenAt < LIMITS.inactivity[account.accountType] && now - s.createdAt < LIMITS.absolute;
  }
}
