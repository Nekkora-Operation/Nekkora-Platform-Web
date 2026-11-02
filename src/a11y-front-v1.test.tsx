import axe from 'axe-core';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from './api/csrf';
import { sessionMemory } from './app/notices';
import { resetLinkTokenCapture } from './auth/linkToken';
import { openLink } from './test/helpers';
import { renderApp } from './test/render';
import { RouteApi } from './test/routeApi';

/** FRONT-V1-001 — axe nas telas novas (respostas por rota conferidas contra o contrato). Contraste: E2E no navegador real. */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const VERSION = '22222222-3333-4444-8555-666666666666';

async function violations() {
  const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

let api: RouteApi;
beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  csrfStore.clear();
  sessionMemory.reset();
  resetLinkTokenCapture();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  api = new RouteApi().install();
  api.on('GET', '/api/v1/csrf', 'getPreAuthCsrf', { status: 200, body: { csrfToken: 'pre' } });
  api.on('GET', '/api/v1/me/session', 'identitySessionState', { status: 200, body: { restricted: false, csrfToken: 'id' } });
  api.on('GET', '/api/v1/me/organizations', 'identityOrganizations', {
    status: 200,
    body: { organizations: [{ organizationId: ORG, name: 'Acme', roles: ['ORG_ADMIN'], activationState: 'AGUARDANDO_ATIVACAO' }], canCreateOrganization: true },
  });
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA' },
  });
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: {
      organizationId: ORG,
      membershipId: VERSION,
      organization: { roles: ['ORG_ADMIN'], permissions: ['org.manage', 'workspace.lifecycle', 'agent.manage', 'worker.manage', 'agent_credential.manage'] },
      allWorkspaces: { permissions: ['automation.read', 'automation.manage', 'automation.publish', 'automation.execute'] },
      hasWorkspaceAssignments: false,
    },
  });
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
});

describe('FRONT-V1-001 — acessibilidade (axe) das telas novas', () => {
  it.each([
    ['entrada geral', '/entrar'],
    ['cadastro', '/cadastro'],
    ['recuperação de senha', '/recuperar-senha'],
  ])('%s sem violações', async (_, path) => {
    renderApp(path);
    await screen.findByRole('heading', { level: 1 });
    expect(await violations()).toEqual([]);
  });

  it('confirmação do cadastro (link) sem violações', async () => {
    openLink('/cadastro/confirmar', 'A'.repeat(43));
    renderApp('/cadastro/confirmar');
    await screen.findByRole('heading', { name: 'Conclua seu cadastro' });
    expect(await violations()).toEqual([]);
  });

  it('organizações e segurança da conta sem violações', async () => {
    const v = renderApp('/organizacoes');
    await screen.findByRole('heading', { name: 'Acme' });
    expect(await violations()).toEqual([]);
    v.unmount();
    renderApp('/conta');
    await screen.findByRole('heading', { name: 'Segurança da conta' });
    expect(await violations()).toEqual([]);
  });

  it('versão (rascunho com pacote) e supervisão vazia sem violações', async () => {
    api.on('GET', `/api/v1/o/${ORG}/automation-versions/${VERSION}`, 'getAutomationVersion', {
      status: 200,
      body: {
        automationVersionId: VERSION,
        automationId: ORG,
        workspaceId: ORG,
        versionNumber: 1,
        status: 'DRAFT',
        runtime: 'python3.12',
        entrypoint: 'main.py',
        arguments: [],
        artifactReference: null,
        artifact: {
          artifactId: VERSION,
          sha256: 'a'.repeat(64),
          sizeBytes: 2048,
          fingerprintRule: 'nekkora-agent/package-fingerprint/1',
          fingerprint: 'b'.repeat(64),
          filesCount: 10,
          manifestVersion: '1.4',
          framework: 'nekkora_rpa',
          executionMode: 'list',
          declaredGenerator: 'Nekkora Studio',
          provenance: 'DECLARED',
          receivedAt: '2026-10-30T10:00:00Z',
        },
        agentPackage: { fingerprintRule: 'nekkora-agent/package-fingerprint/1', fingerprint: 'b'.repeat(64) },
        createdAt: '2026-10-30T09:00:00Z',
        publishedAt: null,
        publishedByMembershipId: null,
      },
    });
    api.on('GET', `/api/v1/o/${ORG}/automations/${ORG}`, 'getAutomation', {
      status: 200,
      body: { automationId: ORG, workspaceId: ORG, name: 'Biografias', description: null, status: 'active', latestPublishedVersion: null, createdAt: '2026-10-30T09:00:00Z', updatedAt: '2026-10-30T09:00:00Z' },
    });
    const v = renderApp(`/o/${ORG}/versoes/${VERSION}`);
    await screen.findByRole('heading', { name: /Biografias — versão 1/ });
    await screen.findByText('Arquivo .zip do pacote');
    expect(await violations()).toEqual([]);
    v.unmount();
    api.on('GET', `/api/v1/o/${ORG}/agent-runs`, 'listAgentRuns', { status: 200, body: { items: [], nextCursor: null } });
    renderApp(`/o/${ORG}/supervisao`);
    await screen.findByText('Nenhuma execução local registrada.');
    expect(await violations()).toEqual([]);
  });
});
