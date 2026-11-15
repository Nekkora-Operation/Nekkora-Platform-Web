import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Heading, Select, Stack, Table, Text, type TableColumn, type Tone } from 'nekkora-lib';
import {
  cancelRemoteExecution,
  listRemoteExecutionCandidates,
  listRemoteExecutions,
  requestRemoteExecution,
  retryRemoteExecution,
  selectRemoteMachinePython,
  type RemoteAttempt,
  type RemoteAttemptState,
  type RemoteCandidate,
  type RemoteExecution,
  type RemoteMissing,
  type RemotePythonChoice,
} from '../../api/remoteExecutions';
import { listRemoteMachinePythonEnvironments, type PythonEnvironment } from '../../api/agents';
import { ApiError, isApiError } from '../../api/http';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { StepUpDialog } from '../../components/StepUpDialog';
import { usePolling } from '../../hooks/usePolling';
import { accessRefusal, orgStepUp } from '../access/shared';
import { DateTimeText, RouteLink } from '../product/shared';
import './agents.css';

/**
 * PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T02 — execução remota de uma versão publicada. A tela mostra, por máquina, o que
 * falta para solicitar e oferece a ação que resolve só a quem tem a permissão dela; solicita, acompanha, pede o cancelamento
 * e executa novamente em outra máquina. Solicitar não é iniciar: cada estado diz só o que a máquina informou.
 *
 * Numa Platform sem o recurso (404), ou sem máquina habilitada no workspace e sem solicitação desta versão, a seção não aparece.
 */
export const REMOTE_INTERVAL_MS = 5_000;

const TERMINAL: RemoteAttemptState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'REFUSED', 'EXPIRED', 'ENDED_UNKNOWN'];
const finished = (s: RemoteAttemptState) => TERMINAL.includes(s);

/** O que a tela pode afirmar de cada estado. Entregar não prova recebimento; receber não prova início. */
export const ATTEMPT_STATE: Record<RemoteAttemptState, { label: string; tone: Tone }> = {
  QUEUED: { label: 'Na fila · aguardando a máquina', tone: 'info' },
  OFFERED: { label: 'Entregue à máquina · recebimento ainda não confirmado', tone: 'info' },
  RECEIVED: { label: 'Recebida pela máquina · ainda não iniciada', tone: 'info' },
  PREPARING: { label: 'Máquina preparando · ainda não iniciada', tone: 'info' },
  STARTING: { label: 'Máquina iniciando', tone: 'info' },
  RUNNING: { label: 'Em execução', tone: 'info' },
  SUCCEEDED: { label: 'Concluída', tone: 'success' },
  FAILED: { label: 'Falhou', tone: 'danger' },
  CANCELLED: { label: 'Cancelada', tone: 'neutral' },
  TIMED_OUT: { label: 'Encerrada por tempo', tone: 'warning' },
  REFUSED: { label: 'Não iniciada', tone: 'warning' },
  EXPIRED: { label: 'Expirada sem a máquina receber', tone: 'neutral' },
  ENDED_UNKNOWN: { label: 'Encerrada sem prova do resultado', tone: 'warning' },
};

const REFUSAL: Record<string, string> = {
  BUSY: 'a máquina já estava executando outra automação',
  PAUSED: 'o recebimento estava pausado na máquina',
  PACKAGE_INVALID: 'o pacote recebido não conferiu com o publicado',
  ENVIRONMENT_GONE: 'o ambiente Python escolhido não existe mais na máquina',
  ENVIRONMENT_INCOMPATIBLE: 'o ambiente Python da máquina não atende ao pacote',
  DEPENDENCIES_MISSING: 'faltam dependências no ambiente Python da máquina',
  DISK_PRESSURE: 'a máquina estava sem espaço em disco',
  CLIENT_INCOMPATIBLE: 'o aplicativo da máquina não executa solicitações da Platform',
  AUTHORIZATION_MISSING: 'não há autorização desta versão para o Worker da máquina',
  AUTHORIZATION_REVOKED: 'a autorização desta versão para o Worker foi revogada antes do início',
  AUTHORIZATION_EXPIRED: 'a autorização desta versão para o Worker venceu antes do início',
  WORKER_NOT_AUTHORIZED: 'o Worker deixou de estar autorizado neste workspace antes do início',
  MACHINE_NOT_LINKED: 'a máquina deixou de estar vinculada ao Worker antes do início',
  MACHINE_NOT_ENABLED: 'a máquina deixou de estar habilitada para execução remota antes do início',
  MACHINE_INCOMPATIBLE: 'o aplicativo da máquina deixou de ser compatível antes do início',
};
export const refusalText = (r: string | null | undefined) => (r ? (REFUSAL[r] ?? r) : '');

/** O que falta para solicitar numa máquina, em palavras. */
export const MISSING: Record<RemoteMissing, string> = {
  REQUIREMENTS_NOT_DECLARED: 'As dependências desta automação ainda não foram declaradas.',
  REQUIREMENTS_CONFLICT: 'As dependências declaradas estão em conflito com o pacote publicado.',
  AUTHORIZATION_MISSING: 'Falta a autorização de execução desta versão para o Worker desta máquina.',
  AUTHORIZATION_REVOKED: 'A autorização de execução desta versão para o Worker desta máquina foi revogada.',
  AUTHORIZATION_EXPIRED: 'A autorização de execução desta versão para o Worker desta máquina venceu.',
  MACHINE_PAUSED: 'O recebimento está pausado nesta máquina.',
  MACHINE_INCOMPATIBLE: 'O aplicativo desta máquina não executa solicitações da Platform.',
  MACHINE_BUSY: 'Esta máquina já tem uma execução remota em andamento.',
  PYTHON_NOT_SELECTED: 'Ainda não foi escolhido o Python desta automação nesta máquina.',
  PYTHON_NOT_IN_INVENTORY: 'O Python escolhido para esta automação não está mais entre os que esta máquina informou.',
};

const PYTHON_KIND: Record<string, string> = { INSTALLATION: 'instalação', VIRTUAL_ENVIRONMENT: 'ambiente virtual' };

/** O motivo de uma recusa do servidor, em palavras (a exigência que faltou no momento do pedido). */
const REQUEST_REFUSAL: Record<string, string> = {
  remote_requirements_not_declared: MISSING.REQUIREMENTS_NOT_DECLARED,
  remote_requirements_conflict: MISSING.REQUIREMENTS_CONFLICT,
  remote_authorization_missing: MISSING.AUTHORIZATION_MISSING,
  remote_authorization_revoked: MISSING.AUTHORIZATION_REVOKED,
  remote_authorization_expired: MISSING.AUTHORIZATION_EXPIRED,
  remote_machine_paused: MISSING.MACHINE_PAUSED,
  remote_machine_incompatible: MISSING.MACHINE_INCOMPATIBLE,
  remote_machine_busy: MISSING.MACHINE_BUSY,
  remote_python_not_selected: MISSING.PYTHON_NOT_SELECTED,
  remote_python_not_in_inventory: 'Esse Python não está mais entre os que a máquina informou. Atualize a lista e escolha outro.',
  remote_machine_not_enabled: 'Esta máquina não está habilitada para execução remota.',
  remote_execution_unavailable: 'A execução remota não está disponível nesta Platform.',
  remote_attempt_not_finished: 'A tentativa anterior ainda não terminou. Só depois do término é possível executar em outra máquina.',
  remote_attempt_already_finished: 'A tentativa já terminou: não há o que cancelar.',
  remote_execution_cancel_requested: 'O cancelamento desta solicitação já foi pedido.',
};
export function remoteRefusal(e: unknown): string {
  const reason = e instanceof ApiError && e.code === 'conflict' ? e.reason : undefined;
  return reason && REQUEST_REFUSAL[reason] ? `${REQUEST_REFUSAL[reason]} Nada foi alterado.` : accessRefusal(e);
}

type Data = { candidates: RemoteCandidate[]; executions: RemoteExecution[] };

export function RemoteExecutions({
  workspaceId,
  automationId,
  version,
  canExecute,
  canManage,
}: {
  workspaceId: string;
  automationId: string;
  version: { automationVersionId: string; versionNumber?: number };
  canExecute: boolean;
  canManage: boolean;
}) {
  const { org, expired } = useSession();
  const [absent, setAbsent] = useState(false);
  const [requesting, setRequesting] = useState<RemoteCandidate | null>(null);
  const [cancelling, setCancelling] = useState<RemoteExecution | null>(null);
  const [retrying, setRetrying] = useState<RemoteExecution | null>(null);
  const [retryAgent, setRetryAgent] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  // escolha do Python (T01c parte 3): a máquina, o que ela informou ter e o ambiente marcado
  const [choosing, setChoosing] = useState<RemoteCandidate | null>(null);
  const [environments, setEnvironments] = useState<{ status: 'loading' | 'ready' | 'error'; items: PythonEnvironment[] }>({ status: 'loading', items: [] });
  const [environment, setEnvironment] = useState('');
  useEffect(() => {
    if (!choosing) return;
    let current = true;
    setEnvironments({ status: 'loading', items: [] });
    setEnvironment('');
    listRemoteMachinePythonEnvironments(org, workspaceId, choosing.agentId).then(
      (r) => current && setEnvironments({ status: 'ready', items: r.items }),
      () => current && setEnvironments({ status: 'error', items: [] }),
    );
    return () => {
      current = false;
    };
  }, [choosing, org, workspaceId]);
  const requestKey = useMemo(() => (requesting ? crypto.randomUUID() : ''), [requesting]);

  const poll = usePolling<Data>(
    async () => {
      try {
        const [c, x] = await Promise.all([listRemoteExecutionCandidates(org, workspaceId, version.automationVersionId), listRemoteExecutions(org, workspaceId)]);
        return { candidates: c.items, executions: x.items.filter((e) => e.automationVersionId === version.automationVersionId) };
      } catch (e) {
        // Platform sem o recurso: não há o que mostrar (e não há o que acompanhar)
        if (isApiError(e, 'not_found')) {
          setAbsent(true);
          return { candidates: [], executions: [] };
        }
        throw e;
      }
    },
    {
      intervalMs: REMOTE_INTERVAL_MS,
      keepGoing: (d) => d.executions.some((e) => !finished(e.state)),
      deps: [org, workspaceId, version.automationVersionId],
      onUnauthenticated: expired,
    },
  );
  const data = poll.data;
  if (absent) return null;
  if (!data) return poll.error ? <Text color="secondary">Não foi possível ler a execução remota desta versão agora.</Text> : null;
  if (data.candidates.length === 0 && data.executions.length === 0) return null;

  const requestable = data.candidates.filter((c) => c.requestable);
  const versionLabel = `versão ${version.versionNumber ?? ''}`.trim();

  /** A ação que resolve o que falta — oferecida só a quem pode fazê-la. */
  const action = (m: RemoteMissing, c: RemoteCandidate) => {
    if (m === 'REQUIREMENTS_NOT_DECLARED' || m === 'REQUIREMENTS_CONFLICT')
      return canManage ? <RouteLink to={orgPath.automation(org, automationId)}>Declarar as dependências na automação</RouteLink> : 'Peça a quem gerencia esta automação.';
    if (m === 'AUTHORIZATION_MISSING' || m === 'AUTHORIZATION_REVOKED' || m === 'AUTHORIZATION_EXPIRED')
      return canExecute
        ? `Autorize a execução local desta versão para o Worker ${c.workerName}, em "Autorizações de execução local", nesta página.`
        : 'Peça a autorização a quem pode executar neste workspace.';
    if (m === 'MACHINE_PAUSED') return 'O recebimento é retomado no próprio computador, em "Execução remota".';
    if (m === 'MACHINE_INCOMPATIBLE') return 'É preciso uma versão do Nekkora Agent que execute solicitações da Platform nesse computador.';
    if (m === 'PYTHON_NOT_SELECTED' || m === 'PYTHON_NOT_IN_INVENTORY')
      return canManage ? 'Escolha o Python na coluna "Python desta automação".' : 'Peça a quem gerencia esta automação.';
    return 'Aguarde a execução em andamento nessa máquina terminar.';
  };

  const columns: TableColumn<RemoteCandidate>[] = [
    {
      key: 'maquina',
      header: 'Máquina',
      render: (c) => (
        <Stack gap={1}>
          <span>{c.agentName}</span>
          <Text variant="body-sm" color="secondary">
            Worker: {c.workerName}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'python',
      header: 'Python desta automação',
      render: (c) => (
        <Stack gap={1}>
          <span>{c.python ? `Python ${c.python.pythonVersion}` : 'Não escolhido'}</span>
          {c.python && !c.python.inInventory && (
            <Text variant="body-sm" color="secondary">
              A máquina não informa mais este Python.
            </Text>
          )}
          {canManage && (
            <span>
              <Button size="sm" variant="ghost" onClick={() => setChoosing(c)} aria-label={`${c.python ? 'Trocar' : 'Escolher'} o Python de ${c.agentName}`}>
                {c.python ? 'Trocar' : 'Escolher'}
              </Button>
            </span>
          )}
        </Stack>
      ),
    },
    {
      key: 'situacao',
      header: 'Para solicitar',
      render: (c) =>
        c.requestable ? (
          <Badge tone="success">Pode solicitar</Badge>
        ) : (
          <Stack gap={2}>
            <span>
              <Badge tone="warning">Falta</Badge>
            </span>
            <ul className="pw-plain-list" aria-label={`O que falta em ${c.agentName}`}>
              {c.missing.map((m) => (
                <li key={m}>
                  <Text variant="body-sm">{MISSING[m]}</Text>
                  <Text variant="body-sm" color="secondary">
                    {action(m, c)}
                  </Text>
                </li>
              ))}
            </ul>
          </Stack>
        ),
    },
    {
      key: 'acao',
      header: 'Ação',
      render: (c) =>
        canExecute && c.requestable ? (
          <Button size="sm" onClick={() => setRequesting(c)} aria-label={`Solicitar execução em ${c.agentName}`}>
            Solicitar execução
          </Button>
        ) : (
          '—'
        ),
    },
  ];

  const attemptLine = (a: RemoteAttempt) => (
    <li key={a.attemptId}>
      <Text variant="body-sm">
        Tentativa {a.attemptNumber} · {a.agentName} · <strong>{ATTEMPT_STATE[a.state].label}</strong>
        {a.state === 'REFUSED' && a.refusalReason ? `: ${refusalText(a.refusalReason)}` : ''}
        {a.exitCode != null ? ` · código de saída ${a.exitCode}` : ''}
      </Text>
      {a.communication === 'LOST' && (
        <Text variant="body-sm" color="secondary">
          Sem comunicação com a máquina no momento. Isso não encerra a execução: o estado é o último que ela informou.
        </Text>
      )}
    </li>
  );

  return (
    <section className="pw-prod__section" aria-labelledby="execucao-remota-titulo">
      <Heading level={2} id="execucao-remota-titulo" className="pw-prod__section-title">
        Execução remota
      </Heading>
      <Text variant="body-sm" color="secondary">
        Solicita que a {versionLabel} rode numa máquina habilitada. Solicitar não é iniciar: a máquina recebe na próxima consulta e a Platform confere de
        novo, antes de iniciar, que a autorização da versão para o Worker dela continua valendo.
      </Text>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {poll.error != null && <Alert tone="warning">Não foi possível atualizar agora. O que está na tela é da última leitura.</Alert>}
      {data.candidates.length > 0 && (
        <div className="pw-prod__scroll" role="region" aria-label="Máquinas para execução remota desta versão" tabIndex={0}>
          <Table columns={columns} data={data.candidates} rowKey="agentId" size="sm" caption="Máquinas habilitadas do workspace e o que falta para solicitar em cada uma." />
        </div>
      )}
      {data.executions.map((x) => {
        const last = x.attempts[x.attempts.length - 1];
        const done = finished(x.state);
        return (
          <Card key={x.remoteExecutionId} variant="outlined" padding="md" aria-label={`Solicitação de ${new Date(x.requestedAt).toLocaleString('pt-BR')}`}>
            <Stack gap={2}>
              <div className="pw-form__row">
                <Badge tone={ATTEMPT_STATE[x.state].tone}>{ATTEMPT_STATE[x.state].label}</Badge>
                <Text variant="body-sm" color="secondary">
                  Solicitada em <DateTimeText iso={x.requestedAt} />
                </Text>
              </div>
              {x.cancelRequestedAt && !done && (
                <Alert tone="info">Cancelamento pedido. A execução só para quando a máquina receber o pedido e informar; até lá o estado não muda.</Alert>
              )}
              <ul className="pw-plain-list" aria-label="Tentativas">
                {x.attempts.map(attemptLine)}
              </ul>
              {canExecute && (
                <div className="pw-form__row">
                  {!done && !x.cancelRequestedAt && (
                    <Button size="sm" variant="ghost" onClick={() => setCancelling(x)}>
                      Pedir cancelamento
                    </Button>
                  )}
                  {done && !x.cancelRequestedAt && last && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setRetryAgent('');
                        setRetrying(x);
                      }}
                    >
                      Executar novamente em outra máquina
                    </Button>
                  )}
                </div>
              )}
            </Stack>
          </Card>
        );
      })}
      <div>
        <Button size="sm" variant="ghost" leftIcon="refresh" loading={poll.loading} onClick={poll.refresh}>
          Atualizar
        </Button>
      </div>

      <StepUpDialog<RemoteExecution>
        open={!!requesting}
        title={requesting ? `Solicitar a execução da ${versionLabel} em ${requesting.agentName}?` : ''}
        guard={{ operation: 'remote-execution.request', target: requestKey }}
        confirmLabel="Solicitar execução"
        stepUp={orgStepUp(org)}
        action={() => (requesting ? requestRemoteExecution(org, workspaceId, { automationVersionId: version.automationVersionId, agentId: requesting.agentId, requestKey }) : Promise.reject())}
        onDone={() => {
          setRequesting(null);
          setNotice({ tone: 'success', text: 'Solicitação registrada. A máquina recebe na próxima consulta; o início aparece quando ela informar.' });
          poll.refresh();
        }}
        onClose={() => setRequesting(null)}
        refusalText={remoteRefusal}
        uncertainText="Não foi possível confirmar a solicitação. Atualize a lista antes de repetir (repetir pelo mesmo diálogo devolve a mesma solicitação)."
        onUnauthenticated={expired}
      >
        <Text>
          A máquina recebe a solicitação na próxima consulta. Antes de iniciar, a Platform confere de novo a autorização desta versão para o Worker dela: se
          tiver sido revogada ou vencido, a execução não inicia e o motivo aparece aqui.
        </Text>
      </StepUpDialog>

      <StepUpDialog<RemoteExecution>
        open={!!cancelling}
        title="Pedir o cancelamento desta execução?"
        guard={{ operation: 'remote-execution.cancel', target: cancelling?.remoteExecutionId }}
        confirmLabel="Pedir cancelamento"
        tone="danger"
        stepUp={orgStepUp(org)}
        action={() => (cancelling ? cancelRemoteExecution(org, cancelling.remoteExecutionId) : Promise.reject())}
        onDone={(x) => {
          setCancelling(null);
          setNotice(
            finished(x.state)
              ? { tone: 'success', text: 'Cancelada: a máquina ainda não tinha recebido a solicitação.' }
              : { tone: 'warning', text: 'Cancelamento pedido. A execução só para quando a máquina receber o pedido e informar.' },
          );
          poll.refresh();
        }}
        onClose={() => setCancelling(null)}
        refusalText={remoteRefusal}
        uncertainText="Não foi possível confirmar o pedido de cancelamento. Atualize a lista e confira antes de repetir."
        onUnauthenticated={expired}
      >
        <Text>
          Se a máquina ainda não recebeu a solicitação, ela é cancelada agora. Se já recebeu, a execução só para quando a máquina obedecer e informar: até lá o
          estado não muda.
        </Text>
      </StepUpDialog>

      <StepUpDialog<RemotePythonChoice>
        open={!!choosing}
        ready={!!environment}
        title={choosing ? `Escolher o Python desta automação em ${choosing.agentName}?` : ''}
        guard={{ operation: 'remote-execution.python', target: choosing ? `${automationId}|${choosing.agentId}|${environment}` : undefined }}
        confirmLabel="Escolher este Python"
        stepUp={orgStepUp(org)}
        action={() => (choosing ? selectRemoteMachinePython(org, automationId, choosing.agentId, environment) : Promise.reject())}
        onDone={(chosen) => {
          setNotice({ tone: 'success', text: `Python ${chosen.pythonVersion} escolhido para esta automação em ${choosing?.agentName ?? 'a máquina'}.` });
          setChoosing(null);
          poll.refresh();
        }}
        onClose={() => setChoosing(null)}
        refusalText={remoteRefusal}
        uncertainText="Não foi possível confirmar a escolha. Atualize a lista antes de repetir."
        onUnauthenticated={expired}
      >
        <Stack gap={3}>
          <Text>
            Vale só para esta automação nesta máquina. A Platform guarda a versão e um identificador que a própria máquina informou, nunca um caminho. Nada é
            instalado: antes de iniciar, a máquina confere se esse Python ainda existe e se tem as dependências; se não tiver, a execução não inicia e o motivo
            aparece aqui.
          </Text>
          {environments.status === 'loading' && <Text variant="body-sm">Carregando o que a máquina informou…</Text>}
          {environments.status === 'error' && (
            <Alert tone="warning">Não foi possível ler as versões de Python desta máquina agora. Feche e tente de novo.</Alert>
          )}
          {environments.status === 'ready' && environments.items.length === 0 && (
            <Alert tone="info">Esta máquina ainda não informou nenhuma versão de Python. O inventário é publicado pelo aplicativo, no próprio computador.</Alert>
          )}
          {environments.status === 'ready' && environments.items.length > 0 && (
            <Select
              label="Python da máquina"
              fullWidth
              value={environment}
              placeholder="Escolha uma versão"
              onChange={(e) => setEnvironment(e.target.value)}
              options={environments.items.map((e, i) => ({
                value: e.environmentId,
                label: `Python ${e.pythonVersion} · ${PYTHON_KIND[e.kind] ?? e.kind} · nº ${i + 1}${e.environmentId === choosing?.python?.environmentId ? ' (atual)' : ''}`,
              }))}
            />
          )}
        </Stack>
      </StepUpDialog>

      <StepUpDialog<RemoteExecution>
        open={!!retrying}
        ready={!!retryAgent}
        title="Executar novamente em outra máquina?"
        guard={{ operation: 'remote-execution.retry', target: retrying ? `${retrying.remoteExecutionId}|${retryAgent}` : undefined }}
        confirmLabel="Executar novamente"
        stepUp={orgStepUp(org)}
        action={() => (retrying ? retryRemoteExecution(org, retrying.remoteExecutionId, retryAgent) : Promise.reject())}
        onDone={() => {
          setRetrying(null);
          setNotice({ tone: 'success', text: 'Nova tentativa registrada, com a mesma versão e as mesmas dependências da solicitação.' });
          poll.refresh();
        }}
        onClose={() => setRetrying(null)}
        refusalText={remoteRefusal}
        uncertainText="Não foi possível confirmar a nova tentativa. Atualize a lista antes de repetir."
        onUnauthenticated={expired}
      >
        <Stack gap={3}>
          <Text>
            É uma nova tentativa da mesma solicitação. A autorização conferida é a desta versão para o Worker da máquina escolhida: a da máquina anterior não é
            aproveitada.
          </Text>
          <Select
            label="Máquina"
            fullWidth
            value={retryAgent}
            placeholder={requestable.length ? 'Escolha a máquina' : 'Nenhuma máquina pode receber agora'}
            onChange={(e) => setRetryAgent(e.target.value)}
            options={requestable.map((c) => ({ value: c.agentId, label: `${c.agentName} (Worker ${c.workerName})` }))}
          />
          {requestable.length === 0 && <Text variant="body-sm">Veja, na lista de máquinas, o que falta em cada uma.</Text>}
        </Stack>
      </StepUpDialog>
    </section>
  );
}
