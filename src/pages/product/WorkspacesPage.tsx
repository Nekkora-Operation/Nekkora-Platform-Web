import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Input, LoadMore, Stack, StateView, Table, Textarea, type TableColumn } from 'nekkora-lib';
import { createWorkspace } from '../../api/access';
import { useInternalArea } from '../../area/InternalShell';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal } from '../access/shared';
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
  const { org, expired } = useSession();
  const navigate = useNavigate();
  const { permissions, reloadWorkspaces } = useInternalArea();
  const canCreate = permissions.status === 'ready' && permissions.data.organization.permissions.includes('workspace.lifecycle');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const nameOk = name.trim().length > 0 && [...name.trim()].length <= 80 && [...description].length <= 500;
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
      <PageHeader
        title="Workspaces"
        subtitle="Os workspaces que você pode consultar nesta organização."
        onRefresh={() => setRefresh((n) => n + 1)}
        refreshing={list.status === 'loading' && refresh > 0}
        actions={
          canCreate ? (
            <Button size="sm" leftIcon="plus" disabled={uncertain} onClick={() => setCreating(true)}>
              Criar workspace
            </Button>
          ) : undefined
        }
      />
      {uncertain && (
        <Alert tone="warning" title="Não foi possível confirmar se o workspace foi criado.">
          Atualize a lista e confira antes de criar de novo.
        </Alert>
      )}
      <StepUpDialog
        open={creating}
        title="Criar workspace"
        guard={{ operation: 'workspace.create' }}
        confirmLabel="Criar workspace"
        ready={nameOk}
        action={() => createWorkspace(org, name.trim(), description.trim() || undefined)}
        onDone={(w) => {
          setCreating(false);
          setName('');
          setDescription('');
          reloadWorkspaces();
          if (w.workspaceId) navigate(orgPath.workspace(org, w.workspaceId));
          else setRefresh((n) => n + 1);
        }}
        onClose={() => setCreating(false)}
        refusalText={(e) => accessRefusal(e, { forbidden: 'Você não tem permissão para criar workspaces nesta organização.' })}
        uncertainText="Não foi possível confirmar se o workspace foi criado. Feche e atualize a lista antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && setUncertain(true)}
      >
        <Input label="Nome" required fullWidth maxLength={80} value={name} onChange={(e) => setName(e.target.value)} hint="Até 80 caracteres." />
        <Textarea label="Descrição (opcional)" fullWidth maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
      </StepUpDialog>
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
