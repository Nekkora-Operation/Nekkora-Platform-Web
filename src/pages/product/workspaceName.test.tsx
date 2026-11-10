import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { location } from '../../test/helpers';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { NAME_TAKEN } from './WorkspacesPage';

/**
 * PLATFORM-V2-001, T03 — nome de workspace único por organização. A API recusa com 409 conflict + reason workspace_name_taken (inclusive
 * " financeiro " contra "Financeiro"): a tela diz exatamente o que houve, mantém o formulário (nome e descrição), marca o
 * campo, não envia de novo sozinha e aceita a correção no mesmo diálogo. Respostas por rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ANA = '00000000-0000-4000-8000-000000000001';
const WS = '22222222-3333-4444-8555-666666666666';
const T = '2026-11-10T12:00:00Z';

let api: RouteApi;

function session() {
  csrfStore.setSession(ORG, 'ses');
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Bruno', email: 'bruno@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' },
  });
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: {
      organizationId: ORG,
      membershipId: ANA,
      organization: { roles: ['ORG_ADMIN'], permissions: ['org.manage', 'workspace.lifecycle'] },
      allWorkspaces: { permissions: ['automation.read'] },
      hasWorkspaceAssignments: false,
    },
  });
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', {
    status: 200,
    body: { items: [{ workspaceId: WS, name: 'Financeiro', description: null, status: 'active', client: null, createdAt: T, updatedAt: T }], nextCursor: null },
  });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
}

const posts = () => api.sent('POST', `/api/v1/o/${ORG}/workspaces`);

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  csrfStore.clear();
  sessionMemory.reset();
  vi.unstubAllGlobals();
  const locks = fakeLocks();
  setOperationRegistryForTest(createOperationRegistry({ storage: () => localStorage, locks: () => locks, now: () => Date.now() }));
  localStorage.clear();
  api = new RouteApi().install();
  session();
});

describe('nome de workspace já usado na organização (T03)', () => {
  it('409 conflict + workspace_name_taken: mensagem exata, formulário mantido, um único envio; corrigir o nome cria', async () => {
    let answer: 'taken' | 'created' = 'taken';
    api.on('POST', `/api/v1/o/${ORG}/workspaces`, 'createWorkspace', () =>
      answer === 'taken'
        ? { status: 409, body: { error: 'conflict', reason: 'workspace_name_taken' } }
        : { status: 201, body: { workspaceId: '33333333-3333-4333-8333-333333333333', name: 'Financeiro Norte', status: 'ACTIVE', createdAt: T } },
    );
    renderApp(`/o/${ORG}/workspaces`);
    fireEvent.click(await screen.findByRole('button', { name: 'Criar workspace' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Criar workspace' });
    const nome = within(dialog).getByLabelText(/^Nome/) as HTMLInputElement;
    const descricao = within(dialog).getByLabelText(/^Descrição/) as HTMLTextAreaElement;
    fireEvent.change(nome, { target: { value: ' financeiro ' } });
    fireEvent.change(descricao, { target: { value: 'Contas a pagar' } });
    const confirmar = within(dialog).getByRole('button', { name: 'Criar workspace' });
    await waitFor(() => expect(confirmar).toBeEnabled());
    fireEvent.click(confirmar);
    fireEvent.click(confirmar); // duplo clique: continua um envio só

    expect(await within(dialog).findByText(`${NAME_TAKEN} Escolha outro nome. Nada foi criado.`)).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual({ name: 'financeiro', description: 'Contas a pagar' });
    // formulário preservado, campo marcado, nada reenviado sozinho
    expect(screen.getByRole('alertdialog', { name: 'Criar workspace' })).toBe(dialog);
    expect(nome.value).toBe(' financeiro ');
    expect(descricao.value).toBe('Contas a pagar');
    expect(nome).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getAllByText(NAME_TAKEN).length).toBeGreaterThanOrEqual(1);
    expect(location()).toBe(`/o/${ORG}/workspaces`);

    // a pessoa muda o nome: a marca some; confirmar de novo envia uma vez e cria
    fireEvent.change(nome, { target: { value: 'Financeiro Norte' } });
    expect(nome).not.toHaveAttribute('aria-invalid', 'true');
    answer = 'created';
    await waitFor(() => expect(confirmar).toBeEnabled());
    fireEvent.click(confirmar);
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/workspaces/33333333-3333-4333-8333-333333333333`));
    expect(posts()).toHaveLength(2);
    expect(posts()[1].body).toEqual({ name: 'Financeiro Norte', description: 'Contas a pagar' });
  });

  it('outro 409 (conflito genérico) continua com o texto genérico, sem atribuir a causa ao nome', async () => {
    api.on('POST', `/api/v1/o/${ORG}/workspaces`, 'createWorkspace', { status: 409, body: { error: 'conflict' } });
    renderApp(`/o/${ORG}/workspaces`);
    fireEvent.click(await screen.findByRole('button', { name: 'Criar workspace' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Criar workspace' });
    const nome = within(dialog).getByLabelText(/^Nome/);
    fireEvent.change(nome, { target: { value: 'Compras' } });
    const confirmar = within(dialog).getByRole('button', { name: 'Criar workspace' });
    await waitFor(() => expect(confirmar).toBeEnabled());
    fireEvent.click(confirmar);
    expect(await within(dialog).findByText(/O estado atual não permite este ato/)).toBeInTheDocument();
    expect(within(dialog).queryByText(NAME_TAKEN)).toBeNull();
    expect(nome).not.toHaveAttribute('aria-invalid', 'true');
  });
});
