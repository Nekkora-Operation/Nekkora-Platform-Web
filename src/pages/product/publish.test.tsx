import axe from 'axe-core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { sessionMemory } from '../../app/notices';
import { fakeLocks } from '../../test/fakeLocks';
import { user } from '../../test/helpers';
import { renderApp } from '../../test/render';
import { RouteApi } from '../../test/routeApi';
import { compareTechnical } from './PublishSummary';

/**
 * PLATFORM-V2-001, T05 — publicar com uma confirmação compreensível. Padrão: automação, versão, arquivo validado e a
 * consequência; nenhum hash a digitar nem caixa de "conferi". Identificação técnica oculta por padrão, acessível por
 * teclado, com SHA-256 (o ZIP) e impressão (o conteúdo reconhecido pelo Agent); comparação opcional que, divergente, impede
 * prosseguir. A publicação leva o par fixado ao abrir; a troca do pacote é recusada pela API (409), mesmo com a confirmação
 * de identidade aceita. Cancelar não envia nada. Respostas por rota conferidas contra o contrato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const VERSION = '22222222-3333-4444-8555-666666666666';
const AUT = '7f8091a2-3b4c-4d5e-8f60-718293a4b5c6';
const WS = '5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f';
const SHA = 'a'.repeat(64);
const FP = 'b'.repeat(64);
const T = '2026-11-10T10:00:00Z';

let api: RouteApi;

function version(opts: { status?: 'DRAFT' | 'PUBLISHED'; external?: boolean; sha?: string } = {}) {
  const external = opts.external ?? false;
  return {
    automationVersionId: VERSION,
    automationId: AUT,
    workspaceId: WS,
    versionNumber: 3,
    status: opts.status ?? 'DRAFT',
    runtime: 'python3.12',
    entrypoint: 'main.py',
    arguments: [],
    artifactReference: null,
    artifact: {
      artifactId: VERSION,
      sha256: opts.sha ?? SHA,
      sizeBytes: 2048,
      fingerprintRule: external ? 'nekkora-agent/external-python-fingerprint/1' : 'nekkora-agent/package-fingerprint/1',
      fingerprint: FP,
      filesCount: 10,
      manifestVersion: external ? '1.0.0' : '1.4',
      framework: external ? null : 'nekkora_rpa',
      executionMode: external ? null : 'list',
      declaredGenerator: null,
      provenance: 'DECLARED',
      receivedAt: T,
      ...(external
        ? { packageKind: 'EXTERNAL_PYTHON', packageName: 'relatorio-pedido', packageVersion: '1.0.0', pythonRequirement: '>=3.11', dependencies: [] }
        : { packageKind: 'STUDIO_PYTHON' }),
    },
    agentPackage: { fingerprintRule: 'nekkora-agent/package-fingerprint/1', fingerprint: FP },
    createdAt: T,
    publishedAt: opts.status === 'PUBLISHED' ? T : null,
    publishedByMembershipId: opts.status === 'PUBLISHED' ? VERSION : null,
  };
}

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  csrfStore.clear();
  sessionMemory.reset();
  vi.unstubAllGlobals();
  localStorage.clear();
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
      membershipId: VERSION,
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
  api.on('GET', new RegExp(`/api/v1/o/${ORG}/workspaces/${WS}/local-run-authorizations`), 'listLocalRunAuthorizations', { status: 200, body: { items: [], nextCursor: null } });
});

const publishes = () => api.sent('POST', `/api/v1/o/${ORG}/automation-versions/${VERSION}/publish`);
const stepUps = () => api.sent('POST', `/api/v1/o/${ORG}/auth/mfa/step-up`);

/**
 * Confirma a publicação nos dois comportamentos do diálogo: o código antes do ato (como hoje) ou, com a T01, só quando a
 * API responder step_up_required. A rota de publicação dos testes pede a confirmação enquanto não houver step-up.
 */
async function confirmPublish(dialog: HTMLElement) {
  const confirm = within(dialog).getByRole('button', { name: 'Publicar' });
  const fill = () => fireEvent.change(within(dialog).getByLabelText(/Código do seu aplicativo autenticador/), { target: { value: '123456' } });
  if (within(dialog).queryByLabelText(/Código do seu aplicativo autenticador/)) fill();
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  await waitFor(() => expect(publishes().length + stepUps().length).toBeGreaterThan(0));
  if (stepUps().length === 0) {
    // T01: o ato foi primeiro e a API pediu a confirmação; nada publicado ainda
    await within(dialog).findByLabelText(/Código do seu aplicativo autenticador/);
    fill();
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
  }
}
const stepUpDone = () => stepUps().length > 0;
const needsStepUp = { status: 403, body: { error: 'forbidden', reason: 'step_up_required' } } as const;

async function openDialog() {
  renderApp(`/o/${ORG}/versoes/${VERSION}`);
  fireEvent.click(await screen.findByRole('button', { name: 'Publicar versão' }));
  return screen.findByRole('alertdialog', { name: 'Publicar a versão 3 de Relatório de pedidos?' });
}

describe('publicação compreensível (T05)', () => {
  it('padrão: automação, versão, arquivo e consequência; sem hash a digitar; publica com o par conferido e não executa', async () => {
    let current = version();
    api.on('GET', `/api/v1/o/${ORG}/automation-versions/${VERSION}`, 'getAutomationVersion', () => ({ status: 200, body: current }));
    api.on('POST', `/api/v1/o/${ORG}/auth/mfa/step-up`, 'mfaStepUp', { status: 204 });
    api.on('POST', `/api/v1/o/${ORG}/automation-versions/${VERSION}/publish`, 'publishAutomationVersion', () => {
      if (!stepUpDone()) return needsStepUp;
      current = version({ status: 'PUBLISHED' });
      return { status: 200, body: current };
    });
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent('Relatório de pedidos');
    expect(dialog).toHaveTextContent('Versão 3');
    expect(dialog).toHaveTextContent('Formato Studio · 2.0 KiB · 10 arquivos');
    expect(dialog).toHaveTextContent('Depois de publicada, esta versão não poderá ser alterada.');
    expect(dialog).toHaveTextContent('Publicar não executa a automação nem autoriza a execução.');
    // nada técnico por padrão, nada a digitar além do código
    expect(within(dialog).queryByText(SHA)).toBeNull();
    expect(within(dialog).queryByText(FP)).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByLabelText(/Comparar com um valor/)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Conferir identificação técnica' })).toHaveAttribute('aria-expanded', 'false');

    await confirmPublish(dialog);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText('Versão publicada: não muda mais.')).toBeInTheDocument();
    expect(stepUps()).toHaveLength(1);
    // uma publicação aceita; com a T01, antes dela uma recusa step_up_required sem efeito
    expect(publishes().length).toBeLessThanOrEqual(2);
    for (const p of publishes()) expect(p.body).toEqual({ expectedArtifactSha256: SHA, expectedPackageFingerprint: FP });
    // publicar não é executar: nenhum outro ato enviado
    expect(api.sent('POST', /run-requests|local-run-authorizations|executions/)).toEqual([]);
    expect(await screen.findByText('Publicada (imutável)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publicar versão' })).toBeNull();
  });

  it('identificação técnica: oculta por padrão, abre pelo teclado; comparação divergente impede prosseguir', async () => {
    api.on('GET', `/api/v1/o/${ORG}/automation-versions/${VERSION}`, 'getAutomationVersion', { status: 200, body: version() });
    const dialog = await openDialog();
    const toggle = within(dialog).getByRole('button', { name: 'Conferir identificação técnica' });
    toggle.focus();
    await user().keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(panel).not.toHaveAttribute('hidden');
    expect(within(panel).getByText(SHA)).toBeInTheDocument();
    expect(within(panel).getByText(FP)).toBeInTheDocument();
    expect(panel).toHaveTextContent('O SHA-256 identifica o arquivo ZIP');
    expect(panel).toHaveTextContent('A impressão identifica o conteúdo reconhecido pelo Agent');
    const a11y = await axe.run(dialog, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(a11y.violations.map((v) => v.id)).toEqual([]);

    const code = within(dialog).queryByLabelText(/Código do seu aplicativo autenticador/);
    if (code) fireEvent.change(code, { target: { value: '123456' } });
    const confirm = within(dialog).getByRole('button', { name: 'Publicar' });
    await waitFor(() => expect(confirm).toBeEnabled());
    const compare = within(panel).getByLabelText(/Comparar com um valor/);
    fireEvent.change(compare, { target: { value: 'c'.repeat(64) } });
    expect(within(panel).getByText(/Não confere com o SHA-256 nem com a impressão/)).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    fireEvent.change(compare, { target: { value: 'nao-e-hash' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(compare, { target: { value: ` ${SHA.toUpperCase()} ` } });
    expect(within(panel).getByText('Confere com o SHA-256 do arquivo ZIP.')).toBeInTheDocument();
    expect(confirm).toBeEnabled();
    fireEvent.change(compare, { target: { value: FP } });
    expect(within(panel).getByText('Confere com a impressão do conteúdo.')).toBeInTheDocument();
    expect(confirm).toBeEnabled();

    // fechar de novo pelo teclado (Espaço)
    toggle.focus();
    await user().keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveAttribute('hidden');
    expect(publishes()).toEqual([]);
  });

  it('pacote trocado entre a revisão e a publicação: a API recusa (409) mesmo com a identidade confirmada; nada publicado', async () => {
    let current = version();
    api.on('GET', `/api/v1/o/${ORG}/automation-versions/${VERSION}`, 'getAutomationVersion', () => ({ status: 200, body: current }));
    api.on('POST', `/api/v1/o/${ORG}/auth/mfa/step-up`, 'mfaStepUp', { status: 204 });
    api.on('POST', `/api/v1/o/${ORG}/automation-versions/${VERSION}/publish`, 'publishAutomationVersion', () =>
      stepUpDone() ? { status: 409, body: { error: 'conflict' } } : needsStepUp,
    );
    const dialog = await openDialog();
    current = version({ sha: 'd'.repeat(64) }); // outra aba trocou o pacote
    await confirmPublish(dialog);
    expect(await within(dialog).findByText(/o pacote mudou depois da sua conferência/)).toBeInTheDocument();
    expect(stepUps()).toHaveLength(1); // a identidade foi confirmada, e mesmo assim a API recusou a troca
    for (const p of publishes()) expect(p.body).toEqual({ expectedArtifactSha256: SHA, expectedPackageFingerprint: FP }); // o par conferido, não o novo
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText('d'.repeat(64))).toBeInTheDocument(); // a versão foi relida
    expect(screen.getByText('Rascunho')).toBeInTheDocument();
  });

  it('cancelar não envia nada e mantém o rascunho', async () => {
    api.on('GET', `/api/v1/o/${ORG}/automation-versions/${VERSION}`, 'getAutomationVersion', { status: 200, body: version() });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(stepUps()).toEqual([]);
    expect(publishes()).toEqual([]);
    expect(screen.getByText('Rascunho')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publicar versão' })).toBeEnabled();
  });

  it('Python externo: mostra a versão declarada pelo projeto separada da versão da Platform', async () => {
    api.on('GET', `/api/v1/o/${ORG}/automation-versions/${VERSION}`, 'getAutomationVersion', { status: 200, body: version({ external: true }) });
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent('Versão na PlatformVersão 3');
    expect(dialog).toHaveTextContent('Declarado pelo projetorelatorio-pedido 1.0.0');
    expect(dialog).toHaveTextContent('Python externo (sem framework Nekkora)');
  });
});

describe('compareTechnical', () => {
  it('sem valor, SHA-256, impressão, divergente e malformado', () => {
    const r = { sha256: SHA, fingerprint: FP };
    expect(compareTechnical('', r)).toEqual({ status: 'empty' });
    expect(compareTechnical(`  ${SHA.slice(0, 32)} ${SHA.slice(32)}\n`, r)).toEqual({ status: 'sha256' });
    expect(compareTechnical(FP.toUpperCase(), r)).toEqual({ status: 'fingerprint' });
    expect(compareTechnical('e'.repeat(64), r)).toEqual({ status: 'mismatch' });
    expect(compareTechnical('xyz', r)).toEqual({ status: 'malformed' });
  });
});
