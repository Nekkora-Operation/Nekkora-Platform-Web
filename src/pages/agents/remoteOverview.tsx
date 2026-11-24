import { useParams } from 'react-router';
import { Badge, Button, Card, DescriptionList, Heading, Stack, StateView, Text } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { getRemoteExecution, type RemoteAttempt } from '../../api/remoteExecutions';
import { useSession } from '../../area/session';
import { useWorkspacePermissions } from '../../area/useWorkspacePermissions';
import { orgPath } from '../../auth/organization';
import { usePolling } from '../../hooks/usePolling';
import { DateTimeText, errorText, NotFoundState, PageHeader, RouteLink } from '../product/shared';
import { ATTEMPT_STATE, WAITING_SLOT_LABEL, WAITING_SLOT_TEXT, endedUnknownText, refusalText } from './RemoteExecutions';
import { RemoteLogs } from './RemoteLogs';
import { RemoteResults } from './RemoteResults';
import { durationText } from './supervision';
import { AttemptEnvironmentDetail, ENVIRONMENT_MODE_TEXT, useManagedEnvironmentAvailable } from './ManagedEnvironment';
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
  const managedOn = useManagedEnvironmentAvailable();
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
  // AMBIENTE-PYTHON-001: o ambiente e a lista efetiva congelada na solicitação (A1); só com a chave ligada ou numa solicitação MANAGED
  const showEnvironment = managedOn || x.environmentMode === 'MANAGED';
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
              { key: 'workspace', term: 'Ambiente de trabalho', description: <RouteLink to={orgPath.workspace(org, x.workspaceId)}>{x.workspaceName ?? x.workspaceId}</RouteLink> },
              { key: 'origem', term: 'Origem', description: REMOTE_ORIGIN },
              { key: 'solicitada', term: 'Solicitada em', description: <DateTimeText iso={x.requestedAt} /> },
              { key: 'cancelamento', term: 'Cancelamento pedido', description: x.cancelRequestedAt ? <DateTimeText iso={x.cancelRequestedAt} /> : 'não' },
              { key: 'tentativas', term: 'Tentativas', description: x.attempts.length },
              ...(showEnvironment
                ? [
                    { key: 'ambiente', term: 'Ambiente', description: ENVIRONMENT_MODE_TEXT[x.environmentMode ?? 'PREPARED'] },
                    {
                      key: 'dependencias',
                      term: `Dependências (revisão ${x.requirementsRevision})`,
                      description: x.dependencies.length ? (
                        <ul className="pw-plain-list" aria-label="Dependências da solicitação">
                          {x.dependencies.map((d) => (
                            <li key={d}>
                              <code>{d}</code>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        'nenhuma além das do pacote'
                      ),
                    },
                  ]
                : []),
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
            {a.environment && <AttemptEnvironmentDetail org={org} executionId={x.remoteExecutionId} attempt={a} canReadLogs={canReadLogs} />}
            <DescriptionList
              items={[
                { key: 'maquina', term: 'Nome da máquina', description: a.agentName },
                {
                  key: 'worker',
                  term: 'Máquina',
                  description: (
                    <span>
                      {a.workerName} · <RouteLink to={orgPath.machine(org, a.workerId)}>Abrir a máquina</RouteLink> ·{' '}
                      <RouteLink to={orgPath.machineActivity(org, a.workerId)} state={{ machine: { workerId: a.workerId, name: a.workerName, computerName: a.agentName } }}>
                        Ver atividade
                      </RouteLink>
                    </span>
                  ),
                },
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
