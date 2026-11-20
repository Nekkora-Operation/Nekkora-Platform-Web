import { useEffect } from 'react';
import { useParams } from 'react-router';
import { Badge, Button, Card, DescriptionList, Heading, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { getRemoteExecution, listVisibleRemoteExecutions, type RemoteAttempt, type RemoteExecution } from '../../api/remoteExecutions';
import { useSession } from '../../area/session';
import { useWorkspacePermissions } from '../../area/useWorkspacePermissions';
import { orgPath } from '../../auth/organization';
import { usePolling } from '../../hooks/usePolling';
import { DateTimeText, errorText, NotFoundState, PageHeader, RouteLink } from '../product/shared';
import { ATTEMPT_STATE, WAITING_SLOT_LABEL, WAITING_SLOT_TEXT, endedUnknownText, refusalText } from './RemoteExecutions';
import { RemoteLogs } from './RemoteLogs';
import { RemoteResults } from './RemoteResults';
import { durationText } from './supervision';
import './agents.css';

/**
 * A execução remota (PLATFORM-CLIENT-EXECUCAO-REMOTA-001) nas telas Execuções e Supervisão. As duas telas liam só os modelos
 * anteriores (execuções da Platform e execuções registradas pelo Agent); a execução remota tem o registro próprio — a
 * SOLICITAÇÃO e as suas TENTATIVAS — e é ESSE registro que aparece aqui, lido da mesma rota, sem cópia.
 *
 * - Execuções: uma linha por SOLICITAÇÃO (o estado é o da tentativa mais recente).
 * - Supervisão: uma linha por TENTATIVA (o que cada máquina informou).
 * - Detalhe (/o/{org}/execucoes-remotas/:id): a solicitação e cada tentativa, com registros e arquivos (para quem pode vê-los).
 */
export const REMOTE_LIST_INTERVAL_MS = 30_000;
export const REMOTE_DETAIL_INTERVAL_MS = 5_000;
export const REMOTE_LIST_LIMIT = 50;
export const REMOTE_ORIGIN = 'Execução remota · solicitada pela Platform';

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'REFUSED', 'EXPIRED', 'ENDED_UNKNOWN'];
const finished = (state: string) => TERMINAL.includes(state);
const last = (x: RemoteExecution): RemoteAttempt | undefined => x.attempts[x.attempts.length - 1];

/**
 * O que a consulta das execuções remotas tem a dizer para a tela que a hospeda: ainda carregando, falhou, não está disponível
 * (Platform sem o recurso ou pessoa sem acesso: a fonte não conta), terminou sem itens ou terminou com itens. A tela só afirma
 * "nenhuma execução" quando TODAS as fontes terminaram sem itens; erro de consulta é erro, não ausência.
 */
export type RemoteSource = 'loading' | 'error' | 'unavailable' | 'empty' | 'items';

export interface RemoteFilter {
  workspaceId?: string;
  automationId?: string;
  from?: string;
  to?: string;
}

function StateBadge({ state, exitCode, waitingForSlot }: { state: RemoteAttempt['state']; exitCode?: number | null; waitingForSlot?: boolean }) {
  // na fila com a organização no limite de simultâneas: aguarda vaga (capacidade, não licença)
  const s = state === 'QUEUED' && waitingForSlot ? { label: WAITING_SLOT_LABEL, tone: 'warning' as const } : ATTEMPT_STATE[state];
  return (
    <span className="pw-remote__state">
      <Badge tone={s.tone} size="sm">
        {s.label}
      </Badge>
      {exitCode != null && <Text as="span" variant="body-sm" color="secondary">{`código de saída ${exitCode}`}</Text>}
    </span>
  );
}

function useRemoteList(filter: RemoteFilter, refreshKey: unknown, enabled: boolean) {
  const { org, expired } = useSession();
  return usePolling(() => (enabled ? listVisibleRemoteExecutions(org, { ...filter, limit: REMOTE_LIST_LIMIT }) : Promise.resolve({ items: [] })), {
    intervalMs: REMOTE_LIST_INTERVAL_MS,
    // continua mesmo vazia ou com tudo encerrado: a solicitação feita em outra tela precisa aparecer
    keepGoing: () => true,
    deps: [org, filter.workspaceId, filter.automationId, filter.from, filter.to, refreshKey, enabled],
    onUnauthenticated: expired,
  });
}

function ListFrame({
  title,
  note,
  poll,
  empty,
  hostEmpty,
  onSource,
  children,
}: {
  title: string;
  note: string;
  poll: ReturnType<typeof useRemoteList>;
  empty: string;
  /** A lista da tela que hospeda a seção não tem linhas a mostrar: o vazio (ou o carregando) geral é dela, não desta seção. */
  hostEmpty: boolean;
  onSource?: (source: RemoteSource) => void;
  children: (items: RemoteExecution[]) => React.ReactNode;
}) {
  const items = poll.data?.items;
  const source: RemoteSource =
    items !== undefined
      ? items.length > 0
        ? 'items'
        : 'empty'
      : poll.error
        ? isApiError(poll.error, 'forbidden') || isApiError(poll.error, 'not_found')
          ? 'unavailable'
          : 'error'
        : 'loading';
  useEffect(() => {
    onSource?.(source);
  }, [onSource, source]);
  // fonte que não conta não ocupa a tela; sem linhas na lista da tela, o carregando e o vazio são os GERAIS (um só, da tela)
  if (source === 'unavailable' || (hostEmpty && (source === 'loading' || source === 'empty'))) return null;
  return (
    <Card variant="outlined" padding="md" aria-label={title}>
      <Stack gap={3}>
        <div className="pw-remote__head">
          <Heading level={2}>
            {title}
          </Heading>
          <Button size="sm" variant="secondary" leftIcon="refresh" loading={poll.loading} onClick={poll.refresh}>
            Atualizar execuções remotas
          </Button>
        </div>
        <Text variant="body-sm" color="secondary">
          {note}
        </Text>
        {items === undefined ? (
          poll.error ? (
            <StateView
              status="error"
              title="Não foi possível consultar as execuções remotas."
              description={`${errorText(poll.error).title} Isto é uma falha de consulta, não a ausência de execuções.`}
              actions={<Button onClick={poll.refresh}>Tentar novamente</Button>}
            />
          ) : (
            <Text color="secondary">Carregando execuções remotas…</Text>
          )
        ) : items.length === 0 ? (
          <Text color="secondary">{empty}</Text>
        ) : (
          <>
            {poll.error != null && <Text color="secondary">Não foi possível atualizar agora; a lista abaixo é a da última leitura.</Text>}
            {children(items)}
            {items.length >= REMOTE_LIST_LIMIT && (
              <Text variant="body-sm" color="secondary">{`Mostrando as ${REMOTE_LIST_LIMIT} solicitações mais recentes. Use o workspace ou o período para ver as anteriores.`}</Text>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}

/** Execuções: uma linha por SOLICITAÇÃO de execução remota dos workspaces visíveis, com os filtros de workspace, automação e período da tela. */
export function RemoteRequestsSection({
  filter,
  refreshKey,
  enabled = true,
  back,
  hostEmpty = false,
  onSource,
}: {
  filter: RemoteFilter;
  refreshKey?: unknown;
  enabled?: boolean;
  back?: string;
  hostEmpty?: boolean;
  onSource?: (source: RemoteSource) => void;
}) {
  const { org } = useSession();
  const poll = useRemoteList(filter, refreshKey, enabled);
  const state = back ? { back } : undefined;
  const columns: TableColumn<RemoteExecution>[] = [
    {
      key: 'automacao',
      header: 'Automação',
      render: (x) => (
        <span className="pw-exec__automation">
          <RouteLink to={orgPath.remoteExecution(org, x.remoteExecutionId)} state={state} aria-label={`Execução remota de ${x.automationName ?? 'automação'}, solicitada em ${x.requestedAt}`}>
            {x.automationName ?? `Automação ${x.automationId.slice(0, 8)}`}
          </RouteLink>
          <span className="pw-exec__muted">versão {x.versionNumber}</span>
        </span>
      ),
    },
    { key: 'workspace', header: 'Workspace', render: (x) => <RouteLink to={orgPath.workspace(org, x.workspaceId)} variant="default">{x.workspaceName ?? `Workspace ${x.workspaceId.slice(0, 8)}`}</RouteLink> },
    { key: 'estado', header: 'Estado', render: (x) => <StateBadge state={x.state} exitCode={last(x)?.exitCode} waitingForSlot={x.waitingForSlot} /> },
    { key: 'origem', header: 'Origem', render: () => REMOTE_ORIGIN },
    { key: 'maquina', header: 'Máquina · Worker', render: (x) => (last(x) ? `${last(x)!.agentName} · ${last(x)!.workerName}` : '—') },
    { key: 'solicitada', header: 'Solicitada em', render: (x) => <DateTimeText iso={x.requestedAt} /> },
    { key: 'inicio', header: 'Início', render: (x) => <DateTimeText iso={last(x)?.startedAt} /> },
    { key: 'termino', header: 'Término', render: (x) => <DateTimeText iso={last(x)?.endedAt} /> },
    { key: 'tentativas', header: 'Tentativas', align: 'right', render: (x) => x.attempts.length },
  ];
  return (
    <ListFrame
      title="Execuções remotas"
      note="Solicitadas pela Platform a uma máquina habilitada. Uma linha por solicitação; o estado, a máquina e os horários são os da tentativa mais recente. Valem os filtros de workspace, automação e período (pela data da solicitação); o filtro de estado acima é só das execuções da lista de cima."
      poll={poll}
      empty="Nenhuma execução remota com esses filtros."
      hostEmpty={hostEmpty}
      onSource={onSource}
    >
      {(items) => (
        <div className="pw-exec__scroll" role="region" aria-label="Lista de execuções remotas" tabIndex={0}>
          <Table columns={columns} data={items} rowKey="remoteExecutionId" size="sm" caption="Execuções remotas, da solicitação mais recente para a mais antiga." />
        </div>
      )}
    </ListFrame>
  );
}

type AttemptRow = RemoteAttempt & { execution: RemoteExecution };

/** Supervisão: uma linha por TENTATIVA de execução remota (o que cada máquina informou), dos workspaces visíveis. */
export function RemoteAttemptsSection({ workspaceId, hostEmpty = false, onSource }: { workspaceId?: string; hostEmpty?: boolean; onSource?: (source: RemoteSource) => void }) {
  const { org } = useSession();
  const poll = useRemoteList({ workspaceId }, 0, true);
  const columns: TableColumn<AttemptRow>[] = [
    { key: 'criada', header: 'Tentativa criada em', render: (a) => <RouteLink to={orgPath.remoteExecution(org, a.execution.remoteExecutionId)} state={{ back: orgPath.agentRuns(org) }}><DateTimeText iso={a.createdAt} /></RouteLink> },
    { key: 'automacao', header: 'Automação', render: (a) => `${a.execution.automationName ?? a.execution.automationId.slice(0, 8)} · versão ${a.execution.versionNumber}` },
    { key: 'maquina', header: 'Máquina', render: (a) => a.agentName },
    { key: 'worker', header: 'Worker', render: (a) => a.workerName },
    { key: 'origem', header: 'Origem', render: () => REMOTE_ORIGIN },
    { key: 'inicio', header: 'Início', render: (a) => <DateTimeText iso={a.startedAt} /> },
    { key: 'fim', header: 'Fim / duração', render: (a) => (a.endedAt ? <><DateTimeText iso={a.endedAt} />{a.startedAt ? ` · ${durationText(a.startedAt, a.endedAt)}` : ''}</> : '—') },
    { key: 'desfecho', header: 'Desfecho', render: (a) => <StateBadge state={a.state} exitCode={a.exitCode} /> },
    { key: 'tentativa', header: 'Tentativa', render: (a) => `${a.attemptNumber} de ${a.execution.attempts.length}` },
    { key: 'workspace', header: 'Workspace', render: (a) => a.execution.workspaceName ?? a.execution.workspaceId.slice(0, 8) },
  ];
  return (
    <ListFrame
      title="Execuções remotas (tentativas)"
      note="O que cada máquina informou das execuções solicitadas pela Platform. Uma linha por tentativa: uma solicitação pode ter mais de uma (executar novamente em outra máquina). Vale o filtro de workspace; o de supervisor é só das execuções locais."
      poll={poll}
      empty="Nenhuma tentativa de execução remota."
      hostEmpty={hostEmpty}
      onSource={onSource}
    >
      {(items) => {
        const rows: AttemptRow[] = items.flatMap((x) => [...x.attempts].reverse().map((a) => ({ ...a, execution: x })));
        return (
          <div className="pw-prod__scroll" role="region" aria-label="Tentativas de execução remota" tabIndex={0}>
            <Table columns={columns} data={rows} rowKey="attemptId" size="sm" caption="Tentativas de execução remota, da solicitação mais recente para a mais antiga." />
          </div>
        );
      }}
    </ListFrame>
  );
}

/** /o/{org}/execucoes-remotas/:remoteExecutionId — a solicitação e cada tentativa, com registros e arquivos. Só leitura. */
export function RemoteExecutionPage() {
  const { org, expired } = useSession();
  const { remoteExecutionId = '' } = useParams();
  const poll = usePolling(() => getRemoteExecution(org, remoteExecutionId), {
    intervalMs: REMOTE_DETAIL_INTERVAL_MS,
    keepGoing: (x) => !finished(x.state),
    deps: [org, remoteExecutionId],
    onUnauthenticated: expired,
  });
  const x = poll.data;
  const perms = useWorkspacePermissions(x?.workspaceId);
  const canReadLogs = perms.status === 'ready' && perms.has('logs.read');
  const back = { to: orgPath.executions(org), label: 'Execuções' };
  if (!x) {
    if (poll.error && (isApiError(poll.error, 'not_found') || isApiError(poll.error, 'forbidden') || isApiError(poll.error, 'invalid_request'))) {
      return <NotFoundState title="Execução remota não encontrada" back={back} />;
    }
    return poll.error ? (
      <StateView status="error" title={errorText(poll.error).title} actions={<Button onClick={poll.refresh}>Tentar novamente</Button>} />
    ) : (
      <StateView status="loading" title="Carregando a execução remota…" />
    );
  }
  const waiting = x.state === 'QUEUED' && !!x.waitingForSlot;
  const current = waiting ? { label: WAITING_SLOT_LABEL, tone: 'warning' as const } : ATTEMPT_STATE[x.state];
  return (
    <Stack gap={5}>
      <PageHeader
        title={`Execução remota · ${x.automationName ?? 'automação'}`}
        subtitle="Uma solicitação feita pela Platform a uma máquina habilitada, e as tentativas dela. O estado é o que a máquina informou. Solicitar, cancelar e executar novamente ficam na página da versão."
        back={back}
      />
      <Card variant="outlined" padding="md" aria-label="Solicitação">
        <Stack gap={3}>
          <div className="pw-remote__head">
            <span className="pw-remote__state">
              <Heading level={2}>Solicitação</Heading>
              <Badge tone={current.tone}>{current.label}</Badge>
            </span>
            <Button size="sm" variant="secondary" leftIcon="refresh" loading={poll.loading} onClick={poll.refresh}>
              Atualizar
            </Button>
          </div>
          {waiting && (
            <Text variant="body-sm" color="secondary">
              {WAITING_SLOT_TEXT}
            </Text>
          )}
          <DescriptionList
            items={[
              { key: 'automacao', term: 'Automação', description: <RouteLink to={orgPath.automation(org, x.automationId)}>{x.automationName ?? x.automationId}</RouteLink> },
              { key: 'versao', term: 'Versão', description: <RouteLink to={orgPath.version(org, x.automationVersionId)}>{`versão ${x.versionNumber}`}</RouteLink> },
              { key: 'workspace', term: 'Workspace', description: <RouteLink to={orgPath.workspace(org, x.workspaceId)}>{x.workspaceName ?? x.workspaceId}</RouteLink> },
              { key: 'origem', term: 'Origem', description: REMOTE_ORIGIN },
              { key: 'solicitada', term: 'Solicitada em', description: <DateTimeText iso={x.requestedAt} /> },
              { key: 'cancelamento', term: 'Cancelamento pedido', description: x.cancelRequestedAt ? <DateTimeText iso={x.cancelRequestedAt} /> : 'não' },
              { key: 'tentativas', term: 'Tentativas', description: x.attempts.length },
            ]}
          />
        </Stack>
      </Card>
      {[...x.attempts].reverse().map((a) => (
        <Card key={a.attemptId} variant="outlined" padding="md" aria-label={`Tentativa ${a.attemptNumber}`}>
          <Stack gap={3}>
            <div className="pw-remote__head">
              <Heading level={2}>{`Tentativa ${a.attemptNumber} de ${x.attempts.length}`}</Heading>
              <StateBadge state={a.state} exitCode={a.exitCode} />
            </div>
            {a.state === 'REFUSED' && a.refusalReason && <Text color="secondary">{`Motivo informado pela máquina: ${refusalText(a.refusalReason)}.`}</Text>}
            {a.state === 'ENDED_UNKNOWN' && <Text color="secondary">{endedUnknownText(a.closureCause)}</Text>}
            <DescriptionList
              items={[
                { key: 'maquina', term: 'Máquina', description: a.agentName },
                { key: 'worker', term: 'Worker', description: a.workerName },
                { key: 'criada', term: 'Criada em', description: <DateTimeText iso={a.createdAt} /> },
                { key: 'entregue', term: 'Entregue à máquina', description: <DateTimeText iso={a.offeredAt} empty="ainda não" /> },
                { key: 'recebida', term: 'Recebida pela máquina', description: <DateTimeText iso={a.receivedAt} empty="ainda não" /> },
                { key: 'inicio', term: 'Início', description: <DateTimeText iso={a.startedAt} empty="não iniciada" /> },
                { key: 'fim', term: 'Término', description: <DateTimeText iso={a.endedAt} empty={a.startedAt ? 'em andamento' : '—'} /> },
                { key: 'duracao', term: 'Duração', description: a.startedAt && a.endedAt ? durationText(a.startedAt, a.endedAt) : '—' },
                { key: 'saida', term: 'Código de saída', description: a.exitCode ?? '—' },
              ]}
            />
            {/* as mesmas regras da página da versão: registros de tentativa que iniciou; arquivos de tentativa que iniciou e terminou */}
            {canReadLogs && a.startedAt && <RemoteLogs org={org} executionId={x.remoteExecutionId} attemptId={a.attemptId} attemptNumber={a.attemptNumber} />}
            {canReadLogs && a.startedAt && finished(a.state) && <RemoteResults org={org} executionId={x.remoteExecutionId} attemptId={a.attemptId} attemptNumber={a.attemptNumber} />}
            {perms.status === 'ready' && !canReadLogs && a.startedAt && <Text color="secondary">Você não tem permissão para ver os registros e os arquivos desta tentativa.</Text>}
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}
