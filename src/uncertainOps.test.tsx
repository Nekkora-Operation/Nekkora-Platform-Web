import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from './api/csrf';
import { createOperationRegistry, opKey, setOperationRegistryForTest, UNKNOWN_REVIEW, type OperationRegistry } from './api/pendingOps';
import { sessionMemory } from './app/notices';
import { fakeLocks } from './test/fakeLocks';
import { renderApp } from './test/render';
import { RouteApi } from './test/routeApi';

/**
 * FRONT-V1-002 — resultado desconhecido sobrevive a navegação, recarga e outra aba (mecanismo compartilhado do
 * StepUpDialog; operação representativa: criar workspace). Respostas por rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ORG2 = '1b7f2a0d-4c3e-4d6f-9a82-3b0c4d5e6f70';
const ANA = '00000000-0000-4000-8000-000000000001';
const BIA = '00000000-0000-4000-8000-000000000002';
const WS = '22222222-3333-4444-8555-666666666666';

let api: RouteApi;
let locks: ReturnType<typeof fakeLocks>;
/** Aba atual: registro próprio, armazenamento e locks da origem compartilhados. */
/** Relógio do registro (o resto da página usa o relógio real): permite simular a passagem das 72 h. */
let skew = 0;
function newTab(): OperationRegistry {
  const reg = createOperationRegistry({ storage: () => localStorage, locks: () => locks, now: () => Date.now() + skew });
  setOperationRegistryForTest(reg);
  return reg;
}

function session(org: string, membershipId: string) {
  csrfStore.setSession(org, 'ses');
  api.on('GET', `/api/v1/o/${org}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: org, organizationActivationState: 'ATIVADA' },
  });
  api.on('GET', `/api/v1/o/${org}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: {
      organizationId: org,
      membershipId,
      organization: { roles: ['ORG_ADMIN'], permissions: ['org.manage', 'workspace.lifecycle'] },
      allWorkspaces: { permissions: ['automation.read'] },
      hasWorkspaceAssignments: false,
    },
  });
  api.on('GET', `/api/v1/o/${org}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${org}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
}

const posts = (org = ORG) => api.sent('POST', `/api/v1/o/${org}/workspaces`).length;

async function openCreate() {
  fireEvent.click(await screen.findByRole('button', { name: 'Criar workspace' }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.change(within(dialog).getByLabelText(/^Nome/), { target: { value: 'Operações' } });
  return dialog;
}
const confirmButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Criar workspace' });

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  csrfStore.clear();
  sessionMemory.reset();
  vi.unstubAllGlobals();
  locks = fakeLocks();
  skew = 0;
  newTab();
  api = new RouteApi().install();
  session(ORG, ANA);
});

describe('resultado desconhecido persistente (FRONT-V1-002)', () => {
  it('1, 2 e 6: servidor aplica e a resposta se perde; sair e voltar mantém o bloqueio; nada é reenviado', async () => {
    let applied = 0;
    api.on('POST', `/api/v1/o/${ORG}/workspaces`, 'createWorkspace', () => {
      applied++; // o servidor criou; a resposta não chega
      return 'network';
    });
    const view = renderApp(`/o/${ORG}/workspaces`);
    const dialog = await openCreate();
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());
    fireEvent.click(confirmButton(dialog));
    expect(await within(dialog).findByText(/Não foi possível confirmar se o workspace foi criado/)).toBeInTheDocument();
    expect(confirmButton(dialog)).toBeDisabled();
    expect(applied).toBe(1);

    // sai da página e volta (mesma aba)
    view.unmount();
    renderApp(`/o/${ORG}/workspaces`);
    const again = await openCreate();
    expect(await within(again).findByText('Resultado não confirmado')).toBeInTheDocument();
    expect(within(again).getByText(/Não encontrar o resultado numa lista não comprova que nada foi feito/)).toBeInTheDocument();
    expect(confirmButton(again)).toBeDisabled();
    fireEvent.click(confirmButton(again));
    expect(posts()).toBe(1);
  });

  it('3: recarga — no meio do envio e depois da resposta perdida — continua desconhecido e sem reenvio', async () => {
    // envio que nunca termina; a aba é recarregada no meio
    api.on('POST', `/api/v1/o/${ORG}/workspaces`, 'createWorkspace', { hold: new Promise(() => {}) });
    const view = renderApp(`/o/${ORG}/workspaces`);
    const dialog = await openCreate();
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(posts()).toBe(1));
    view.unmount();
    locks.dropAll(); // a aba recarregada perde os locks; a memória do registro também (novo registro)
    newTab();
    renderApp(`/o/${ORG}/workspaces`);
    const after = await openCreate();
    expect(await within(after).findByText('Resultado não confirmado')).toBeInTheDocument();
    expect(confirmButton(after)).toBeDisabled();
    expect(posts()).toBe(1);
  });

  it('4: outra aba vê o envio em andamento e não consegue enviar; depois vê a incerteza', async () => {
    let release!: (r: { gateway: 502 }) => void;
    api.on('POST', `/api/v1/o/${ORG}/workspaces`, 'createWorkspace', { hold: new Promise((r) => (release = r)) });
    const tabA = newTab();
    const viewA = renderApp(`/o/${ORG}/workspaces`);
    const dialogA = await openCreate();
    await waitFor(() => expect(confirmButton(dialogA)).toBeEnabled());
    fireEvent.click(confirmButton(dialogA));
    await waitFor(() => expect(posts()).toBe(1));

    // aba B: outro registro, mesma origem
    const tabB = newTab();
    const key = await opKey({ subject: `m:${ANA}`, org: ORG, operation: 'workspace.create' });
    expect(await tabB.begin(key)).toMatchObject({ ok: false, reason: 'busy' });
    viewA.unmount(); // a aba A segue com o envio, sem tela
    const viewB = renderApp(`/o/${ORG}/workspaces`);
    const dialogB = await openCreate();
    expect(await within(dialogB).findByText('Envio em andamento')).toBeInTheDocument();
    expect(confirmButton(dialogB)).toBeDisabled();

    // a resposta da aba A é um 502 do PROXY, sem o corpo da API (antes este teste mandava um status fora do contrato, que
    // virava erro de rede por acaso): incerta, e a aba B passa a ver isso
    setOperationRegistryForTest(tabA);
    await act(async () => release({ gateway: 502 }));
    setOperationRegistryForTest(tabB);
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(await within(dialogB).findByText('Resultado não confirmado')).toBeInTheDocument();
    expect(confirmButton(dialogB)).toBeDisabled();
    expect(posts()).toBe(1);
    viewB.unmount();
  });

  it('5: outra pessoa ou outra organização no mesmo navegador não vê o registro anterior', async () => {
    api.on('POST', `/api/v1/o/${ORG}/workspaces`, 'createWorkspace', 'network');
    const view = renderApp(`/o/${ORG}/workspaces`);
    const dialog = await openCreate();
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());
    fireEvent.click(confirmButton(dialog));
    await within(dialog).findByText(/Não foi possível confirmar se o workspace foi criado/);
    view.unmount();

    // Bia, na mesma organização
    session(ORG, BIA);
    const bia = renderApp(`/o/${ORG}/workspaces`);
    const dialogBia = await openCreate();
    await waitFor(() => expect(confirmButton(dialogBia)).toBeEnabled());
    expect(within(dialogBia).queryByText('Resultado não confirmado')).toBeNull();
    bia.unmount();

    // Ana, em outra organização
    session(ORG2, ANA);
    renderApp(`/o/${ORG2}/workspaces`);
    const dialogOrg2 = await openCreate();
    await waitFor(() => expect(confirmButton(dialogOrg2)).toBeEnabled());
    expect(within(dialogOrg2).queryByText('Resultado não confirmado')).toBeNull();
    // nada identificável em claro no armazenamento
    const dump = JSON.stringify({ ...localStorage });
    for (const plain of [ORG, ANA, 'workspace', 'Operações']) expect(dump).not.toContain(plain);
    expect(posts()).toBe(1);
  });

  it('liberação explícita depois de conferir permite UMA nova tentativa; recusa não deixa incerteza', async () => {
    api.on('POST', `/api/v1/o/${ORG}/workspaces`, 'createWorkspace', (_c, n) =>
      n === 0 ? 'network' : { status: 201, body: { workspaceId: WS, name: 'Operações', description: null, status: 'ACTIVE', createdAt: '2026-10-30T10:00:00Z', updatedAt: '2026-10-30T10:00:00Z' } },
    );
    const view = renderApp(`/o/${ORG}/workspaces`);
    const dialog = await openCreate();
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());
    fireEvent.click(confirmButton(dialog));
    await within(dialog).findByText(/Não foi possível confirmar se o workspace foi criado/);
    view.unmount();
    renderApp(`/o/${ORG}/workspaces`);
    const again = await openCreate();
    fireEvent.click(await within(again).findByRole('button', { name: 'Já conferi o estado atual; liberar nova tentativa' }));
    await waitFor(() => expect(confirmButton(again)).toBeEnabled());
    expect(posts()).toBe(1); // liberar não envia nada
    fireEvent.click(confirmButton(again));
    await waitFor(() => expect(posts()).toBe(2));
  });

  it('FRONT-V1-003: 72 h depois, após recarga e em outra aba, a incerteza continua bloqueando; liberar explica que não confirma nada', async () => {
    api.on('POST', `/api/v1/o/${ORG}/workspaces`, 'createWorkspace', (_c, n) =>
      n === 0 ? 'network' : { status: 201, body: { workspaceId: WS, name: 'Operações', description: null, status: 'ACTIVE', createdAt: '2026-10-30T10:00:00Z', updatedAt: '2026-10-30T10:00:00Z' } },
    );
    const view = renderApp(`/o/${ORG}/workspaces`);
    const dialog = await openCreate();
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());
    fireEvent.click(confirmButton(dialog));
    await within(dialog).findByText(/Não foi possível confirmar se o workspace foi criado/);
    view.unmount();

    // 73 h depois, página recarregada (registro novo; a limpeza do carregamento roda)
    skew = UNKNOWN_REVIEW + 60 * 60_000;
    newTab().sweep();
    const reloaded = renderApp(`/o/${ORG}/workspaces`);
    const after = await openCreate();
    expect(await within(after).findByText('Resultado não confirmado')).toBeInTheDocument();
    expect(within(after).getByText(/mais de 72 horas e continua sem confirmação/)).toBeInTheDocument();
    expect(within(after).getByText(/Não confirma o resultado da tentativa anterior nem garante que não haverá duplicidade/)).toBeInTheDocument();
    expect(confirmButton(after)).toBeDisabled();
    fireEvent.click(confirmButton(after));
    reloaded.unmount();

    // outra aba, também 73 h depois
    const tabB = newTab();
    expect(await tabB.begin(await opKey({ subject: `m:${ANA}`, org: ORG, operation: 'workspace.create' }))).toMatchObject({ ok: false, reason: 'unknown' });
    renderApp(`/o/${ORG}/workspaces`);
    const inB = await openCreate();
    expect(await within(inB).findByText('Resultado não confirmado')).toBeInTheDocument();
    expect(confirmButton(inB)).toBeDisabled();
    expect(posts()).toBe(1);

    // só a decisão explícita libera, e libera UM envio
    fireEvent.click(within(inB).getByRole('button', { name: 'Já conferi o estado atual; liberar nova tentativa' }));
    await waitFor(() => expect(confirmButton(inB)).toBeEnabled());
    expect(posts()).toBe(1);
    fireEvent.click(confirmButton(inB));
    await waitFor(() => expect(posts()).toBe(2));
  });

  it('armazenamento indisponível: nada é enviado e a pessoa sabe por quê', async () => {
    setOperationRegistryForTest(
      createOperationRegistry({
        storage: () =>
          ({
            getItem: () => null,
            setItem: () => {
              throw new DOMException('quota', 'QuotaExceededError');
            },
            removeItem: () => {},
            key: () => null,
            length: 0,
            clear: () => {},
          }) as Storage,
        locks: () => locks,
        now: () => Date.now(),
      }),
    );
    api.on('POST', `/api/v1/o/${ORG}/workspaces`, 'createWorkspace', 'network');
    renderApp(`/o/${ORG}/workspaces`);
    const dialog = await openCreate();
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());
    fireEvent.click(confirmButton(dialog));
    expect(await within(dialog).findByText(/não permitiu registrar a operação antes do envio/)).toBeInTheDocument();
    expect(posts()).toBe(0);
  });
});
