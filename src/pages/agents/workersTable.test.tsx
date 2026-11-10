import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { fakeLocks } from '../../test/fakeLocks';
import { sessionMemory } from '../../app/notices';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { WORKERS_INTRO, removeLabel } from './WorkersPage';

/**
 * PLATFORM-AGENT-V2-002, T08 — legibilidade da tabela de Workers: cabeçalhos e células centralizados (regras locais a esta
 * tabela), um par nome + "Retirar" por workspace, e o destino da ação legível por leitor de tela. Sem workspace, com um e
 * com vários (inclusive nome longo); "Retirar" atua só no item indicado.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ID = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const LONG = 'Contas a pagar e conciliação bancária das filiais do Nordeste e do Centro-Oeste';
const ws = (n: number, name: string) => ({
  workspaceId: ID(n),
  name,
  description: null,
  status: 'active',
  client: null,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
});

let api: RouteApi;
beforeEach(() => {
  csrfStore.clear();
  csrfStore.setSession(ORG, 'ses');
  sessionMemory.reset();
  vi.unstubAllGlobals();
  localStorage.clear();
  const locks = fakeLocks();
  setOperationRegistryForTest(createOperationRegistry({ storage: () => localStorage, locks: () => locks, now: () => Date.now() }));
  api = new RouteApi().install();
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' },
  });
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: {
      organizationId: ORG,
      membershipId: ID(90),
      organization: { roles: ['ORG_ADMIN'], permissions: ['worker.manage', 'worker_workspace.authorize'] },
      allWorkspaces: { permissions: [] },
      hasWorkspaceAssignments: true,
    },
  });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', {
    status: 200,
    body: { items: [ws(11, 'Financeiro'), ws(12, 'Compras'), ws(13, LONG)], nextCursor: null },
  });
  api.on('GET', `/api/v1/o/${ORG}/workers`, 'listWorkers', {
    status: 200,
    body: {
      items: [
        { workerId: ID(1), name: 'Estação sem workspace', status: 'ACTIVE', agentId: null, workspaceIds: [] },
        { workerId: ID(2), name: 'Estação fiscal', status: 'ACTIVE', agentId: null, workspaceIds: [ID(11)] },
        { workerId: ID(3), name: 'Estação central', status: 'ACTIVE', agentId: ID(50), workspaceIds: [ID(11), ID(12), ID(13)] },
      ],
    },
  });
});

const table = async () => within(await screen.findByRole('region', { name: 'Lista de Workers' })).getByRole('table');

describe('tabela de Workers (T08)', () => {
  it('texto de abertura, cabeçalhos e células centralizados só nesta tabela', async () => {
    renderApp(`/o/${ORG}/workers`);
    expect(await screen.findByText(WORKERS_INTRO)).toBeInTheDocument();
    const t = await table();
    expect(t.closest('.pw-workers')).not.toBeNull();
    for (const th of within(t).getAllByRole('columnheader')) expect(th.className).toMatch(/nk-table__cell--center/);
    for (const td of within(t).getAllByRole('cell')) expect(td.className).toMatch(/nk-table__cell--center/);
  });

  it('sem workspace, com um e com vários: um par nome + "Retirar" por item, com o destino no nome acessível', async () => {
    renderApp(`/o/${ORG}/workers`);
    await table();
    const none = screen.getByRole('row', { name: /Estação sem workspace/ });
    expect(within(none).getByText('Nenhum')).toBeInTheDocument();
    expect(within(none).queryByRole('button', { name: /^Retirar/ })).toBeNull();

    const one = screen.getByRole('list', { name: 'Workspaces autorizados de Estação fiscal' });
    expect(within(one).getAllByRole('listitem')).toHaveLength(1);
    expect(within(one).getByRole('button', { name: removeLabel('Financeiro', 'Estação fiscal') })).toHaveTextContent('Retirar');

    const many = screen.getByRole('list', { name: 'Workspaces autorizados de Estação central' });
    const items = within(many).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    for (const [i, name] of ['Financeiro', 'Compras', LONG].entries()) {
      // cada item tem exatamente o seu nome e o seu botão, lado a lado (mesmo item da lista)
      expect(items[i]).toHaveClass('pw-workers__ws-item');
      expect(within(items[i]).getByText(name)).toHaveClass('pw-workers__ws-name');
      const buttons = within(items[i]).getAllByRole('button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveAccessibleName(removeLabel(name, 'Estação central'));
    }
    // dois Workers no mesmo workspace: os botões não se confundem para o leitor de tela
    expect(screen.getAllByRole('button', { name: /^Retirar autorização de Financeiro/ })).toHaveLength(2);
  });

  it('"Retirar" atua só no item indicado (teclado)', async () => {
    renderApp(`/o/${ORG}/workers`);
    await table();
    const b = screen.getByRole('button', { name: removeLabel('Compras', 'Estação central') });
    b.focus();
    expect(b).toHaveFocus();
    fireEvent.click(b);
    const dialog = await screen.findByRole('alertdialog', { name: 'Retirar Estação central de Compras?' });
    expect(dialog).toBeInTheDocument();
    expect(api.sent('DELETE', /\/workers\//)).toEqual([]); // nada enviado antes de confirmar
    api.on('DELETE', `/api/v1/o/${ORG}/workers/${ID(3)}/workspaces/${ID(12)}`, 'revokeWorkerInWorkspace', { status: 204 });
    const confirm = within(dialog).getByRole('button', { name: 'Retirar' });
    await vi.waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(api.sent('DELETE', /\/workers\//)).toHaveLength(1));
    expect(api.sent('DELETE', /\/workers\//)[0].path).toContain(`/workers/${ID(3)}/workspaces/${ID(12)}`);
  });
});
