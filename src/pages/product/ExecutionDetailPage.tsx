import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';
import { Badge, Card, DescriptionList, Heading, Link, LoadMore, Stack, StateView, Table, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { getExecution, listExecutionEvents } from '../../api/product';
import type { ExecutionDetail, ExecutionEvent } from '../../api/v1';
import { orgPath } from '../../auth/organization';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { useCursorList } from '../../hooks/useCursorList';
import { useResource } from '../../hooks/useResource';
import { formatDuration, ORIGIN_LABEL, REASON_LABEL, STATUS_LABEL, STATUS_TONE } from '../executions/format';
import { DateTimeText, errorOf, errorText, isMissing, isSubordinateGone, LoadErrorState, NotFoundState, PageHeader, useBackTarget, useExpiresOn } from './shared';

const EVENTS_PAGE = 25;

/** Tipos de evento do contrato (ExecutionEvent.type). O evento não tem payload na API (DC-12). */
export const EVENT_LABEL: Record<ExecutionEvent['type'], string> = {
  process_started: 'Processo iniciado',
  process_succeeded: 'Processo concluído',
  process_failed: 'Processo falhou',
  process_start_failed: 'Falha ao iniciar o processo',
  process_cancelled: 'Processo cancelado',
};

/** Rota /execucoes/:executionId. A chave pelo identificador remonta a página: nada da execução anterior sobra. */
export function ExecutionDetailPage() {
  const { executionId = '' } = useParams();
  return <ExecutionDetail key={executionId} executionId={executionId} />;
}

/**
 * Detalhe da execução (L07) e eventos (L08, paginados por cursor, ordem do contrato: sequence asc). Só leitura: sem
 * executar, cancelar ou reagendar, e sem comandos, snapshots, payloads, logs ou dados de Worker/Agent (não publicados).
 */
function ExecutionDetail({ executionId }: { executionId: string }) {
  const { org } = useSession();
  const { workspaces } = useInternalArea();
  const back = useBackTarget(orgPath.executions(org));
  const [refresh, setRefresh] = useState(0);
  const execution = useResource(() => getExecution(org, executionId), [org, executionId]);
  const events = useCursorList<ExecutionEvent>(
    (cursor) => listExecutionEvents(org, executionId, { limit: EVENTS_PAGE, cursor }),
    (e) => String(e.sequence),
    [org, executionId, refresh],
  );

  useExpiresOn(errorOf(execution), events.error);
  // a execução sumiu para quem consulta: pelo detalhe ou pelos eventos (inclusive ao carregar mais) — a página inteira
  // vira "não encontrada", sem os dados carregados antes
  const gone = (execution.status === 'error' && isMissing(execution.error)) || isSubordinateGone(events.error);

  const onRefresh = () => {
    execution.refresh();
    setRefresh((n) => n + 1);
  };
  const backLink = { to: back, label: 'Voltar para execuções' };

  if (gone) return <NotFoundState title="Execução não encontrada." back={backLink} />;
  if (execution.status === 'loading') return <StateView status="loading" title="Carregando execução…" />;
  if (execution.status === 'error') {
    return <LoadErrorState error={execution.error} onRetry={onRefresh} page />;
  }

  const e: ExecutionDetail = execution.data;
  const workspaceName = workspaces.items.find((w) => w.workspaceId === e.workspaceId)?.name;
  const requester = e.requestedBy
    ? e.requestedBy.displayName
    : e.origin === 'scheduled'
      ? 'Nenhum (execução agendada)'
      : 'Não informado';

  const columns: TableColumn<ExecutionEvent>[] = [
    { key: 'seq', header: 'Sequência', render: (ev) => ev.sequence, align: 'right', width: 110 },
    { key: 'tipo', header: 'Evento', render: (ev) => EVENT_LABEL[ev.type] },
    { key: 'ocorrido', header: 'Ocorrido em', render: (ev) => <DateTimeText iso={ev.occurredAt} /> },
    { key: 'recebido', header: 'Recebido em', render: (ev) => <DateTimeText iso={ev.receivedAt} /> },
  ];

  return (
    <Stack gap={6}>
      <PageHeader
        title={`Execução de ${e.automation.name}`}
        subtitle={<>Identificador <code>{e.executionId}</code></>}
        back={backLink}
        onRefresh={onRefresh}
        refreshing={execution.refreshing}
      />
      <Card variant="surface" padding="lg">
        <DescriptionList
          items={[
            {
              key: 'estado',
              term: 'Estado',
              description: (
                <span className="pw-prod__cell">
                  <Badge tone={STATUS_TONE[e.status]} size="sm">
                    {STATUS_LABEL[e.status]}
                  </Badge>
                  {e.statusReason && REASON_LABEL[e.statusReason] && <span className="pw-prod__muted">{REASON_LABEL[e.statusReason]}</span>}
                </span>
              ),
            },
            { key: 'origem', term: 'Origem', description: ORIGIN_LABEL[e.origin] },
            {
              key: 'automacao',
              term: 'Automação',
              description: (
                <Link as={RouterLink} to={orgPath.automation(org, e.automation.automationId)}>
                  {e.automation.name}
                </Link>
              ),
            },
            { key: 'versao', term: 'Versão', description: `versão ${e.automationVersion.versionNumber}` },
            {
              key: 'workspace',
              term: 'Workspace',
              description: (
                <Link as={RouterLink} to={orgPath.workspace(org, e.workspaceId)}>
                  {workspaceName ?? 'Abrir workspace'}
                </Link>
              ),
            },
            { key: 'solicitante', term: 'Solicitante', description: requester },
            { key: 'criada', term: 'Criada em', description: <DateTimeText iso={e.createdAt} /> },
            { key: 'inicio', term: 'Início', description: <DateTimeText iso={e.startedAt} empty="Ainda não iniciada" /> },
            { key: 'termino', term: 'Término', description: <DateTimeText iso={e.finishedAt} empty={e.startedAt ? 'Em andamento' : '—'} /> },
            { key: 'duracao', term: 'Duração', description: e.durationMs === null ? null : formatDuration(e.durationMs) },
            { key: 'cancelamento', term: 'Cancelamento solicitado em', description: <DateTimeText iso={e.cancelRequestedAt} empty="Não solicitado" /> },
            {
              key: 'reexecucao',
              term: 'Reexecução de',
              description: e.retryOfExecutionId ? (
                <Link as={RouterLink} to={orgPath.execution(org, e.retryOfExecutionId)}>
                  Execução anterior
                </Link>
              ) : (
                'Não é reexecução'
              ),
            },
          ]}
        />
      </Card>

      <section className="pw-prod__section" aria-labelledby="eventos-titulo">
        <Heading level={2} id="eventos-titulo" className="pw-prod__section-title">
          Eventos
        </Heading>
        {events.status === 'loading' ? (
          <StateView status="loading" title="Carregando eventos…" />
        ) : events.status === 'error' ? (
          <LoadErrorState error={events.error} onRetry={events.reload} />
        ) : events.items.length === 0 ? (
          <StateView status="neutral" title="Nenhum evento registrado." description="Execuções na fila ou canceladas antes do envio não têm eventos." />
        ) : (
          <>
            <div className="pw-prod__scroll" role="region" aria-label="Eventos da execução" tabIndex={0}>
              <Table columns={columns} data={events.items} rowKey={(ev) => ev.sequence} size="sm" caption="Eventos em ordem de sequência, sem conteúdo (a API não publica payload)." />
            </div>
            <LoadMore
              hasMore={events.hasMore}
              loading={events.status === 'loading-more'}
              onLoadMore={events.loadMore}
              count={events.items.length}
              itemLabel={events.items.length === 1 ? 'evento' : 'eventos'}
              error={events.error && !isApiError(events.error, 'unauthenticated') ? `${errorText(events.error).title} A lista exibida continua válida.` : undefined}
              stale={events.cursorRejected ? 'A lista de eventos mudou desde a última página (ou a continuação expirou).' : undefined}
              onRestart={events.reload}
            />
          </>
        )}
      </section>
    </Stack>
  );
}
