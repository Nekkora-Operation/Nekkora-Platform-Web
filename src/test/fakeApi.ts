/**
 * API falsa, em memória, com a semântica do contrato 8.7 (CSRF por contexto, desafio, tentativas, tokens de
 * uso único, respostas genéricas). Substitui `fetch` nos testes de integração da interface.
 */
import { vi } from 'vitest';

export const ORG = '3f2a1c9e-5b7d-4e21-9c61-2e4d8f7a91c0';
export const TOTP_OK = '654321';
export const ENROLL_OK = '123456';
export const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

interface User {
  password: string;
  hasFactor: boolean;
  recoveryCodes: string[];
  eligible: boolean;
}

export interface FakeRequest {
  method: string;
  path: string;
  body?: unknown;
  csrf?: string;
}

type Failure = 'network' | 503 | 429 | 500;

export class FakeApi {
  users = new Map<string, User>();
  requests: FakeRequest[] = [];
  resetTokens = new Set<string>();
  verifyTokens = new Set<string>();
  /** Falhas forçadas para as próximas requisições (fila). */
  failures: Failure[] = [];
  /** Atraso artificial (ms) para testar envio duplicado. */
  delay = 0;
  private pre?: string;
  private challenge?: { email: string; purpose: 'verify' | 'enroll'; csrf: string; attempts: number; valid: boolean };
  private session?: { email: string; csrf: string };
  private seq = 0;

  constructor() {
    this.users.set('ana@empresa.com', { password: 'senha-muito-segura', hasFactor: true, recoveryCodes: ['ABCD-EFGH-IJKL-MNOP'], eligible: true });
    this.users.set('novo@empresa.com', { password: 'senha-muito-segura', hasFactor: false, recoveryCodes: [], eligible: true });
  }

  install() {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => this.handle(String(input), init)));
    return this;
  }

  expireSession() {
    this.session = undefined;
  }

  hasSession() {
    return !!this.session;
  }

  private token(prefix: string) {
    return `${prefix}-${++this.seq}`;
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const csrf = headers.get('X-CSRF-Token') ?? undefined;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    this.requests.push({ method, path, body, csrf });
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    const failure = this.failures.shift();
    if (failure === 'network') throw new TypeError('Failed to fetch');
    if (failure === 429) return this.error(429, 'rate_limited', { 'Retry-After': '120' });
    if (failure === 503) return this.error(503, 'service_unavailable');
    if (failure === 500) return this.error(500, 'internal_error');

    if (path === '/api/v1/csrf') {
      this.pre = this.token('pre');
      return this.json(200, { csrfToken: this.pre });
    }
    const m = path.match(/^\/api\/v1\/o\/([^/]+)(\/.*)$/);
    if (!m) return this.error(404, 'not_found');
    const [, org, route] = m;
    if (org !== ORG) return this.error(401, 'unauthenticated'); // organização inexistente: genérico

    const preOk = () => !!this.pre && csrf === this.pre;
    const challengeOk = () => !!this.challenge && this.challenge.valid && csrf === this.challenge.csrf;

    switch (`${method} ${route}`) {
      case 'POST /auth/login': {
        if (!preOk()) return this.error(403, 'forbidden');
        const user = this.users.get(String(body?.email).toLowerCase());
        if (!user || user.password !== body?.password || !user.eligible) return this.error(401, 'unauthenticated');
        this.pre = undefined;
        this.challenge = { email: body.email, purpose: user.hasFactor ? 'verify' : 'enroll', csrf: this.token('chl'), attempts: 0, valid: true };
        return this.json(200, { status: user.hasFactor ? 'mfa_required' : 'mfa_enrollment_required', csrfToken: this.challenge.csrf });
      }
      case 'POST /auth/mfa/enroll/start':
        if (!challengeOk() || this.challenge!.purpose !== 'enroll') return this.error(challengeOk() ? 401 : 403, challengeOk() ? 'unauthenticated' : 'forbidden');
        return this.json(200, { otpauthUri: `otpauth://totp/Nekkora:novo%40empresa.com?secret=${SECRET}&issuer=Nekkora&algorithm=SHA1&digits=6&period=30` });
      case 'POST /auth/mfa/enroll/confirm': {
        if (!challengeOk()) return this.error(403, 'forbidden');
        if (body?.code !== ENROLL_OK) return this.wrong();
        const user = this.users.get(this.challenge!.email)!;
        user.hasFactor = true;
        user.recoveryCodes = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-DD${String.fromCharCode(65 + i)}${String.fromCharCode(66 + i)}`);
        return this.createSession(user.recoveryCodes);
      }
      case 'POST /auth/mfa/verify': {
        if (!challengeOk()) return this.error(403, 'forbidden');
        if ((body?.code == null) === (body?.recoveryCode == null)) return this.error(400, 'invalid_request');
        const user = this.users.get(this.challenge!.email)!;
        if (body.recoveryCode != null) {
          const norm = String(body.recoveryCode).replace(/-/g, '').toUpperCase();
          const i = user.recoveryCodes.findIndex((c) => c.replace(/-/g, '') === norm);
          if (i < 0) return this.wrong();
          user.recoveryCodes.splice(i, 1);
        } else if (body.code !== TOTP_OK) {
          return this.wrong();
        }
        return this.createSession();
      }
      case 'GET /me':
        if (!this.session) return this.error(401, 'unauthenticated');
        return this.json(200, { accountType: 'internal', displayName: 'Ana Souza', email: this.session.email, organizationId: ORG });
      // área interna (F4): respostas mínimas conformes ao contrato — conta sem atribuições, sem workspaces
      case 'GET /me/permissions':
        if (!this.session) return this.error(401, 'unauthenticated');
        return this.json(200, {
          organizationId: ORG,
          membershipId: '0b6f6a10-8c0e-4a8e-9f2e-1d2c3b4a5f60',
          organization: { roles: [], permissions: [] },
          allWorkspaces: { permissions: [] },
          hasWorkspaceAssignments: false,
        });
      case 'GET /workspaces?limit=100':
      case 'GET /executions':
        if (!this.session) return this.error(401, 'unauthenticated');
        return this.json(200, { items: [], nextCursor: null });
      case 'GET /auth/csrf':
        if (!this.session) return this.error(401, 'unauthenticated');
        return this.json(200, { csrfToken: this.session.csrf });
      case 'POST /auth/logout':
        if (this.session && csrf !== this.session.csrf) return this.error(403, 'forbidden');
        this.session = undefined;
        return new Response(null, { status: 204 });
      case 'POST /auth/password-reset/request':
      case 'POST /auth/email-verification/request':
        if (!preOk()) return this.error(403, 'forbidden');
        return new Response(null, { status: 202 }); // idêntico exista ou não a conta
      case 'POST /auth/password-reset/confirm': {
        if (!preOk()) return this.error(403, 'forbidden');
        const len = Array.from(String(body?.newPassword ?? '')).length;
        if (!this.resetTokens.delete(body?.token) || len < 12 || len > 128) return this.error(400, 'invalid_request');
        return new Response(null, { status: 204 });
      }
      case 'POST /auth/email-verification/confirm':
        if (!preOk()) return this.error(403, 'forbidden');
        if (!this.verifyTokens.delete(body?.token)) return this.error(400, 'invalid_request');
        return new Response(null, { status: 204 });
      default:
        return this.error(404, 'not_found');
    }
  }

  private wrong() {
    const c = this.challenge!;
    c.attempts += 1;
    if (c.attempts >= 5) c.valid = false;
    return this.error(401, 'unauthenticated');
  }

  private createSession(recoveryCodes?: string[]) {
    this.session = { email: this.challenge!.email, csrf: this.token('ses') };
    this.challenge = undefined;
    return this.json(200, recoveryCodes ? { recoveryCodes, csrfToken: this.session.csrf } : { csrfToken: this.session.csrf });
  }

  private json(status: number, data: unknown) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'X-Request-Id': '0b4e7c2a-1f3d-4d8e-9a6b-5c2e1f0a9d31' } });
  }

  private error(status: number, code: string, extra: Record<string, string> = {}) {
    return new Response(JSON.stringify({ error: code }), {
      status,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': '0b4e7c2a-1f3d-4d8e-9a6b-5c2e1f0a9d31', ...extra },
    });
  }
}
