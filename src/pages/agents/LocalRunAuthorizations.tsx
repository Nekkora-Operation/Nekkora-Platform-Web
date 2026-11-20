import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Heading, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import {
  listAgents,
  listLocalRunAuthorizations,
  listWorkers,
  revokeLocalRunAuthorization,
  type Agent,
  type LocalRunAuthorization,
  type Worker,
} from '../../api/agents';
import { RunRequestDialog, RunRequestPanel } from './runRequests';
import { SOURCE_KIND } from './supervision';
import { isApiError } from '../../api/http';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal } from '../access/shared';
import { useInternalArea } from '../../area/InternalShell';
import { DateTimeText, LoadErrorState, RouteLink } from '../product/shared';

const short = (v: string | undefined) => (v ? `${v.slice(0, 8)}…` : '—');

/** Data curta para textos de opção (os <option> não aceitam componente). */

/**
 * PLATFORM-AGENT-V2-003, T12 (API 033): no máximo UMA autorização vigente por escopo — o Worker no workspace e a versão
 * (pacote) ou a automação (monitoramento). Repetir o pedido responde 409 conflict + reason local_run_authorization_exists e
 * não grava nada.
 */
export const EXISTS_REASON = 'local_run_authorization_exists';

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
 * `version`: com versão publicada e `automation.execute`, a seção oferece a autorização dela e, para cada autorização vigente
 * de pacote, o botão "Executar" (pedido de execução, 030). `automation`: a seção vira a do MONITORAMENTO de Python externo da
 * automação (sem versão nem impressão; o vínculo com o script é feito na máquina).
 */
export function LocalRunAuthorizations({
  workspaceId,
  version,
  automation,
  canExecute,
}: {
  workspaceId: string;
  version?: { automationVersionId: string; versionNumber?: number; fingerprint?: string | null };
  automation?: { automationId: string; name?: string };
  canExecute: boolean;
}) {
  const { org, expired } = useSession();
  const [list, setList] = useState<{ status: 'loading' } | { status: 'ready'; items: LocalRunAuthorization[] } | { status: 'error'; error: unknown }>({ status: 'loading' });
  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const [revoking, setRevoking] = useState<LocalRunAuthorization | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>([]);
  const [executing, setExecuting] = useState<LocalRunAuthorization | null>(null);
  const [requests, setRequests] = useState<string[]>([]);
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
    // máquinas para o "Executar" (agent.read); sem a permissão, o botão fica sem opção de máquina
    listAgents(org).then(
      (a) => setAgents(a.items),
      // sem a permissão não há máquinas a oferecer; qualquer outra falha é "não foi possível ler", não "nenhuma máquina"
      (e) => setAgents(isApiError(e, 'forbidden') ? [] : null),
    );
    return () => {
      generation.current++;
    };
  }, [load, org]);

  const items =
    list.status === 'ready'
      ? list.items.filter((a) =>
          automation
            ? a.sourceKind === 'EXTERNAL_MONITORED' && a.automationId === automation.automationId
            : !version || a.automationVersionId === version.automationVersionId,
        )
      : [];
  const workerName = (id?: string) => workers?.find((w) => w.workerId === id)?.name ?? short(id);
  // PLATFORM-FLUXO-002: a criação manual saiu desta tela; a ativação (Licenças e automações) emite as autorizações
  const { permissions } = useInternalArea();
  const canManage = permissions.status === 'ready' && permissions.data.organization.permissions.includes('org.manage');

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
    { key: 'origem', header: 'Origem', render: (a) => (a.sourceKind ? SOURCE_KIND[a.sourceKind] : '—') },
    { key: 'worker', header: 'Worker', render: (a) => workerName(a.workerId) },
    {
      key: 'impressao',
      header: 'Impressão do pacote',
      render: (a) => (a.packageFingerprint ? <code className="pw-hash">{short(a.packageFingerprint)}</code> : 'sem pacote (o código fica na máquina)'),
    },
    { key: 'ate', header: 'Vale até', render: (a) => <DateTimeText iso={a.validUntil} /> },
    {
      key: 'acoes',
      header: 'Ações',
      render: (a) =>
        canExecute && stateOf(a).label === 'Vigente' ? (
          <span className="pw-form__row">
            {a.sourceKind !== 'EXTERNAL_MONITORED' && (
              <Button size="sm" onClick={() => setExecuting(a)} aria-label={`Executar na máquina do Worker ${workerName(a.workerId)}`}>
                Executar
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRevoking(a)} aria-label={`Revogar a autorização para ${workerName(a.workerId)}`}>
              Revogar
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <section className="pw-prod__section" aria-labelledby={`autorizacoes-${workspaceId}`}>
      <Heading level={2} id={`autorizacoes-${workspaceId}`} className="pw-prod__section-title">
        {automation ? 'Monitoramento de Python externo' : 'Autorizações de execução local'}
      </Heading>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <Alert tone="info" title={automation ? 'O monitoramento é liberado pela ativação da automação.' : 'A execução desta versão é liberada pela ativação da automação.'}>
        Quem administra a organização ativa a automação em Administração › Licenças e automações: escolhe os Workers e, em um passo, libera a
        execução e o monitoramento, com a licença. Uma versão nova é aceita em “Gerenciar ativação”.{' '}
        {canManage && <RouteLink to={orgPath.licenses(org)}>Abrir Licenças e automações</RouteLink>}
        {automation && (
          <>
            {' '}
            Identificador da automação para o comando vincular do Agent: <code className="pw-hash">{automation.automationId}</code>
          </>
        )}
      </Alert>

      {requests.map((rid) => (
        <RunRequestPanel key={rid} runRequestId={rid} />
      ))}

      {list.status === 'loading' && <StateView status="loading" title="Carregando autorizações…" />}
      {list.status === 'error' && <LoadErrorState error={list.error} onRetry={() => void load()} />}
      {list.status === 'ready' &&
        (items.length === 0 ? (
          <StateView
            status="neutral"
            title={automation ? 'Esta automação ainda não tem monitoramento autorizado.' : version ? 'Esta versão ainda não tem autorizações.' : 'Nenhuma autorização de execução local neste ambiente de trabalho.'}
          />
        ) : (
          <div className="pw-prod__scroll" role="region" aria-label="Autorizações de execução local" tabIndex={0}>
            <Table columns={columns} data={items} rowKey="authorizationId" size="sm" caption="Autorizações de execução local." />
          </div>
        ))}

      <RunRequestDialog
        open={!!executing}
        workspaceId={workspaceId}
        authorization={executing}
        agents={agents}
        onCreated={(q) => {
          setExecuting(null);
          if (q.runRequestId) setRequests((r) => [q.runRequestId!, ...r.filter((x) => x !== q.runRequestId)]);
          setNotice({ tone: 'success', text: 'Pedido de execução registrado. Ele não é o início: acompanhe abaixo a entrega, a decisão da máquina, o início e o desfecho.' });
        }}
        onClose={() => setExecuting(null)}
      />

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
