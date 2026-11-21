import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, Input, Link, SectionHeader, Select, Stack, StateView, Text } from 'nekkora-lib';
import { Link as RouterLink, useParams, useSearchParams } from 'react-router';
import {
  fetchSharedFile,
  getSharedSummary,
  listClientOrganizations,
  listSharedAutomations,
  listSharedExecutions,
  listSharedFiles,
  previewKind,
  PreviewError,
  sharedFileHref,
  type ClientOrganization,
  type SharedAutomation,
  type SharedExecution,
  type SharedFile,
  type SharedOutcome,
  type SharedSummary,
} from '../api/clientArea';
import { ApiError, isApiError } from '../api/http';
import { clientPath } from '../auth/organization';
import { useCursorList } from '../hooks/useCursorList';
import { useIdentityArea } from '../identity/IdentityArea';
import { DateTimeText } from '../pages/product/shared';
import './client.css';

/**
 * Área do cliente (PLATFORM-FLUXO-002, 070/071). A pessoa entra com a conta Nekkora e, em cada organização, vê SÓ o que foi
 * compartilhado com ela: o DASHBOARD de execução das automações (indicadores e o estado de cada execução em linguagem simples) e
 * os ARQUIVOS DE RETORNO autorizados (ver ou baixar), identificados pela automação e pela data da execução. Nada de registros
 * técnicos, máquinas, ambientes de trabalho ou ações. Tudo vem do Portal, que reconfere vínculo, concessões e o conteúdo a cada
 * consulta: revogar, reduzir ou suspender vale na próxima leitura. Relatórios personalizados ainda não existem.
 */

type Load<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: unknown };

function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[]): [Load<T>, () => void] {
  const { expired } = useIdentityArea();
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    fn().then(
      (data) => alive && setState({ status: 'ready', data }),
      (error: unknown) => {
        if (!alive) return;
        if (isApiError(error, 'unauthenticated')) return expired();
        setState({ status: 'error', error });
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return [state, () => setN((x) => x + 1)];
}

/** Recusas do Portal sem revelar o que não foi compartilhado (fora do escopo e inexistente respondem igual). */
function ClientError({ error, onRetry, forbidden }: { error: unknown; onRetry?: () => void; forbidden?: string }) {
  const title = isApiError(error, 'forbidden')
    ? (forbidden ?? 'Você não tem acesso de cliente nesta organização (ou ele foi suspenso).')
    : isApiError(error, 'not_found') || (error instanceof ApiError && error.status === 404)
      ? 'Não encontrado, ou não compartilhado com você.'
      : 'Não foi possível carregar agora.';
  return (
    <StateView
      status="warning"
      title={title}
      actions={
        <>
          <Link as={RouterLink} to={clientPath.home()}>
            Ver tudo o que foi compartilhado comigo
          </Link>
          {onRetry && (
            <Button size="sm" variant="ghost" onClick={onRetry}>
              Tentar de novo
            </Button>
          )}
        </>
      }
    />
  );
}

/**
 * O estado da execução em linguagem simples, sempre com texto (a cor nunca fala sozinha), SEM mudar o significado do estado
 * interno: "Concluída" é só o sucesso confirmado; código de saída zero sem confirmação de sucesso (no_error_signaled) continua
 * separado, assim como o resultado desconhecido (unconfirmed: não se sabe como terminou).
 */
export const CLIENT_OUTCOME: Record<SharedOutcome, { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' | 'warning' }> = {
  succeeded: { label: 'Concluída', tone: 'success' },
  failed: { label: 'Terminou com erro', tone: 'danger' },
  in_progress: { label: 'Em andamento', tone: 'info' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
  not_started: { label: 'Não iniciada', tone: 'neutral' },
  unconfirmed: { label: 'Resultado desconhecido', tone: 'warning' },
  no_error_signaled: { label: 'Terminou sem confirmação de sucesso', tone: 'neutral' },
};

function OutcomeBadge({ outcome }: { outcome: SharedOutcome | null }) {
  if (!outcome) return <span className="pw-prod__muted">Nenhuma execução</span>;
  const o = CLIENT_OUTCOME[outcome];
  return (
    <Badge tone={o.tone} dot>
      {o.label}
    </Badge>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sizeText = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

function Back({ to, children }: { to: string; children: ReactNode }) {
  return (
    <nav aria-label="Voltar">
      <Link as={RouterLink} to={to}>
        ← {children}
      </Link>
    </nav>
  );
}

/** Na lista de organizações da identidade: o que foi compartilhado com a pessoa como cliente (some se não houver nada). */
export function SharedWithYouSection() {
  const [orgs, setOrgs] = useState<ClientOrganization[] | null>(null);
  useEffect(() => {
    let alive = true;
    listClientOrganizations().then(
      (o) => alive && setOrgs(o),
      () => alive && setOrgs([]),
    );
    return () => {
      alive = false;
    };
  }, []);
  if (!orgs || orgs.length === 0) return null;
  return (
    <section aria-labelledby="compartilhado-comigo" className="pw-client__section">
      <Text as="h2" variant="h3" id="compartilhado-comigo">
        Compartilhado com você
      </Text>
      <ul className="pw-client__orgs">
        {orgs.map((o) => (
          <li key={o.organizationId}>
            <Card variant="outlined" padding="md">
              <div className="pw-client__org">
                <div>
                  <Text as="h3" variant="h4">
                    {o.organizationName}
                  </Text>
                  <Text variant="body-sm" color="secondary">
                    {plural(o.sharedAutomations, 'automação compartilhada', 'automações compartilhadas')}
                  </Text>
                </div>
                <Link as={RouterLink} to={clientPath.organization(o.organizationId)} arrow>
                  Acompanhar
                </Link>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** /cliente — tudo o que foi compartilhado com a pessoa, por organização. */
export function ClientHomePage() {
  const [state, retry] = useLoad(() => listClientOrganizations(), []);
  return (
    <Stack gap={5} className="pw-client">
      <SectionHeader as="h1" title="Compartilhado com você" description="Dashboards de execução e arquivos de retorno que organizações compartilharam com você." />
      {state.status === 'loading' ? (
        <StateView status="loading" title="Carregando…" />
      ) : state.status === 'error' ? (
        <ClientError error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <StateView status="neutral" title="Nenhuma automação compartilhada com você" />
      ) : (
        <SharedWithYouSection />
      )}
    </Stack>
  );
}

/** Um indicador: número grande e o rótulo (sem cor; o estado vem só nos selos com texto). */
function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="pw-client__stat">
      <span className="pw-client__stat-value">{value}</span>
      <span className="pw-client__stat-label">{label}</span>
    </div>
  );
}

/** /cliente/o/:orgId — dashboards de execução (cards por automação) e o acesso aos arquivos de retorno. */
export function ClientOrganizationPage() {
  const { orgId = '' } = useParams();
  const [state, retry] = useLoad(() => listSharedAutomations(orgId), [orgId]);
  const withFiles = state.status === 'ready' ? state.data.filter((a) => a.canDownloadResults) : [];
  const filesTotal = withFiles.reduce((n, a) => n + (a.filesAvailable ?? 0), 0);
  return (
    <Stack gap={5} className="pw-client">
      <Back to={clientPath.home()}>Compartilhado com você</Back>
      <SectionHeader
        as="h1"
        title="Dashboards de execução"
        description={state.status === 'ready' && state.data[0] ? `Compartilhado com ${state.data[0].clientName}. Indicadores dos últimos 30 dias.` : undefined}
      />
      {state.status === 'loading' ? (
        <StateView status="loading" title="Carregando automações…" />
      ) : state.status === 'error' ? (
        <ClientError error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <StateView status="neutral" title="Nenhuma automação compartilhada com você" />
      ) : (
        <>
          {withFiles.length > 0 && (
            <Card variant="surface" padding="md">
              <div className="pw-client__org">
                <div>
                  <Text as="h2" variant="h4">
                    Arquivos de retorno
                  </Text>
                  <Text variant="body-sm" color="secondary">
                    {plural(filesTotal, 'arquivo disponível', 'arquivos disponíveis')} de {plural(withFiles.length, 'automação', 'automações')}
                  </Text>
                </div>
                <Link as={RouterLink} to={clientPath.files(orgId)} arrow>
                  Ver arquivos de retorno
                </Link>
              </div>
            </Card>
          )}
          <ul className="pw-client__cards" aria-label="Automações compartilhadas">
            {state.data.map((a) => (
              <li key={a.automationId}>
                <AutomationCard org={orgId} a={a} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Stack>
  );
}

function AutomationCard({ org, a }: { org: string; a: SharedAutomation }) {
  const d = a.dashboard;
  return (
    <Card variant="outlined" padding="md" className="pw-client__card">
      <Stack gap={3}>
        <Text as="h2" variant="h4">
          {a.name}
        </Text>
        {d ? (
          <>
            <div className="pw-client__card-row">
              <OutcomeBadge outcome={d.lastOutcome} />
              {d.lastRequestedAt && (
                <Text variant="body-sm" color="secondary">
                  última em <DateTimeText iso={d.lastRequestedAt} />
                </Text>
              )}
            </div>
            <div className="pw-client__stats" aria-label={`Indicadores de ${a.name} nos últimos 30 dias`} role="group">
              <Stat value={d.executionsLast30Days} label="execuções" />
              <Stat value={d.succeededLast30Days} label="concluídas" />
              <Stat value={d.failedLast30Days} label="com erro" />
              <Stat value={d.inProgress} label="em andamento" />
            </div>
            <Link as={RouterLink} to={clientPath.automation(org, a.automationId)} arrow aria-label={`Ver o dashboard de ${a.name}`}>
              Ver dashboard
            </Link>
          </>
        ) : (
          <Text variant="body-sm" color="secondary">
            O dashboard desta automação não foi compartilhado com você.
          </Text>
        )}
        {a.canDownloadResults && (
          <Link as={RouterLink} to={clientPath.files(org, a.automationId)} arrow aria-label={`Ver os arquivos de retorno de ${a.name}`}>
            {plural(a.filesAvailable ?? 0, 'arquivo de retorno', 'arquivos de retorno')}
          </Link>
        )}
      </Stack>
    </Card>
  );
}

const PERIODS = [
  { value: '7', label: 'Últimos 7 dias' },
  { value: '30', label: 'Últimos 30 dias' },
  { value: '90', label: 'Últimos 90 dias' },
  { value: '365', label: 'Últimos 12 meses' },
];
/** Período em dias (padrão 30) → [de, até) em ISO; até = agora (o Portal limita a 400 dias). */
function periodOf(days: string | null): { from: string; to: string; days: string } {
  const d = PERIODS.some((p) => p.value === days) ? days! : '30';
  const to = new Date(Date.now() + 1000);
  const from = new Date(to.getTime() - Number(d) * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString(), days: d };
}

/** /cliente/o/:orgId/automacoes/:automationId — o dashboard de UMA automação: resumo do período e as execuções. */
export function ClientAutomationPage() {
  const { orgId = '', automationId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const period = useMemo(() => periodOf(params.get('periodo')), [params]);
  const [info] = useLoad(() => listSharedAutomations(orgId).then((all) => all.find((a) => a.automationId === automationId) ?? null), [orgId, automationId]);
  const [summary, retrySummary] = useLoad<SharedSummary>(() => getSharedSummary(orgId, automationId, period), [orgId, automationId, period.days]);
  const executions = useCursorList<SharedExecution>(
    (cursor) => listSharedExecutions(orgId, automationId, { from: period.from, to: period.to, cursor, limit: 25 }),
    (e) => e.id,
    [orgId, automationId, period.days],
  );
  const automation = info.status === 'ready' ? info.data : null;
  if (info.status === 'ready' && !automation) return <ClientError error={new ApiError('not_found', 404)} />;
  return (
    <Stack gap={5} className="pw-client">
      <Back to={clientPath.organization(orgId)}>Dashboards de execução</Back>
      {info.status === 'error' ? (
        <ClientError error={info.error} />
      ) : (
        <>
          <SectionHeader as="h1" title={automation?.name ?? 'Automação'} description="Dashboard de execução" />
          <div className="pw-client__toolbar">
            <Select
              label="Período"
              value={period.days}
              onChange={(e) => setParams((p) => (p.set('periodo', e.target.value), p), { replace: true })}
              options={PERIODS}
            />
            {automation?.canDownloadResults && (
              <Link as={RouterLink} to={clientPath.files(orgId, automationId)} arrow>
                Arquivos de retorno desta automação
              </Link>
            )}
          </div>
          {summary.status === 'loading' ? (
            <StateView status="loading" title="Carregando indicadores…" />
          ) : summary.status === 'error' ? (
            <ClientError error={summary.error} onRetry={retrySummary} forbidden="O dashboard desta automação não foi compartilhado com você." />
          ) : (
            <Card variant="surface" padding="md">
              <div className="pw-client__stats pw-client__stats--wide" role="group" aria-label="Indicadores do período">
                <Stat value={summary.data.total} label="execuções" />
                <Stat value={summary.data.succeeded} label="concluídas" />
                <Stat value={summary.data.failed} label="com erro" />
                <Stat value={summary.data.inProgress} label="em andamento" />
                <Stat value={summary.data.noErrorSignaled} label="sem confirmação de sucesso" />
                <Stat value={summary.data.unconfirmed} label="resultado desconhecido" />
                <Stat value={summary.data.notStarted + summary.data.cancelled} label="não iniciadas ou canceladas" />
              </div>
            </Card>
          )}
          {summary.status === 'ready' &&
            (executions.status === 'loading' ? (
              <StateView status="loading" title="Carregando execuções…" />
            ) : executions.status === 'error' ? (
              <ClientError error={executions.error} onRetry={executions.reload} />
            ) : executions.items.length === 0 ? (
              <StateView status="neutral" title="Nenhuma execução neste período." />
            ) : (
              <section aria-labelledby="execucoes-titulo">
                <Stack gap={3}>
                  <Text as="h2" variant="h4" id="execucoes-titulo">
                    Execuções
                  </Text>
                  <ul className="pw-client__executions" aria-label="Execuções">
                    {executions.items.map((e) => (
                      <li key={e.id}>
                        <Card variant="outlined" padding="sm">
                          <div className="pw-client__execution">
                            <OutcomeBadge outcome={e.outcome} />
                            <Text variant="body-sm">
                              Pedida em <DateTimeText iso={e.requestedAt} />
                            </Text>
                            <Text variant="body-sm" color="secondary">
                              {e.endedAt ? (
                                <>
                                  Terminou em <DateTimeText iso={e.endedAt} />
                                </>
                              ) : e.startedAt ? (
                                <>
                                  Começou em <DateTimeText iso={e.startedAt} />
                                </>
                              ) : (
                                'Ainda não começou'
                              )}
                            </Text>
                            {e.files !== null && e.files > 0 && (
                              <Link as={RouterLink} to={clientPath.files(orgId, automationId)}>
                                {plural(e.files, 'arquivo de retorno', 'arquivos de retorno')}
                              </Link>
                            )}
                          </div>
                        </Card>
                      </li>
                    ))}
                  </ul>
                  {executions.hasMore && (
                    <div>
                      <Button variant="secondary" loading={executions.status === 'loading-more'} onClick={executions.loadMore}>
                        Carregar mais
                      </Button>
                    </div>
                  )}
                </Stack>
              </section>
            ))}
        </>
      )}
    </Stack>
  );
}

type Preview = { file: SharedFile; state: 'loading' } | { file: SharedFile; state: 'text'; text: string } | { file: SharedFile; state: 'blob'; url: string; kind: 'image' | 'pdf' } | { file: SharedFile; state: 'error'; text: string };

/** /cliente/o/:orgId/arquivos — arquivos de retorno autorizados: por automação, período e nome; ver na página ou baixar. */
export function ClientFilesPage() {
  const { orgId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const automationId = params.get('automacao') ?? '';
  const q = params.get('q') ?? '';
  const period = useMemo(() => periodOf(params.get('periodo') ?? '90'), [params]);
  const [search, setSearch] = useState(q);
  const [automations] = useLoad(() => listSharedAutomations(orgId), [orgId]);
  const files = useCursorList<SharedFile>(
    (cursor) => listSharedFiles(orgId, { automationId: automationId || undefined, from: period.from, to: period.to, q: q || undefined, cursor, limit: 25 }),
    (f) => `${f.attemptId}:${f.number}`,
    [orgId, automationId, q, period.days],
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => () => (preview?.state === 'blob' ? URL.revokeObjectURL(preview.url) : undefined), [preview]);
  const set = (k: string, v: string) => setParams((p) => (v ? p.set(k, v) : p.delete(k), p), { replace: true });
  const options = automations.status === 'ready' ? automations.data.filter((a) => a.canDownloadResults) : [];

  const view = async (f: SharedFile) => {
    setPreview({ file: f, state: 'loading' });
    try {
      const r = await fetchSharedFile(orgId, f.attemptId, f.number, f.fileName);
      if ('text' in r) setPreview({ file: f, state: 'text', text: r.text });
      else setPreview({ file: f, state: 'blob', url: URL.createObjectURL(r.blob), kind: previewKind(f.fileName) === 'pdf' ? 'pdf' : 'image' });
    } catch (e) {
      const s = e instanceof PreviewError ? e.status : 0;
      setPreview({
        file: f,
        state: 'error',
        text:
          s === 413
            ? 'Arquivo grande demais para ver na página. Use Baixar.'
            : s === 403 || s === 404
              ? 'Este arquivo não está mais compartilhado com você.'
              : s === 409
                ? 'Este arquivo foi removido pelo prazo de guarda.'
                : 'Não foi possível abrir o arquivo agora.',
      });
    }
  };

  return (
    <Stack gap={5} className="pw-client">
      <Back to={clientPath.organization(orgId)}>Dashboards de execução</Back>
      <SectionHeader as="h1" title="Arquivos de retorno" description="Resultados das automações compartilhadas com você, pela data da execução." />
      <Card variant="surface" padding="md">
        <form
          className="pw-client__toolbar"
          aria-label="Filtros de arquivos"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            set('q', search.trim());
          }}
        >
          {options.length > 0 && (
            <Select
              label="Automação"
              value={automationId}
              onChange={(e) => set('automacao', e.target.value)}
              options={[{ value: '', label: 'Todas' }, ...options.map((a) => ({ value: a.automationId, label: a.name }))]}
            />
          )}
          <Select label="Período da execução" value={period.days} onChange={(e) => set('periodo', e.target.value)} options={PERIODS} />
          <Input label="Nome do arquivo" type="search" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
          <Button type="submit" variant="secondary">
            Buscar
          </Button>
        </form>
      </Card>
      {files.status === 'loading' ? (
        <StateView status="loading" title="Carregando arquivos…" />
      ) : files.status === 'error' ? (
        <ClientError error={files.error} onRetry={files.reload} forbidden="Os arquivos de retorno desta automação não foram compartilhados com você." />
      ) : files.items.length === 0 ? (
        <StateView status="neutral" title="Nenhum arquivo de retorno com esses filtros." />
      ) : (
        <>
          <ul className="pw-client__files" aria-label="Arquivos de retorno">
            {files.items.map((f) => (
              <li key={`${f.attemptId}:${f.number}`}>
                <Card variant="outlined" padding="sm">
                  <div className="pw-client__execution">
                    <span className="pw-client__file">
                      <Text>{f.fileName}</Text>
                      <Text variant="body-sm" color="secondary">
                        {f.automation.name} · execução de <DateTimeText iso={f.executionRequestedAt} /> · {sizeText(f.sizeBytes)}
                      </Text>
                    </span>
                    {f.available ? (
                      <span className="pw-client__file-actions">
                        {previewKind(f.fileName) && (
                          <Button size="sm" variant="ghost" onClick={() => void view(f)} aria-label={`Visualizar ${f.fileName}`}>
                            Visualizar
                          </Button>
                        )}
                        <a className="pw-client__download" href={sharedFileHref(orgId, f.attemptId, f.number)} download aria-label={`Baixar ${f.fileName}`}>
                          Baixar
                        </a>
                      </span>
                    ) : (
                      <Text variant="body-sm" color="secondary">
                        Removido pelo prazo de guarda
                      </Text>
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
          {files.hasMore && (
            <div>
              <Button variant="secondary" loading={files.status === 'loading-more'} onClick={files.loadMore}>
                Carregar mais
              </Button>
            </div>
          )}
        </>
      )}
      {preview && (
        <Card variant="outlined" padding="md">
          <section aria-labelledby="visualizacao-titulo">
            <Stack gap={3}>
              <div className="pw-client__org">
                <Text as="h2" variant="h4" id="visualizacao-titulo">
                  {preview.file.fileName}
                </Text>
                <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                  Fechar visualização
                </Button>
              </div>
              {preview.state === 'loading' && <Text color="secondary">Abrindo…</Text>}
              {preview.state === 'error' && <Alert tone="warning">{preview.text}</Alert>}
              {preview.state === 'text' && (
                <pre className="pw-client__preview" tabIndex={0} aria-label={`Conteúdo de ${preview.file.fileName}`}>
                  {preview.text}
                </pre>
              )}
              {preview.state === 'blob' && preview.kind === 'image' && <img className="pw-client__image" src={preview.url} alt={`Conteúdo de ${preview.file.fileName}`} />}
              {preview.state === 'blob' && preview.kind === 'pdf' && (
                <iframe className="pw-client__pdf" src={preview.url} title={`Conteúdo de ${preview.file.fileName}`} />
              )}
            </Stack>
          </section>
        </Card>
      )}
    </Stack>
  );
}
