/**
 * Respostas mínimas CONFORMES ao contrato da API v1, para testes do cliente (que agora valida as respostas).
 * Dados sintéticos; os ids são UUIDs válidos sem significado.
 */
export const IDS = {
  org: '3f2a1c9e-5b7d-4e21-9c61-2e4d8f7a91c0',
  membership: '0b6f6a10-8c0e-4a8e-9f2e-1d2c3b4a5f60',
  workspace: 'e9b0c7a2-1111-4a22-8b33-0c44d55e66f7',
  automation: '5d8c2b1a-2222-4b33-9c44-1d55e66f7788',
  version: '7a6b5c4d-3333-4c44-8d55-2e66f7788990',
  execution: '9c8b7a6d-4444-4d55-9e66-3f778899aabb',
};

export const workspace = {
  workspaceId: IDS.workspace,
  name: 'Financeiro',
  description: null,
  status: 'active',
  client: null,
  createdAt: '2026-09-01T12:00:00Z',
  updatedAt: '2026-09-02T12:00:00Z',
};

export const automation = {
  automationId: IDS.automation,
  workspaceId: IDS.workspace,
  name: 'Conciliação',
  description: 'Rotina diária',
  status: 'active',
  latestPublishedVersion: { automationVersionId: IDS.version, versionNumber: 3, publishedAt: '2026-09-10T08:00:00Z' },
  createdAt: '2026-08-01T12:00:00Z',
  updatedAt: '2026-09-10T08:00:00Z',
};

export const execution = {
  executionId: IDS.execution,
  workspaceId: IDS.workspace,
  automation: { automationId: IDS.automation, name: 'Conciliação' },
  automationVersion: { automationVersionId: IDS.version, versionNumber: 3 },
  origin: 'scheduled',
  status: 'succeeded',
  statusReason: 'process_completed',
  createdAt: '2026-10-01T06:00:00Z',
  startedAt: '2026-10-01T06:00:05Z',
  finishedAt: '2026-10-01T06:01:05Z',
  durationMs: 60000,
  cancelRequestedAt: null,
};

export const executionDetail = { ...execution, retryOfExecutionId: null, requestedBy: null };

export const myPermissions = {
  organizationId: IDS.org,
  membershipId: IDS.membership,
  organization: { roles: [], permissions: [] },
  allWorkspaces: { permissions: [] },
  hasWorkspaceAssignments: false,
};

export const portalWorkspace = { workspaceId: IDS.workspace, name: 'Financeiro' };
export const portalEvent = { type: 'process_started', receivedAt: '2026-10-01T06:00:05Z' };
export const portalExecution = {
  executionId: IDS.execution,
  automation: { id: IDS.automation, name: 'Conciliação' },
  createdAt: '2026-10-01T06:00:00Z',
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  status: 'pending',
  statusReason: null,
};

export const emptyPage = { items: [], nextCursor: null };
