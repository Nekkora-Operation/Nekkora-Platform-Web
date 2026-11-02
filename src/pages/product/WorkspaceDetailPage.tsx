import { useState } from 'react';
import { useNavigate } from 'react-router';
import { createAutomation } from '../../api/lifecycle';
import { useWorkspacePermissions } from '../../area/useWorkspacePermissions';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal } from '../access/shared';
import { LocalRunAuthorizations } from '../agents/LocalRunAuthorizations';
import { Link as RouterLink, useParams } from 'react-router';
import { Alert, Button, Card, Input, DescriptionList, Heading, Link, LoadMore, Stack, StateView, Table, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { getWorkspace, listAutomations } from '../../api/product';
import type { Automation } from '../../api/v1';
import { orgPath } from '../../auth/organization';
import { useSession } from '../../area/session';
import { useCursorList } from '../../hooks/useCursorList';
import { useResource } from '../../hooks/useResource';
import { RouteLink, DateTimeText, errorOf, errorText, isMissing, isSubordinateGone, LoadErrorState, NotFoundState, PageHeader, ResourceStatusBadge, useBackState, useBackTarget, useExpiresOn } from './shared';

const PAGE = 25;

export function WorkspaceDetailPage() {
  const { workspaceId = '' } = useParams();
  return <WorkspaceDetail key={workspaceId} workspaceId={workspaceId} />;
}

/** Detalhe do workspace (L02) e suas automações (L03, paginadas por cursor). */
function WorkspaceDetail({ workspaceId }: { workspaceId: string }) {
  const { org, expired } = useSession();
  const navigate = useNavigate();
  const perms = useWorkspacePermissions(workspaceId);
  const canManage = perms.status === 'ready' && perms.has('automation.manage');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createUncertain, setCreateUncertain] = useState(false);
  const back = useBackTarget(orgPath.workspaces(org));
  const backState = useBackState();
  const [refresh, setRefresh] = useState(0);
  const workspace = useResource(() => getWorkspace(org, workspaceId), [org, workspaceId]);
  const automations = useCursorList<Automation>(
    (cursor) => listAutomations(org, workspaceId, { limit: PAGE, cursor }),
    (a) => a.automationId,
    [org, workspaceId, refresh],
  );

  useExpiresOn(errorOf(workspace), automations.error);
  const gone = (workspace.status === 'error' && isMissing(workspace.error)) || isSubordinateGone(automations.error);

  const onRefresh = () => {
    workspace.refresh();
    setRefresh((n) => n + 1);
  };
  const backLink = { to: back, label: 'Voltar para workspaces' };

  if (gone) return <NotFoundState title="Workspace não encontrado." back={backLink} />;
  if (workspace.status === 'loading') return <StateView status="loading" title="Carregando workspace…" />;
  if (workspace.status === 'error') {
    return <LoadErrorState error={workspace.error} onRetry={onRefresh} page />;
  }

  const w = workspace.data;
  const columns: TableColumn<Automation>[] = [
    {
      key: 'nome',
      header: 'Automação',
      render: (a) => (
        <RouteLink to={orgPath.automation(org, a.automationId)} state={backState}>
          {a.name}
        </RouteLink>
      ),
    },
    { key: 'estado', header: 'Estado', render: (a) => <ResourceStatusBadge status={a.status} /> },
    {
      key: 'versao',
      header: 'Última versão publicada',
      render: (a) =>
        a.latestPublishedVersion ? (
          <span className="pw-prod__cell">
            <span>versão {a.latestPublishedVersion.versionNumber}</span>
            <span className="pw-prod__muted">
              <DateTimeText iso={a.latestPublishedVersion.publishedAt} />
            </span>
          </span>
        ) : (
          <span className="pw-prod__muted">Nenhuma publicada</span>
        ),
    },
    { key: 'atualizada', header: 'Atualizada em', render: (a) => <DateTimeText iso={a.updatedAt} /> },
  ];

  return (
    <Stack gap={6}>
      <PageHeader
        title={w.name}
        subtitle="Workspace"
        back={backLink}
        onRefresh={onRefresh}
        refreshing={workspace.refreshing}
        actions={
          canManage && w.status === 'active' ? (
            <Button size="sm" leftIcon="plus" disabled={createUncertain} onClick={() => setCreating(true)}>
              Criar automação
            </Button>
          ) : undefined
        }
      />
      {createUncertain && <Alert tone="warning">Não foi possível confirmar se a automação foi criada. Atualize a lista antes de criar de novo.</Alert>}
      <StepUpDialog
        open={creating}
        title="Criar automação"
        guard={{ operation: 'automation.create', target: w.workspaceId }}
        confirmLabel="Criar automação"
        ready={newName.trim().length > 0 && [...newName.trim()].length <= 80}
        action={() => createAutomation(org, w.workspaceId, newName.trim())}
        onDone={(a) => {
          setCreating(false);
          setNewName('');
          if (a.automationId) navigate(orgPath.automation(org, a.automationId));
          else onRefresh();
        }}
        onClose={() => setCreating(false)}
        refusalText={(e) => accessRefusal(e, { conflict: 'O workspace não está ativo.', notFound: 'Você não tem acesso a este workspace para criar automações.' })}
        uncertainText="Não foi possível confirmar se a automação foi criada. Feche e atualize a lista antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && setCreateUncertain(true)}
      >
        <Input label="Nome da automação" required fullWidth maxLength={80} value={newName} onChange={(e) => setNewName(e.target.value)} hint="Até 80 caracteres." />
      </StepUpDialog>
      <Card variant="surface" padding="lg">
        <Stack gap={4}>
          <DescriptionList
            items={[
              { key: 'estado', term: 'Estado', description: <ResourceStatusBadge status={w.status} /> },
              { key: 'cliente', term: 'Cliente', description: w.client?.name ?? 'Sem cliente' },
              { key: 'descricao', term: 'Descrição', description: w.description, wide: true },
              { key: 'criado', term: 'Criado em', description: <DateTimeText iso={w.createdAt} /> },
              { key: 'atualizado', term: 'Atualizado em', description: <DateTimeText iso={w.updatedAt} /> },
            ]}
          />
          <div className="pw-prod__links">
            <Link as={RouterLink} to={`${orgPath.executions(org)}?workspace=${encodeURIComponent(w.workspaceId)}`} arrow>
              Ver execuções deste workspace
            </Link>
          </div>
        </Stack>
      </Card>

      <LocalRunAuthorizations workspaceId={w.workspaceId} canExecute={perms.status === 'ready' && perms.has('automation.execute')} />

      <section className="pw-prod__section" aria-labelledby="automacoes-titulo">
        <Heading level={2} id="automacoes-titulo" className="pw-prod__section-title">
          Automações
        </Heading>
        {automations.status === 'loading' ? (
          <StateView status="loading" title="Carregando automações…" />
        ) : automations.status === 'error' ? (
          <LoadErrorState error={automations.error} onRetry={automations.reload} />
        ) : automations.items.length === 0 ? (
          <StateView status="neutral" title="Nenhuma automação neste workspace." />
        ) : (
          <>
            <div className="pw-prod__scroll" role="region" aria-label="Automações do workspace" tabIndex={0}>
              <Table columns={columns} data={automations.items} rowKey="automationId" size="sm" caption="Automações em ordem alfabética." />
            </div>
            <LoadMore
              hasMore={automations.hasMore}
              loading={automations.status === 'loading-more'}
              onLoadMore={automations.loadMore}
              count={automations.items.length}
              itemLabel={automations.items.length === 1 ? 'automação' : 'automações'}
              error={automations.error && !isApiError(automations.error, 'unauthenticated') ? `${errorText(automations.error).title} A lista exibida continua válida.` : undefined}
              stale={automations.cursorRejected ? 'A lista mudou desde a última página (ou a continuação expirou).' : undefined}
              onRestart={automations.reload}
            />
          </>
        )}
      </section>
    </Stack>
  );
}
