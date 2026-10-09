import { useState } from 'react';
import { Button, Card, Grid, Select, Stack, StateView, Table, type TableColumn } from 'nekkora-lib';
import { listClientGrants, listClients } from '../../api/admin';
import type { ClientGrant, GrantStatus } from '../../api/v1';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { useCursorList } from '../../hooks/useCursorList';
import { useResource } from '../../hooks/useResource';
import { DateTimeText, errorOf, LoadErrorState, PageHeader, RouteLink, useExpiresOn } from '../product/shared';
import {
  ADMIN_PAGE,
  AdminLoadMore,
  ForbiddenState,
  GRANT_STATUS_LABEL,
  GRANT_STATUS_ORDER,
  GrantStatusBadge,
  useAccessDenied,
  StatusFilter,
  useUrlFilters,
} from './shared';
import './admin.css';

/** Valor explícito de "todos" (o Select da lib pinta o vazio como placeholder). */
const ALL = 'todos';
/** Clientes carregados para o filtro (máximo do contrato numa página). */
const CLIENT_OPTIONS_LIMIT = 100;

/**
 * Concessões de acesso externo (M02, `external_access.manage`), só leitura, da mais recente para a mais antiga.
 * Filtros na URL: estado (vários), cliente e workspace. Cliente ou workspace inexistente ou de outra organização dá
 * lista vazia (exceção documentada DC-05), não erro. A revogação entra na F6a-2 em diante.
 */
export function GrantsPage() {
  const { org } = useSession();
  const { workspaces } = useInternalArea();
  const filters = useUrlFilters<GrantStatus>({ statuses: GRANT_STATUS_ORDER, ids: ['cliente', 'workspace'] });
  const clientId = filters.ids.cliente;
  const workspaceId = filters.ids.workspace;
  const [refresh, setRefresh] = useState(0);
  const list = useCursorList<ClientGrant>(
    (cursor) =>
      listClientGrants(org, {
        limit: ADMIN_PAGE,
        cursor,
        status: filters.statuses.length ? [...filters.statuses] : undefined,
        clientId: clientId ?? undefined,
        workspaceId: workspaceId ?? undefined,
      }),
    (g) => g.grantId,
    [org, filters.key, refresh],
  );
  const clients = useResource(() => listClients(org, { limit: CLIENT_OPTIONS_LIMIT }), [org]);
  useExpiresOn(list.error, errorOf(clients));
  const forbidden = useAccessDenied(list);
  const anyFilter = filters.statuses.length > 0 || !!clientId || !!workspaceId;

  const clientItems = clients.status === 'ready' ? clients.data.items : [];
  const clientOptions = [
    { value: ALL, label: 'Todos os clientes' },
    ...clientItems.map((c) => ({ value: c.clientId, label: c.name })),
    // cliente vindo do endereço e fora da parte carregada
    ...(clientId && !clientItems.some((c) => c.clientId === clientId) ? [{ value: clientId, label: `Cliente ${clientId.slice(0, 8)}` }] : []),
  ];
  const wsOptions = [
    { value: ALL, label: 'Todos os workspaces' },
    ...workspaces.items.map((w) => ({ value: w.workspaceId, label: w.name })),
    ...(workspaceId && !workspaces.items.some((w) => w.workspaceId === workspaceId) ? [{ value: workspaceId, label: `Workspace ${workspaceId.slice(0, 8)}` }] : []),
  ];

  const columns: TableColumn<ClientGrant>[] = [
    {
      key: 'conta',
      header: 'Conta externa',
      render: (g) => (
        <span className="pw-admin__person">
          <span>{g.externalAccount.displayName}</span>
          <span className="pw-prod__muted">{g.externalAccount.email}</span>
        </span>
      ),
    },
    { key: 'cliente', header: 'Cliente', render: (g) => g.client.name },
    { key: 'workspace', header: 'Workspace', render: (g) => <RouteLink to={orgPath.workspace(org, g.workspace.workspaceId)}>{g.workspace.name}</RouteLink> },
    {
      key: 'estado',
      header: 'Estado',
      render: (g) => (
        <span className="pw-admin__person">
          <GrantStatusBadge status={g.status} />
          {g.revokedAt && (
            <span className="pw-prod__muted">
              em <DateTimeText iso={g.revokedAt} />
            </span>
          )}
        </span>
      ),
    },
    { key: 'inicio', header: 'Início', render: (g) => <DateTimeText iso={g.startsAt} /> },
    { key: 'expira', header: 'Expira em', render: (g) => <DateTimeText iso={g.expiresAt} empty={<span>Sem expiração</span>} /> },
    { key: 'revisao', header: 'Próxima revisão', render: (g) => <DateTimeText iso={g.nextReviewAt} /> },
    { key: 'acesso', header: 'Último acesso', render: (g) => <DateTimeText iso={g.lastAccessAt} empty={<span>Nunca acessou</span>} /> },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Concessões"
        subtitle="Acessos de contas externas aos workspaces dos clientes. Somente consulta."
        onRefresh={forbidden ? undefined : () => setRefresh((n) => n + 1)}
        refreshing={list.status === 'loading' && refresh > 0}
      />
      {forbidden ? (
        <ForbiddenState area="as concessões desta organização" onRetry={list.reload} />
      ) : (
        <>
          <Card variant="surface" padding="md">
            <form className="pw-admin__filters" aria-label="Filtros de concessões" onSubmit={(e) => e.preventDefault()}>
              <Grid columns={2} minColumnWidth="220px" gap={4}>
                <Select
                  label="Cliente"
                  value={clientId ?? ALL}
                  onChange={(e) => filters.setId('cliente', e.target.value === ALL ? null : e.target.value)}
                  disabled={clients.status === 'loading'}
                  hint={
                    clients.status === 'loading'
                      ? 'Carregando clientes…'
                      : clients.status === 'error'
                        ? 'Não foi possível carregar a lista de clientes.'
                        : clients.data.nextCursor
                          ? `Mostrando os ${CLIENT_OPTIONS_LIMIT} primeiros clientes.`
                          : undefined
                  }
                  options={clientOptions}
                  fullWidth
                />
                <Select
                  label="Workspace"
                  value={workspaceId ?? ALL}
                  onChange={(e) => filters.setId('workspace', e.target.value === ALL ? null : e.target.value)}
                  disabled={workspaces.status === 'loading'}
                  hint={
                    workspaces.status === 'loading'
                      ? 'Carregando workspaces…'
                      : workspaces.status === 'error'
                        ? 'Não foi possível carregar a lista de workspaces.'
                        : workspaces.status === 'ready' && !workspaces.complete
                          ? 'Mostrando a parte já carregada dos workspaces.'
                          : undefined
                  }
                  options={wsOptions}
                  fullWidth
                />
              </Grid>
              <StatusFilter legend="Estado" order={GRANT_STATUS_ORDER} labels={GRANT_STATUS_LABEL} selected={filters.statuses} onToggle={filters.toggleStatus} />
            </form>
          </Card>
          {list.status === 'loading' ? (
            <StateView status="loading" title="Carregando concessões…" />
          ) : list.status === 'error' ? (
            <LoadErrorState error={list.error} onRetry={list.reload} />
          ) : list.items.length === 0 ? (
            <StateView
              status="neutral"
              title={anyFilter ? 'Nenhuma concessão com esses filtros.' : 'Nenhuma concessão registrada.'}
              actions={anyFilter ? <Button variant="secondary" size="sm" onClick={filters.clear}>Limpar filtros</Button> : undefined}
            />
          ) : (
            <>
              <div className="pw-prod__scroll" role="region" aria-label="Lista de concessões" tabIndex={0}>
                <Table columns={columns} data={list.items} rowKey="grantId" size="sm" caption="Concessões, da mais recente para a mais antiga." />
              </div>
              <AdminLoadMore list={list} one="concessão" many="concessões" />
            </>
          )}
        </>
      )}
    </Stack>
  );
}
