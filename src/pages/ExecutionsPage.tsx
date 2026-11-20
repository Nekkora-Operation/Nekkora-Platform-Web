import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Badge, Button, Card, Grid, Input, LoadMore, Select, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../api/http';
import { listActivity, type ActivityItem, type ActivityOutcome } from '../api/activity';
import { getAutomation } from '../api/product';
import { ContractViolation } from '../api/validate';
import { commonMessage } from '../auth/messages';
import { useInternalArea } from '../area/InternalShell';
import { useSession } from '../area/session';
import { useCursorList } from '../hooks/useCursorList';
import { useResource } from '../hooks/useResource';
import { orgPath } from '../auth/organization';
import { machineName } from './agents/machine';
import { DateTimeText, errorOf, RouteLink, useExpiresOn } from './product/shared';
import {
  customRangeError,
  DEFAULT_PERIOD,
  formatDateTime,
  isoToLocalInput,
  localInputToIso,
  offsetLabel,
  PERIOD_LABEL,
  PERIOD_PRESETS,
  presetAppliedAt,
  presetFrom,
  timeZoneName,
  type PeriodPreset,
} from './executions/format';
import './ExecutionsPage.css';

const PAGE_SIZE = 25;
/** Valor explícito de "todos": o Select da lib pinta o valor vazio como placeholder (cor de baixo contraste). */
const ALL_WORKSPACES = 'todos';

type Tab = 'in_progress' | 'history';

interface Filters {
  tab: Tab;
  workspaceId: string; // ALL_WORKSPACES = todos os visíveis
  /** Filtro por automação (vem do detalhe da automação); '' = nenhum. */
  automationId: string;
  /** Filtro por máquina (Worker), vindo de Máquinas › "Ver atividade"; '' = nenhuma. */
  workerId: string;
  period: PeriodPreset;
  /** Momento em que o período pronto foi aplicado (base do `from`); "Atualizar" o renova. */
  appliedAt: number;
  customFrom: string; // valor do campo datetime-local
  customTo: string;
  /** Muda a cada "Atualizar": refaz a consulta. */
  refresh: number;
}

const defaultFilters = (): Filters => ({
  tab: 'in_progress',
  workspaceId: ALL_WORKSPACES,
  automationId: '',
  workerId: '',
  period: DEFAULT_PERIOD,
  appliedAt: Date.now(),
  customFrom: '',
  customTo: '',
  refresh: 0,
});

/**
 * Filtros na URL: voltar do detalhe ou recarregar reabre a lista com os MESMOS filtros. Parâmetros: aba (andamento |
 * historico), workspace, automacao, maquina, periodo, desde, de, ate. Valores desconhecidos são ignorados (o antigo
 * "estado" também: a lista unificada mostra a situação de cada execução).
 */
function filtersFromUrl(sp: URLSearchParams): Filters {
  const f = defaultFilters();
  if (sp.get('aba') === 'historico') f.tab = 'history';
  const period = sp.get('periodo');
  if (period && (PERIOD_PRESETS as string[]).includes(period)) f.period = period as PeriodPreset;
  const desde = sp.get('desde');
  const applied = desde ? presetAppliedAt(f.period, desde) : undefined;
  if (applied !== undefined) f.appliedAt = applied;
  const ws = sp.get('workspace');
  if (ws) f.workspaceId = ws;
  const auto = sp.get('automacao');
  if (auto) f.automationId = auto;
  const machine = sp.get('maquina');
  if (machine) f.workerId = machine;
  const de = sp.get('de');
  const ate = sp.get('ate');
  if (de && !Number.isNaN(Date.parse(de))) f.customFrom = isoToLocalInput(de);
  if (ate && !Number.isNaN(Date.parse(ate))) f.customTo = isoToLocalInput(ate);
  return f;
}

function filtersToUrl(f: Filters): URLSearchParams {
  const sp = new URLSearchParams();
  sp.set('aba', f.tab === 'history' ? 'historico' : 'andamento');
  if (f.workspaceId !== ALL_WORKSPACES) sp.set('workspace', f.workspaceId);
  if (f.automationId) sp.set('automacao', f.automationId);
  if (f.workerId) sp.set('maquina', f.workerId);
  if (f.tab === 'history') {
    sp.set('periodo', f.period);
    const from = presetFrom(f.period, f.appliedAt);
    if (from) sp.set('desde', from);
    if (f.period === 'custom') {
      const de = f.customFrom ? localInputToIso(f.customFrom) : undefined;
      const ate = f.customTo ? localInputToIso(f.customTo) : undefined;
      if (de) sp.set('de', de);
      if (ate) sp.set('ate', ate);
    }
  }
  return sp;
}

/** Limites enviados (ISO em UTC) e o erro de validação local, se houver. Só no Histórico. */
function queryRange(f: Filters): { from?: string; to?: string; error: string | null } {
  if (f.tab !== 'history') return { error: null };
  if (f.period !== 'custom') return { from: presetFrom(f.period, f.appliedAt), error: null };
  const from = f.customFrom ? localInputToIso(f.customFrom) : undefined;
  const to = f.customTo ? localInputToIso(f.customTo) : undefined;
  return { from, to, error: customRangeError(from, to) };
}

export const OUTCOME: Record<ActivityOutcome, { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' | 'warning' }> = {
  in_progress: { label: 'Em andamento', tone: 'info' },
  succeeded: { label: 'Concluída com sucesso', tone: 'success' },
  failed: { label: 'Falhou', tone: 'danger' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
  not_started: { label: 'Não iniciada', tone: 'neutral' },
  unconfirmed: { label: 'Resultado não confirmado', tone: 'warning' },
};

export const ATTENTION_LABEL = 'Requer atenção';
export const ATTENTION_TEXT =
  'Resultado desconhecido ainda não reconciliado: não se sabe se o processo terminou. Não é uma execução comprovadamente ativa nem deixa a máquina livre. Abra o detalhe para ver o que se sabe e o que fazer.';

const KIND_LABEL: Record<ActivityItem['kind'], string> = {
  platform: 'Platform',
  local_agent: 'Agent anterior',
  local_request: 'Pedido ao Agent anterior',
  remote: 'Agent Client',
};

/** O detalhe de cada origem (o pedido ao Agent anterior que não virou execução é acompanhado na automação). */
function detailPath(org: string, e: ActivityItem): string {
  switch (e.kind) {
    case 'platform':
      return orgPath.execution(org, e.id);
    case 'local_agent':
      return orgPath.agentRun(org, e.id);
    case 'remote':
      return orgPath.remoteExecution(org, e.id);
    default:
      return orgPath.automation(org, e.automation.id);
  }
}

/**
 * Execuções (PLATFORM-FLUXO-002): o acompanhamento unificado. Uma linha por execução, das mesmas origens do resumo do Início
 * (Platform, Agent anterior, pedido ao Agent anterior e Agent Client), sem repetir nenhuma.
 *
 * - "Em andamento" (padrão): o que ainda não tem desfecho e as pendências de atenção (resultado desconhecido não
 *   reconciliado), SEM período: uma pendência antiga nunca some por causa da data.
 * - "Histórico": o que já tem desfecho, no período escolhido (padrão: últimos 30 dias); as pendências também aparecem,
 *   marcadas.
 * - Filtros por ambiente de trabalho, automação e máquina ("Ver atividade" nas Máquinas); cada linha leva ao detalhe da
 *   execução e à sua máquina.
 */
export function ExecutionsPage() {
  const { org } = useSession();
  const { workspaces, loadMoreWorkspaces, restartWorkspaces } = useInternalArea();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => filtersFromUrl(searchParams));
  const written = useRef<string | null>(null);
  const seen = useRef(searchParams.toString());
  const range = queryRange(filters);
  const backState = { back: `${orgPath.executions(org)}?${filtersToUrl(filters).toString()}` };

  // mudança externa da URL (ex.: menu, "Ver atividade") reabre os filtros a partir dela; efeitos de layout (FRONT-V1-004)
  useLayoutEffect(() => {
    const current = searchParams.toString();
    if (current === seen.current) return;
    seen.current = current;
    if (written.current !== null && current !== written.current) setFilters(filtersFromUrl(searchParams));
  }, [searchParams]);

  useLayoutEffect(() => {
    const next = filtersToUrl(filters).toString();
    written.current = next;
    if (next !== searchParams.toString()) setSearchParams(new URLSearchParams(next), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const automation = useResource(
    () => (filters.automationId ? getAutomation(org, filters.automationId) : Promise.resolve(null)),
    [org, filters.automationId],
  );
  const tzOffset = offsetLabel(new Date());
  const tzName = timeZoneName();

  const query = useMemo(
    () => ({
      tab: filters.tab,
      workspaceId: filters.workspaceId === ALL_WORKSPACES ? undefined : filters.workspaceId,
      automationId: filters.automationId || undefined,
      workerId: filters.workerId || undefined,
      from: range.from,
      to: range.to,
    }),
    [filters.tab, filters.workspaceId, filters.automationId, filters.workerId, range.from, range.to],
  );
  const queryKey = range.error ? 'invalido' : JSON.stringify([query, filters.refresh]);

  const list = useCursorList<ActivityItem>(
    async (cursor) => {
      if (range.error) return { items: [], nextCursor: null }; // período inválido: nada é enviado
      return listActivity(org, { ...query, limit: PAGE_SIZE, cursor });
    },
    (e) => `${e.kind}:${e.id}`,
    [org, queryKey],
  );

  useExpiresOn(list.error, errorOf(automation));

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const machineLabel = list.items.find((e) => e.machine?.workerId === filters.workerId)?.machine;
  const attention = list.items.filter((e) => e.attention).length;

  const columns: TableColumn<ActivityItem>[] = [
    {
      key: 'automacao',
      header: 'Automação',
      render: (e) => (
        <span className="pw-exec__automation">
          <RouteLink
            to={detailPath(org, e)}
            state={backState}
            aria-label={`${e.kind === 'local_request' ? 'Pedido' : 'Execução'} de ${e.automation.name}, pedida em ${formatDateTime(e.requestedAt).text}`}
          >
            {e.automation.name}
          </RouteLink>
          <span className="pw-exec__muted">{KIND_LABEL[e.kind]}</span>
        </span>
      ),
    },
    {
      key: 'workspace',
      header: 'Ambiente de trabalho',
      render: (e) => (
        <RouteLink to={orgPath.workspace(org, e.workspace.id)} state={backState} variant="default">
          {e.workspace.name}
        </RouteLink>
      ),
    },
    {
      key: 'maquina',
      header: 'Máquina',
      render: (e) =>
        e.machine ? (
          <RouteLink to={orgPath.machine(org, e.machine.workerId)} state={backState} variant="default" aria-label={`Máquina ${machineName(e.machine.name, e.machine.computerName)}`}>
            {machineName(e.machine.name, e.machine.computerName)}
          </RouteLink>
        ) : (
          <span className="pw-exec__muted">—</span>
        ),
    },
    {
      key: 'situacao',
      header: 'Situação',
      render: (e) => (
        <span className="pw-exec__status">
          <Badge tone={OUTCOME[e.outcome].tone} size="sm">
            {OUTCOME[e.outcome].label}
          </Badge>
          {e.attention && (
            <Badge tone="warning" size="sm" dot>
              {ATTENTION_LABEL}
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'pedida', header: 'Pedida em', render: (e) => <DateTimeText iso={e.requestedAt} /> },
    { key: 'inicio', header: 'Início', render: (e) => <DateTimeText iso={e.startedAt} /> },
    {
      key: 'termino',
      header: 'Término',
      render: (e) => (e.endedAt ? <DateTimeText iso={e.endedAt} /> : <span className="pw-exec__muted">{e.outcome === 'in_progress' ? 'em andamento' : '—'}</span>),
    },
  ];

  const periodText =
    filters.period === 'custom'
      ? range.error
        ? null
        : `${range.from ? `De ${formatDateTime(range.from).text}` : 'Desde o início'} ${range.to ? `até ${formatDateTime(range.to).text} (exclusivo)` : 'até agora'} · ${tzOffset}`
      : range.from
        ? `Desde ${formatDateTime(range.from).text} (${tzOffset}). Execuções anteriores ficam fora do período; altere-o para ver mais.`
        : 'Sem limite de período: todo o histórico dos ambientes de trabalho visíveis.';

  const noWorkspaces = workspaces.status === 'ready' && workspaces.complete && workspaces.items.length === 0;
  const errorTitle = (e: unknown) =>
    e instanceof ContractViolation
      ? 'A resposta do servidor veio fora do formato esperado.'
      : isApiError(e, 'not_found')
        ? 'Ambiente de trabalho não encontrado ou sem acesso.'
        : isApiError(e, 'invalid_request')
          ? 'Algum filtro não foi aceito.'
          : commonMessage(e).title;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'in_progress', label: 'Em andamento' },
    { id: 'history', label: 'Histórico' },
  ];

  return (
    <Stack gap={5}>
      <div className="pw-exec__tabs" role="tablist" aria-label="Acompanhamento das execuções">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`aba-${t.id}`}
            aria-selected={filters.tab === t.id}
            aria-controls="painel-execucoes"
            tabIndex={filters.tab === t.id ? 0 : -1}
            className={`pw-exec__tab${filters.tab === t.id ? ' pw-exec__tab--active' : ''}`}
            onClick={() => set({ tab: t.id, appliedAt: Date.now() })}
            onKeyDown={(ev) => {
              if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
                const other = t.id === 'in_progress' ? 'history' : 'in_progress';
                set({ tab: other, appliedAt: Date.now() });
                requestAnimationFrame(() => document.getElementById(`aba-${other}`)?.focus());
              }
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="painel-execucoes" role="tabpanel" aria-labelledby={`aba-${filters.tab}`}>
        <Stack gap={5}>
          <Card variant="surface" padding="md">
            <form className="pw-exec__filters" aria-label="Filtros de execuções" onSubmit={(e) => e.preventDefault()}>
              <Grid columns={3} minColumnWidth="220px" gap={4}>
                <Select
                  label="Ambiente de trabalho"
                  value={filters.workspaceId}
                  onChange={(e) => set({ workspaceId: e.target.value })}
                  disabled={workspaces.status === 'loading'}
                  hint={
                    workspaces.status === 'loading'
                      ? 'Carregando ambientes de trabalho…'
                      : workspaces.status === 'error'
                        ? 'Não foi possível carregar a lista de ambientes de trabalho.'
                        : undefined
                  }
                  options={[
                    { value: ALL_WORKSPACES, label: 'Todos os ambientes de trabalho visíveis' },
                    ...workspaces.items.map((w) => ({ value: w.workspaceId, label: w.name })),
                    ...(filters.workspaceId !== ALL_WORKSPACES && !workspaces.items.some((w) => w.workspaceId === filters.workspaceId)
                      ? [{ value: filters.workspaceId, label: `Ambiente de trabalho ${filters.workspaceId.slice(0, 8)}` }]
                      : []),
                  ]}
                  fullWidth
                />
                {filters.tab === 'history' ? (
                  <Select
                    label="Período"
                    value={filters.period}
                    onChange={(e) => {
                      const period = e.target.value as PeriodPreset;
                      const seed = period === 'custom' && !filters.customFrom && range.from ? isoToLocalInput(range.from) : filters.customFrom;
                      set({ period, appliedAt: Date.now(), customFrom: seed });
                    }}
                    options={(Object.keys(PERIOD_LABEL) as PeriodPreset[]).map((p) => ({ value: p, label: p === DEFAULT_PERIOD ? `${PERIOD_LABEL[p]} (padrão)` : PERIOD_LABEL[p] }))}
                    fullWidth
                  />
                ) : (
                  <Text variant="body-sm" color="secondary" role="note">
                    Sem filtro de período: tudo o que está em andamento e as pendências que requerem atenção aparecem sempre, qualquer que seja a data.
                  </Text>
                )}
                <div className="pw-exec__actions">
                  <Button variant="secondary" size="sm" leftIcon="refresh" onClick={() => setFilters((f) => ({ ...f, appliedAt: Date.now(), refresh: f.refresh + 1 }))}>
                    Atualizar
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setFilters({ ...defaultFilters(), tab: filters.tab })}>
                    Limpar filtros
                  </Button>
                </div>
              </Grid>
              {workspaces.status === 'ready' && !workspaces.complete && (
                <div className="pw-exec__more-ws">
                  {workspaces.cursorRejected ? (
                    <>
                      <Text variant="body-sm" color="secondary" as="span">
                        A continuação da lista de ambientes de trabalho deixou de valer (a lista mudou ou a continuação expirou).{' '}
                        {workspaces.items.length} ambientes de trabalho carregados.
                        {workspaces.moreError != null && ' Não foi possível recomeçar.'}
                      </Text>
                      <Button variant="ghost" size="sm" leftIcon="refresh" loading={workspaces.loadingMore} onClick={restartWorkspaces}>
                        Recomeçar lista de ambientes de trabalho
                      </Button>
                    </>
                  ) : (
                    <>
                      <Text variant="body-sm" color="secondary" as="span">
                        Lista parcial: {workspaces.items.length} ambientes de trabalho carregados; há mais.
                        {workspaces.moreError != null && ' Não foi possível carregar a próxima parte.'}
                      </Text>
                      <Button variant="ghost" size="sm" loading={workspaces.loadingMore} onClick={loadMoreWorkspaces}>
                        Carregar mais ambientes de trabalho
                      </Button>
                    </>
                  )}
                </div>
              )}
              {filters.automationId && (
                <div className="pw-exec__more-ws" role="status">
                  <Text variant="body-sm" color="secondary" as="span">
                    {automation.status === 'ready' && automation.data
                      ? `Somente a automação ${automation.data.name}.`
                      : automation.status === 'error'
                        ? 'Filtro por uma automação não encontrada ou sem acesso.'
                        : 'Filtro por automação.'}
                  </Text>
                  <Button variant="ghost" size="sm" onClick={() => set({ automationId: '' })}>
                    Remover filtro de automação
                  </Button>
                </div>
              )}
              {filters.workerId && (
                <div className="pw-exec__more-ws" role="status">
                  <Text variant="body-sm" color="secondary" as="span">
                    Somente a máquina {machineLabel ? machineName(machineLabel.name, machineLabel.computerName) : `${filters.workerId.slice(0, 8)}…`}.
                  </Text>
                  <RouteLink to={orgPath.machine(org, filters.workerId)} variant="default">
                    Abrir a máquina
                  </RouteLink>
                  <Button variant="ghost" size="sm" onClick={() => set({ workerId: '' })}>
                    Remover filtro de máquina
                  </Button>
                </div>
              )}
              {filters.tab === 'history' && filters.period === 'custom' && (
                <Grid columns={2} minColumnWidth="220px" gap={4}>
                  <Input type="datetime-local" label="Início (inclusivo)" value={filters.customFrom} onChange={(e) => set({ customFrom: e.target.value })} hint={`Hora local (${tzOffset})`} fullWidth />
                  <Input type="datetime-local" label="Fim (exclusivo)" value={filters.customTo} onChange={(e) => set({ customTo: e.target.value })} hint={`Hora local (${tzOffset})`} fullWidth />
                </Grid>
              )}
              {filters.tab === 'history' &&
                (range.error ? (
                  <Alert tone="warning" title="Período inválido">
                    {range.error} Nenhuma consulta foi enviada.
                  </Alert>
                ) : (
                  <Text variant="body-sm" color="secondary" className="pw-exec__period" role="note">
                    <strong>
                      Período: {PERIOD_LABEL[filters.period]}
                      {filters.period === DEFAULT_PERIOD ? ' (padrão)' : ''}.
                    </strong>{' '}
                    {periodText} Pendências que requerem atenção continuam em “Em andamento”, qualquer que seja a data.
                  </Text>
                ))}
            </form>
          </Card>

          {attention > 0 && (
            <Alert tone="warning" title={attention === 1 ? '1 execução requer atenção.' : `${attention} execuções requerem atenção.`}>
              {ATTENTION_TEXT}
            </Alert>
          )}

          {list.status === 'loading' ? (
            <StateView status="loading" title="Carregando execuções…" />
          ) : list.status === 'error' ? (
            <StateView
              status="error"
              title={errorTitle(list.error)}
              description={
                list.error instanceof ContractViolation
                  ? 'Nada foi exibido a partir dela. Tente novamente; se continuar, avise o suporte.'
                  : isApiError(list.error, 'not_found')
                    ? 'O ambiente de trabalho escolhido não está disponível para você agora.'
                    : commonMessage(list.error).description
              }
              actions={<Button onClick={list.reload}>Tentar novamente</Button>}
            />
          ) : list.items.length === 0 ? (
            range.error ? null : noWorkspaces ? (
              <StateView status="neutral" title="Você ainda não tem acesso a nenhum ambiente de trabalho." description="Quando um administrador der acesso, as execuções aparecem aqui." />
            ) : filters.tab === 'in_progress' ? (
              <StateView status="neutral" title="Nada em andamento agora." description="Nenhuma execução em andamento e nenhuma pendência que requer atenção com esses filtros. O que já terminou está em Histórico." />
            ) : (
              <StateView
                status="neutral"
                title="Nenhuma execução encontrada."
                description={filters.period !== 'all' ? 'Nada com esses filtros neste período. Amplie o período ou ajuste os filtros.' : 'Nada com esses filtros.'}
              />
            )
          ) : (
            <>
              <div className="pw-exec__scroll" role="region" aria-label="Lista de execuções" tabIndex={0}>
                <Table
                  columns={columns}
                  data={list.items}
                  rowKey={(e: ActivityItem) => `${e.kind}:${e.id}`}
                  size="sm"
                  caption={`Execuções, do pedido mais recente para o mais antigo. Horários no fuso deste navegador${tzName ? ` (${tzName})` : ''}, ${tzOffset}.`}
                />
              </div>
              <LoadMore
                hasMore={list.hasMore}
                loading={list.status === 'loading-more'}
                onLoadMore={list.loadMore}
                count={list.items.length}
                itemLabel={list.items.length === 1 ? 'execução' : 'execuções'}
                error={list.error && !isApiError(list.error, 'unauthenticated') ? `${errorTitle(list.error)} A lista exibida continua válida.` : undefined}
                stale={list.cursorRejected ? 'A lista mudou desde a última página (ou a continuação expirou).' : undefined}
                onRestart={list.reload}
              />
            </>
          )}
        </Stack>
      </div>
    </Stack>
  );
}
