import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, Grid, IconBox, LoadMore, Select, Stack, StateView, Text, type IconName, type Tone } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { getExecutionSummary, listOrganizationAutomations } from '../../api/product';
import type { ExecutionOutcome, ExecutionSummary, OrganizationAutomation } from '../../api/v1';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { formatDateTime, offsetLabel } from '../executions/format';
import { DateTimeText, ResourceStatusBadge, RouteLink } from '../product/shared';
import './Dashboard.css';

/**
 * Início da organização como painel (PLATFORM-INICIO-001): métricas das execuções do período, próximas execuções e as
 * automações em cards. Só leitura e só apresentação: a API decide o que cada pessoa vê (os números já vêm restritos aos
 * ambientes em que ela tem leitura) e nenhuma ação de execução é oferecida aqui.
 */

// ------------------------------------------------------------------ período

export type DashboardPeriod = '24h' | '7d' | '30d' | '90d';
export const DASHBOARD_DEFAULT_PERIOD: DashboardPeriod = '30d';
const PERIOD_LABEL: Record<DashboardPeriod, string> = {
  '24h': 'Últimas 24 horas',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  '90d': 'Últimos 90 dias',
};
const PERIOD_MS: Record<DashboardPeriod, number> = { '24h': 24 * 3600_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 };

/** Intervalo [from, to) do período, calculado no momento em que ele é aplicado (instantes ISO em UTC). */
export function periodRange(period: DashboardPeriod, now: number): { from: string; to: string } {
  return { from: new Date(now - PERIOD_MS[period]).toISOString(), to: new Date(now).toISOString() };
}

// ------------------------------------------------------------------ situações

export const OUTCOME_LABEL: Record<ExecutionOutcome, string> = {
  succeeded: 'Sucesso',
  failed: 'Erro',
  inProgress: 'Em andamento',
  cancelled: 'Cancelada',
  notStarted: 'Não iniciada',
  unconfirmed: 'Resultado não confirmado',
};
export const OUTCOME_TONE: Record<ExecutionOutcome, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  succeeded: 'success',
  failed: 'danger',
  inProgress: 'info',
  cancelled: 'neutral',
  notStarted: 'neutral',
  unconfirmed: 'warning',
};

const count = (n: number) => n.toLocaleString('pt-BR');
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

type Load<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

// ------------------------------------------------------------------ métricas

function Metric({ icon, tone, label, value, caption }: { icon: IconName; tone: Tone; label: string; value: string; caption?: ReactNode }) {
  return (
    <Card variant="surface" padding="lg" className="pw-dash__metric">
      <Stack direction="row" gap={4} align="flex-start">
        <IconBox icon={icon} tone={tone} size="lg" />
        <Stack gap={1}>
          <Text as="h3" variant="body" color="secondary" className="pw-dash__metric-label">
            {label}
          </Text>
          <Text variant="h1" as="p" className="pw-dash__metric-value">
            {value}
          </Text>
          {caption && (
            <Text variant="body-sm" color="secondary">
              {caption}
            </Text>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

/** As situações que não são sucesso nem erro, em uma linha: é o que fecha a conta do total. */
function OtherOutcomes({ s }: { s: ExecutionSummary }) {
  const others: [number, string][] = [
    [s.inProgress, plural(s.inProgress, 'em andamento', 'em andamento')],
    [s.cancelled, plural(s.cancelled, 'cancelada', 'canceladas')],
    [s.notStarted, plural(s.notStarted, 'não iniciada', 'não iniciadas')],
    [s.unconfirmed, plural(s.unconfirmed, 'com resultado não confirmado', 'com resultado não confirmado')],
  ];
  const shown = others.filter(([n]) => n > 0);
  if (shown.length === 0) return null;
  return (
    <Text className="pw-dash__others">
      <strong>O total também inclui:</strong> {shown.map(([, text]) => text).join(' · ')}. Essas situações não contam como erro: erro é só
      quando a automação executou e falhou.
    </Text>
  );
}

function Metrics({ summary, onRetry }: { summary: Load<ExecutionSummary>; onRetry: () => void }) {
  if (summary.status === 'loading') return <StateView status="loading" title="Carregando as execuções do período…" />;
  if (summary.status === 'error') {
    return (
      <Alert
        tone="warning"
        title="Não foi possível carregar as execuções do período."
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Tentar novamente
          </Button>
        }
      >
        Os números não aparecem enquanto a consulta não responder: nenhum total parcial é mostrado.
      </Alert>
    );
  }
  const s = summary.data;
  return (
    <Stack gap={4}>
      <Grid minColumnWidth="15rem" gap={4}>
        <Metric icon="executions" tone="accent" label="Total de execuções" value={count(s.total)} caption={s.total === 0 ? 'Nenhuma execução pedida no período.' : 'Pedidas no período.'} />
        <Metric icon="check-circle" tone="success" label="Sucessos" value={count(s.succeeded)} />
        <Metric icon="x-circle" tone="danger" label="Erros" value={count(s.failed)} caption="A automação executou e falhou, ou passou do tempo." />
      </Grid>
      <OtherOutcomes s={s} />
    </Stack>
  );
}

// ------------------------------------------------------------------ próximas execuções

/**
 * Próximas execuções. A Platform ainda não tem agendamentos (não há leitura nem agendador na API): a seção diz isso, em vez
 * de mostrar uma lista vazia. Uma execução pedida à mão e ainda na fila NÃO é agendamento e não aparece aqui.
 */
function Upcoming() {
  return (
    <Card variant="outlined" padding="lg">
      <StateView
        status="info"
        title="Agendamentos ainda não estão disponíveis"
        description="A Platform ainda não agenda execuções. Quando o agendamento existir, as próximas execuções previstas aparecem aqui, com data, horário e fuso. Por enquanto, as execuções começam por pedido de uma pessoa."
      />
    </Card>
  );
}

// ------------------------------------------------------------------ automações

function lastExecutionPath(org: string, l: NonNullable<OrganizationAutomation['lastExecution']>): string | null {
  if (!l.id) return null;
  return l.source === 'platform' ? orgPath.execution(org, l.id) : l.source === 'remote' ? orgPath.remoteExecution(org, l.id) : orgPath.agentRun(org, l.id);
}

function AutomationCard({ a }: { a: OrganizationAutomation }) {
  const { org } = useSession();
  const navigate = useNavigate();
  const last = a.lastExecution;
  const lastPath = last ? lastExecutionPath(org, last) : null;
  return (
    <Card as="li" variant="surface" padding="lg" className="pw-dash__automation">
      <Stack gap={3}>
        <div className="pw-dash__automation-head">
          <Text as="h3" variant="h4" className="pw-dash__automation-name">
            {a.name}
          </Text>
          <ResourceStatusBadge status={a.status} />
        </div>
        <Text variant="body-sm" color="secondary">
          Workspace {a.workspaceName}
        </Text>
        {a.description && <Text className="pw-dash__automation-description">{a.description}</Text>}
        <dl className="pw-dash__facts">
          <div>
            <dt>Versão publicada</dt>
            <dd>{a.latestPublishedVersion ? `Versão ${a.latestPublishedVersion.versionNumber}` : 'Nenhuma ainda'}</dd>
          </div>
          <div>
            <dt>Última execução</dt>
            <dd>
              {last ? (
                <span className="pw-dash__last">
                  <Badge tone={OUTCOME_TONE[last.outcome]}>{OUTCOME_LABEL[last.outcome]}</Badge>
                  <DateTimeText iso={last.requestedAt} />
                </span>
              ) : (
                'Nenhuma ainda'
              )}
            </dd>
          </div>
        </dl>
        <div className="pw-dash__automation-actions">
          <Button variant="secondary" rightIcon="arrow-right" aria-label={`Ver automação ${a.name}`} onClick={() => navigate(orgPath.automation(org, a.automationId))}>
            Ver automação
          </Button>
          {lastPath && (
            <RouteLink to={lastPath} aria-label={`Abrir a última execução de ${a.name}`}>
              Abrir a última execução
            </RouteLink>
          )}
        </div>
      </Stack>
    </Card>
  );
}

const AUTOMATIONS_PAGE = 12;

type AutomationList =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; items: OrganizationAutomation[]; next: string | null; more: 'idle' | 'loading' | 'error' | 'stale' };

/** As automações dos ambientes visíveis (ativas e suspensas; arquivadas ficam no workspace), 12 por vez. */
function useAutomations(org: string, expired: () => void) {
  const [list, setList] = useState<AutomationList>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    setList({ status: 'loading' });
    listOrganizationAutomations(org, { status: ['active', 'suspended'], limit: AUTOMATIONS_PAGE })
      .then((p) => gen === generation.current && setList({ status: 'ready', items: p.items, next: p.nextCursor, more: 'idle' }))
      .catch((e) => {
        if (gen !== generation.current) return;
        if (isApiError(e, 'unauthenticated')) return expired();
        setList({ status: 'error' });
      });
    return () => {
      generation.current++;
    };
  }, [org, attempt, expired]);

  const loadMore = useCallback(() => {
    if (list.status !== 'ready' || !list.next || list.more === 'loading') return;
    const gen = generation.current;
    const current = list;
    setList({ ...current, more: 'loading' });
    listOrganizationAutomations(org, { status: ['active', 'suspended'], limit: AUTOMATIONS_PAGE, cursor: current.next! })
      .then((p) => gen === generation.current && setList({ status: 'ready', items: [...current.items, ...p.items], next: p.nextCursor, more: 'idle' }))
      .catch((e) => {
        if (gen !== generation.current) return;
        if (isApiError(e, 'unauthenticated')) return expired();
        // cursor recusado (a lista mudou): não repete sozinho; a pessoa recomeça
        setList({ ...current, more: isApiError(e, 'invalid_request') ? 'stale' : 'error' });
      });
  }, [list, org, expired]);

  return { list, loadMore, restart: () => setAttempt((n) => n + 1) };
}

function Automations() {
  const { org, expired } = useSession();
  const { list, loadMore, restart } = useAutomations(org, expired);
  if (list.status === 'loading') return <StateView status="loading" title="Carregando automações…" />;
  if (list.status === 'error') {
    return (
      <Alert
        tone="warning"
        title="Não foi possível carregar as automações."
        action={
          <Button size="sm" variant="secondary" onClick={restart}>
            Tentar novamente
          </Button>
        }
      >
        A lista não aparece enquanto a consulta não responder.
      </Alert>
    );
  }
  if (list.items.length === 0) {
    return (
      <Card variant="outlined" padding="lg">
        <StateView status="neutral" title="Nenhuma automação ainda" description="Quando houver automações nos seus workspaces, elas aparecem aqui." />
      </Card>
    );
  }
  return (
    <Stack gap={4}>
      <ul className="pw-dash__automations" aria-label="Automações">
        {list.items.map((a) => (
          <AutomationCard key={a.automationId} a={a} />
        ))}
      </ul>
      <LoadMore
        hasMore={list.next !== null}
        loading={list.more === 'loading'}
        onLoadMore={loadMore}
        count={list.items.length}
        itemLabel="automações"
        error={list.more === 'error' ? 'Não foi possível carregar mais automações.' : undefined}
        stale={list.more === 'stale' ? 'A lista de automações mudou desde que foi carregada.' : undefined}
        onRestart={restart}
      />
    </Stack>
  );
}

// ------------------------------------------------------------------ painel

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="pw-dash__section" aria-label={title}>
      <div className="pw-dash__section-head">
        <Text as="h2" variant="h3">
          {title}
        </Text>
        {description && <Text color="secondary">{description}</Text>}
      </div>
      {children}
    </section>
  );
}

/**
 * O painel da organização aberta. Trocar de organização remonta o componente (a página o renderiza com `key={org}`), e cada
 * resposta é conferida contra a consulta em vigor: dado de outra organização ou de outro período nunca fica na tela.
 */
export function Dashboard({ header }: { header: (period: ReactNode) => ReactNode }) {
  const { org, expired } = useSession();
  const { workspaces } = useInternalArea();
  const [period, setPeriod] = useState<DashboardPeriod>(DASHBOARD_DEFAULT_PERIOD);
  const [appliedAt, setAppliedAt] = useState(() => Date.now());
  const [summary, setSummary] = useState<Load<ExecutionSummary>>({ status: 'loading' });
  const range = periodRange(period, appliedAt);
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    setSummary({ status: 'loading' });
    getExecutionSummary(org, { from: range.from, to: range.to })
      .then((data) => gen === generation.current && setSummary({ status: 'ready', data }))
      .catch((e) => {
        if (gen !== generation.current) return;
        if (isApiError(e, 'unauthenticated')) return expired();
        setSummary({ status: 'error' });
      });
    return () => {
      generation.current++;
    };
  }, [org, range.from, range.to, expired]);

  const noAccess = workspaces.status === 'ready' && workspaces.items.length === 0;
  const tz = offsetLabel(new Date(appliedAt));
  const periodFilter = (
    <div className="pw-dash__period">
      <Select
        label="Período"
        value={period}
        onChange={(e) => {
          setPeriod(e.target.value as DashboardPeriod);
          setAppliedAt(Date.now());
        }}
        options={(Object.keys(PERIOD_LABEL) as DashboardPeriod[]).map((p) => ({ value: p, label: PERIOD_LABEL[p] }))}
      />
    </div>
  );

  return (
    <Stack gap={8} className="pw-dash">
      {header(periodFilter)}
      {noAccess ? (
        <Card variant="outlined" padding="lg">
          <StateView
            status="neutral"
            title="Você ainda não tem acesso a nenhum workspace"
            description="As execuções e as automações aparecem aqui quando alguém que administra a organização der acesso a um workspace."
          />
        </Card>
      ) : (
        <>
          <Section
            title="Execuções no período"
            description={
              <>
                De <time dateTime={range.from}>{formatDateTime(range.from).text}</time> até <time dateTime={range.to}>{formatDateTime(range.to).text}</time> · horários em {tz}.
                Contam as execuções pedidas nesse intervalo, nos workspaces que você pode ver.
              </>
            }
          >
            <Metrics summary={summary} onRetry={() => setAppliedAt(Date.now())} />
            <div>
              <RouteLink to={orgPath.executions(org)}>Ver execuções</RouteLink>
            </div>
          </Section>
          <Section title="Próximas execuções" description="Execuções previstas por agendamento. Não dependem do período escolhido acima.">
            <Upcoming />
          </Section>
          <Section title="Automações" description="As automações dos seus workspaces, com a última execução de cada uma.">
            <Automations />
            <div>
              <RouteLink to={orgPath.workspaces(org)}>Ver workspaces</RouteLink>
            </div>
          </Section>
        </>
      )}
    </Stack>
  );
}
