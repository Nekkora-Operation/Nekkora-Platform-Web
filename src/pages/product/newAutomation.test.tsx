import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { location } from '../../test/helpers';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { resetNewAutomationMemoryForTest } from './NewAutomationPage';

/**
 * PLATFORM-V2-001, T04 — criar automação com a primeira versão e o ZIP. Rascunho só com nome; ZIP válido dos dois formatos
 * (metadados conferidos pela Platform; versão da Platform separada da declarada pelo projeto); ZIP inválido corrigido NO
 * MESMO rascunho; recusa de tamanho antes de qualquer gravação; falha de rede depois da criação e do envio, com
 * reconciliação antes de nova tentativa; duplo clique. Em todos: no máximo uma automação e uma versão, e nenhuma publicação
 * ou execução. Respostas por rota conferidas contra o contrato; o PUT do ZIP (XHR) por um dublê local.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const WS = '5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f';
const AUT = '7f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const VER = 'a2b3c4d5-e6f7-4081-92a3-b4c5d6e7f809';
const T = '2026-11-10T12:00:00Z';
const SHA_OF = new Map<string, string>();

let api: RouteApi;

// ------------------------------------------------------------------ dublê do XHR do envio
type XhrAnswer = { status: number; body?: unknown } | 'network';
let xhrHandler: (file: Blob) => XhrAnswer = () => 'network';
const puts: { url: string; file: Blob }[] = [];
class FakeXhr {
  status = 0;
  responseText = '';
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  withCredentials = false;
  private url = '';
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  getResponseHeader() {
    return null;
  }
  abort() {
    this.onabort?.();
  }
  send(file: Blob) {
    puts.push({ url: this.url, file });
    const a = xhrHandler(file);
    setTimeout(() => {
      this.upload.onprogress?.({ loaded: file.size, total: file.size, lengthComputable: true });
      if (a === 'network') return this.onerror?.();
      this.status = a.status;
      this.responseText = a.body === undefined ? '' : JSON.stringify(a.body);
      this.onload?.();
    }, 0);
  }
}

async function sha256(b: Blob) {
  const d = await crypto.subtle.digest('SHA-256', await b.arrayBuffer());
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function zip(name = 'pacote.zip', content = 'PK conteudo') {
  return new File([content], name, { type: 'application/zip' });
}

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
  puts.length = 0;
  SHA_OF.clear();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
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
const versionPosts = () => api.sent('POST', `/api/v1/o/${ORG}/automations/${AUT}/versions`);
const noPublishNoRun = () => {
  expect(api.sent('POST', /publish|run-requests|local-run-authorizations|executions/)).toEqual([]);
};

function created(answer: 'ok' | 'network' = 'ok') {
  api.on('POST', `/api/v1/o/${ORG}/workspaces/${WS}/automations`, 'createAutomation', () =>
    answer === 'ok' ? { status: 201, body: { automationId: AUT, workspaceId: WS, name: 'Relatório de pedidos', status: 'ACTIVE', createdAt: new Date().toISOString() } } : 'network',
  );
}
function versionCreated(answer: () => 'ok' | 'network' = () => 'ok') {
  api.on('POST', `/api/v1/o/${ORG}/automations/${AUT}/versions`, 'createAutomationVersion', () => (answer() === 'ok' ? { status: 201, body: version() } : 'network'));
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
const submit = () => screen.getByRole('button', { name: /Criar e enviar o pacote|Continuar|Salvar rascunho/ });

describe('criar automação com versão e ZIP (T04)', () => {
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
    noPublishNoRun();
  });

  it('ZIP válido (Studio): automação, versão 1 e pacote; mostra o que a Platform conferiu e segue para revisar', async () => {
    created();
    versionCreated();
    const f = zip('studio.zip');
    const sha = await sha256(f);
    xhrHandler = () => ({ status: 200, body: version({ sha }) });
    await open();
    await pick(f);
    fireEvent.click(submit());
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(screen.getByText('Versão 1 (rascunho)')).toBeInTheDocument();
    expect(screen.getByText('Formato Studio')).toBeInTheDocument();
    expect(automationPosts()).toHaveLength(1);
    expect(versionPosts()).toHaveLength(1);
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain(`/automation-versions/${VER}/artifact`);
    noPublishNoRun();
    fireEvent.click(screen.getByRole('button', { name: 'Revisar e publicar' }));
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/versoes/${VER}`));
  });

  it('ZIP válido (Python externo): a versão declarada pelo projeto aparece separada da versão da Platform', async () => {
    created();
    versionCreated();
    const f = zip('externo.zip', 'PK externo');
    xhrHandler = () => ({ status: 200, body: version({ sha: 'c'.repeat(64), external: true }) });
    await open();
    await pick(f);
    fireEvent.click(submit());
    expect(await screen.findByText('Python externo (sem framework Nekkora)')).toBeInTheDocument();
    expect(screen.getByText('Versão 1 (rascunho)')).toBeInTheDocument();
    expect(screen.getByText('relatorio-pedido 2.4.0')).toBeInTheDocument();
    expect(screen.getByText('Versão declarada pelo projeto')).toBeInTheDocument();
    noPublishNoRun();
  });

  it('ZIP inválido, depois o corrigido: o mesmo rascunho (uma automação, uma versão, dois envios à mesma versão)', async () => {
    created();
    versionCreated();
    let attempt = 0;
    const good = zip('corrigido.zip', 'PK corrigido');
    const goodSha = await sha256(good);
    xhrHandler = () => (++attempt === 1 ? { status: 422, body: { error: 'package_rejected', reason: 'manifesto_ausente' } } : { status: 200, body: version({ sha: goodSha }) });
    await open();
    await pick(zip('errado.zip', 'PK errado'));
    fireEvent.click(submit());
    expect(await screen.findByText(/O pacote foi recusado pela conferência da Platform/)).toBeInTheDocument();
    expect(screen.getByText(/a automação e a versão já criadas continuam as mesmas/)).toBeInTheDocument();
    expect(screen.getByText(/Rascunho em andamento: Relatório de pedidos/)).toBeInTheDocument();
    await pick(good);
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(automationPosts()).toHaveLength(1);
    expect(versionPosts()).toHaveLength(1);
    expect(puts.map((p) => p.url)).toEqual([expect.stringContaining(VER), expect.stringContaining(VER)]);
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

  it('rede cai ao criar a versão: confere antes de outra tentativa e retoma a versão já criada', async () => {
    created();
    let calls = 0;
    versionCreated(() => (++calls === 1 ? 'network' : 'ok'));
    api.on('GET', `/api/v1/o/${ORG}/automations/${AUT}/versions`, 'listAutomationVersions', {
      status: 200,
      body: { items: [{ automationVersionId: VER, versionNumber: 1, status: 'draft', publishedAt: null, createdAt: T }], nextCursor: null },
    });
    const f = zip('ok.zip');
    const sha = await sha256(f);
    xhrHandler = () => ({ status: 200, body: version({ sha }) });
    await open();
    await pick(f);
    fireEvent.click(submit());
    expect(await screen.findByText('A versão pode ter sido criada.', { exact: false })).toBeInTheDocument();
    expect(submit()).toBeDisabled(); // sem conferir, nada de nova tentativa
    fireEvent.click(screen.getByRole('button', { name: 'Conferir agora' }));
    expect(await screen.findByText(/Conferido: a versão 1 foi criada/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(automationPosts()).toHaveLength(1);
    expect(versionPosts()).toHaveLength(1); // a versão do servidor foi retomada, não recriada
    expect(puts).toHaveLength(1);
    noPublishNoRun();
  });

  it('rede cai ao criar a automação: a incerteza fica registrada; a conferência acha a automação e o fluxo continua', async () => {
    created('network');
    versionCreated();
    api.on('GET', `/api/v1/o/${ORG}/workspaces/${WS}/automations`, 'listAutomations', () => ({
      status: 200,
      body: {
        items: [{ automationId: AUT, workspaceId: WS, name: 'Relatório de pedidos', description: null, status: 'active', latestPublishedVersion: null, createdAt: new Date().toISOString(), updatedAt: T }],
        nextCursor: null,
      },
    }));
    const f = zip('ok.zip');
    const sha = await sha256(f);
    xhrHandler = () => ({ status: 200, body: version({ sha }) });
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
    expect(versionPosts()).toHaveLength(1);
    noPublishNoRun();
  });

  it('rede cai no envio do ZIP: a conferência acha o pacote (mesmo SHA-256) sem reenviar', async () => {
    created();
    versionCreated();
    const f = zip('ok.zip');
    const sha = await sha256(f);
    xhrHandler = () => 'network';
    api.on('GET', `/api/v1/o/${ORG}/automation-versions/${VER}`, 'getAutomationVersion', { status: 200, body: version({ sha }) });
    await open();
    await pick(f);
    fireEvent.click(submit());
    expect(await screen.findByText('Os bytes do pacote podem ter chegado.', { exact: false })).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Conferir agora' }));
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(puts).toHaveLength(1);
    noPublishNoRun();
  });

  it('duplo clique: uma automação, uma versão, um envio', async () => {
    created();
    versionCreated();
    const f = zip('ok.zip');
    const sha = await sha256(f);
    xhrHandler = () => ({ status: 200, body: version({ sha }) });
    await open();
    await pick(f);
    fireEvent.click(submit());
    fireEvent.click(submit());
    fireEvent.click(submit());
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(automationPosts()).toHaveLength(1);
    expect(versionPosts()).toHaveLength(1);
    expect(puts).toHaveLength(1);
  });
});
