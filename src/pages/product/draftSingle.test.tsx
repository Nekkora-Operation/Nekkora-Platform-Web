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

/**
 * PLATFORM-AGENT-V2-002, T09 — um único rascunho por automação, que nasce com o primeiro ZIP aceito. "Nova versão" só abre
 * o formulário (nenhuma escrita ao abrir ou sair); o rascunho nasce no 201 do PUT do rascunho da automação; ZIP recusado
 * não cria nada; com rascunho, a automação oferece "Continuar rascunho" (o mesmo id); a página da versão envia com a
 * expectativa (este rascunho e o SHA-256 atual) e nunca sobrescreve em silêncio (409 draft_changed); resposta perdida é
 * reconciliada pelo SHA-256; publicar devolve "Nova versão". Um servidor em memória responde por rota (conferido contra o
 * contrato) e pelo dublê do XHR.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const WS = '5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f';
const AUT = '7f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const V1 = '11111111-2222-4333-8444-555555555555';
const V2 = '22222222-3333-4444-8555-666666666666';
const T = '2026-11-10T12:00:00Z';
const DRAFT_PUT = `/api/v1/o/${ORG}/automations/${AUT}/draft/artifact`;
const OLD_SHA = 'e'.repeat(64);

type Row = { id: string; n: number; status: 'DRAFT' | 'PUBLISHED'; sha: string | null; runtime: string; args: string[] };

let api: RouteApi;
let xhr: { handler: (put: XhrPut) => XhrAnswer; puts: XhrPut[] };
/** Servidor em memória: as versões da automação. */
let rows: Row[];

function lifecycle(r: Row) {
  return {
    automationVersionId: r.id,
    automationId: AUT,
    workspaceId: WS,
    versionNumber: r.n,
    status: r.status,
    runtime: r.runtime,
    entrypoint: 'main.py',
    arguments: r.args,
    artifactReference: r.sha ? `nekkora-artifact:${r.id}` : null,
    artifact: r.sha
      ? {
          artifactId: r.id,
          sha256: r.sha,
          sizeBytes: 11,
          fingerprintRule: 'nekkora-agent/package-fingerprint/1',
          fingerprint: 'b'.repeat(64),
          filesCount: 7,
          manifestVersion: '1.4',
          framework: 'nekkora_rpa',
          executionMode: 'list',
          declaredGenerator: null,
          provenance: 'DECLARED',
          receivedAt: T,
          packageKind: 'STUDIO_PYTHON',
        }
      : null,
    agentPackage: r.sha ? { fingerprintRule: 'nekkora-agent/package-fingerprint/1', fingerprint: 'b'.repeat(64) } : null,
    createdAt: T,
    publishedAt: r.status === 'PUBLISHED' ? T : null,
    publishedByMembershipId: r.status === 'PUBLISHED' ? V1 : null,
  };
}
const draftRow = () => rows.find((r) => r.status === 'DRAFT');

/**
 * O PUT do rascunho como a API (T09): recusa do pacote sem efeito; sem rascunho e sem expectativa cria (201); com a
 * expectativa certa substitui na MESMA versão (200); expectativa vencida: 409 draft_changed, salvo mesmos bytes (200).
 */
function serverPut(reject?: (put: XhrPut) => boolean) {
  return async (put: XhrPut): Promise<{ status: number; body?: unknown }> => {
    if (reject?.(put)) return { status: 422, body: { error: 'package_rejected', reason: 'zip_malformado' } };
    const sha = await sha256(put.file);
    const draft = draftRow();
    const expectedId = put.query.get('expectedDraftVersionId');
    const expectedSha = put.query.get('expectedSha256');
    if (draft && draft.sha === sha) return { status: 200, body: lifecycle(draft) };
    if (!draft && !expectedId) {
      const row: Row = { id: V2, n: Math.max(0, ...rows.map((r) => r.n)) + 1, status: 'DRAFT', sha, runtime: put.query.get('runtime') ?? 'python3.12', args: put.query.getAll('argument') };
      rows.push(row);
      return { status: 201, body: lifecycle(row) };
    }
    if (draft && expectedId === draft.id && (expectedSha ?? null) === draft.sha) {
      draft.sha = sha;
      return { status: 200, body: lifecycle(draft) };
    }
    return { status: 409, body: { error: 'conflict', reason: 'draft_changed' } };
  };
}
const answer = (fn: (put: XhrPut) => Promise<{ status: number; body?: unknown }>) => (put: XhrPut): XhrAnswer => ({ hold: fn(put) });

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  csrfStore.clear();
  sessionMemory.reset();
  vi.unstubAllGlobals();
  localStorage.clear();
  xhr = installFakeXhr();
  xhr.handler = answer(serverPut());
  rows = [{ id: V1, n: 1, status: 'PUBLISHED', sha: 'a'.repeat(64), runtime: 'python3.12', args: [] }];
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
      membershipId: V1,
      organization: { roles: ['ORG_ADMIN'], permissions: ['org.manage', 'workspace.lifecycle'] },
      allWorkspaces: { permissions: ['automation.read', 'automation.manage', 'automation.publish'] },
      hasWorkspaceAssignments: false,
    },
  });
  api.on('GET', `/api/v1/o/${ORG}/workspaces`, 'listWorkspaces', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', `/api/v1/o/${ORG}/automations/${AUT}`, 'getAutomation', {
    status: 200,
    body: { automationId: AUT, workspaceId: WS, name: 'Relatório de pedidos', description: null, status: 'active', latestPublishedVersion: null, createdAt: T, updatedAt: T },
  });
  api.on('GET', `/api/v1/o/${ORG}/automations/${AUT}/versions`, 'listAutomationVersions', () => ({
    status: 200,
    body: {
      items: [...rows]
        .sort((a, b) => b.n - a.n)
        .map((r) => ({ automationVersionId: r.id, versionNumber: r.n, status: r.status === 'DRAFT' ? 'draft' : 'published', publishedAt: r.status === 'PUBLISHED' ? T : null, createdAt: T })),
      nextCursor: null,
    },
  }));
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/automation-versions/[0-9a-f-]+$`), 'getAutomationVersion', (call) => {
    const row = rows.find((r) => call.path.endsWith(r.id));
    return row ? { status: 200, body: lifecycle(row) } : { status: 404, body: { error: 'not_found' } };
  });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workspaces/${WS}/local-run-authorizations`), 'listLocalRunAuthorizations', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/agents`), 'listAgents', { status: 200, body: { items: [], nextCursor: null } });
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workers`), 'listWorkers', { status: 200, body: { items: [], nextCursor: null } });
});
afterEach(() => vi.unstubAllGlobals());

/** Escritas na API por rota (fetch); o PUT do pacote vai pelo XHR (`xhr.puts`). */
const writes = () => api.calls.filter((c) => c.method !== 'GET');
const versionPosts = () => api.sent('POST', /\/versions$/);

async function openAutomation() {
  renderApp(`/o/${ORG}/automacoes/${AUT}`);
  await screen.findByRole('heading', { name: 'Relatório de pedidos' });
  await screen.findByRole('region', { name: 'Versões da automação' });
}
async function pick(label: string, file: File) {
  fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText(new RegExp(file.name.replace('.', '\\.')))).toBeInTheDocument());
}
const NEW_ZIP = 'Arquivo .zip do pacote';
const PERMS_UNVERIFIED = 'Não foi possível verificar suas permissões neste workspace agora.';
/** "Tentar novamente" do aviso de permissões não conferidas (há outros botões com o mesmo nome em outras seções). */
const retryPermissions = () => within(screen.getByText(PERMS_UNVERIFIED).closest('.nk-alert') as HTMLElement).getByRole('button', { name: 'Tentar novamente' });
const sendNew = () => screen.getByRole('button', { name: 'Enviar o pacote e criar o rascunho' });

describe('um único rascunho por automação (T09)', () => {
  it('"Nova versão" aberta e fechada 10 vezes não grava nada; o primeiro ZIP aceito cria a versão 2 e leva ao rascunho', async () => {
    await openAutomation();
    for (let i = 0; i < 10; i++) {
      fireEvent.click(await screen.findByRole('button', { name: 'Nova versão' }));
      await screen.findByRole('heading', { name: 'Nova versão' });
      expect(location()).toBe(`/o/${ORG}/automacoes/${AUT}/nova-versao`);
      fireEvent.click(await screen.findByRole('link', { name: 'Voltar para Relatório de pedidos' }));
      await screen.findByRole('region', { name: 'Versões da automação' });
    }
    expect(writes()).toEqual([]);
    expect(xhr.puts).toEqual([]);
    expect(rows).toHaveLength(1);

    fireEvent.click(await screen.findByRole('button', { name: 'Nova versão' }));
    await screen.findByRole('heading', { name: 'Nova versão' });
    fireEvent.change(screen.getByLabelText(/^Ambiente de execução/), { target: { value: 'python3.11' } });
    fireEvent.change(screen.getByLabelText(/^Argumentos/), { target: { value: '--lote\n7' } });
    await pick(NEW_ZIP, zip('v2.zip', 'PK v2'));
    expect(xhr.puts).toEqual([]); // escolher o arquivo não envia
    fireEvent.click(sendNew());
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/versoes/${V2}`));
    expect(await screen.findByText('Rascunho criado com o pacote conferido pela Platform.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /versão 2/ })).toBeInTheDocument();
    expect(xhr.puts).toHaveLength(1);
    expect(xhr.puts[0].path).toBe(DRAFT_PUT);
    expect(xhr.puts[0].query.get('expectedDraftVersionId')).toBeNull();
    expect(xhr.puts[0].query.get('runtime')).toBe('python3.11');
    expect(xhr.puts[0].query.getAll('argument')).toEqual(['--lote', '7']);
    expect(rows.map((r) => [r.n, r.status])).toEqual([
      [1, 'PUBLISHED'],
      [2, 'DRAFT'],
    ]);
    expect(writes()).toEqual([]);
    expect(versionPosts()).toEqual([]);
  });

  it('ZIP inválido: nada criado, sem navegação, campos mantidos e o motivo à vista; o corrigido cria o rascunho', async () => {
    xhr.handler = answer(serverPut((p) => p.file.size < 8));
    renderApp(`/o/${ORG}/automacoes/${AUT}/nova-versao`);
    await screen.findByRole('heading', { name: 'Nova versão' });
    fireEvent.change(screen.getByLabelText(/^Ambiente de execução/), { target: { value: 'python3.11' } });
    fireEvent.change(screen.getByLabelText(/^Argumentos/), { target: { value: '--lote' } });
    await pick(NEW_ZIP, zip('ruim.zip', 'PK'));
    fireEvent.click(sendNew());
    expect(await screen.findByText(/O pacote foi recusado pela conferência da Platform: o arquivo não é um ZIP válido/)).toBeInTheDocument();
    expect(screen.getByText(/Nenhuma versão foi criada/)).toBeInTheDocument();
    expect(location()).toBe(`/o/${ORG}/automacoes/${AUT}/nova-versao`);
    expect(screen.getByLabelText(/^Ambiente de execução/)).toHaveValue('python3.11');
    expect(screen.getByLabelText(/^Argumentos/)).toHaveValue('--lote');
    expect(rows).toHaveLength(1);
    await pick(NEW_ZIP, zip('bom.zip', 'PK bom e valido'));
    fireEvent.click(sendNew());
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/versoes/${V2}`));
    expect(rows.filter((r) => r.status === 'DRAFT')).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  it('permissões da organização não conferidas (429): Nova versão diz que não conferiu, sem "sem permissão", sem envio; Tentar novamente recupera', async () => {
    let fail = true; // até a pessoa pedir nova tentativa (o modo estrito pede duas vezes)
    api.on('GET', `/api/v1/o/${ORG}/me/permissions`, 'getMyPermissions', () =>
      fail
        ? { status: 429, body: { error: 'rate_limited' } }
        : {
            status: 200,
            body: {
              organizationId: ORG,
              membershipId: V1,
              organization: { roles: ['ORG_ADMIN'], permissions: ['org.manage', 'workspace.lifecycle'] },
              allWorkspaces: { permissions: ['automation.read', 'automation.manage', 'automation.publish'] },
              hasWorkspaceAssignments: false,
            },
          },
    );
    renderApp(`/o/${ORG}/automacoes/${AUT}/nova-versao`);
    const alert = await screen.findByText('Não foi possível verificar suas permissões neste workspace agora.');
    expect(screen.queryByText(/Você não tem permissão/)).toBeNull();
    expect(screen.queryByLabelText(NEW_ZIP)).toBeNull();
    expect(writes()).toEqual([]);
    expect(xhr.puts).toEqual([]);
    const box = alert.closest('.nk-alert') as HTMLElement;
    fail = false;
    fireEvent.click(within(box).getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByLabelText(NEW_ZIP)).toBeInTheDocument();
    expect(screen.queryByText('Não foi possível verificar suas permissões neste workspace agora.')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('permissões do workspace com falha de rede: a automação não esconde Nova versão em silêncio; Tentar novamente recupera', async () => {
    let fail = true;
    api.on('GET', new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`), 'listMyWorkspacePermissions', () =>
      fail ? 'network' : { status: 200, body: { items: [], nextCursor: null } },
    );
    await openAutomation();
    const alert = await screen.findByText('Não foi possível verificar suas permissões neste workspace agora.');
    expect(alert.closest('[role="alert"], [role="status"], .nk-alert')).toHaveTextContent(/Nova versão, Continuar rascunho e a execução local só aparecem depois dessa verificação/);
    expect(screen.queryByRole('button', { name: 'Nova versão' })).toBeNull();
    expect(screen.queryByText(/Você não tem permissão/)).toBeNull();
    fail = false;
    fireEvent.click(retryPermissions());
    expect(await screen.findByRole('button', { name: 'Nova versão' })).toBeInTheDocument();
    expect(screen.queryByText('Não foi possível verificar suas permissões neste workspace agora.')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('429 seguido de 429 na nova tentativa: o aviso continua, nada é enviado, e a terceira tentativa recupera', async () => {
    let fail = true;
    const route = new RegExp(`/api/v1/o/${ORG}/me/permissions/workspaces`);
    api.on('GET', route, 'listMyWorkspacePermissions', () => (fail ? { status: 429, body: { error: 'rate_limited' } } : { status: 200, body: { items: [], nextCursor: null } }));
    await openAutomation();
    await screen.findByText('Não foi possível verificar suas permissões neste workspace agora.');
    const before = api.sent('GET', route).length;
    fireEvent.click(retryPermissions());
    await waitFor(() => expect(api.sent('GET', route).length).toBeGreaterThan(before));
    expect(await screen.findByText('Não foi possível verificar suas permissões neste workspace agora.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nova versão' })).toBeNull();
    fail = false;
    fireEvent.click(retryPermissions());
    expect(await screen.findByRole('button', { name: 'Nova versão' })).toBeInTheDocument();
    expect(writes()).toEqual([]);
  });

  it('comando inválido: recusado na tela, sem envio', async () => {
    renderApp(`/o/${ORG}/automacoes/${AUT}/nova-versao`);
    await screen.findByRole('heading', { name: 'Nova versão' });
    fireEvent.change(screen.getByLabelText(/^Ambiente de execução/), { target: { value: 'python2' } });
    await pick(NEW_ZIP, zip());
    fireEvent.click(sendNew());
    expect(await screen.findByText('Use o formato python3.N (por exemplo, python3.12).')).toBeInTheDocument();
    expect(xhr.puts).toEqual([]);
  });

  it('com rascunho, a automação oferece "Continuar rascunho" (o mesmo id) em vez de "Nova versão"; o formulário também leva a ele', async () => {
    rows.push({ id: V2, n: 2, status: 'DRAFT', sha: OLD_SHA, runtime: 'python3.12', args: [] });
    await openAutomation();
    expect(screen.queryByRole('button', { name: 'Nova versão' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Continuar rascunho' }));
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/versoes/${V2}`));
    await screen.findByRole('heading', { name: /versão 2/ });
    // voltar e reabrir: o mesmo rascunho
    fireEvent.click(await screen.findByRole('link', { name: 'Voltar para Relatório de pedidos' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continuar rascunho' }));
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/versoes/${V2}`));
    expect(writes()).toEqual([]);
    expect(xhr.puts).toEqual([]);
  });

  it('com rascunho, um link antigo para "Nova versão" não oferece o envio: leva ao rascunho existente', async () => {
    rows.push({ id: V2, n: 2, status: 'DRAFT', sha: OLD_SHA, runtime: 'python3.12', args: [] });
    renderApp(`/o/${ORG}/automacoes/${AUT}/nova-versao`);
    expect(await screen.findByText('Esta automação já tem um rascunho: a versão 2.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar o pacote e criar o rascunho' })).toBeNull();
    expect(writes()).toEqual([]);
    expect(xhr.puts).toEqual([]);
  });

  it('substituir com ZIP válido: a MESMA versão, com a expectativa (rascunho e SHA-256 atual) na query', async () => {
    rows.push({ id: V2, n: 2, status: 'DRAFT', sha: OLD_SHA, runtime: 'python3.12', args: [] });
    renderApp(`/o/${ORG}/versoes/${V2}`);
    await screen.findByText('Substituir o pacote');
    const f = zip('novo.zip', 'PK novo');
    const sha = await sha256(f);
    await pick(NEW_ZIP, f);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pacote' }));
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(xhr.puts).toHaveLength(1);
    expect(xhr.puts[0].url).toBe(`${DRAFT_PUT}?expectedDraftVersionId=${V2}&expectedSha256=${OLD_SHA}`);
    expect(rows.find((r) => r.id === V2)!.sha).toBe(sha);
    expect(rows).toHaveLength(2);
    expect(versionPosts()).toEqual([]);
  });

  it('rascunho ainda sem pacote: a expectativa vai sem SHA-256', async () => {
    rows.push({ id: V2, n: 2, status: 'DRAFT', sha: null, runtime: 'python3.12', args: [] });
    renderApp(`/o/${ORG}/versoes/${V2}`);
    await screen.findByText('Enviar o pacote');
    await pick(NEW_ZIP, zip('primeiro.zip', 'PK primeiro'));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pacote' }));
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(xhr.puts[0].url).toBe(`${DRAFT_PUT}?expectedDraftVersionId=${V2}`);
  });

  it('substituir com ZIP inválido: o pacote anterior continua valendo', async () => {
    rows.push({ id: V2, n: 2, status: 'DRAFT', sha: OLD_SHA, runtime: 'python3.12', args: [] });
    xhr.handler = answer(serverPut(() => true));
    renderApp(`/o/${ORG}/versoes/${V2}`);
    await screen.findByText('Substituir o pacote');
    await pick(NEW_ZIP, zip('ruim.zip'));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pacote' }));
    expect(await screen.findByText(/O pacote foi recusado pela conferência da Platform: o arquivo não é um ZIP válido\. O pacote anterior continua valendo no rascunho/)).toBeInTheDocument();
    expect(rows.find((r) => r.id === V2)!.sha).toBe(OLD_SHA);
    expect(screen.getAllByText(OLD_SHA).length).toBeGreaterThan(0);
  });

  it('duas abas: a outra trocou o pacote; 409 draft_changed mostra qual pacote ficou, nada sobrescrito; reenviar usa a expectativa nova', async () => {
    rows.push({ id: V2, n: 2, status: 'DRAFT', sha: OLD_SHA, runtime: 'python3.12', args: [] });
    renderApp(`/o/${ORG}/versoes/${V2}`);
    await screen.findByText('Substituir o pacote');
    // a outra aba envia depois que esta leu a versão
    const otherSha = 'f'.repeat(64);
    rows.find((r) => r.id === V2)!.sha = otherSha;
    const mine = zip('meu.zip', 'PK meu');
    const mineSha = await sha256(mine);
    await pick(NEW_ZIP, mine);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pacote' }));
    const alert = await screen.findByText('O rascunho mudou desde que você abriu esta página. Nada foi sobrescrito.');
    const box = alert.closest('[role="alert"], [role="status"], .nk-alert') as HTMLElement;
    expect(within(box).getByText('ffffffffffff…')).toBeInTheDocument();
    expect(box).toHaveTextContent('7 arquivos');
    expect(rows.find((r) => r.id === V2)!.sha).toBe(otherSha);
    expect(xhr.puts[0].query.get('expectedSha256')).toBe(OLD_SHA);
    // a pessoa decide enviar de novo: agora com o pacote que ficou como expectativa
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar pacote' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pacote' }));
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    expect(xhr.puts).toHaveLength(2);
    expect(xhr.puts[1].query.get('expectedSha256')).toBe(otherSha);
    expect(rows.find((r) => r.id === V2)!.sha).toBe(mineSha);
  });

  it('resposta perdida na página da versão: conferência pelo SHA-256 (chegou: aceito; não chegou: reenviar só pela pessoa)', async () => {
    rows.push({ id: V2, n: 2, status: 'DRAFT', sha: OLD_SHA, runtime: 'python3.12', args: [] });
    // primeiro envio: a API grava, mas a resposta se perde
    let n = 0;
    const real = serverPut();
    xhr.handler = (put) => ({ hold: real(put).then((r) => (++n === 1 ? ('network' as const) : r)) });
    renderApp(`/o/${ORG}/versoes/${V2}`);
    await screen.findByText('Substituir o pacote');
    await pick(NEW_ZIP, zip('perdido.zip', 'PK perdido'));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pacote' }));
    expect(await screen.findByText('O envio foi interrompido ou ficou sem resposta.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar pacote' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Conferir a versão' }));
    expect(await screen.findByText('Conferido: a Platform tem o pacote com o mesmo SHA-256 do arquivo escolhido.')).toBeInTheDocument();
    expect(xhr.puts).toHaveLength(1);

    // segundo: a resposta se perde e os bytes NÃO chegaram
    xhr.handler = () => 'network';
    await pick(NEW_ZIP, zip('outro.zip', 'PK outro'));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pacote' }));
    expect(await screen.findByText('O envio foi interrompido ou ficou sem resposta.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Conferir a versão' }));
    expect(await screen.findByText(/Conferido: o pacote deste arquivo não chegou; o rascunho continua com o pacote mostrado acima/)).toBeInTheDocument();
    expect(xhr.puts).toHaveLength(2); // nada reenviado sozinho
    xhr.handler = answer(serverPut());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar pacote' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pacote' }));
    expect(await screen.findByText('Pacote recebido e conferido pela Platform.')).toBeInTheDocument();
    // a expectativa do reenvio é o pacote que a conferência achou
    expect(xhr.puts[2].query.get('expectedSha256')).toBe(await sha256(zip('perdido.zip', 'PK perdido')));
  });

  it('resposta perdida em "Nova versão": mesmo SHA-256 leva ao rascunho; outro pacote, mostra o rascunho existente sem reenviar', async () => {
    let n = 0;
    const real = serverPut();
    xhr.handler = (put) => ({ hold: real(put).then((r) => (++n === 1 ? ('network' as const) : r)) });
    renderApp(`/o/${ORG}/automacoes/${AUT}/nova-versao`);
    await screen.findByRole('heading', { name: 'Nova versão' });
    await pick(NEW_ZIP, zip('v2.zip', 'PK v2'));
    fireEvent.click(sendNew());
    expect(await screen.findByText('Não foi possível confirmar o resultado.')).toBeInTheDocument();
    expect(sendNew()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Conferir agora' }));
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/versoes/${V2}`));
    expect(xhr.puts).toHaveLength(1);
  });

  it('resposta perdida em "Nova versão" e o rascunho é de outra aba: leva a ele, nada sobrescrito', async () => {
    xhr.handler = () => 'network';
    renderApp(`/o/${ORG}/automacoes/${AUT}/nova-versao`);
    await screen.findByRole('heading', { name: 'Nova versão' });
    await pick(NEW_ZIP, zip('v2.zip', 'PK v2'));
    rows.push({ id: V2, n: 2, status: 'DRAFT', sha: OLD_SHA, runtime: 'python3.12', args: [] });
    fireEvent.click(sendNew());
    fireEvent.click(await screen.findByRole('button', { name: 'Conferir agora' }));
    expect(await screen.findByText('Esta automação já tem um rascunho: a versão 2.')).toBeInTheDocument();
    expect(screen.getByText(/outra aba ou pessoa criou este rascunho/)).toBeInTheDocument();
    expect(screen.getByText('eeeeeeeeeeee…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar rascunho' }));
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/versoes/${V2}`));
    expect(xhr.puts).toHaveLength(1);
  });

  it('duplo clique em "Nova versão": um envio, um rascunho', async () => {
    renderApp(`/o/${ORG}/automacoes/${AUT}/nova-versao`);
    await screen.findByRole('heading', { name: 'Nova versão' });
    await pick(NEW_ZIP, zip('v2.zip', 'PK v2'));
    fireEvent.click(sendNew());
    fireEvent.click(sendNew());
    fireEvent.click(sendNew());
    await waitFor(() => expect(location()).toBe(`/o/${ORG}/versoes/${V2}`));
    expect(xhr.puts).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it('publicar o rascunho: a versão fica imutável, nada executa; a automação volta a oferecer "Nova versão"', async () => {
    rows.push({ id: V2, n: 2, status: 'DRAFT', sha: OLD_SHA, runtime: 'python3.12', args: [] });
    const stepUps = () => api.sent('POST', `/api/v1/o/${ORG}/auth/mfa/step-up`);
    api.on('POST', `/api/v1/o/${ORG}/auth/mfa/step-up`, 'mfaStepUp', { status: 204 });
    api.on('POST', `/api/v1/o/${ORG}/automation-versions/${V2}/publish`, 'publishAutomationVersion', () => {
      if (stepUps().length === 0) return { status: 403, body: { error: 'forbidden', reason: 'step_up_required' } };
      const row = rows.find((r) => r.id === V2)!;
      row.status = 'PUBLISHED';
      return { status: 200, body: lifecycle(row) };
    });
    renderApp(`/o/${ORG}/versoes/${V2}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Publicar versão' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Publicar' });
    const fill = () => fireEvent.change(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/), { target: { value: '123456' } });
    if (within(dialog).queryByLabelText(/Código do seu aplicativo autenticador/)) fill();
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    if (stepUps().length === 0) {
      await within(dialog).findByLabelText(/Código do seu aplicativo autenticador/);
      fill();
      await waitFor(() => expect(confirm).toBeEnabled());
      fireEvent.click(confirm);
    }
    expect(await screen.findByText('Versão publicada: não muda mais.')).toBeInTheDocument();
    expect(screen.queryByText('Substituir o pacote')).toBeNull();
    expect(api.sent('POST', /run-requests|local-run-authorizations|executions/)).toEqual([]);
    fireEvent.click(await screen.findByRole('link', { name: 'Voltar para Relatório de pedidos' }));
    expect(await screen.findByRole('button', { name: 'Nova versão' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continuar rascunho' })).toBeNull();
    expect(xhr.puts).toEqual([]);
  });
});
