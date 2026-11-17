import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, DescriptionList, Input, Select, Stack, Text, type Tone } from 'nekkora-lib';
import { createRunRequest, getRunRequest, revokeRunRequest, type Agent, type LocalRunAuthorization, type RunRequest } from '../../api/agents';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { StepUpDialog } from '../../components/StepUpDialog';
import { usePolling } from '../../hooks/usePolling';
import { accessRefusal, orgStepUp } from '../access/shared';
import { DateTimeText, RouteLink } from '../product/shared';
import { outcomeLabel } from './supervision';

/** Frequência do acompanhamento de UM pedido (moderada; para quando o pedido chega a um desfecho). */
export const REQUEST_INTERVAL_MS = 5_000;

const REASON: Record<string, string> = {
  PACKAGE_NOT_PRESENT: 'o pacote desta versão não está na máquina',
  PACKAGE_NOT_APPROVED: 'o pacote está na máquina, mas não foi aprovado nela',
  AUTHORIZATION_UNUSABLE: 'a máquina não tem a autorização válida',
  ENVIRONMENT_INCOMPATIBLE: 'o ambiente Python preparado não atende ao pacote',
  BUSY: 'a máquina já está executando outra automação',
  EXPIRED: 'o pedido venceu antes da decisão',
  LAUNCH_NOT_ATTEMPTED: 'o processo comprovadamente não foi criado',
  // PLATFORM-AGENT-V2-004, T13: a máquina se desvinculou antes de decidir; o pedido não vai para outra máquina
  AGENT_UNLINKED: 'a máquina foi desvinculada antes de decidir',
};

/** Motivo da decisão da máquina, em texto (desconhecido: o código como veio). */
export const decisionReasonText = (r: string) => REASON[r] ?? r;

/**
 * O que a tela pode afirmar de um pedido. Entregar ou aceitar NÃO prova início: "Execução iniciada" só com o instante de
 * início vindo do supervisor; máquina desconectada continua "aguardando a máquina", nunca "em execução" por inferência.
 */
export function requestStage(q: RunRequest): { label: string; tone: Tone; done: boolean } {
  switch (q.state) {
    case 'REQUESTED':
      return { label: 'Solicitação registrada · aguardando a máquina', tone: 'info', done: false };
    case 'DELIVERED':
      return { label: 'Entregue à máquina · aguardando decisão', tone: 'info', done: false };
    case 'ACCEPTED':
      return { label: 'Aceita pela máquina · início ainda não confirmado', tone: 'info', done: false };
    case 'REFUSED':
      return { label: 'Recusada pela máquina', tone: 'warning', done: true };
    case 'NOT_STARTED':
      return { label: 'Aceita, mas não iniciada', tone: 'warning', done: true };
    case 'EXPIRED':
      return { label: 'Expirada sem decisão da máquina', tone: 'neutral', done: true };
    case 'REVOKED':
      return { label: 'Revogada antes da decisão', tone: 'neutral', done: true };
    case 'RUN_LINKED': {
      const run = q.run;
      if (!run) return { label: 'Execução registrada', tone: 'info', done: false };
      if (run.outcome && run.outcome !== 'PENDING') {
        const o = outcomeLabel(run.state, run.code, run.exitCode);
        return { label: `Desfecho reportado: ${o.label}`, tone: o.tone, done: true };
      }
      if (run.startedAt) return { label: 'Execução iniciada', tone: 'info', done: false };
      return { label: 'Execução registrada · início ainda não confirmado', tone: 'info', done: false };
    }
    default:
      return { label: String(q.state ?? '—'), tone: 'neutral', done: false };
  }
}

/** Acompanhamento de um pedido: linha do tempo com o que cada etapa prova e o desfecho do supervisor. */
export function RunRequestPanel({ runRequestId, onChanged }: { runRequestId: string; onChanged?: () => void }) {
  const { org, expired } = useSession();
  const [revoking, setRevoking] = useState(false);
  const poll = usePolling(() => getRunRequest(org, runRequestId), {
    intervalMs: REQUEST_INTERVAL_MS,
    keepGoing: (q) => !requestStage(q).done,
    deps: [org, runRequestId],
    onUnauthenticated: expired,
  });
  const q = poll.data;
  if (!q) return <Text color="secondary">{poll.error ? 'Não foi possível ler o pedido agora.' : 'Carregando o pedido…'}</Text>;
  const stage = requestStage(q);
  const run = q.run;
  return (
    <Card variant="outlined" padding="md" aria-label="Pedido de execução">
      <Stack gap={3}>
        <div className="pw-form__row">
          <Badge tone={stage.tone}>{stage.label}</Badge>
          <Button size="sm" variant="secondary" leftIcon="refresh" loading={poll.loading} onClick={poll.refresh}>
            Atualizar
          </Button>
          {(q.state === 'REQUESTED' || q.state === 'DELIVERED') && (
            <Button size="sm" variant="ghost" onClick={() => setRevoking(true)}>
              Revogar pedido
            </Button>
          )}
        </div>
        {q.machine?.connectivity === 'DISCONNECTED' && !stage.done && (
          <Alert tone="info">A máquina está sem sinal recente. O pedido continua aguardando até ela voltar ou vencer (<DateTimeText iso={q.validUntil} />).</Alert>
        )}
        <DescriptionList
          items={[
            { key: 'maquina', term: 'Máquina', description: q.agentName ?? '—' },
            { key: 'versao', term: 'Versão', description: q.automationVersionId ? <RouteLink to={orgPath.version(org, q.automationVersionId)}>{`${q.automationName ?? ''} v${q.versionNumber ?? ''}`}</RouteLink> : '—' },
            { key: 'pedido', term: 'Solicitação registrada', description: <DateTimeText iso={q.requestedAt} /> },
            { key: 'validade', term: 'Vale até', description: <DateTimeText iso={q.validUntil} /> },
            {
              key: 'entrega',
              term: 'Entregue à máquina',
              description: q.deliveredAt ? (
                <>
                  <DateTimeText iso={q.deliveredAt} /> {q.deliveries && q.deliveries > 1 ? `(${q.deliveries} leituras)` : ''}
                </>
              ) : (
                'ainda não'
              ),
            },
            {
              key: 'decisao',
              term: 'Decisão da máquina',
              description: q.decidedAt ? (
                <>
                  <DateTimeText iso={q.decidedAt} /> · {q.state === 'REFUSED' ? 'recusada' : 'aceita'}
                  {q.decisionReason ? ` (${decisionReasonText(q.decisionReason)})` : ''}
                </>
              ) : (
                'ainda não'
              ),
            },
            { key: 'inicio', term: 'Início (supervisor)', description: run?.startedAt ? <DateTimeText iso={run.startedAt} /> : 'não confirmado' },
            {
              key: 'desfecho',
              term: 'Desfecho (supervisor)',
              description: run && run.outcome !== 'PENDING' ? `${outcomeLabel(run.state, run.code, run.exitCode).label}${run.exitCode != null ? ` · código ${run.exitCode}` : ''}` : '—',
            },
            {
              key: 'execucao',
              term: 'Execução',
              description: run?.runId ? <RouteLink to={orgPath.agentRun(org, run.runId)}>{q.agentExecutionId ?? run.runId}</RouteLink> : (q.agentExecutionId ?? '—'),
            },
          ]}
        />
      </Stack>
      <StepUpDialog
        open={revoking}
        title="Revogar este pedido de execução?"
        guard={{ operation: 'run-request.revoke', target: runRequestId }}
        confirmLabel="Revogar pedido"
        tone="danger"
        stepUp={orgStepUp(org)}
        action={() => revokeRunRequest(org, runRequestId)}
        onDone={() => {
          setRevoking(false);
          poll.refresh();
          onChanged?.();
        }}
        onClose={() => setRevoking(false)}
        refusalText={(e) => accessRefusal(e, { conflict: 'A máquina já decidiu (ou o pedido venceu): a revogação não é mais possível. Cancelar uma execução não existe nesta versão.' })}
        uncertainText="Não foi possível confirmar a revogação. Atualize o pedido antes de repetir."
        onUnauthenticated={expired}
      >
        <Text>Só antes da decisão da máquina. Depois dela, nada é cancelado por aqui.</Text>
      </StepUpDialog>
    </Card>
  );
}

/** Capacidade do contrato Platform-Agent que o PEDIDO DE EXECUÇÃO exige da máquina (o Nekkora Agent Client não a declara). */
export const RUN_REQUEST_CAPABILITY = 'RUN_REQUEST_1_0';

/**
 * A máquina atende o pedido de execução? Quem já se apresentou sem a capacidade (o Nekkora Agent Client, que atende a
 * EXECUÇÃO REMOTA) nunca lê este pedido. Quem ainda não se apresentou (lista vazia) segue a regra de sempre.
 */
export const servesRunRequest = (a: Agent) => !a.capabilities?.length || a.capabilities.includes(RUN_REQUEST_CAPABILITY);

/**
 * "Executar": pede que a versão da autorização rode no Agent escolhido. A chave do pedido é gerada quando o diálogo abre:
 * repetir depois de uma resposta perdida devolve o MESMO pedido.
 */
export function RunRequestDialog({
  open,
  workspaceId,
  authorization,
  agents,
  onCreated,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  authorization: LocalRunAuthorization | null;
  /** null = a lista de máquinas não pôde ser lida (não é o mesmo que "nenhuma máquina"). */
  agents: Agent[] | null;
  onCreated: (q: RunRequest) => void;
  onClose: () => void;
}) {
  const { org, expired } = useSession();
  const onWorker = (agents ?? []).filter((a) => a.status === 'ACTIVE' && a.workerId === authorization?.workerId);
  const eligible = onWorker.filter(servesRunRequest);
  // a máquina existe e está ativa, mas é de outro fluxo: dizer isso, em vez de "nenhum Agent"
  const otherFlow = eligible.length === 0 && onWorker.length > 0;
  const [agentId, setAgentId] = useState('');
  const [minutes, setMinutes] = useState('15');
  const chosen = agentId || (eligible.length === 1 ? eligible[0].agentId! : '');
  const requestKey = useMemo(() => (open ? crypto.randomUUID() : ''), [open, authorization?.authorizationId]);
  const m = Number(minutes);
  const minutesOk = Number.isInteger(m) && m >= 1 && m <= 1440;
  return (
    <StepUpDialog
      open={open}
      ready={!!chosen && minutesOk}
      title="Executar esta versão agora?"
      guard={{ operation: 'run-request.create', target: requestKey }}
      confirmLabel="Pedir execução"
      stepUp={orgStepUp(org)}
      action={() => createRunRequest(org, workspaceId, { authorizationId: authorization!.authorizationId!, agentId: chosen, validForSeconds: m * 60, requestKey })}
      onDone={onCreated}
      onClose={onClose}
      refusalText={(e) =>
        accessRefusal(e, { conflict: 'A autorização não está vigente, é de monitoramento, ou a máquina não está ativa e associada ao Worker da autorização.' })
      }
      uncertainText="Não foi possível confirmar o pedido. Confira a lista de pedidos antes de repetir (repetir pelo mesmo diálogo devolve o mesmo pedido)."
      onUnauthenticated={expired}
    >
      <Stack gap={3}>
        <Text>
          A máquina recebe o pedido na próxima consulta, confere o pacote aprovado nela e decide. Pedir não é iniciar: o início e o desfecho aparecem quando o
          supervisor da máquina os informar.
        </Text>
        {agents === null && <Alert tone="warning">Não foi possível ler as máquinas da organização agora. Feche e abra de novo para tentar outra vez.</Alert>}
        {otherFlow && (
          <Alert tone="warning">
            A máquina vinculada a este Worker ({onWorker[0].name ?? 'sem nome'}) está ativa, mas usa o Nekkora Agent Client, que não recebe este tipo de pedido.
            Nada foi pedido e nada precisa ser refeito: o vínculo e as autorizações continuam valendo. Para executar nela, use a seção “Execução remota”{' '}
            {authorization?.automationVersionId ? <RouteLink to={orgPath.version(org, authorization.automationVersionId)}>na página da versão</RouteLink> : 'na página da versão'}.
          </Alert>
        )}
        <Select
          label="Máquina"
          fullWidth
          value={chosen}
          placeholder={eligible.length ? 'Escolha a máquina' : agents === null ? 'Máquinas não lidas' : otherFlow ? 'A máquina deste Worker não recebe este pedido' : 'Nenhum Agent ativo neste Worker'}
          onChange={(e) => setAgentId(e.target.value)}
          options={eligible.map((a) => ({ value: a.agentId!, label: `${a.name ?? a.agentId}${a.connectivity === 'CONNECTED' ? ' (conectado)' : ' (sem sinal recente)'}` }))}
        />
        <Input
          label="Validade do pedido (minutos)"
          type="number"
          fullWidth
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          hint="De 1 a 1440. Sem decisão da máquina até lá, o pedido expira."
          error={minutesOk ? undefined : 'De 1 a 1440 minutos.'}
        />
      </Stack>
    </StepUpDialog>
  );
}
