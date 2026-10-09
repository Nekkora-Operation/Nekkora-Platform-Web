import { useState } from 'react';
import { Button, Card, Stack, StateView, Table, type TableColumn } from 'nekkora-lib';
import { listClients } from '../../api/admin';
import type { Client, ResourceStatus } from '../../api/v1';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { useCursorList } from '../../hooks/useCursorList';
import { DateTimeText, LoadErrorState, PageHeader, RESOURCE_STATUS_LABEL, ResourceStatusBadge, RouteLink, useExpiresOn } from '../product/shared';
import { ADMIN_PAGE, AdminLoadMore, ForbiddenState, useAccessDenied, StatusFilter, useUrlFilters } from './shared';

const CLIENT_STATUS_ORDER: ResourceStatus[] = ['active', 'suspended', 'archived'];

/**
 * Clientes da organização (M03, `org.manage` OU `external_access.manage`), só leitura, em ordem alfabética do contrato
 * (48 primeiros pontos de código + id). Filtro de estado na URL; paginação por cursor sem total. O atalho para as
 * concessões do cliente aparece só para quem tem `external_access.manage` pela P01 (a API decide de qualquer forma).
 */
export function ClientsPage() {
  const { org } = useSession();
  const { permissions } = useInternalArea();
  const filters = useUrlFilters<ResourceStatus>({ statuses: CLIENT_STATUS_ORDER });
  const [refresh, setRefresh] = useState(0);
  const list = useCursorList<Client>(
    (cursor) => listClients(org, { limit: ADMIN_PAGE, cursor, status: filters.statuses.length ? [...filters.statuses] : undefined }),
    (c) => c.clientId,
    [org, filters.key, refresh],
  );
  useExpiresOn(list.error);
  const forbidden = useAccessDenied(list);
  const seesGrants = permissions.status === 'ready' && permissions.data.organization.permissions.includes('external_access.manage');

  const columns: TableColumn<Client>[] = [
    { key: 'nome', header: 'Cliente', render: (c) => c.name },
    { key: 'estado', header: 'Estado', render: (c) => <ResourceStatusBadge status={c.status} /> },
    { key: 'criado', header: 'Criado em', render: (c) => <DateTimeText iso={c.createdAt} /> },
    { key: 'atualizado', header: 'Atualizado em', render: (c) => <DateTimeText iso={c.updatedAt} /> },
    ...(seesGrants
      ? [
          {
            key: 'concessoes',
            header: 'Concessões',
            render: (c: Client) => (
              <RouteLink to={`${orgPath.grants(org)}?cliente=${encodeURIComponent(c.clientId)}`} aria-label={`Ver concessões de ${c.name}`}>
                Ver concessões
              </RouteLink>
            ),
          },
        ]
      : []),
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Clientes"
        subtitle="Clientes atendidos pela organização. Somente consulta."
        onRefresh={forbidden ? undefined : () => setRefresh((n) => n + 1)}
        refreshing={list.status === 'loading' && refresh > 0}
      />
      {forbidden ? (
        <ForbiddenState area="os clientes desta organização" onRetry={list.reload} />
      ) : (
        <>
          <Card variant="surface" padding="md">
            <form aria-label="Filtros de clientes" onSubmit={(e) => e.preventDefault()}>
              <StatusFilter legend="Estado" order={CLIENT_STATUS_ORDER} labels={RESOURCE_STATUS_LABEL} selected={filters.statuses} onToggle={filters.toggleStatus} />
            </form>
          </Card>
          {list.status === 'loading' ? (
            <StateView status="loading" title="Carregando clientes…" />
          ) : list.status === 'error' ? (
            <LoadErrorState error={list.error} onRetry={list.reload} />
          ) : list.items.length === 0 ? (
            <StateView
              status="neutral"
              title={filters.statuses.length ? 'Nenhum cliente com esses estados.' : 'Nenhum cliente cadastrado.'}
              actions={filters.statuses.length ? <Button variant="secondary" size="sm" onClick={filters.clear}>Limpar filtros</Button> : undefined}
            />
          ) : (
            <>
              <div className="pw-prod__scroll" role="region" aria-label="Lista de clientes" tabIndex={0}>
                <Table columns={columns} data={list.items} rowKey="clientId" size="sm" caption="Clientes em ordem alfabética." />
              </div>
              <AdminLoadMore list={list} one="cliente" many="clientes" />
            </>
          )}
        </>
      )}
    </Stack>
  );
}
