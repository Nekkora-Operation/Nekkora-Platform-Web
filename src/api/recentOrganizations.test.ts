import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from './csrf';
import { forgetOrganizationsForTest, myOrganizations, ORGANIZATION_NAMES_REUSE_MS, recentOrganizations } from './identity';
import { RouteApi } from '../test/routeApi';

/**
 * A1 (LICENCIAMENTO-002): o cabeçalho da organização reaproveita a lista que a tela "Organizações" acabou de ler (até 10 s),
 * em vez de lê-la de novo ao trocar de organização. A tela de escolha sempre lê na hora; sair da sessão esquece a lista.
 */
let api: RouteApi;
const list = (name: string) => ({
  status: 200,
  body: { organizations: [{ organizationId: '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f', name, roles: ['ORG_ADMIN'], activationState: 'ATIVADA', handle: 'acme' }], canCreateOrganization: true },
});

beforeEach(() => {
  vi.unstubAllGlobals();
  csrfStore.clear();
  forgetOrganizationsForTest();
  api = new RouteApi().install();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('lista de organizações para o cabeçalho', () => {
  it('logo depois da tela de escolha: reaproveita, sem nova leitura', async () => {
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', list('Acme'));
    await myOrganizations();
    const r = await recentOrganizations();
    expect(r.organizations[0].name).toBe('Acme');
    expect(api.sent('GET', '/api/v1/me/organizations')).toHaveLength(1);
  });

  it('passado o prazo: lê de novo', async () => {
    vi.useFakeTimers({ now: Date.now() });
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', list('Acme'));
    await myOrganizations();
    vi.setSystemTime(Date.now() + ORGANIZATION_NAMES_REUSE_MS + 1);
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', list('Acme Renomeada'));
    expect((await recentOrganizations()).organizations[0].name).toBe('Acme Renomeada');
    expect(api.sent('GET', '/api/v1/me/organizations')).toHaveLength(2);
  });

  it('a tela de escolha sempre lê na hora', async () => {
    api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', list('Acme'));
    await myOrganizations();
    await myOrganizations();
    expect(api.sent('GET', '/api/v1/me/organizations')).toHaveLength(2);
  });
});
