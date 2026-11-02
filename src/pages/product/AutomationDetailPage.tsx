import { useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router';
import { Alert, Badge, Button, Card, DescriptionList, Heading, Link, LoadMore, Stack, StateView, Table, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { createAutomationVersion } from '../../api/lifecycle';
import { useWorkspacePermissions } from '../../area/useWorkspacePermissions';
import { accessRefusal } from '../access/shared';
import { getAutomation, listAutomationVersions } from '../../api/product';
import type { AutomationVersion } from '../../api/v1';
import { orgPath } from '../../auth/organization';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { useCursorList } from '../../hooks/useCursorList';
import { useResource } from '../../hooks/useResource';
import { DateTimeText, errorOf, errorText, isMissing, isSubordinateGone, LoadErrorState, NotFoundState, PageHeader, ResourceStatusBadge, RouteLink, useBackTarget, useExpiresOn } from './shared';

const PAGE = 25;

export function AutomationDetailPage() {
  const { automationId = '' } = useParams();
  return <AutomationDetail key={automationId} automationId={automationId} />;
}

/**
 * Detalhe da automação (L04, sem comando nem criador: DC-08/09) e versões (L05, paginadas, versionNumber desc). M3: nova
 * versão DRAFT (automation.manage no workspace); cada versão abre o detalhe do ciclo de vida (pacote e publicação).
 */
function AutomationDetail({ automationId }: { automationId: string }) {
  const { org, expired } = useSession();
  const { workspaces } = useInternalArea();
  const navigate = useNavigate();
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [versionUncertain, setVersionUncertain] = useState(false);
  const [versionError, setVersionError] = useState<{ tone: 'danger' | 'warning'; text: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const automation = useResource(() => getAutomation(org, automationId), [org, automationId]);
  const versions = useCursorList<AutomationVersion>(
    (cursor) => listAutomationVersions(org, automationId, { limit: PAGE, cursor }),
    (v) => v.automationVersionId,
    [org, automationId, refresh],
  );
  const workspaceId = automation.status === 'ready' ? automation.data.workspaceId : undefined;
  const perms = useWorkspacePermissions(workspaceId);
  const canManage = perms.status === 'ready' && perms.has('automation.manage');
  const back = useBackTarget(workspaceId ? orgPath.workspace(org, workspaceId) : orgPath.workspaces(org));

  useExpiresOn(errorOf(automation), versions.error);
  const gone = (automation.status === 'error' && isMissing(automation.error)) || isSubordinateGone(versions.error);

  const onRefresh = () => {
    automation.refresh();
    setRefresh((n) => n + 1);
  };

  if (gone) return <NotFoundState title="Automação não encontrada." back={{ to: back, label: 'Voltar para workspaces' }} />;
  if (automation.status === 'loading') return <StateView status="loading" title="Carregando automação…" />;
  if (automation.status === 'error') {
    return <LoadErrorState error={automation.error} onRetry={onRefresh} page />;
  }

  const a = automation.data;
  const newVersion = async () => {
    if (creatingVersion) return;
    setCreatingVersion(true);
    setVersionError(null);
    try {
      const created = await createAutomationVersion(org, a.automationId);
      navigate(orgPath.version(org, created.automationVersionId!));
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      if (isApiError(e, 'network', 'unexpected', 'internal_error')) {
        setVersionUncertain(true);
        setVersionError({ tone: 'warning', text: 'Não foi possível confirmar se a versão foi criada. Atualize a lista antes de criar outra.' });
      } else setVersionError({ tone: 'danger', text: accessRefusal(e, { conflict: 'A automação ou o workspace não está ativo.' }) });
    } finally {
      setCreatingVersion(false);
    }
  };
  const workspaceName = workspaces.items.find((w) => w.workspaceId === a.workspaceId)?.name;
  const columns: TableColumn<AutomationVersion>[] = [
    {
      key: 'versao',
      header: 'Versão',
      render: (v) => <RouteLink to={orgPath.version(org, v.automationVersionId)}>versão {v.versionNumber}</RouteLink>,
    },
    {
      key: 'estado',
      header: 'Estado',
      render: (v) => (
        <Badge tone={v.status === 'published' ? 'success' : 'neutral'} size="sm">
          {v.status === 'published' ? 'Publicada' : 'Rascunho'}
        </Badge>
      ),
    },
    { key: 'publicada', header: 'Publicada em', render: (v) => <DateTimeText iso={v.publishedAt} empty="Não publicada" /> },
    { key: 'criada', header: 'Criada em', render: (v) => <DateTimeText iso={v.createdAt} /> },
  ];

  return (
    <Stack gap={6}>
      <PageHeader title={a.name} subtitle="Automação" back={{ to: back, label: workspaceName ? `Voltar para ${workspaceName}` : 'Voltar para o workspace' }} onRefresh={onRefresh} refreshing={automation.refreshing} />
      <Card variant="surface" padding="lg">
        <Stack gap={4}>
          <DescriptionList
            items={[
              { key: 'estado', term: 'Estado', description: <ResourceStatusBadge status={a.status} /> },
              {
                key: 'workspace',
                term: 'Workspace',
                description: (
                  <Link as={RouterLink} to={orgPath.workspace(org, a.workspaceId)}>
                    {workspaceName ?? 'Abrir workspace'}
                  </Link>
                ),
              },
              {
                key: 'publicada',
                term: 'Última versão publicada',
                description: a.latestPublishedVersion ? (
                  <>
                    versão {a.latestPublishedVersion.versionNumber}, em <DateTimeText iso={a.latestPublishedVersion.publishedAt} />
                  </>
                ) : (
                  'Nenhuma versão publicada'
                ),
              },
              { key: 'descricao', term: 'Descrição', description: a.description, wide: true },
              { key: 'criada', term: 'Criada em', description: <DateTimeText iso={a.createdAt} /> },
              { key: 'atualizada', term: 'Atualizada em', description: <DateTimeText iso={a.updatedAt} /> },
            ]}
          />
          <div className="pw-prod__links">
            <Link as={RouterLink} to={`${orgPath.executions(org)}?automacao=${encodeURIComponent(a.automationId)}`} arrow>
              Ver execuções desta automação
            </Link>
          </div>
        </Stack>
      </Card>

      <section className="pw-prod__section" aria-labelledby="versoes-titulo">
        <div className="pw-prod__header-row">
          <Heading level={2} id="versoes-titulo" className="pw-prod__section-title">
            Versões
          </Heading>
          {canManage && (
            <Button size="sm" leftIcon="plus" loading={creatingVersion} disabled={versionUncertain} onClick={() => void newVersion()}>
              Nova versão
            </Button>
          )}
        </div>
        {versionError && <Alert tone={versionError.tone}>{versionError.text}</Alert>}
        {versions.status === 'loading' ? (
          <StateView status="loading" title="Carregando versões…" />
        ) : versions.status === 'error' ? (
          <LoadErrorState error={versions.error} onRetry={versions.reload} />
        ) : versions.items.length === 0 ? (
          <StateView status="neutral" title="Nenhuma versão registrada." />
        ) : (
          <>
            <div className="pw-prod__scroll" role="region" aria-label="Versões da automação" tabIndex={0}>
              <Table columns={columns} data={versions.items} rowKey="automationVersionId" size="sm" caption="Versões da mais recente para a mais antiga (sem o comando, que a API não publica)." />
            </div>
            <LoadMore
              hasMore={versions.hasMore}
              loading={versions.status === 'loading-more'}
              onLoadMore={versions.loadMore}
              count={versions.items.length}
              itemLabel={versions.items.length === 1 ? 'versão' : 'versões'}
              error={versions.error && !isApiError(versions.error, 'unauthenticated') ? `${errorText(versions.error).title} A lista exibida continua válida.` : undefined}
              stale={versions.cursorRejected ? 'A lista mudou desde a última página (ou a continuação expirou).' : undefined}
              onRestart={versions.reload}
            />
          </>
        )}
      </section>
    </Stack>
  );
}
