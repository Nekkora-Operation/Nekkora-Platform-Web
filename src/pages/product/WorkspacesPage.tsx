import { useState } from 'react';
import { LoadMore, Stack, StateView, Table, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { listWorkspaces } from '../../api/product';
import type { Workspace } from '../../api/v1';
import { orgPath } from '../../auth/organization';
import { useSession } from '../../area/session';
import { useCursorList } from '../../hooks/useCursorList';
import { RouteLink, DateTimeText, errorText, LoadErrorState, PageHeader, ResourceStatusBadge, useBackState, useExpiresOn } from './shared';

const PAGE = 25;

/**
 * Workspaces visíveis (L01: `automation.read` efetivo; arquivados e suspensos incluídos), paginados por cursor na
 * ordem do contrato (48 primeiros pontos de código do nome + id). Sem total: "carregar mais" até o fim.
 */
export function WorkspacesPage() {
  const { org } = useSession();
  const backState = useBackState();
  const [refresh, setRefresh] = useState(0);
  const list = useCursorList<Workspace>((cursor) => listWorkspaces(org, { limit: PAGE, cursor }), (w) => w.workspaceId, [org, refresh]);

  useExpiresOn(list.error);

  const columns: TableColumn<Workspace>[] = [
    {
      key: 'nome',
      header: 'Workspace',
      render: (w) => (
        <RouteLink to={orgPath.workspace(org, w.workspaceId)} state={backState}>
          {w.name}
        </RouteLink>
      ),
    },
    { key: 'estado', header: 'Estado', render: (w) => <ResourceStatusBadge status={w.status} /> },
    { key: 'cliente', header: 'Cliente', render: (w) => w.client?.name ?? <span className="pw-prod__muted">Sem cliente</span> },
    { key: 'atualizado', header: 'Atualizado em', render: (w) => <DateTimeText iso={w.updatedAt} /> },
  ];

  return (
    <Stack gap={5}>
      <PageHeader title="Workspaces" subtitle="Os workspaces que você pode consultar nesta organização." onRefresh={() => setRefresh((n) => n + 1)} refreshing={list.status === 'loading' && refresh > 0} />
      {list.status === 'loading' ? (
        <StateView status="loading" title="Carregando workspaces…" />
      ) : list.status === 'error' ? (
        <LoadErrorState error={list.error} onRetry={list.reload} />
      ) : list.items.length === 0 ? (
        <StateView status="neutral" title="Você ainda não tem acesso a nenhum workspace." description="Quando um administrador der acesso, eles aparecem aqui." />
      ) : (
        <>
          <div className="pw-prod__scroll" role="region" aria-label="Lista de workspaces" tabIndex={0}>
            <Table columns={columns} data={list.items} rowKey="workspaceId" size="sm" caption="Workspaces em ordem alfabética." />
          </div>
          <LoadMore
            hasMore={list.hasMore}
            loading={list.status === 'loading-more'}
            onLoadMore={list.loadMore}
            count={list.items.length}
            itemLabel={list.items.length === 1 ? 'workspace' : 'workspaces'}
            error={list.error && !isApiError(list.error, 'unauthenticated') ? `${errorText(list.error).title} A lista exibida continua válida.` : undefined}
            stale={list.cursorRejected ? 'A lista mudou desde a última página (ou a continuação expirou).' : undefined}
            onRestart={list.reload}
          />
        </>
      )}
    </Stack>
  );
}
