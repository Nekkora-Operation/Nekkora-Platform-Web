import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Badge, Button, Card, Checkbox, Fieldset, Grid, Input, LoadMore, Select, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../api/http';
import { getAutomation, listExecutions } from '../api/product';
import type { Execution, ExecutionStatus } from '../api/v1';
import { ContractViolation } from '../api/validate';
import { commonMessage } from '../auth/messages';
import { useInternalArea } from '../area/InternalShell';
import { useSession } from '../area/session';
import { useCursorList } from '../hooks/useCursorList';
import { useResource } from '../hooks/useResource';
import { orgPath } from '../auth/organization';
import { DateTimeText, errorOf, RouteLink, useExpiresOn } from './product/shared';
import {
  customRangeError,
  DEFAULT_PERIOD,
  formatDateTime,
  formatDuration,
  isoToLocalInput,
  localInputToIso,
  offsetLabel,
  ORIGIN_LABEL,
  PERIOD_LABEL,
  PERIOD_PRESETS,
  presetAppliedAt,
  presetFrom,
  REASON_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
  STATUS_TONE,
  timeZoneName,
  type PeriodPreset,
} from './executions/format';
import './ExecutionsPage.css';

const PAGE_SIZE = 25;
/** Valor explícito de "todos": o Select da lib pinta o valor vazio como placeholder (cor de baixo contraste). */
const ALL_WORKSPACES = 'todos';

interface Filters {
  workspaceId: string; // ALL_WORKSPACES = todos os visíveis
  /** Filtro por automação (vem do detalhe da automação); '' = nenhum. */
  automationId: string;
  statuses: ExecutionStatus[];
  period: PeriodPreset;
  /** Momento em que o período pronto foi aplicado (base do `from`); "Atualizar" o renova. */
  appliedAt: number;
  customFrom: string; // valor do campo datetime-local
  customTo: string;
  /** Muda a cada "Atualizar": refaz a consulta em QUALQUER período (nos relativos também recalcula o início). */
  refresh: number;
}

const defaultFilters = (): Filters => ({ workspaceId: ALL_WORKSPACES, automationId: '', statuses: [], period: DEFAULT_PERIOD, appliedAt: Date.now(), customFrom: '', customTo: '', refresh: 0 });

/**
 * Filtros na URL (F5): voltar do detalhe ou recarregar reabre a lista com os MESMOS filtros e os MESMOS limites de período
 * (nos relativos vai o instante de início já calculado, `desde`; no personalizado, `de`/`ate` em ISO UTC). Parâmetros:
 * workspace, automacao, estado (repetido), periodo, desde, de, ate. Valores desconhecidos são ignorados.
 */
function filtersFromUrl(sp: URLSearchParams): Filters {
  const f = defaultFilters();
  const period = sp.get('periodo');
  if (period && (PERIOD_PRESETS as string[]).includes(period)) f.period = period as PeriodPreset;
  const desde = sp.get('desde');
  const applied = desde ? presetAppliedAt(f.period, desde) : undefined;
  if (applied !== undefined) f.appliedAt = applied;
  const ws = sp.get('workspace');
  if (ws) f.workspaceId = ws;
  const auto = sp.get('automacao');
  if (auto) f.automationId = auto;
  f.statuses = STATUS_ORDER.filter((x) => sp.getAll('estado').includes(x));
  const de = sp.get('de');
  const ate = sp.get('ate');
  if (de && !Number.isNaN(Date.parse(de))) f.customFrom = isoToLocalInput(de);
  if (ate && !Number.isNaN(Date.parse(ate))) f.customTo = isoToLocalInput(ate);
  return f;
}

function filtersToUrl(f: Filters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.workspaceId !== ALL_WORKSPACES) sp.set('workspace', f.workspaceId);
  if (f.automationId) sp.set('automacao', f.automationId);
  for (const st of f.statuses) sp.append('estado', st);
  sp.set('periodo', f.period);
  const from = presetFrom(f.period, f.appliedAt);
  if (from) sp.set('desde', from);
  if (f.period === 'custom') {
    const de = f.customFrom ? localInputToIso(f.customFrom) : undefined;
    const ate = f.customTo ? localInputToIso(f.customTo) : undefined;
    if (de) sp.set('de', de);
    if (ate) sp.set('ate', ate);
  }
  return sp;
}

/** Limites enviados (ISO em UTC) e o erro de validação local, se houver. */
function queryRange(f: Filters): { from?: string; to?: string; error: string | null } {
  if (f.period !== 'custom') return { from: presetFrom(f.period, f.appliedAt), error: null };
  const from = f.customFrom ? localInputToIso(f.customFrom) : undefined;
  const to = f.customTo ? localInputToIso(f.customTo) : undefined;
  return { from, to, error: customRangeError(from, to) };
}

/**
 * Lista de execuções (L06) da área interna. Só consulta e acompanha: sem executar, cancelar ou reagendar (fora da v1
 * desta etapa). Cada linha leva ao detalhe da execução por um link real (teclado, nova aba).
 *
 * - Filtros: workspace (entre os visíveis), estado (vários) e período. Padrão PROPOSTO: últimos 30 dias, indicado e
 *   editável. Limites enviados em ISO UTC; `from` inclusivo, `to` exclusivo.
 * - Paginação por cursor ("carregar mais"), sem total nem número de página. Trocar filtros limpa a lista e descarta
 *   respostas antigas (useCursorList). Cursor recusado mantém os itens e oferece recomeçar; resposta fora do contrato
 *   não acrescenta itens (o cliente valida antes); nada é repetido automaticamente.
 * - 401 = sessão expirada (leitura de sessão) → fluxo de sessão expirada.
 */
export function ExecutionsPage() {
  const { org } = useSession();
  const { workspaces, loadMoreWorkspaces, restartWorkspaces } = useInternalArea();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => filtersFromUrl(searchParams));
  /** Último endereço escrito por esta tela: mudança externa da URL (ex.: menu) reabre os filtros a partir dela. */
  const written = useRef<string | null>(null);
  const range = queryRange(filters);
  /** Estado de volta dos links: o endereço com os filtros EM VIGOR (não o da barra, que é gravado logo depois). */
  const backState = { back: `${orgPath.executions(org)}?${filtersToUrl(filters).toString()}` };

  // A ordem importa: a detecção de mudança externa roda antes da escrita, para nunca comparar a URL antiga com a
  // que acabou de ser pedida no mesmo ciclo.
  // Efeitos de layout (FRONT-V1-004): rodam na própria confirmação da renderização. Com useEffect, uma navegação que
  // chegasse entre a renderização e o efeito (ex.: clique logo depois de abrir) fazia o efeito pendente rodar com a URL
  // ANTIGA e o `replace` da escrita apagava a navegação nova (filtro voltava ao anterior). Visto como falha intermitente
  // de f5.test.tsx ("troca do filtro de automação com respostas fora de ordem") com a suíte inteira em paralelo.
  useLayoutEffect(() => {
    const current = searchParams.toString();
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
      workspaceId: filters.workspaceId === ALL_WORKSPACES ? undefined : filters.workspaceId,
      automationId: filters.automationId || undefined,
      status: filters.statuses.length ? [...filters.statuses] : undefined,
      from: range.from,
      to: range.to,
    }),
    [filters.workspaceId, filters.automationId, filters.statuses, range.from, range.to],
  );
  // o contador de "Atualizar" faz parte da chave: uma única mudança de chave por clique (o início recalculado dos
  // períodos relativos e o contador mudam na MESMA atualização de estado → uma requisição só)
  const queryKey = range.error ? 'invalido' : JSON.stringify([query, filters.refresh]);

  const list = useCursorList<Execution>(
    async (cursor) => {
      if (range.error) return { items: [], nextCursor: null }; // período inválido: nada é enviado
      return listExecutions(org, { ...query, limit: PAGE_SIZE, cursor });
    },
    (e) => e.executionId,
    [org, queryKey],
  );

  // 401 da lista OU da leitura auxiliar da automação (filtro) encerra a sessão
  useExpiresOn(list.error, errorOf(automation));

  const workspaceName = useMemo(() => new Map(workspaces.items.map((w) => [w.workspaceId, w.name])), [workspaces.items]);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const toggleStatus = (s: ExecutionStatus, on: boolean) =>
    setFilters((f) => ({ ...f, statuses: on ? STATUS_ORDER.filter((x) => x === s || f.statuses.includes(x)) : f.statuses.filter((x) => x !== s) }));

  const columns: TableColumn<Execution>[] = [
    {
      key: 'automacao',
      header: 'Automação',
      render: (e) => (
        <span className="pw-exec__automation">
          <RouteLink
            to={orgPath.execution(org, e.executionId)}
            state={backState}
            aria-label={`Execução de ${e.automation.name}, criada em ${formatDateTime(e.createdAt).text}`}
          >
            {e.automation.name}
          </RouteLink>
          <span className="pw-exec__muted">versão {e.automationVersion.versionNumber}</span>
        </span>
      ),
    },
    {
      key: 'workspace',
      header: 'Workspace',
      render: (e) => (
        <RouteLink to={orgPath.workspace(org, e.workspaceId)} state={backState} variant="default">
          {workspaceName.get(e.workspaceId) ?? `Workspace ${e.workspaceId.slice(0, 8)}`}
        </RouteLink>
      ),
    },
    {
      key: 'estado',
      header: 'Estado',
      render: (e) => (
        <span className="pw-exec__status">
          <Badge tone={STATUS_TONE[e.status]} size="sm">
            {STATUS_LABEL[e.status]}
          </Badge>
          {e.statusReason && REASON_LABEL[e.statusReason] && <span className="pw-exec__muted">{REASON_LABEL[e.statusReason]}</span>}
        </span>
      ),
    },
    { key: 'origem', header: 'Origem', render: (e) => ORIGIN_LABEL[e.origin] },
    { key: 'criada', header: 'Criada em', render: (e) => <DateTimeText iso={e.createdAt} /> },
    { key: 'inicio', header: 'Início', render: (e) => <DateTimeText iso={e.startedAt} /> },
    {
      key: 'termino',
      header: 'Término',
      render: (e) =>
        e.finishedAt ? <DateTimeText iso={e.finishedAt} /> : <span className="pw-exec__muted">{e.startedAt ? 'em andamento' : '—'}</span>,
    },
    {
      key: 'duracao',
      header: 'Duração',
      align: 'right',
      render: (e) => (e.durationMs === null ? <span aria-label="não informado">—</span> : formatDuration(e.durationMs)),
    },
  ];

  const periodText =
    filters.period === 'custom'
      ? range.error
        ? null
        : `${range.from ? `De ${formatDateTime(range.from).text}` : 'Desde o início'} ${range.to ? `até ${formatDateTime(range.to).text} (exclusivo)` : 'até agora'} · ${tzOffset}`
      : range.from
        ? `Desde ${formatDateTime(range.from).text} (${tzOffset}). Execuções anteriores ficam fora do período; altere-o para ver mais.`
        : 'Sem limite de período: todo o histórico dos workspaces visíveis.';

  const noWorkspaces = workspaces.status === 'ready' && workspaces.complete && workspaces.items.length === 0;
  const errorTitle = (e: unknown) =>
    e instanceof ContractViolation
      ? 'A resposta do servidor veio fora do formato esperado.'
      : isApiError(e, 'not_found')
        ? filters.automationId
          ? 'Automação ou workspace não encontrado ou sem acesso.'
          : 'Workspace não encontrado ou sem acesso.'
        : isApiError(e, 'invalid_request')
          ? 'Algum filtro não foi aceito.'
          : commonMessage(e).title;

  return (
    <Stack gap={5}>
      <Card variant="surface" padding="md">
        <form className="pw-exec__filters" aria-label="Filtros de execuções" onSubmit={(e) => e.preventDefault()}>
          <Grid columns={3} minColumnWidth="220px" gap={4}>
            <Select
              label="Workspace"
              value={filters.workspaceId}
              onChange={(e) => set({ workspaceId: e.target.value })}
              disabled={workspaces.status === 'loading'}
              hint={
                workspaces.status === 'loading'
                  ? 'Carregando workspaces…'
                  : workspaces.status === 'error'
                    ? 'Não foi possível carregar a lista de workspaces.'
                    : undefined
              }
              options={[
                { value: ALL_WORKSPACES, label: 'Todos os workspaces visíveis' },
                ...workspaces.items.map((w) => ({ value: w.workspaceId, label: w.name })),
                // workspace vindo do endereço e ainda fora da parte carregada da lista
                ...(filters.workspaceId !== ALL_WORKSPACES && !workspaces.items.some((w) => w.workspaceId === filters.workspaceId)
                  ? [{ value: filters.workspaceId, label: `Workspace ${filters.workspaceId.slice(0, 8)}` }]
                  : []),
              ]}
              fullWidth
            />
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
            <div className="pw-exec__actions">
              <Button
                variant="secondary"
                size="sm"
                leftIcon="refresh"
                onClick={() => setFilters((f) => ({ ...f, appliedAt: Date.now(), refresh: f.refresh + 1 }))}
              >
                Atualizar
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setFilters(defaultFilters())}>
                Limpar filtros
              </Button>
            </div>
          </Grid>
          {workspaces.status === 'ready' && !workspaces.complete && (
            <div className="pw-exec__more-ws">
              {workspaces.cursorRejected ? (
                <>
                  <Text variant="body-sm" color="secondary" as="span">
                    A continuação da lista de workspaces deixou de valer (a lista mudou ou a continuação expirou).{' '}
                    {workspaces.items.length} workspaces carregados.
                    {workspaces.moreError != null && ' Não foi possível recomeçar.'}
                  </Text>
                  <Button variant="ghost" size="sm" leftIcon="refresh" loading={workspaces.loadingMore} onClick={restartWorkspaces}>
                    Recomeçar lista de workspaces
                  </Button>
                </>
              ) : (
                <>
                  <Text variant="body-sm" color="secondary" as="span">
                    Lista parcial: {workspaces.items.length} workspaces carregados; há mais.
                    {workspaces.moreError != null && ' Não foi possível carregar a próxima parte.'}
                  </Text>
                  <Button variant="ghost" size="sm" loading={workspaces.loadingMore} onClick={loadMoreWorkspaces}>
                    Carregar mais workspaces
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
          {filters.period === 'custom' && (
            <Grid columns={2} minColumnWidth="220px" gap={4}>
              <Input
                type="datetime-local"
                label="Início (inclusivo)"
                value={filters.customFrom}
                onChange={(e) => set({ customFrom: e.target.value })}
                hint={`Hora local (${tzOffset})`}
                fullWidth
              />
              <Input
                type="datetime-local"
                label="Fim (exclusivo)"
                value={filters.customTo}
                onChange={(e) => set({ customTo: e.target.value })}
                hint={`Hora local (${tzOffset})`}
                fullWidth
              />
            </Grid>
          )}
          <Fieldset legend="Estado" variant="plain" description="Nenhum marcado = todos os estados.">
            <div className="pw-exec__statuses">
              {STATUS_ORDER.map((s) => (
                <Checkbox key={s} label={STATUS_LABEL[s]} checked={filters.statuses.includes(s)} onChange={(e) => toggleStatus(s, e.target.checked)} />
              ))}
            </div>
          </Fieldset>
          {range.error ? (
            <Alert tone="warning" title="Período inválido">
              {range.error} Nenhuma consulta foi enviada.
            </Alert>
          ) : (
            <Text variant="body-sm" color="secondary" className="pw-exec__period" role="note">
              <strong>Período: {PERIOD_LABEL[filters.period]}{filters.period === DEFAULT_PERIOD ? ' (padrão)' : ''}.</strong> {periodText}
            </Text>
          )}
        </form>
      </Card>

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
                ? 'O workspace escolhido não está disponível para você agora.'
                : commonMessage(list.error).description
          }
          actions={
            isApiError(list.error, 'not_found') && (filters.workspaceId !== ALL_WORKSPACES || filters.automationId) ? (
              <Button onClick={() => set({ workspaceId: ALL_WORKSPACES, automationId: '' })}>Ver todos os workspaces</Button>
            ) : (
              <Button onClick={list.reload}>Tentar novamente</Button>
            )
          }
        />
      ) : list.items.length === 0 ? (
        range.error ? null : noWorkspaces ? (
          <StateView status="neutral" title="Você ainda não tem acesso a nenhum workspace." description="Quando um administrador der acesso, as execuções aparecem aqui." />
        ) : (
          <StateView
            status="neutral"
            title="Nenhuma execução encontrada."
            description={filters.period !== 'all' ? 'Nada com esses filtros neste período. Amplie o período ou ajuste os filtros.' : 'Nada com esses filtros.'}
          />
        )
      ) : (
        <>
          {/* região rolável focável: no celular a tabela rola na horizontal e o teclado precisa alcançá-la */}
          <div className="pw-exec__scroll" role="region" aria-label="Lista de execuções" tabIndex={0}>
            <Table
              columns={columns}
              data={list.items}
              rowKey="executionId"
              size="sm"
              caption={`Execuções, da mais recente para a mais antiga. Horários no fuso deste navegador${tzName ? ` (${tzName})` : ''}, ${tzOffset}.`}
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
  );
}
