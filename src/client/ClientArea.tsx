import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, Link, SectionHeader, Stack, StateView, Text } from 'nekkora-lib';
import { Link as RouterLink, useParams } from 'react-router';
import {
  getSharedExecution,
  getSharedLogs,
  getSharedResults,
  listClientOrganizations,
  listSharedAutomations,
  listSharedExecutions,
  sharedResultHref,
  type ClientOrganization,
  type ExecutionKind,
  type SharedAttempt,
  type SharedAutomation,
  type SharedExecution,
  type SharedExecutionDetail,
  type SharedLogs,
  type SharedResults,
} from '../api/clientArea';
import { ApiError, isApiError } from '../api/http';
import { clientPath } from '../auth/organization';
import { useCursorList } from '../hooks/useCursorList';
import { useIdentityArea } from '../identity/IdentityArea';
import { DateTimeText } from '../pages/product/shared';
import { OUTCOME } from '../pages/ExecutionsPage';
import './client.css';

/**
 * Área do cliente (PLATFORM-FLUXO-002, 070). A pessoa entra com a conta Nekkora; em cada organização vê SÓ o que foi
 * compartilhado com ela: automações (cards) → automação e execuções → execução, com registros e resultados quando
 * concedidos separadamente. Tudo vem do Portal, que reconfere vínculo e concessões a cada consulta: revogar ou suspender vale na
 * próxima leitura. A máquina aparece só como contexto da execução (sem acesso à administração dela nem às outras atividades).
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
function ClientError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const title = isApiError(error, 'forbidden')
    ? 'Você não tem acesso de cliente nesta organização (ou ele foi suspenso).'
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

function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return <span className="pw-prod__muted">—</span>;
  const o = OUTCOME[outcome as keyof typeof OUTCOME];
  return (
    <Badge tone={o?.tone ?? 'neutral'} dot>
      {o?.label ?? outcome}
    </Badge>
  );
}

const machinesText = (a: Pick<SharedAutomation, 'allMachines' | 'machines'>) =>
  a.allMachines ? 'Todas as máquinas desta automação' : a.machines.map((m) => m.name).join(', ');
const permissionsText = (a: { canReadLogs: boolean; canDownloadResults: boolean }) =>
  [a.canReadLogs ? 'registros' : null, a.canDownloadResults ? 'resultados' : null].filter(Boolean).join(' e ') || 'só as execuções';

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
                    Cliente {o.clientName} · {o.sharedAutomations === 1 ? '1 automação' : `${o.sharedAutomations} automações`}
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
      <SectionHeader as="h1" title="Compartilhado com você" description="Automações que organizações compartilharam com você para acompanhamento." />
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

/** /cliente/o/:orgId — cards das automações compartilhadas nesta organização. */
export function ClientOrganizationPage() {
  const { orgId = '' } = useParams();
  const [state, retry] = useLoad(() => listSharedAutomations(orgId), [orgId]);
  return (
    <Stack gap={5} className="pw-client">
      <Back to={clientPath.home()}>Compartilhado com você</Back>
      <SectionHeader as="h1" title="Automações compartilhadas" description={state.status === 'ready' && state.data[0] ? `Cliente ${state.data[0].clientName}` : undefined} />
      {state.status === 'loading' ? (
        <StateView status="loading" title="Carregando automações…" />
      ) : state.status === 'error' ? (
        <ClientError error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <StateView status="neutral" title="Nenhuma automação compartilhada com você" />
      ) : (
        <ul className="pw-client__cards" aria-label="Automações compartilhadas">
          {state.data.map((a) => (
            <li key={a.automationId}>
              <Card variant="outlined" padding="md" className="pw-client__card">
                <Stack gap={2}>
                  <Text as="h2" variant="h4">
                    {a.name}
                  </Text>
                  <Text variant="body-sm" color="secondary">
                    {a.workspaceName} · {machinesText(a)}
                  </Text>
                  <div className="pw-client__card-row">
                    <OutcomeBadge outcome={a.lastOutcome} />
                    {a.lastRequestedAt && (
                      <Text variant="body-sm" color="secondary">
                        última em <DateTimeText iso={a.lastRequestedAt} />
                      </Text>
                    )}
                  </div>
                  <Text variant="body-sm" color="secondary">
                    {a.executionsLast30Days === 1 ? '1 execução' : `${a.executionsLast30Days} execuções`} nos últimos 30 dias · você vê {permissionsText(a)}
                  </Text>
                  <Link as={RouterLink} to={clientPath.automation(orgId, a.automationId)} arrow aria-label={`Ver ${a.name}`}>
                    Ver execuções
                  </Link>
                </Stack>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </Stack>
  );
}

/** /cliente/o/:orgId/automacoes/:automationId — o que foi compartilhado da automação e as execuções dela. */
export function ClientAutomationPage() {
  const { orgId = '', automationId = '' } = useParams();
  const [info] = useLoad(() => listSharedAutomations(orgId).then((all) => all.find((a) => a.automationId === automationId) ?? null), [orgId, automationId]);
  const executions = useCursorList<SharedExecution>((cursor) => listSharedExecutions(orgId, automationId, { cursor, limit: 25 }), (e) => `${e.kind}:${e.id}`, [
    orgId,
    automationId,
  ]);
  const automation = info.status === 'ready' ? info.data : null;
  if (info.status === 'ready' && !automation) return <ClientError error={new ApiError('not_found', 404)} />;
  return (
    <Stack gap={5} className="pw-client">
      <Back to={clientPath.organization(orgId)}>Automações compartilhadas</Back>
      {info.status === 'error' ? (
        <ClientError error={info.error} />
      ) : (
        <>
          <SectionHeader
            as="h1"
            title={automation?.name ?? 'Automação'}
            description={automation ? `${automation.workspaceName} · ${machinesText(automation)} · você vê ${permissionsText(automation)}` : undefined}
          />
          {executions.status === 'loading' ? (
            <StateView status="loading" title="Carregando execuções…" />
          ) : executions.status === 'error' ? (
            <ClientError error={executions.error} onRetry={executions.reload} />
          ) : executions.items.length === 0 ? (
            <StateView status="neutral" title="Nenhuma execução ainda." />
          ) : (
            <>
              <ul className="pw-client__executions" aria-label="Execuções">
                {executions.items.map((e) => (
                  <li key={`${e.kind}:${e.id}`}>
                    <Card variant="outlined" padding="sm">
                      <div className="pw-client__execution">
                        <OutcomeBadge outcome={e.outcome} />
                        <Text variant="body-sm">
                          Pedida em <DateTimeText iso={e.requestedAt} />
                        </Text>
                        <Text variant="body-sm" color="secondary">
                          {e.machine ? `Máquina ${e.machine.name}` : 'Sem máquina registrada'}
                        </Text>
                        <Link as={RouterLink} to={clientPath.execution(orgId, e.kind, e.id)} arrow>
                          Detalhes
                        </Link>
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
            </>
          )}
        </>
      )}
    </Stack>
  );
}

/** /cliente/o/:orgId/execucoes/:kind/:id — estado, horários e, quando concedidos, registros e resultados. */
export function ClientExecutionPage() {
  const { orgId = '', kind = '', id = '' } = useParams();
  const [state, retry] = useLoad(() => getSharedExecution(orgId, kind as ExecutionKind, id), [orgId, kind, id]);
  if (state.status === 'loading') return <StateView status="loading" title="Carregando execução…" />;
  if (state.status === 'error')
    return (
      <Stack gap={5} className="pw-client">
        <Back to={clientPath.organization(orgId)}>Automações compartilhadas</Back>
        <ClientError error={state.error} onRetry={retry} />
      </Stack>
    );
  const e: SharedExecutionDetail = state.data;
  return (
    <Stack gap={5} className="pw-client">
      <Back to={clientPath.automation(orgId, e.automation.automationId)}>{e.automation.name}</Back>
      <SectionHeader as="h1" title={`Execução de ${e.automation.name}`} />
      <Card variant="outlined" padding="md">
        <dl className="pw-client__facts">
          <dt>Situação</dt>
          <dd>
            <OutcomeBadge outcome={e.outcome} />
          </dd>
          <dt>Pedida em</dt>
          <dd>
            <DateTimeText iso={e.requestedAt} />
          </dd>
          <dt>Início</dt>
          <dd>
            <DateTimeText iso={e.startedAt} />
          </dd>
          <dt>Fim</dt>
          <dd>
            <DateTimeText iso={e.endedAt} />
          </dd>
          <dt>Máquina</dt>
          <dd>{e.machine?.name ?? 'Sem máquina registrada para esta execução.'}</dd>
        </dl>
      </Card>
      {e.attempts.length === 0 ? (
        <Text color="secondary">Esta execução não tem registros nem arquivos de resultado enviados à Platform.</Text>
      ) : (
        e.attempts.map((a) => <AttemptSection key={a.attemptId} org={orgId} execution={e.id} attempt={a} many={e.attempts.length > 1} />)
      )}
    </Stack>
  );
}

function AttemptSection({ org, execution, attempt, many }: { org: string; execution: string; attempt: SharedAttempt; many: boolean }) {
  const [logs] = useLoad<SharedLogs | null>(() => (attempt.canReadLogs ? getSharedLogs(org, execution, attempt.attemptId) : Promise.resolve(null)), [attempt.attemptId]);
  const [results] = useLoad<SharedResults | null>(
    () => (attempt.canDownloadResults ? getSharedResults(org, execution, attempt.attemptId) : Promise.resolve(null)),
    [attempt.attemptId],
  );
  return (
    <section aria-labelledby={`tentativa-${attempt.attemptId}`} className="pw-client__attempt">
      <Text as="h2" variant="h4" id={`tentativa-${attempt.attemptId}`}>
        {many ? `Tentativa ${attempt.number} · máquina ${attempt.workerName ?? '—'}` : `Na máquina ${attempt.workerName ?? '—'}`}
      </Text>
      <Card variant="surface" padding="md">
        <Stack gap={2}>
          <Text as="h3" variant="body" className="pw-client__subtitle">
            Registros
          </Text>
          {!attempt.canReadLogs ? (
            <Text color="secondary">Os registros não foram compartilhados com você.</Text>
          ) : logs.status === 'loading' ? (
            <Text color="secondary">Carregando registros…</Text>
          ) : logs.status === 'error' ? (
            <Alert tone="warning">Não foi possível carregar os registros.</Alert>
          ) : !logs.data || logs.data.items.length === 0 ? (
            <Text color="secondary">Nenhum registro enviado.</Text>
          ) : (
            <pre className="pw-client__logs" tabIndex={0} aria-label="Registros da execução">
              {logs.data.items.map((l) => (l.textRemoved ? '[texto removido pelo prazo de guarda]' : l.message)).join('\n')}
            </pre>
          )}
        </Stack>
      </Card>
      <Card variant="surface" padding="md">
        <Stack gap={2}>
          <Text as="h3" variant="body" className="pw-client__subtitle">
            Arquivos de resultado
          </Text>
          {!attempt.canDownloadResults ? (
            <Text color="secondary">Os arquivos de resultado não foram compartilhados com você.</Text>
          ) : results.status === 'loading' ? (
            <Text color="secondary">Carregando arquivos…</Text>
          ) : results.status === 'error' ? (
            <Alert tone="warning">Não foi possível carregar os arquivos.</Alert>
          ) : !results.data || results.data.items.length === 0 ? (
            <Text color="secondary">Nenhum arquivo de resultado enviado.</Text>
          ) : (
            <ul className="pw-client__files">
              {results.data.items.map((f) => (
                <li key={f.number}>
                  {f.available ? (
                    <a href={sharedResultHref(org, execution, attempt.attemptId, f.number)} download>
                      Baixar {f.fileName}
                    </a>
                  ) : (
                    <Text color="secondary">{f.fileName} (removido pelo prazo de guarda)</Text>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Stack>
      </Card>
    </section>
  );
}
