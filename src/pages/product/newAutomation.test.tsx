import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { installFakeXhr, sha256, zip, type XhrAnswer, type XhrPut } from '../../test/fakeXhr';
import { location } from '../../test/helpers';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { resetNewAutomationMemoryForTest } from './NewAutomationPage';

/**
 * PLATFORM-V2-001, T04 — criar automação com a primeira versão e o ZIP. Com a T09 (PLATFORM-AGENT-V2-002), a versão só
 * passa a existir quando a Platform aceita o ZIP: a tela cria a automação e envia o pacote ao rascunho da automação (PUT
 * sem expectativa), sem nenhum POST de versão. Rascunho só com nome; ZIP válido dos dois formatos (metadados conferidos
 * pela Platform; versão da Platform separada da declarada pelo projeto); ZIP inválido: a automação fica sem versão e o
 * reenvio vai para a MESMA automação; recusa de tamanho antes de qualquer gravação; falha de rede na criação e no envio,
 * com reconciliação antes de nova tentativa; rascunho criado por outra aba; duplo clique. Em todos: no máximo uma
 * automação, nenhum POST de versão, nenhuma publicação ou execução. Respostas por rota e do PUT (XHR) conferidas contra o
 * contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const WS = '5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f';
const AUT = '7f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const VER = 'a2b3c4d5-e6f7-4081-92a3-b4c5d6e7f809';
const T = '2026-11-10T12:00:00Z';
const DRAFT_PUT = `/api/v1/o/${ORG}/automations/${AUT}/draft/artifact`;

let api: RouteApi;
let xhr: { handler: (put: XhrPut) => XhrAnswer; puts: XhrPut[] };

function version(opts: { sha?: string; external?: boolean } = {}) {
  const external = !!opts.external;
  return {
    automationVersionId: VER,
    automationId: AUT,
    workspaceId: WS,
    versionNumber: 1,
    status: 'DRAFT',
    runtime: 'python3.12',
    entrypoint: external ? 'relatorio/main.py' : 'main.py',
    arguments: [],
    artifactReference: opts.sha ? `nekkora-artifact:${VER}` : null,
    artifact: opts.sha
      ? {
          artifactId: VER,
          sha256: opts.sha,
          sizeBytes: 11,
          fingerprintRule: external ? 'nekkora-agent/external-python-fingerprint/1' : 'nekkora-agent/package-fingerprint/1',
          fingerprint: 'b'.repeat(64),
          filesCount: 3,
          manifestVersion: external ? '1.0.0' : '1.4',
          framework: external ? null : 'nekkora_rpa',
          executionMode: external ? null : 'list',
          declaredGenerator: null,
          provenance: 'DECLARED',
          receivedAt: T,
          ...(external
            ? { packageKind: 'EXTERNAL_PYTHON', packageName: 'relatorio-pedido', packageVersion: '2.4.0', pythonRequirement: '>=3.11', dependencies: [] }
            : { packageKind: 'STUDIO_PYTHON' }),
        }
      : null,
    agentPackage: opts.sha ? { fingerprintRule: 'nekkora-agent/package-fingerprint/1', fingerprint: 'b'.repeat(64) } : null,
    createdAt: T,
    publishedAt: null,
    publishedByMembershipId: null,
  };
}

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  csrfStore.clear();
  sessionMemory.reset();
  resetNewAutomationMemoryForTest();
  vi.unstubAllGlobals();
  localStorage.clear();
  xhr = installFakeXhr();
  const locks = fakeLocks();
  setOperationRegistryForTest(createOperationRegistry({ storage: () => localStorage, locks: () => locks, now: () => Date.now() }));
  api = new RouteApi().install();
  csrfStore.setSession(ORG, 'ses');
  api.on('GET', `/api/v1/o/${ORG}/me`, 'getMe', {
    status: 200,
    body: { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: ORG, organizationActivationState: 'ATIVADA', stepUpMethod: 'totp' },
  });
  api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', {
    status: 200,
    body: {
      organizationId: ORG,
      membershipId: VER,
      organization: { roles: ['ORG_ADMIN'], permissions: ['org.manage', 'workspace.lifecycle'] },
      allWorkspaces: { permissions: ['automation.read', 'automation.manage', 'automation.publish'] },
      hasWorkspaceAssignments: false,
    },
  });
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}`, 'getWorkspace', {
    status: 200,
    body: { workspaceId: WS, name: 'Financeiro', description: null, status: 'active', client: null, createdAt: T, updatedAt: T },
  });
  api.on('GET', `/api/v1/o/${ORG}/automations/${AUT}`, 'getAutomation', {
    status: 200,
    body: { automationId: AUT, workspaceId: WS, name: 'Relatório de pedidos', description: null, status: 'active', latestPublishedVersion: null, createdAt: T, updatedAt: T },
  });
});
afterEach(() => vi.unstubAllGlobals());

const automationPosts = () => api.sent('POST', `/api/v1/o/${ORG}/workspaces/${WS}/automations`);
/** A rota antiga de criação de versão não é usada: a versão nasce com o ZIP aceito. */
const versionPosts = () => api.sent('POST', /\/versions$/);
const noPublishNoRun = () => {
  expect(api.sent('POST', /publish|run-requests|local-run-authorizations|executions/)).toEqual([]);
};

function created(answer: 'ok' | 'network' = 'ok') {
  api.on('POST', `/api/v1/o/${ORG}/workspaces/${WS}/automations`, 'createAutomation', () =>
    answer === 'ok' ? { status: 201, body: { automationId: AUT, workspaceId: WS, name: 'Relatório de pedidos', status: 'ACTIVE', createdAt: new Date().toISOString() } } : 'network',
  );
}
/** O rascunho que a API tem agora (lista: só o resumo; a versão: o pacote). */
function serverDraft(sha: string | null | 'none') {
  api.on('GET', `/api/v1/o/${ORG}/automations/${AUT}/versions`, 'listAutomationVersions', {
    status: 200,
    body: { items: sha === 'none' ? [] : [{ automationVersionId: VER, versionNumber: 1, status: 'draft', publishedAt: null, createdAt: T }], nextCursor: null },
  });
  if (sha !== 'none') api.on('GET', `/api/v1/o/${ORG}/automation-versions/${VER}`, 'getAutomationVersion', { status: 200, body: version({ sha: sha ?? undefined }) });
}

async function open() {
  renderApp(`/o/${ORG}/workspaces/${WS}/nova-automacao`);
  await screen.findByRole('heading', { name: 'Nova automação' });
  fireEvent.change(screen.getByLabelText(/^Nome da automação/), { target: { value: 'Relatório de pedidos' } });
}
async function pick(file: File) {
  fireEvent.change(screen.getByLabelText('Arquivo .zip do pacote'), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText(new RegExp(file.name.replace('.', '\\.')))).toBeInTheDocument());
}
const submit = () => screen.getByRole('button', { name: /Criar e enviar o pacote|Continuar$|Salvar rascunho/ });

describe('criar automação com versão e ZIP (T04 + T09)', () => {
  it('permissões do workspace não conferidas (429): avisa e deixa tentar de novo, sem "sem permissão" e sem gravar; a nova tentativa abre o formulário', async () => {
    let fail = true;
    api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', () =>
      fail ? { status: 429, body: { error: 'rate_limited' } } : { status: 200, body: { items: [], nextCursor: null } },
    );
    renderApp(`/o/${ORG}/workspaces/${WS}/nova-automacao`);
    const alert = (await screen.findByText('Não foi possível verificar suas permissões neste workspace agora.')).closest('.nk-alert') as HTMLElement;
    expect(screen.queryByText(/Você não tem permissão/)).toBeNull();
    expect(screen.queryByLabelText(/^Nome da automação/)).toBeNull();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByLabelText(/^Nome da automação/)).toBeInTheDocument();
    expect(automationPosts()).toEqual([]);
  });

  it('só o nome: salva o rascunho e abre a automação; nenhuma versão', async () => {
    created();
    await open();
    fireEvent.click(screen.getByRole('radio', { name: /Só o nome, como rascunho/ }));
    expect(screen.queryByLabelText('Arquivo .zip do pacote')).toBeNull();
    await waitFor(() => expect(submit()).toBeEnabled());
    fireEvent.click(submit());
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/automacoes/${AUT}`));
    expect(automationPosts()).toHaveLength(1);
    expect(automationPosts()[0].body).toEqual({ name: 'Relatório de pedidos' });
    expect(versionPosts()).toEqual([]);
    expect(xhr.puts).toEqual([]);
    noPublishNoRun();
  });

  it('ZIP válido (Studio): automação e, com o ZIP aceito, a versão 1; mostra o que a Platform conferiu e segue para revisar', async () => {
    created();
    const f = zip('studio.zip');
    const sha = await sha256(f);
    xhr.handler = () => ({ status: 201, body: version({ sha }) });
    await open();
    await pick(f);
    fireEvent.click(submit());
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(screen.getByText('Versão 1 (rascunho)')).toBeInTheDocument();
    expect(screen.getByText('Formato Studio')).toBeInTheDocument();
    expect(automationPosts()).toHaveLength(1);
    expect(versionPosts()).toEqual([]);
    expect(xhr.puts).toHaveLength(1);
    // sem expectativa de rascunho: o envio aceito cria a versão
    expect(xhr.puts[0].url).toBe(DRAFT_PUT);
    noPublishNoRun();
    fireEvent.click(screen.getByRole('button', { name: 'Revisar e publicar' }));
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/versoes/${VER}`));
  });

  it('ZIP válido (Python externo): a versão declarada pelo projeto aparece separada da versão da Platform', async () => {
    created();
    const f = zip('externo.zip', 'PK externo');
    xhr.handler = () => ({ status: 201, body: version({ sha: 'c'.repeat(64), external: true }) });
    await open();
    await pick(f);
    fireEvent.click(submit());
    expect(await screen.findByText('Python externo (sem framework Nekkora)')).toBeInTheDocument();
    expect(screen.getByText('Versão 1 (rascunho)')).toBeInTheDocument();
    expect(screen.getByText('relatorio-pedido 2.4.0')).toBeInTheDocument();
    expect(screen.getByText('Versão declarada pelo projeto')).toBeInTheDocument();
    noPublishNoRun();
  });

  it('ZIP inválido: a automação fica sem versão; o corrigido vai para a MESMA automação e cria a versão 1', async () => {
    created();
    let attempt = 0;
    const good = zip('corrigido.zip', 'PK corrigido');
    const goodSha = await sha256(good);
    xhr.handler = () => (++attempt === 1 ? { status: 422, body: { error: 'package_rejected', reason: 'manifesto_ausente' } } : { status: 201, body: version({ sha: goodSha }) });
    await open();
    await pick(zip('errado.zip', 'PK errado'));
    fireEvent.click(submit());
    expect(await screen.findByText(/O pacote foi recusado pela conferência da Platform: falta o manifest.json do Studio/)).toBeInTheDocument();
    expect(screen.getByText(/A automação foi criada, mas nenhuma versão/)).toBeInTheDocument();
    expect(screen.queryByText(/a automação e a versão já criadas continuam as mesmas/)).toBeNull();
    expect(screen.getByText(/Rascunho em andamento: Relatório de pedidos/)).toBeInTheDocument();
    expect(screen.getByText(/A automação já foi criada, ainda sem versão/)).toBeInTheDocument();
    // o nome continua (fixo) e nenhuma versão foi pedida
    expect(screen.getByLabelText(/^Nome da automação/)).toHaveValue('Relatório de pedidos');
    expect(versionPosts()).toEqual([]);
    await pick(good);
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(automationPosts()).toHaveLength(1);
    expect(versionPosts()).toEqual([]);
    expect(xhr.puts.map((p) => p.url)).toEqual([DRAFT_PUT, DRAFT_PUT]);
    noPublishNoRun();
  });

  it('arquivo acima de 50 MiB: recusado antes de qualquer gravação', async () => {
    created();
    await open();
    const big = zip('grande.zip');
    Object.defineProperty(big, 'size', { value: 50 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText('Arquivo .zip do pacote'), { target: { files: [big] } });
    expect(await screen.findByText(/o limite é 50 MiB\. Nada foi criado\./)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    expect(automationPosts()).toEqual([]);
  });

  it('rede cai no envio e o pacote não chegou: a conferência não acha rascunho e libera reenviar à mesma automação', async () => {
    created();
    serverDraft('none');
    const f = zip('ok.zip');
    const sha = await sha256(f);
    let attempt = 0;
    xhr.handler = () => (++attempt === 1 ? 'network' : { status: 201, body: version({ sha }) });
    await open();
    await pick(f);
    fireEvent.click(submit());
    expect(await screen.findByText('Os bytes do pacote podem ter chegado e criado a versão.', { exact: false })).toBeInTheDocument();
    expect(submit()).toBeDisabled(); // sem conferir, nada de nova tentativa
    fireEvent.click(screen.getByRole('button', { name: 'Conferir agora' }));
    expect(await screen.findByText(/Conferido: o pacote não chegou e nenhuma versão foi criada/)).toBeInTheDocument();
    expect(xhr.puts).toHaveLength(1); // nada reenviado sozinho
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(automationPosts()).toHaveLength(1);
    expect(versionPosts()).toEqual([]);
    expect(xhr.puts.map((p) => p.url)).toEqual([DRAFT_PUT, DRAFT_PUT]);
    noPublishNoRun();
  });

  it('rede cai ao criar a automação: a incerteza fica registrada; a conferência acha a automação e o fluxo continua', async () => {
    created('network');
    api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/automations`, 'listAutomations', () => ({
      status: 200,
      body: {
        items: [{ automationId: AUT, workspaceId: WS, name: 'Relatório de pedidos', description: null, status: 'active', latestPublishedVersion: null, createdAt: new Date().toISOString(), updatedAt: T }],
        nextCursor: null,
      },
    }));
    const f = zip('ok.zip');
    const sha = await sha256(f);
    xhr.handler = () => ({ status: 201, body: version({ sha }) });
    await open();
    await pick(f);
    fireEvent.click(submit());
    expect(await screen.findByText('A automação pode ter sido criada.', { exact: false })).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Conferir agora' }));
    expect(await screen.findByText(/Conferido: a automação foi criada/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(automationPosts()).toHaveLength(1);
    expect(versionPosts()).toEqual([]);
    expect(xhr.puts.map((p) => p.url)).toEqual([DRAFT_PUT]);
    noPublishNoRun();
  });

  it('rede cai no envio do ZIP: a conferência acha o rascunho com o mesmo SHA-256, sem reenviar', async () => {
    created();
    const f = zip('ok.zip');
    const sha = await sha256(f);
    xhr.handler = () => 'network';
    serverDraft(sha);
    await open();
    await pick(f);
    fireEvent.click(submit());
    expect(await screen.findByText('Os bytes do pacote podem ter chegado', { exact: false })).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Conferir agora' }));
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(xhr.puts).toHaveLength(1);
    noPublishNoRun();
  });

  it('outra aba criou o rascunho desta automação: 409 draft_changed, nada sobrescrito; a tela leva ao rascunho existente', async () => {
    created();
    serverDraft('d'.repeat(64));
    xhr.handler = () => ({ status: 409, body: { error: 'conflict', reason: 'draft_changed' } });
    await open();
    await pick(zip('meu.zip', 'PK meu'));
    fireEvent.click(submit());
    expect(await screen.findByText('A automação já tem um rascunho: a versão 1.')).toBeInTheDocument();
    expect(screen.getByText(/Ele não tem o pacote deste arquivo/)).toBeInTheDocument();
    expect(screen.getByText('dddddddddddd…')).toBeInTheDocument();
    expect(screen.getByText(/Nada foi sobrescrito/)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar rascunho' }));
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/versoes/${VER}`));
    expect(xhr.puts).toHaveLength(1);
    expect(versionPosts()).toEqual([]);
  });

  it('duplo clique: uma automação, um envio, nenhum POST de versão', async () => {
    created();
    const f = zip('ok.zip');
    const sha = await sha256(f);
    xhr.handler = () => ({ status: 201, body: version({ sha }) });
    await open();
    await pick(f);
    fireEvent.click(submit());
    fireEvent.click(submit());
    fireEvent.click(submit());
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(automationPosts()).toHaveLength(1);
    expect(versionPosts()).toEqual([]);
    expect(xhr.puts).toHaveLength(1);
  });
});
