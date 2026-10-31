import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Heading, Input, Select, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import {
  createLocalRunAuthorization,
  listLocalRunAuthorizations,
  listWorkers,
  revokeLocalRunAuthorization,
  type LocalRunAuthorization,
  type Worker,
} from '../../api/agents';
import { isApiError } from '../../api/http';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal, orgStepUp } from '../access/shared';
import { DateTimeText, LoadErrorState, RouteLink } from '../product/shared';

const MAX_DAYS = 366;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const short = (v: string | undefined) => (v ? `${v.slice(0, 8)}…` : '—');
const dayFromNow = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function stateOf(a: LocalRunAuthorization): { label: string; tone: 'success' | 'neutral' | 'warning' } {
  if (a.revokedAt) return { label: 'Revogada', tone: 'neutral' };
  if (a.validUntil && new Date(a.validUntil).getTime() <= Date.now()) return { label: 'Vencida', tone: 'warning' };
  return { label: 'Vigente', tone: 'success' };
}

/**
 * Autorizações de execução LOCAL de um workspace (025). Autorizar não inicia nada: o Agent recebe a autorização, o
 * pacote precisa estar na máquina e o início é confirmado pela pessoa no próprio Agent. A autorização vincula o pacote
 * IMUTÁVEL pela impressão (não pelo SHA-256 dos bytes).
 *
 * `version`: com versão publicada e `automation.execute`, a seção oferece a autorização dela.
 */
export function LocalRunAuthorizations({
  workspaceId,
  version,
  canExecute,
}: {
  workspaceId: string;
  version?: { automationVersionId: string; versionNumber?: number; fingerprint?: string | null };
  canExecute: boolean;
}) {
  const { org, expired } = useSession();
  const [list, setList] = useState<{ status: 'loading' } | { status: 'ready'; items: LocalRunAuthorization[] } | { status: 'error'; error: unknown }>({ status: 'loading' });
  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const [workerId, setWorkerId] = useState('');
  const [until, setUntil] = useState(dayFromNow(30));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<LocalRunAuthorization | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setList({ status: 'loading' });
    try {
      const data = await listLocalRunAuthorizations(org, workspaceId);
      if (gen === generation.current) setList({ status: 'ready', items: data.items });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      setList({ status: 'error', error: e });
    }
  }, [org, workspaceId, expired]);

  useEffect(() => {
    void load();
    // nomes dos Workers só com worker.manage; sem ela, a autorização aceita o identificador informado
    listWorkers(org).then(
      (w) => setWorkers(w.items),
      () => setWorkers(null),
    );
    return () => {
      generation.current++;
    };
  }, [load, org]);

  const workerName = (id?: string) => workers?.find((w) => w.workerId === id)?.name ?? short(id);
  const eligible = (workers ?? []).filter((w) => w.status === 'ACTIVE' && w.workspaceIds?.includes(workspaceId));
  const untilDate = until ? new Date(`${until}T23:59:59`) : null;
  const untilOk = !!untilDate && untilDate.getTime() > Date.now() && untilDate.getTime() <= Date.now() + MAX_DAYS * 86_400_000;

  const items = list.status === 'ready' ? list.items.filter((a) => !version || a.automationVersionId === version.automationVersionId) : [];
  const columns: TableColumn<LocalRunAuthorization>[] = [
    { key: 'estado', header: 'Situação', render: (a) => <Badge tone={stateOf(a).tone}>{stateOf(a).label}</Badge> },
    ...(version
      ? []
      : [
          {
            key: 'versao',
            header: 'Versão',
            render: (a: LocalRunAuthorization) => (a.automationVersionId ? <RouteLink to={orgPath.version(org, a.automationVersionId)}>{short(a.automationVersionId)}</RouteLink> : '—'),
          },
        ]),
    { key: 'worker', header: 'Worker', render: (a) => workerName(a.workerId) },
    { key: 'impressao', header: 'Impressão do pacote', render: (a) => <code className="pw-hash">{short(a.packageFingerprint)}</code> },
    { key: 'ate', header: 'Vale até', render: (a) => <DateTimeText iso={a.validUntil} /> },
    {
      key: 'acoes',
      header: 'Ações',
      render: (a) =>
        canExecute && stateOf(a).label === 'Vigente' ? (
          <Button size="sm" variant="ghost" onClick={() => setRevoking(a)} aria-label={`Revogar a autorização para ${workerName(a.workerId)}`}>
            Revogar
          </Button>
        ) : null,
    },
  ];

  return (
    <section className="pw-prod__section" aria-labelledby={`autorizacoes-${workspaceId}`}>
      <Heading level={2} id={`autorizacoes-${workspaceId}`} className="pw-prod__section-title">
        Autorizações de execução local
      </Heading>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      {version && canExecute && (
        <Card variant="outlined" padding="lg">
          <div className="pw-identity__form">
            <Text>
              Autorize um Worker a executar esta versão publicada{version.fingerprint ? ' (pacote de impressão ' : ''}
              {version.fingerprint && <code className="pw-hash">{short(version.fingerprint)}</code>}
              {version.fingerprint ? ')' : ''}. Isso não inicia nada.
            </Text>
            {workers ? (
              <Select
                label="Worker autorizado neste workspace"
                fullWidth
                value={workerId}
                placeholder={eligible.length ? 'Escolha um Worker' : 'Nenhum Worker autorizado neste workspace'}
                onChange={(e) => setWorkerId(e.target.value)}
                options={eligible.map((w) => ({ value: w.workerId!, label: w.name ?? w.workerId! }))}
                hint="Só Workers ativos e autorizados no workspace (tela de Workers)."
              />
            ) : (
              <Input
                label="Identificador do Worker"
                fullWidth
                value={workerId}
                onChange={(e) => setWorkerId(e.target.value.trim())}
                hint="Sem permissão para listar Workers: informe o identificador recebido de quem administra os Workers."
                error={workerId && !UUID.test(workerId) ? 'Formato 8-4-4-4-12.' : undefined}
              />
            )}
            <Input label="Vale até" type="date" fullWidth value={until} onChange={(e) => setUntil(e.target.value)} hint="Data futura, até 366 dias." error={until && !untilOk ? 'Escolha uma data futura dentro de 366 dias.' : undefined} />
            <div>
              <Button disabled={!UUID.test(workerId) || !untilOk} onClick={() => setCreating(true)}>
                Autorizar execução local
              </Button>
            </div>
          </div>
        </Card>
      )}

      {list.status === 'loading' && <StateView status="loading" title="Carregando autorizações…" />}
      {list.status === 'error' && <LoadErrorState error={list.error} onRetry={() => void load()} />}
      {list.status === 'ready' &&
        (items.length === 0 ? (
          <StateView status="neutral" title={version ? 'Esta versão ainda não tem autorizações.' : 'Nenhuma autorização de execução local neste workspace.'} />
        ) : (
          <div className="pw-prod__scroll" role="region" aria-label="Autorizações de execução local" tabIndex={0}>
            <Table columns={columns} data={items} rowKey="authorizationId" size="sm" caption="Autorizações de execução local." />
          </div>
        ))}

      {version && (
        <StepUpDialog
          open={creating}
          title={`Autorizar a execução local da versão ${version.versionNumber ?? ''}?`}
          guard={{ operation: 'local-run.authorize', target: `${version.automationVersionId}|${workerId}` }}
          confirmLabel="Autorizar execução local"
          stepUp={orgStepUp(org)}
          action={() => createLocalRunAuthorization(org, workspaceId, { workerId, automationVersionId: version.automationVersionId, validUntil: untilDate!.toISOString() })}
          onDone={() => {
            setCreating(false);
            setNotice({
              tone: 'success',
              text: 'Execução local autorizada. Nada foi iniciado: o Agent recebe a autorização na próxima conexão, o pacote precisa estar na máquina e o início é confirmado pela pessoa no Agent. Acompanhe em Supervisão.',
            });
            void load();
          }}
          onClose={() => setCreating(false)}
          refusalText={(e) =>
            accessRefusal(e, {
              conflict: 'A versão não está publicada com pacote, o Worker não está autorizado neste workspace, ou a automação/workspace não está ativo.',
            })
          }
          uncertainText="Não foi possível confirmar a autorização. Feche e confira a lista de autorizações antes de repetir."
          onUnauthenticated={expired}
          onOutcome={(k) => k === 'uncertain' && setNotice({ tone: 'warning', text: 'O resultado da última autorização não foi confirmado. Confira a lista.' })}
        >
          <Text>
            Worker: {workerName(workerId)}. Vale até <DateTimeText iso={untilDate?.toISOString() ?? null} />. A autorização é para o pacote imutável desta versão.
          </Text>
        </StepUpDialog>
      )}

      <StepUpDialog
        open={!!revoking}
        title="Revogar esta autorização?"
        guard={{ operation: 'local-run.revoke', target: revoking?.authorizationId }}
        confirmLabel="Revogar autorização"
        tone="danger"
        action={() => revokeLocalRunAuthorization(org, workspaceId, revoking!.authorizationId!)}
        onDone={() => {
          setRevoking(null);
          setNotice({
            tone: 'success',
            text: 'Autorização revogada. Uma máquina desconectada só vê a revogação na próxima conexão; execuções já registradas continuam como fatos.',
          });
          void load();
        }}
        onClose={() => setRevoking(null)}
        refusalText={(e) => accessRefusal(e)}
        uncertainText="Não foi possível confirmar a revogação. Feche e confira a lista."
        onUnauthenticated={expired}
      >
        <Text>Uma máquina desconectada só vê a revogação na próxima conexão. Execuções já registradas continuam como fatos aceitos.</Text>
      </StepUpDialog>
    </section>
  );
}
