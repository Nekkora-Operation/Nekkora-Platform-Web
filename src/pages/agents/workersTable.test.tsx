import axe from 'axe-core';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * R1 — cartões no modo estreito. O jsdom não mede: a largura da região e a de que a tabela precisa são simuladas, e o
 * ResizeObserver é um dublê que avisa quando a "janela" muda.
 */
describe('Workers em cartões quando a tabela não cabe (T08 R1)', () => {
  let width = 600;
  const NEEDED = 1100;
  let observers: (() => void)[] = [];
  beforeEach(() => {
    width = 600;
    observers = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
          observers.push(cb);
        }
        observe() {}
        disconnect() {
          observers = observers.filter((o) => o !== this.cb);
        }
      },
    );
    // a região mede `width`; a tabela, quando presente, precisa de NEEDED; os cartões cabem sempre
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).classList.contains('pw-rtable') ? width : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get() {
        const el = this as HTMLElement;
        if (!el.classList.contains('pw-rtable')) return 0;
        return el.querySelector('table') ? Math.max(NEEDED, width) : width;
      },
    });
  });
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
  });
  const resize = (w: number) => {
    width = w;
    for (const o of [...observers]) o();
  };
  const region = () => screen.findByRole('region', { name: 'Lista de Workers' });

  it('estreito: um cartão por Worker, sem tabela no DOM; cada workspace com o seu "Retirar"; uma consulta só', async () => {
    renderApp(`/o/${ORG}/workers`);
    const r = await region();
    await vi.waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    expect(within(r).queryByRole('table')).toBeNull();
    const cards = within(r).getAllByRole('article');
    expect(cards.map((c) => within(c).getByRole('heading').textContent)).toEqual(['Estação sem workspace', 'Estação fiscal', 'Estação central']);
    const central = cards[2];
    expect(within(central).getByText('Workspaces autorizados')).toBeInTheDocument();
    const itens = within(central).getAllByRole('listitem');
    expect(itens.map((li) => li.textContent)).toEqual(['FinanceiroRetirar', 'ComprasRetirar', `${LONG}Retirar`]);
    for (const [li, nome] of itens.map((li, i) => [li, ['Financeiro', 'Compras', LONG][i]] as const))
      expect(within(li).getByRole('button', { name: removeLabel(nome, 'Estação central') })).toBeInTheDocument();
    // nenhum controle duplicado/escondido: um "Retirar" por workspace na página inteira
    expect(screen.getAllByRole('button', { name: /^Retirar autorização de/ })).toHaveLength(4);
    expect(within(cards[0]).getByText('Nenhum')).toBeInTheDocument();
    expect(within(cards[0]).getByRole('button', { name: 'Autorizar Estação sem workspace num workspace' })).toBeInTheDocument();
    // a região só recebe foco quando é a tabela rolável
    expect(r).not.toHaveAttribute('tabindex');
    // trocar de formato não pede nada à API: a mesma lista (carga inicial, com a montagem dupla do modo estrito)
    const gets = api.sent('GET', `/api/v1/o/${ORG}/workers`).length;
    resize(650);
    expect(api.sent('GET', `/api/v1/o/${ORG}/workers`)).toHaveLength(gets);
  });

  it('estreito, pelo teclado: "Retirar" do cartão atua só no par indicado', async () => {
    renderApp(`/o/${ORG}/workers`);
    const r = await region();
    await vi.waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    const b = within(r).getByRole('button', { name: removeLabel(LONG, 'Estação central') });
    b.focus();
    expect(b).toHaveFocus();
    fireEvent.click(b);
    const dialog = await screen.findByRole('alertdialog', { name: `Retirar Estação central de ${LONG}?` });
    api.on('DELETE', `/api/v1/o/${ORG}/workers/${ID(3)}/workspaces/${ID(13)}`, 'revokeWorkerInWorkspace', { status: 204 });
    const confirm = within(dialog).getByRole('button', { name: 'Retirar' });
    await vi.waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(api.sent('DELETE', /\/workers\//)).toHaveLength(1));
    expect(api.sent('DELETE', /\/workers\//)[0].path).toContain(`/workers/${ID(3)}/workspaces/${ID(13)}`);
  });

  it('a troca acompanha o espaço: alarga e volta à tabela (com foco de rolagem), estreita e volta aos cartões, sem nova consulta', async () => {
    renderApp(`/o/${ORG}/workers`);
    const r = await region();
    await vi.waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    const gets = api.sent('GET', `/api/v1/o/${ORG}/workers`).length;
    resize(1000); // ainda menor que o necessário
    expect(r).toHaveAttribute('data-format', 'cartoes');
    resize(1200);
    await vi.waitFor(() => expect(r).toHaveAttribute('data-format', 'tabela'));
    expect(within(r).getByRole('table')).toBeInTheDocument();
    expect(within(r).queryByRole('article')).toBeNull();
    expect(r).toHaveAttribute('tabindex', '0');
    resize(700);
    await vi.waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    expect(api.sent('GET', `/api/v1/o/${ORG}/workers`)).toHaveLength(gets);
  });

  it('acessibilidade (axe) dos cartões', async () => {
    renderApp(`/o/${ORG}/workers`);
    const r = await region();
    await vi.waitFor(() => expect(r).toHaveAttribute('data-format', 'cartoes'));
    const result = await axe.run(r, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });

  it('desktop (a tabela cabe): tabela, sem cartões', async () => {
    width = 1400;
    renderApp(`/o/${ORG}/workers`);
    const r = await region();
    await within(r).findByRole('table');
    expect(r).toHaveAttribute('data-format', 'tabela');
    expect(within(r).queryByRole('article')).toBeNull();
  });
});
