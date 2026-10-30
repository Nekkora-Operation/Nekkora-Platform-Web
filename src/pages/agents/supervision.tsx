import { useState } from 'react';
import { useParams } from 'react-router';
import { Alert, Badge, Button, Card, DescriptionList, Heading, Select, Stack, StateView, Table, Text, type TableColumn, type Tone } from 'nekkora-lib';
import { getAgentRun, listAgentRunEvents, listAgentRuns, type AgentRun, type AgentRunEvent, type AgentSupervisorState } from '../../api/agents';
import { isApiError } from '../../api/http';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { usePolling, type Polling } from '../../hooks/usePolling';
import { DateTimeText, errorText, NotFoundState, PageHeader, RouteLink } from '../product/shared';
import './agents.css';

/** Frequências registradas (moderadas; uma requisição por vez; pausa com a aba oculta). */
export const LIST_INTERVAL_MS = 30_000;
export const DETAIL_INTERVAL_MS = 10_000;
/** Páginas de eventos relidas por ciclo (100 por página). A API não oferece continuação depois da última página. */
const EVENT_PAGES_PER_CYCLE = 20;

const SUPERVISOR: Record<AgentSupervisorState, { label: string; tone: Tone }> = {
  READY: { label: 'Pronta', tone: 'neutral' },
  STARTING: { label: 'Iniciando', tone: 'info' },
  RUNNING: { label: 'Em execução', tone: 'info' },
  SUCCEEDED: { label: 'Concluída com sucesso', tone: 'success' },
  FAILED: { label: 'Falhou', tone: 'danger' },
  CANCELLED: { label: 'Cancelada', tone: 'warning' },
  TIMED_OUT: { label: 'Tempo esgotado', tone: 'danger' },
  BLOCKED: { label: 'Bloqueada', tone: 'warning' },
  OUTCOME_UNKNOWN: { label: 'Desfecho desconhecido', tone: 'warning' },
};
const PROCESS: Record<NonNullable<AgentRun['process']>, string> = {
  NOT_STARTED: 'Não iniciado',
  STARTING: 'Iniciando',
  RUNNING: 'Em execução',
  ENDED: 'Encerrado',
};
const OUTCOME: Record<NonNullable<AgentRun['outcome']>, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pendente', tone: 'info' },
  KNOWN: { label: 'Conhecido', tone: 'success' },
  UNKNOWN: { label: 'Desconhecido', tone: 'warning' },
};
const COMPLETENESS: Record<NonNullable<NonNullable<AgentRun['history']>['completeness']>, { label: string; tone: Tone }> = {
  COMPLETE: { label: 'Completo', tone: 'success' },
  PENDING: { label: 'Entrega pendente', tone: 'info' },
  INCOMPLETE: { label: 'Incompleto', tone: 'warning' },
};
const REASON: Record<string, string> = {
  DELIVERY_PENDING: 'eventos ainda não entregues pelo Agent',
  LOST_AT_SOURCE: 'perdidos na origem (Framework)',
  LOST_LOCAL: 'perdidos na máquina',
  PURGED_LOCAL: 'expurgados na máquina antes da entrega',
  INVALID_REFUSED: 'recusados por estarem fora do contrato',
  DELIVERY_CONFLICT: 'conflito de entrega',
};
const RETENTION: Record<string, string> = {
  AVAILABLE: 'Disponível no servidor',
  PARTIALLY_PURGED: 'Parcialmente expurgado no servidor (retenção)',
  PURGED: 'Expurgado no servidor (retenção)',
};
const short = (v: string | null | undefined) => (v ? `${v.slice(0, 8)}…` : '—');

/** Um acompanhamento acabou quando o desfecho deixou de estar pendente E a entrega do histórico não está pendente. */
export const runIsSettled = (r: AgentRun) => r.outcome !== 'PENDING' && r.history?.completeness !== 'PENDING';

function Freshness({ poll, interval }: { poll: Polling<unknown>; interval: number }) {
  return (
    <div className="pw-form__row" role="status">
      <Text variant="body-sm" color="secondary">
        {poll.lastSuccessAt ? (
          <>
            Consultado às <DateTimeText iso={new Date(poll.lastSuccessAt).toISOString()} />.{' '}
          </>
        ) : null}
        {poll.paused
          ? 'Atualização pausada com a aba oculta.'
          : poll.following
            ? `Atualiza a cada ${interval / 1000} s enquanto houver algo pendente.`
            : 'Acompanhamento automático encerrado: nada pendente.'}
      </Text>
      <Button size="sm" variant="secondary" leftIcon="refresh" loading={poll.loading} onClick={poll.refresh}>
        Atualizar
      </Button>
    </div>
  );
}

function StaleAlert({ poll }: { poll: Polling<unknown> }) {
  if (!poll.stale || poll.data === undefined) return null;
  return (
    <Alert tone="warning" title="Os dados podem estar desatualizados.">
      {poll.error ? `${errorText(poll.error).title} ` : ''}Mostrando a última consulta bem-sucedida; a próxima tentativa é automática.
    </Alert>
  );
}

/** /o/{org}/supervisao — execuções locais registradas pelos Agents (não é o catálogo /executions nem o Portal). */
export function AgentRunsPage() {
  const { org, expired } = useSession();
  const { workspaces } = useInternalArea();
  const [workspaceId, setWorkspaceId] = useState('');
  const [state, setState] = useState<AgentSupervisorState | ''>('');
  const poll = usePolling(() => listAgentRuns(org, { limit: 25, ...(workspaceId ? { workspaceId } : {}), ...(state ? { state: [state] } : {}) }), {
    intervalMs: LIST_INTERVAL_MS,
    keepGoing: (page) => page.items.some((r) => !runIsSettled(r)),
    deps: [org, workspaceId, state],
    onUnauthenticated: expired,
  });

  const columns: TableColumn<AgentRun>[] = [
    { key: 'registro', header: 'Registrada em', render: (r) => <RouteLink to={orgPath.agentRun(org, r.runId!)}><DateTimeText iso={r.registeredAt} /></RouteLink> },
    { key: 'supervisor', header: 'Supervisor', render: (r) => (r.supervisor?.state ? <Badge tone={SUPERVISOR[r.supervisor.state].tone}>{SUPERVISOR[r.supervisor.state].label}</Badge> : '—') },
    { key: 'processo', header: 'Processo', render: (r) => (r.process ? PROCESS[r.process] : '—') },
    { key: 'historico', header: 'Histórico', render: (r) => (r.history?.completeness ? COMPLETENESS[r.history.completeness].label : '—') },
    { key: 'workspace', header: 'Workspace', render: (r) => workspaces.items.find((w) => w.workspaceId === r.correlation?.workspaceId)?.name ?? short(r.correlation?.workspaceId) },
  ];

  return (
    <Stack gap={5}>
      <PageHeader title="Supervisão" subtitle="Execuções locais registradas pelos Agents. O início é sempre no Agent; aqui só se acompanha." />
      <div className="pw-form__row">
        <Select
          label="Workspace"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          options={[{ value: '', label: 'Todos' }, ...workspaces.items.map((w) => ({ value: w.workspaceId, label: w.name }))]}
        />
        <Select
          label="Supervisor"
          value={state}
          onChange={(e) => setState(e.target.value as AgentSupervisorState | '')}
          options={[{ value: '', label: 'Todos' }, ...Object.entries(SUPERVISOR).map(([value, s]) => ({ value, label: s.label }))]}
        />
      </div>
      <Freshness poll={poll} interval={LIST_INTERVAL_MS} />
      <StaleAlert poll={poll} />
      {poll.data === undefined ? (
        poll.error ? (
          isApiError(poll.error, 'forbidden') ? (
            <StateView status="neutral" title="Você não tem permissão para ver estas execuções." />
          ) : (
            <StateView status="error" title={errorText(poll.error).title} actions={<Button onClick={poll.refresh}>Tentar novamente</Button>} />
          )
        ) : (
          <StateView status="loading" title="Carregando execuções…" />
        )
      ) : poll.data.items.length === 0 ? (
        <StateView status="neutral" title="Nenhuma execução local registrada." description="Elas aparecem quando um Agent inicia uma automação autorizada e registra a execução." />
      ) : (
        <div className="pw-prod__scroll" role="region" aria-label="Execuções locais" tabIndex={0}>
          <Table columns={columns} data={poll.data.items} rowKey="runId" size="sm" caption="Execuções locais, da mais recente para a mais antiga (primeiros 25)." />
        </div>
      )}
    </Stack>
  );
}

/** Todas as páginas de eventos (ordem de `sequence`), relidas a cada ciclo até o fim ou ao teto do ciclo. */
async function readEvents(org: string, runId: string): Promise<{ items: AgentRunEvent[]; truncated: boolean }> {
  const items: AgentRunEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < EVENT_PAGES_PER_CYCLE; page++) {
    const data = await listAgentRunEvents(org, runId, { limit: 100, cursor });
    items.push(...data.items);
    if (!data.nextCursor) return { items, truncated: false };
    cursor = data.nextCursor;
  }
  return { items, truncated: true };
}

/** /o/{org}/supervisao/:runId — uma execução local: identificação, cinco dimensões e etapas reais. */
export function AgentRunPage() {
  const { org, expired } = useSession();
  const { runId = '' } = useParams();
  const poll = usePolling(
    async () => {
      const run = await getAgentRun(org, runId);
      const events = run.history?.stepsAvailable === false && !run.history?.eventsStored ? { items: [], truncated: false } : await readEvents(org, runId);
      return { run, events };
    },
    { intervalMs: DETAIL_INTERVAL_MS, keepGoing: ({ run }) => !runIsSettled(run), deps: [org, runId], onUnauthenticated: expired },
  );

  if (poll.data === undefined) {
    if (poll.error && isApiError(poll.error, 'not_found', 'invalid_request'))
      return <NotFoundState title="Execução não encontrada." back={{ to: orgPath.agentRuns(org), label: 'Voltar para a supervisão' }} />;
    if (poll.error) return <StateView status="error" title={errorText(poll.error).title} actions={<Button onClick={poll.refresh}>Tentar novamente</Button>} />;
    return <StateView status="loading" title="Carregando execução…" />;
  }

  const { run: r, events } = poll.data;
  const s = r.supervisor;
  const h = r.history;
  const c = r.correlation;
  const eventColumns: TableColumn<AgentRunEvent>[] = [
    { key: 'seq', header: 'Seq.', render: (e) => e.sequence },
    { key: 'origem', header: 'Origem', render: (e) => e.source ?? '—' },
    { key: 'evento', header: 'Evento', render: (e) => <code className="pw-hash">{e.eventCode}</code> },
    { key: 'fase', header: 'Fase / etapa', render: (e) => (e.purged ? 'Expurgado (retenção)' : [e.phase, e.stepId, e.action].filter(Boolean).join(' · ') || '—') },
    { key: 'status', header: 'Situação', render: (e) => [e.status, e.errorCode && `erro ${e.errorCode}`, e.attempt != null && `tentativa ${e.attempt}`].filter(Boolean).join(' · ') || '—' },
    { key: 'tempo', header: 'Duração', render: (e) => (e.elapsedMs != null ? `${(e.elapsedMs / 1000).toFixed(1)} s` : '—') },
    { key: 'observado', header: 'Observado pelo Agent', render: (e) => <DateTimeText iso={e.observedUtc} /> },
  ];

  return (
    <Stack gap={5}>
      <PageHeader title="Execução local" subtitle={`Registrada em ${r.registeredAt ? new Date(r.registeredAt).toLocaleString('pt-BR') : '—'}`} back={{ to: orgPath.agentRuns(org), label: 'Voltar para a supervisão' }} />
      <Freshness poll={poll as Polling<unknown>} interval={DETAIL_INTERVAL_MS} />
      <StaleAlert poll={poll as Polling<unknown>} />
      {r.authorizationStateAtRegistration && r.authorizationStateAtRegistration !== 'ACTIVE' && (
        <Alert tone="warning">
          Registrada com a autorização {r.authorizationStateAtRegistration === 'REVOKED' ? 'já revogada' : 'já vencida'} (máquina desconectada vê a
          revogação só na próxima conexão). A execução continua sendo um fato registrado.
        </Alert>
      )}

      <div className="pw-run__dims">
        <Card variant="outlined" padding="md">
          <Text variant="overline">Processo</Text>
          <Text variant="h4">{r.process ? PROCESS[r.process] : '—'}</Text>
        </Card>
        <Card variant="outlined" padding="md">
          <Text variant="overline">Desfecho</Text>
          {r.outcome && <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge>}
          <Text variant="body-sm">Supervisor: {s?.state ? SUPERVISOR[s.state].label : '—'}</Text>
        </Card>
        <Card variant="outlined" padding="md">
          <Text variant="overline">Transporte</Text>
          <Badge tone={r.transport?.connectivity === 'CONNECTED' ? 'success' : 'neutral'} dot>
            {r.transport?.connectivity === 'CONNECTED' ? 'Agent conectado' : 'Agent sem sinal recente'}
          </Badge>
          <Text variant="body-sm">
            Último sinal: <DateTimeText iso={r.transport?.lastHeartbeatAt} empty="nunca" />
          </Text>
          <Text variant="body-sm" color="secondary">
            Presença do Agent, não término do processo.
          </Text>
        </Card>
        <Card variant="outlined" padding="md">
          <Text variant="overline">Histórico</Text>
          {h?.completeness && <Badge tone={COMPLETENESS[h.completeness].tone}>{COMPLETENESS[h.completeness].label}</Badge>}
          {!!h?.reasons?.length && <Text variant="body-sm">{h.reasons.map((x) => REASON[x] ?? x).join('; ')}</Text>}
        </Card>
        <Card variant="outlined" padding="md">
          <Text variant="overline">Retenção no servidor</Text>
          <Text variant="body-sm">{r.retention?.state ? RETENTION[r.retention.state] : '—'}</Text>
          {!!r.retention?.eventsPurged && <Text variant="body-sm">{r.retention.eventsPurged} eventos expurgados (não é perda na origem)</Text>}
        </Card>
      </div>

      <Card variant="surface" padding="lg">
        <DescriptionList
          items={[
            { key: 'auto', term: 'Automação', description: c?.automationId ? <RouteLink to={orgPath.automation(org, c.automationId)}>{short(c.automationId)}</RouteLink> : '—' },
            { key: 'versao', term: 'Versão', description: c?.automationVersionId ? <RouteLink to={orgPath.version(org, c.automationVersionId)}>{short(c.automationVersionId)}</RouteLink> : '—' },
            { key: 'agent', term: 'Agent', description: short(c?.agentId) },
            { key: 'worker', term: 'Worker', description: short(c?.workerId) },
            { key: 'autorizacao', term: 'Autorização', description: short(c?.authorizationId) },
            { key: 'execucao', term: 'Execução no Agent', description: <code className="pw-hash">{c?.agentExecutionId ?? '—'}</code> },
            { key: 'framework', term: 'Execução no Framework', description: <code className="pw-hash">{c?.frameworkExecutionId ?? '—'}</code> },
            { key: 'codigo', term: 'Código do supervisor', description: s?.code ?? '—' },
            { key: 'saida', term: 'Código de saída', description: s?.exitCode ?? '—' },
            { key: 'inicio', term: 'Início (relógio do Agent)', description: <DateTimeText iso={s?.agentStartedAt} /> },
            { key: 'fim', term: 'Fim (relógio do Agent)', description: <DateTimeText iso={s?.agentEndedAt} /> },
            { key: 'relatos', term: 'Relatos do supervisor', description: `${s?.reports ?? 0}${s?.conflicts ? ` (${s.conflicts} contraditórios registrados)` : ''}` },
            {
              key: 'contagens',
              term: 'Contagens',
              description: s?.counts && Object.keys(s.counts).length ? Object.entries(s.counts).map(([k, n]) => `${k}: ${n}`).join(' · ') : '—',
              wide: true,
            },
            {
              key: 'transacoes',
              term: 'Transações vistas',
              description: r.transactionsSeen && Object.keys(r.transactionsSeen).length ? Object.entries(r.transactionsSeen).map(([k, n]) => `${k}: ${n}`).join(' · ') : '—',
              wide: true,
            },
          ]}
        />
      </Card>

      <section className="pw-prod__section" aria-labelledby="etapas-titulo">
        <Heading level={2} id="etapas-titulo" className="pw-prod__section-title">
          Etapas
        </Heading>
        {h?.stepsAvailable === false ? (
          <StateView status="neutral" title="Etapas indisponíveis" description="O processo não produziu eventos do Framework. Nada é inventado: só o que o Agent observou aparece aqui." />
        ) : events.items.length === 0 ? (
          <StateView status="neutral" title="Nenhum evento recebido ainda." />
        ) : (
          <>
            {events.truncated && <Alert tone="info">Histórico longo: mostrando os primeiros {events.items.length} eventos. Use Atualizar para reler.</Alert>}
            <div className="pw-prod__scroll" role="region" aria-label="Eventos da execução" tabIndex={0}>
              <Table columns={eventColumns} data={events.items} rowKey="sequence" size="sm" caption="Eventos em ordem de observação pelo Agent (sequence), não pelo relógio." />
            </div>
          </>
        )}
      </section>
    </Stack>
  );
}
