import { useRef } from 'react';
import { useParams } from 'react-router';
import { Alert, Badge, Button, Card, DescriptionList, Heading, Stack, StateView, Table, Text, type TableColumn, type Tone } from 'nekkora-lib';
import { getAgentRun, listAgentRunEvents, type AgentRun, type AgentRunEvent, type AgentSupervisorState } from '../../api/agents';
import { isApiError } from '../../api/http';
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
  // neutro: "conhecido" não é "bem-sucedido" — a cor do desfecho vem do estado do supervisor (Falhou, Concluída…)
  KNOWN: { label: 'Conhecido', tone: 'neutral' },
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

/** Origem do código e de quem pediu (030). */
export const SOURCE_KIND: Record<string, string> = {
  STUDIO_PACKAGE: 'Pacote Studio',
  EXTERNAL_PACKAGE: 'Pacote Python externo',
  EXTERNAL_MONITORED: 'Python externo monitorado',
};
const ORIGIN: Record<string, string> = { LOCAL_AUTHORIZED: 'Iniciada na máquina', PLATFORM_REQUEST: 'Pedido pela Platform' };

/**
 * O desfecho em palavras. Python externo (AGT-EXT-*): código 0 sem sinal é "terminou sem erro sinalizado", NUNCA sucesso de
 * negócio; sem evidência do desfecho, "desconhecido". Nos demais, o rótulo do supervisor.
 */
export function outcomeLabel(state: AgentSupervisorState | undefined, code?: string | null, exitCode?: number | null): { label: string; tone: Tone } {
  if (!state) return { label: '—', tone: 'neutral' };
  switch (code) {
    case 'AGT-EXT-001':
      return { label: 'Terminou sem erro sinalizado (código 0; sucesso de negócio não sinalizado)', tone: 'neutral' };
    case 'AGT-EXT-002':
      return { label: `Terminou com erro (código de saída ${exitCode ?? '?'})`, tone: 'danger' };
    case 'AGT-EXT-003':
      return { label: 'Falha de negócio sinalizada pelo script', tone: 'danger' };
    case 'AGT-EXT-004':
      return { label: 'Desconhecido: o lançador terminou sem observar o fim', tone: 'warning' };
    case 'AGT-EXT-005':
      return { label: 'O processo do script não pôde ser criado', tone: 'danger' };
    default:
      if (state === 'SUCCEEDED' && !code) return { label: 'Concluída com sucesso', tone: 'success' };
      return SUPERVISOR[state];
  }
}

/** Duração pelo relógio do Agent (início e fim do supervisor); sem os dois, nada é inventado. */
export function durationText(start?: string | null, end?: string | null): string {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** Um acompanhamento acabou quando o desfecho deixou de estar pendente E a entrega do histórico não está pendente. */
export const runIsSettled = (r: AgentRun) => r.outcome !== 'PENDING' && r.history?.completeness !== 'PENDING';

/** `always`: a lista continua consultando mesmo sem nada pendente (uma execução nova pode aparecer). */
function Freshness({ poll, interval, always = false }: { poll: Polling<unknown>; interval: number; always?: boolean }) {
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
            ? always
              ? `Atualiza a cada ${interval / 1000} s.`
              : `Atualiza a cada ${interval / 1000} s enquanto houver algo pendente.`
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
      {poll.error ? `${errorText(poll.error).title} ` : ''}Mostrando a última consulta bem-sucedida;{' '}
      {poll.following && !poll.paused ? 'a próxima tentativa é automática.' : 'use Atualizar para consultar de novo.'}
    </Alert>
  );
}

/** Todas as páginas de eventos (ordem de `sequence`), até o fim ou ao teto da tela. */
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

/** /o/{org}/execucoes-locais/:runId (antes /supervisao/:runId, que redireciona para cá) — uma execução local: identificação, cinco dimensões e etapas reais. */
export function AgentRunPage() {
  const { org, expired } = useSession();
  const { runId = '' } = useParams();
  // eventos da última leitura e a "assinatura" do histórico (contagens, retenção) que os produziu: se nada mudou no
  // servidor, o ciclo não relê as páginas (o cursor é assinado e acaba na última página; não há como pedir "só os novos")
  const lastEvents = useRef<{ key: string; sig: string; events: { items: AgentRunEvent[]; truncated: boolean } } | null>(null);
  const poll = usePolling(
    async () => {
      const run = await getAgentRun(org, runId);
      const key = `${org}/${runId}`;
      const sig = JSON.stringify([run.history ?? null, run.retention ?? null]);
      const prev = lastEvents.current;
      const events =
        run.history?.stepsAvailable === false && !run.history?.eventsStored
          ? { items: [], truncated: false }
          : prev && prev.key === key && prev.sig === sig
            ? prev.events
            : await readEvents(org, runId);
      lastEvents.current = { key, sig, events };
      return { run, events };
    },
    { intervalMs: DETAIL_INTERVAL_MS, keepGoing: ({ run }) => !runIsSettled(run), deps: [org, runId], onUnauthenticated: expired },
  );

  if (poll.data === undefined) {
    if (poll.error && isApiError(poll.error, 'not_found', 'invalid_request'))
      return <NotFoundState title="Execução não encontrada." back={{ to: orgPath.executions(org), label: 'Voltar para Execuções' }} />;
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
      <PageHeader title="Execução local" subtitle={`Registrada em ${r.registeredAt ? new Date(r.registeredAt).toLocaleString('pt-BR') : '—'}`} back={{ to: orgPath.executions(org), label: 'Voltar para Execuções' }} />
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
          <Text variant="body-sm">Supervisor: {s?.state ? outcomeLabel(s.state, s.code, s.exitCode).label : '—'}</Text>
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
            { key: 'auto', term: 'Automação', description: c?.automationId ? <RouteLink to={orgPath.automation(org, c.automationId)}>{r.automationName ?? short(c.automationId)}</RouteLink> : '—' },
            {
              key: 'versao',
              term: 'Versão',
              description: c?.automationVersionId ? (
                <RouteLink to={orgPath.version(org, c.automationVersionId)}>{short(c.automationVersionId)}</RouteLink>
              ) : r.sourceKind === 'EXTERNAL_MONITORED' ? (
                'sem versão (Python externo monitorado: a Platform não conhece o código)'
              ) : (
                '—'
              ),
            },
            { key: 'origem', term: 'Origem', description: [r.sourceKind ? SOURCE_KIND[r.sourceKind] : null, r.origin ? ORIGIN[r.origin] : null].filter(Boolean).join(' · ') || '—' },
            { key: 'agent', term: 'Computador (Agent)', description: r.agentName ?? short(c?.agentId) },
            { key: 'duracao', term: 'Duração (relógio do Agent)', description: durationText(s?.agentStartedAt, s?.agentEndedAt) },
            {
              key: 'worker',
              term: 'Máquina',
              description: c?.workerId ? (
                <span>
                  <RouteLink to={orgPath.machine(org, c.workerId)}>Abrir a máquina</RouteLink> ·{' '}
                  <RouteLink to={orgPath.machineActivity(org, c.workerId)}>Ver atividade</RouteLink>
                </span>
              ) : (
                '—'
              ),
            },
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
            {events.truncated && (
              <Alert tone="info">Histórico longo: esta tela mostra só os primeiros {events.items.length} eventos; os seguintes não aparecem aqui.</Alert>
            )}
            <div className="pw-prod__scroll" role="region" aria-label="Eventos da execução" tabIndex={0}>
              <Table columns={eventColumns} data={events.items} rowKey="sequence" size="sm" caption="Eventos em ordem de observação pelo Agent (sequence), não pelo relógio." />
            </div>
          </>
        )}
      </section>
    </Stack>
  );
}
