import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Heading, Input, Select, Stack, Table, Text, Textarea, type TableColumn, type Tone } from 'nekkora-lib';
import {
  cancelRemoteExecution,
  checkRemoteMachineDependencies,
  listRemoteExecutionCandidates,
  listRemoteExecutions,
  requestRemoteExecution,
  retryRemoteExecution,
  reconcileRemoteAttempt,
  type ReconciliationReason,
  selectRemoteMachinePython,
  type RemoteAttempt,
  type RemoteAttemptState,
  type RemoteCandidate,
  type RemoteDependencyCheck,
  type RemoteExecution,
  type RemoteMissing,
  type RemotePythonChoice,
} from '../../api/remoteExecutions';
import { listLocalRunAuthorizations, listRemoteMachinePythonEnvironments, type PythonEnvironment } from '../../api/agents';
import { ApiError, isApiError } from '../../api/http';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { StepUpDialog } from '../../components/StepUpDialog';
import { usePolling } from '../../hooks/usePolling';
import { accessRefusal, orgStepUp } from '../access/shared';
import { DateTimeText, RouteLink } from '../product/shared';
import { RemoteLogs } from './RemoteLogs';
import { RemoteResults } from './RemoteResults';
import './agents.css';
import { CAPACITY_PENDING_TEXT, LICENSE_EXPIRED_TEXT, LICENSE_REQUIRED_TEXT, reducedValidityText } from '../licenses/texts';

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

/**
 * AGUARDANDO VAGA (PLATFORM-LICENCIAMENTO-001): a tentativa está na fila e a organização está no limite técnico de execuções
 * simultâneas. É capacidade, não licença - a licença da automação foi conferida quando a solicitação foi aceita.
 */
export const WAITING_SLOT_LABEL = 'Aguardando vaga';
export const WAITING_SLOT_TEXT =
  'A organização está no limite de execuções simultâneas. Esta execução começa quando uma vaga for liberada, sem nova solicitação. É um limite de capacidade, não falta de licença: a licença desta automação já foi conferida quando a solicitação foi aceita.';

/** S2: o que falta nesta máquina é SÓ a autorização da versão (ausente, revogada ou vencida)? Então dá para autorizar e solicitar no mesmo passo. */
export const onlyAuthorizationMissing = (missing: readonly string[]) =>
  missing.length > 0 && missing.every((m) => m === 'AUTHORIZATION_MISSING' || m === 'AUTHORIZATION_REVOKED' || m === 'AUTHORIZATION_EXPIRED');

/**
 * PLATFORM-FLUXO-002: o aceite da versão e da máquina faz parte da CONFIRMAÇÃO da execução (um botão só, "Solicitar
 * execução"), quando a versão ainda não foi aceita para o Worker desta máquina. Com uma autorização válida, nada a aceitar.
 */
export const ACCEPT_VERSION = {
  ACK: (version: string, worker: string) => `Aceito executar a ${version} no Worker ${worker}.`,
  SCOPE:
    'Esta versão ainda não foi aceita para o Worker desta máquina. Ao confirmar, você a aceita aqui e a solicitação segue no mesmo passo. O aceite vale só para esta versão, neste Worker: versões futuras não ficam aceitas. Fica registrado com o seu nome.',
  UNTIL_LICENSED: 'O aceite vale até o fim da licença desta automação.',
  UNTIL_LEGACY: 'Esta organização ainda não exige licença: escolha até quando o aceite vale (data futura, até 366 dias).',
};

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
  ENDED_UNKNOWN: { label: 'Resultado não confirmado', tone: 'warning' },
};

/**
 * T06 — o que "Resultado não confirmado" quer dizer, sempre junto do estado. A tela não marca sucesso porque chegaram
 * arquivos, nem falha porque faltou o código de saída; e não libera repetição por conta própria.
 */
/**
 * T06 — o código curto de um ambiente Python: os 6 primeiros caracteres do identificador opaco que a máquina publicou. Serve
 * para a pessoa distinguir dois ambientes da mesma versão e achar o mesmo ambiente no computador, onde o aplicativo mostra o
 * mesmo código ao lado da pasta. Não revela a pasta.
 */
export const environmentCode = (environmentId: string) => environmentId.slice(0, 6);

export const ENDED_UNKNOWN_TEXT =
  'O Agent foi interrompido e não conseguiu confirmar como a automação terminou. Os arquivos recebidos estão disponíveis, mas não comprovam sucesso.';

/**
 * Quando foi a PLATFORM que encerrou a tentativa (a máquina não informou o desfecho): o que aconteceu, sem inventar resultado.
 * Vale para "Resultado não confirmado" (a execução podia estar em andamento) e para "Não iniciada" (a Platform nunca chegou a
 * autorizar o início).
 */
export const CLOSURE_TEXT: Record<string, { unknown: string; notStarted: string }> = {
  MACHINE_UNLINKED: {
    unknown:
      'A máquina foi desvinculada da Platform com esta execução em andamento. Não há confirmação de como a automação terminou, nem de que terminou. O que foi recebido até ali está disponível, mas não comprova sucesso.',
    notStarted: 'A máquina foi desvinculada da Platform antes de a execução começar.',
  },
  MACHINE_REVOKED: {
    unknown:
      'A máquina foi revogada por quem administra com esta execução em andamento. Não há confirmação de como a automação terminou, nem de que terminou. A parada do processo é feita pelo aplicativo naquele computador quando ele percebe a revogação: se o computador estava sem contato, a automação pode ter continuado. O que foi recebido até ali está disponível, mas não comprova sucesso.',
    notStarted: 'A máquina foi revogada por quem administra antes de a execução começar.',
  },
  COMMUNICATION_LOST: {
    unknown:
      'A máquina deixou de se comunicar durante a execução e não voltou dentro do prazo. Não há confirmação de como a automação terminou, nem de que terminou: ela pode ainda estar em andamento naquele computador. O que foi recebido até ali está disponível, mas não comprova sucesso. Se a máquina voltar, o que ela informar aparece aqui.',
    notStarted: 'A máquina deixou de se comunicar antes de a execução começar e não voltou dentro do prazo.',
  },
};

/**
 * Decisões de 16/11 — reconciliação. Uma tentativa com resultado não confirmado BLOQUEIA a repetição da solicitação até ser
 * reconciliada: pela máquina (ela confirma que o processo não está mais em execução) ou por DECLARAÇÃO de quem administra a
 * organização. "Aceitar o risco", revogar a máquina ou esperar não liberam nada.
 */
export function unreconciled(x: RemoteExecution | null): boolean {
  const last = x?.attempts[x.attempts.length - 1];
  return !!last && (last.state === 'ENDED_UNKNOWN' || last.processes != null) && last.reconciliations.length === 0;
}
/** A última tentativa terminou com um desfecho, mas os processos dela ainda não foram confirmados ausentes pela máquina. */
export function processesPending(x: RemoteExecution | null): boolean {
  const last = x?.attempts[x.attempts.length - 1];
  return !!last && last.state !== 'ENDED_UNKNOWN' && last.processes != null;
}
/**
 * Decisões de 16/11 — processos da tentativa. Terminar o processo principal não libera a máquina enquanto houver processo da
 * automação ativo: o desfecho e o código de saída ficam registrados, e a ocupação, a repetição e a limpeza esperam.
 */
export const FINISHING_LABEL = 'Finalizando — processos da automação ainda ativos';
export const PROCESSES_TEXT = {
  ACTIVE:
    'Finalizando — processos da automação ainda ativos: o processo principal desta tentativa terminou, mas a máquina informou que ainda há processos da automação em execução nela. Ela continua ocupada até eles terminarem.',
  UNCERTAIN:
    'Ocupação incerta: a máquina informou que não consegue confirmar se restou algum processo desta tentativa em execução nela. Ela continua indisponível até confirmar; o tempo, um novo contato e a declaração de reconciliação não a liberam.',
} as const;
export const RETRY_BLOCKED_PROCESSES_TEXT =
  'Executar novamente está bloqueado: o processo principal da última tentativa terminou, mas ainda não há confirmação de que os demais processos da automação terminaram naquele computador. A liberação vem quando a própria máquina confirmar, ou por declaração de quem administra a organização depois de verificar a máquina. Esperar não libera.';
export const RETRY_BLOCKED_TEXT =
  'Executar novamente está bloqueado: a última tentativa terminou com resultado não confirmado, e ainda não há confirmação de que a automação parou naquele computador. A liberação vem quando a própria máquina confirmar, ou por declaração de quem administra a organização depois de verificar a máquina. Revogar a máquina ou esperar não libera.';
export const RECONCILE = {
  BUTTON: 'Declarar reconciliação',
  TITLE: 'Declarar que a execução anterior não está mais em andamento?',
  INTRO:
    'Use só quando não for possível obter a confirmação da própria máquina e você tiver verificado a situação dela. Só quem administra a organização pode declarar. A declaração não executa nada e não muda o resultado da tentativa, que continua "Resultado não confirmado": ela libera uma nova tentativa, sujeita às mesmas autorizações. A máquina antiga continua indisponível até ela mesma confirmar.',
  WARNING:
    'A execução anterior pode ter causado efeitos parciais: parte do trabalho pode ter sido feita, ou todo ele. A Platform não sabe. Se ninguém conseguiu verificar a máquina, não declare: o bloqueio deve continuar.',
  ACK: 'Verifiquei a máquina e sei que a execução anterior pode ter causado efeitos parciais.',
  REASON_LABEL: 'O que foi verificado',
  VERIFICATION_LABEL: 'Descrição da verificação realizada',
  VERIFICATION_HINT: 'Diga o que você verificou, quando e como (de 20 a 2000 caracteres). Fica registrado com o seu nome.',
  CONFIRM: 'Declarar reconciliação',
  DONE: 'Reconciliação declarada e registrada. A tentativa continua com resultado não confirmado; uma nova tentativa já pode ser solicitada.',
  FORBIDDEN: 'Só quem administra a organização pode declarar a reconciliação. Nada foi alterado.',
  ADMIN_ONLY: 'A declaração de reconciliação cabe a quem administra a organização.',
} as const;
export const RECONCILIATION_REASON: Record<string, string> = {
  MACHINE_OFF_OUT_OF_OPERATION: 'Computador desligado e mantido fora de operação',
  PROCESS_ENDED_BY_ADMINISTRATOR: 'Processo encerrado por quem administra a máquina',
  OTHER_VERIFIED: 'Outra verificação (descreva)',
};

/** O texto do desfecho incerto: o da causa, quando a Platform encerrou; senão, o do aplicativo que voltou sem prova. */
export const endedUnknownText = (closureCause: string | null | undefined) =>
  (closureCause && CLOSURE_TEXT[closureCause]?.unknown) || ENDED_UNKNOWN_TEXT;

/** O que a máquina disse DEPOIS de a Platform encerrar a tentativa por falta de comunicação. Não muda o estado da tentativa. */
export const LATE_REPORT_STATE: Record<string, string> = {
  SUCCEEDED: 'a automação terminou',
  FAILED: 'a automação falhou',
  CANCELLED: 'a execução foi cancelada',
  TIMED_OUT: 'a execução foi encerrada por tempo',
  ENDED_UNKNOWN: 'o processo não está mais em execução, e ela também não sabe como terminou',
};

const REFUSAL: Record<string, string> = {
  BUSY: 'a máquina já estava executando outra automação',
  PAUSED: 'o recebimento estava pausado na máquina',
  PACKAGE_INVALID: 'o pacote recebido não conferiu com o publicado',
  ENVIRONMENT_GONE: 'o ambiente Python escolhido não existe mais na máquina',
  ENVIRONMENT_INCOMPATIBLE: 'o ambiente Python da máquina não atende ao pacote',
  DEPENDENCIES_MISSING: 'faltam dependências no ambiente Python da máquina',
  DISK_PRESSURE: 'a máquina estava sem espaço em disco',
  CLIENT_INCOMPATIBLE: 'o aplicativo da máquina não executa esta solicitação (tipo de pacote não suportado, ou aplicativo desatualizado)',
  SESSION_UNAVAILABLE: 'a tela do Windows estava bloqueada, ou não havia sessão aberta no computador',
  AUTHORIZATION_MISSING: 'não há autorização desta versão para o Worker da máquina',
  AUTHORIZATION_REVOKED: 'a autorização desta versão para o Worker foi revogada antes do início',
  AUTHORIZATION_EXPIRED: 'a autorização desta versão para o Worker venceu antes do início',
  WORKER_NOT_AUTHORIZED: 'o Worker deixou de estar autorizado neste ambiente de trabalho antes do início',
  MACHINE_NOT_LINKED: 'a máquina deixou de estar vinculada ao Worker antes do início',
  MACHINE_NOT_ENABLED: 'a máquina deixou de estar habilitada para execução remota antes do início',
  MACHINE_INCOMPATIBLE: 'o aplicativo da máquina deixou de ser compatível antes do início',
  COMMUNICATION_LOST: 'a máquina deixou de se comunicar antes do início',
  // PLATFORM-LICENCIAMENTO-001: a licença é conferida de novo antes de entregar e antes de iniciar
  LICENSE_REQUIRED: 'a automação estava sem licença no momento do início',
  LICENSE_EXPIRED: 'a licença da automação venceu antes do início',
};
export const refusalText = (r: string | null | undefined) => (r ? (REFUSAL[r] ?? r) : '');

/** O que falta para solicitar numa máquina, em palavras. */
export const MISSING: Record<RemoteMissing, string> = {
  PACKAGE_NOT_SUPPORTED: 'O pacote desta versão está no formato Studio. A execução remota aceita apenas pacotes Python externos compatíveis.',
  PACKAGE_NOT_REGISTERED: 'A Platform não tem o pacote desta versão registrado. Sem ele, não há o que entregar à máquina.',
  REQUIREMENTS_NOT_DECLARED: 'As dependências desta automação ainda não foram declaradas.',
  REQUIREMENTS_CONFLICT: 'As dependências declaradas estão em conflito com o pacote publicado.',
  AUTHORIZATION_MISSING: 'Falta a autorização de execução desta versão para o Worker desta máquina.',
  AUTHORIZATION_REVOKED: 'A autorização de execução desta versão para o Worker desta máquina foi revogada.',
  AUTHORIZATION_EXPIRED: 'A autorização de execução desta versão para o Worker desta máquina venceu.',
  MACHINE_PAUSED: 'Os novos trabalhos estão pausados nesta máquina.',
  MACHINE_INCOMPATIBLE: 'O aplicativo desta máquina não executa solicitações da Platform.',
  MACHINE_BUSY: 'Esta máquina já tem uma execução remota em andamento.',
  MACHINE_UNCONFIRMED:
    'Ocupação incerta: há uma execução desta máquina cujos processos ela ainda não confirmou que terminaram.',
  MACHINE_FINISHING: 'Finalizando — processos da automação ainda ativos nesta máquina.',
  MACHINE_OCCUPIED: 'Esta máquina informou que está ocupada. A Platform não recebe detalhes do que ela está fazendo.',
  MACHINE_DISK_PRESSURE: 'Esta máquina informou pouco espaço livre em disco: ela não aceita trabalho novo até haver espaço.',
  PYTHON_NOT_SELECTED: 'Ainda não foi escolhido o Python desta automação nesta máquina.',
  PYTHON_NOT_IN_INVENTORY: 'O Python escolhido para esta automação não está mais entre os que esta máquina informou.',
  LICENSE_REQUIRED: LICENSE_REQUIRED_TEXT,
  LICENSE_EXPIRED: LICENSE_EXPIRED_TEXT,
};

/**
 * O que a verificação sob demanda das dependências diz, em palavras. Sem resposta, ou quando a máquina não conseguiu conferir,
 * a tela diz que NÃO FOI POSSÍVEL VERIFICAR - nunca que o ambiente é incompatível. A verificação é só informação: a máquina
 * confere de novo antes de iniciar.
 */
export const DEPENDENCY_CHECK = {
  NONE: 'Dependências ainda não verificadas nesta máquina.',
  PENDING: 'Verificação pedida: aguardando a máquina responder.',
  UNANSWERED:
    'Não foi possível verificar: a máquina não respondeu a tempo (ela pode estar sem contato, ou com o aplicativo fechado). Isso não quer dizer que o Python seja incompatível.',
  SATISFIED: 'As dependências declaradas estão neste Python. A máquina confere de novo antes de iniciar.',
  MISSING: 'Faltam neste Python:',
  ENVIRONMENT_GONE: 'A máquina não encontrou mais o Python escolhido. Escolha outro; nenhum é trocado sozinho.',
  NOT_VERIFIED: 'Não foi possível verificar: a máquina não conseguiu conferir este Python. Isso não quer dizer que ele seja incompatível.',
  STALE: 'Esta verificação é de antes da última mudança do Python escolhido ou das dependências declaradas: verifique de novo.',
  NOTHING_INSTALLED: 'A Platform não instala nada: quem cuida do ambiente é quem administra a máquina.',
  TOO_SOON: 'Não foi possível verificar agora: já houve um pedido para esta máquina e esta automação há pouco. Tente de novo em instantes. Nada foi alterado.',
} as const;

export function dependencyCheckText(check: RemoteDependencyCheck | null): string {
  if (!check) return DEPENDENCY_CHECK.NONE;
  if (check.state === 'PENDING') return DEPENDENCY_CHECK.PENDING;
  if (check.state === 'UNANSWERED' || !check.outcome) return DEPENDENCY_CHECK.UNANSWERED;
  if (check.outcome === 'MISSING') return `${DEPENDENCY_CHECK.MISSING} ${check.missing.join(', ')}. ${DEPENDENCY_CHECK.NOTHING_INSTALLED}`;
  return DEPENDENCY_CHECK[check.outcome];
}

const PYTHON_KIND: Record<string, string> = { INSTALLATION: 'instalação', VIRTUAL_ENVIRONMENT: 'ambiente virtual' };

/** O motivo de uma recusa do servidor, em palavras (a exigência que faltou no momento do pedido). */
export const REQUEST_REFUSAL: Record<string, string> = {
  remote_package_not_supported: MISSING.PACKAGE_NOT_SUPPORTED,
  remote_package_not_registered: MISSING.PACKAGE_NOT_REGISTERED,
  remote_requirements_not_declared: MISSING.REQUIREMENTS_NOT_DECLARED,
  remote_requirements_conflict: MISSING.REQUIREMENTS_CONFLICT,
  remote_authorization_missing: MISSING.AUTHORIZATION_MISSING,
  remote_authorization_revoked: MISSING.AUTHORIZATION_REVOKED,
  remote_authorization_expired: MISSING.AUTHORIZATION_EXPIRED,
  remote_machine_paused: MISSING.MACHINE_PAUSED,
  remote_machine_incompatible: MISSING.MACHINE_INCOMPATIBLE,
  remote_machine_busy: MISSING.MACHINE_BUSY,
  remote_machine_unconfirmed: MISSING.MACHINE_UNCONFIRMED,
  remote_machine_finishing: MISSING.MACHINE_FINISHING,
  remote_previous_processes_pending:
    'O processo principal da tentativa anterior terminou, mas os processos da automação ainda não foram confirmados como encerrados: executar novamente está bloqueado.',
  remote_previous_result_unconfirmed:
    'A tentativa anterior terminou com resultado não confirmado e ainda não foi reconciliada: executar novamente está bloqueado.',
  remote_attempt_not_unconfirmed: 'Só uma tentativa com resultado não confirmado, ou com processos ainda não confirmados como encerrados, pode ser reconciliada.',
  remote_attempt_already_reconciled: 'Esta tentativa já tem uma declaração de reconciliação.',
  remote_python_not_selected: MISSING.PYTHON_NOT_SELECTED,
  license_required: LICENSE_REQUIRED_TEXT,
  license_expired: LICENSE_EXPIRED_TEXT,
  capacity_pending_limit_reached: CAPACITY_PENDING_TEXT,
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
  canReadLogs,
  canReconcile,
  externalPackage,
}: {
  workspaceId: string;
  automationId: string;
  version: { automationVersionId: string; versionNumber?: number };
  canExecute: boolean;
  canManage: boolean;
  /** Pode ver registros e resultados (logs.read): só então a tela oferece os arquivos de resultado. */
  canReadLogs: boolean;
  /**
   * Administra a organização (ORG_ADMIN, pela leitura de permissões): só então a tela OFERECE declarar a reconciliação. É só
   * apresentação: quem autoriza é o servidor, que recusa a chamada de quem não administra.
   */
  canReconcile: boolean;
  /** O pacote desta versão é um pacote Python externo: o único tipo que a execução remota aceita nesta versão do produto. */
  externalPackage: boolean;
}) {
  const { org, expired, me } = useSession();
  const licensed = me.organizationLicenseModel === 'licensed';
  const [absent, setAbsent] = useState(false);
  const [requesting, setRequesting] = useState<RemoteCandidate | null>(null);
  // S2: autorizar a versão no mesmo passo de solicitar (aceite explícito, com validade)
  const [accepting, setAccepting] = useState<RemoteCandidate | null>(null);
  const [acceptAck, setAcceptAck] = useState(false);
  const [acceptUntil, setAcceptUntil] = useState('');
  const [cancelling, setCancelling] = useState<RemoteExecution | null>(null);
  const [retrying, setRetrying] = useState<RemoteExecution | null>(null);
  const [retryAgent, setRetryAgent] = useState('');
  const [reconciling, setReconciling] = useState<{ execution: RemoteExecution; attemptId: string; attemptNumber: number } | null>(null);
  const [reconcileReason, setReconcileReason] = useState<ReconciliationReason | ''>('');
  const [reconcileText, setReconcileText] = useState('');
  const [reconcileAck, setReconcileAck] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  // escolha do Python (T01c parte 3): a máquina, o que ela informou ter e o ambiente marcado
  const [choosing, setChoosing] = useState<RemoteCandidate | null>(null);
  const [environments, setEnvironments] = useState<{ status: 'loading' | 'ready' | 'error'; items: PythonEnvironment[] }>({ status: 'loading', items: [] });
  const [environment, setEnvironment] = useState('');
  // verificação sob demanda das dependências (plano 5.9): a máquina em que o pedido está sendo enviado agora
  const [checking, setChecking] = useState('');
  const checkDependencies = async (c: RemoteCandidate) => {
    setChecking(c.agentId);
    try {
      await checkRemoteMachineDependencies(org, automationId, c.agentId);
      setNotice({ tone: 'success', text: `Verificação pedida a ${c.agentName}. O resultado aparece na linha dela quando a máquina responder (até 2 minutos).` });
      poll.refresh();
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) expired();
      else setNotice({ tone: 'warning', text: isApiError(e, 'rate_limited') ? DEPENDENCY_CHECK.TOO_SOON : remoteRefusal(e) });
    } finally {
      setChecking('');
    }
  };
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
  // uma chave por diálogo aberto (solicitar, ou autorizar e solicitar): repetir pelo mesmo diálogo devolve a mesma solicitação
  const requestKey = useMemo(() => (requesting || accepting ? crypto.randomUUID() : ''), [requesting, accepting]);

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
  const acceptUntilDate = acceptUntil ? new Date(`${acceptUntil}T23:59:59`) : null;
  const acceptUntilOk = !!acceptUntilDate && acceptUntilDate.getTime() > Date.now() && acceptUntilDate.getTime() <= Date.now() + 366 * 86_400_000;
  const versionLabel = `versão ${version.versionNumber ?? ''}`.trim();

  /** A ação que resolve o que falta — oferecida só a quem pode fazê-la. */
  const action = (m: RemoteMissing, c: RemoteCandidate) => {
    if (m === 'REQUIREMENTS_NOT_DECLARED' || m === 'REQUIREMENTS_CONFLICT')
      return canManage ? <RouteLink to={orgPath.automation(org, automationId)}>Declarar as dependências na automação</RouteLink> : 'Peça a quem gerencia esta automação.';
    if (m === 'AUTHORIZATION_MISSING' || m === 'AUTHORIZATION_REVOKED' || m === 'AUTHORIZATION_EXPIRED')
      return canExecute
        ? `Autorize a execução local desta versão para o Worker ${c.workerName}, em "Autorizações de execução local", nesta página.`
        : 'Peça a autorização a quem pode executar neste ambiente de trabalho.';
    if (m === 'PACKAGE_NOT_SUPPORTED') return 'Não há ação nesta máquina: esta versão não pode ser executada remotamente.';
    if (m === 'PACKAGE_NOT_REGISTERED') return 'Não há ação nesta máquina: publique uma nova versão da automação com o pacote.';
    if (m === 'MACHINE_PAUSED') return 'Os novos trabalhos voltam a ser recebidos no próprio computador, em "Execução remota".';
    if (m === 'MACHINE_UNCONFIRMED')
      return 'Volta a poder receber quando o aplicativo desse computador confirmar que o processo parou. Voltar a se comunicar, sozinho, não basta.';
    if (m === 'MACHINE_FINISHING') return 'Volta a poder receber quando esses processos terminarem nesse computador.';
    if (m === 'MACHINE_OCCUPIED') return 'Volta a poder receber quando o aplicativo desse computador informar que está livre.';
    if (m === 'MACHINE_DISK_PRESSURE') return 'Libere espaço no disco desse computador; nada do que está guardado nele é apagado automaticamente.';
    if (m === 'MACHINE_INCOMPATIBLE') return 'É preciso uma versão do Nekkora Agent que execute solicitações da Platform nesse computador.';
    if (m === 'PYTHON_NOT_SELECTED' || m === 'PYTHON_NOT_IN_INVENTORY')
      return canManage ? 'Escolha o Python na coluna "Python desta automação".' : 'Peça a quem gerencia esta automação.';
    // licença não é pendência da máquina: quem resolve é a administração da organização (vínculo) ou o suporte (renovação)
    if (m === 'LICENSE_REQUIRED') return 'Não há ação nesta máquina: quem administra a organização vincula uma licença a esta automação.';
    if (m === 'LICENSE_EXPIRED') return 'Não há ação nesta máquina: a renovação da licença é feita pelo suporte da Nekkora.';
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
          <span>{c.python ? `Python ${c.python.pythonVersion} · código ${environmentCode(c.python.environmentId)}` : 'Não escolhido'}</span>
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
          {c.python && (
            <Text variant="body-sm" color="secondary">
              {dependencyCheckText(c.dependencyCheck)}
              {c.dependencyCheck?.answeredAt ? (
                <>
                  {' '}
                  Respondido em <DateTimeText iso={c.dependencyCheck.answeredAt} />.
                </>
              ) : null}
              {c.dependencyCheck && c.dependencyCheck.state !== 'PENDING' && !c.dependencyCheck.current ? ` ${DEPENDENCY_CHECK.STALE}` : ''}
            </Text>
          )}
          {canExecute && c.python && c.python.inInventory && c.dependencyCheck?.state !== 'PENDING' && (
            <span>
              <Button
                size="sm"
                variant="ghost"
                loading={checking === c.agentId}
                disabled={checking !== ''}
                onClick={() => void checkDependencies(c)}
                aria-label={`Verificar as dependências em ${c.agentName}`}
              >
                Verificar dependências
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
        canExecute && c.requestable && externalPackage ? (
          <Button size="sm" onClick={() => setRequesting(c)} aria-label={`Solicitar execução em ${c.agentName}`}>
            Solicitar execução
          </Button>
        ) : canExecute && externalPackage && onlyAuthorizationMissing(c.missing) ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setAcceptAck(false);
              setAcceptUntil('');
              setAccepting(c);
            }}
            aria-label={`Solicitar execução em ${c.agentName}`}
          >
            Solicitar execução
          </Button>
        ) : (
          '—'
        ),
    },
  ];

  const executionOf = (attemptId: string) => data.executions.find((x) => x.attempts.some((t) => t.attemptId === attemptId))?.remoteExecutionId ?? '';
  const attemptLine = (a: RemoteAttempt) => (
    <li key={a.attemptId}>
      <Text variant="body-sm">
        Tentativa {a.attemptNumber} · {a.agentName} · <strong>{ATTEMPT_STATE[a.state].label}</strong>
        {a.state === 'REFUSED' && a.refusalReason ? `: ${refusalText(a.refusalReason)}` : ''}
        {a.exitCode != null ? ` · código de saída ${a.exitCode}` : ''}
      </Text>
      {a.state === 'ENDED_UNKNOWN' && (
        <Text variant="body-sm" color="secondary">
          {endedUnknownText(a.closureCause)}
        </Text>
      )}
      {a.state === 'REFUSED' && a.closureCause && CLOSURE_TEXT[a.closureCause] && (
        <Text variant="body-sm" color="secondary">
          {CLOSURE_TEXT[a.closureCause].notStarted}
        </Text>
      )}
      {a.processes && (
        <Text variant="body-sm" color="secondary">
          {PROCESSES_TEXT[a.processes]}
          {a.processesAt ? ' Informado em ' : ''}
          {a.processesAt && <DateTimeText iso={a.processesAt} />}
          {a.processesAt ? '.' : ''}
        </Text>
      )}
      {a.state === 'ENDED_UNKNOWN' && a.machineStillRunningAt && (
        <Text variant="body-sm" color="secondary">
          Em <DateTimeText iso={a.machineStillRunningAt} />, a máquina voltou e informou que ainda executa esta tentativa. Ela continua ocupada até
          informar que terminou.
        </Text>
      )}
      {a.reconciliations.map((r) =>
        r.kind === 'MANUAL' ? (
          <Text key={r.kind} variant="body-sm" color="secondary">
            {a.state === 'ENDED_UNKNOWN' ? 'Resultado não confirmado — reconciliado manualmente' : 'Processos da tentativa — reconciliado manualmente'} em{' '}
            <DateTimeText iso={r.at} /> por quem administra a organização. Verificado: {RECONCILIATION_REASON[r.reason ?? ''] ?? r.reason}. {r.verification} O
            resultado da tentativa não mudou; a declaração liberou uma nova tentativa e não liberou a máquina.
          </Text>
        ) : (
          <Text key={r.kind} variant="body-sm" color="secondary">
            Em <DateTimeText iso={r.at} />, a própria máquina confirmou que nenhum processo desta tentativa continua em execução nela.
            {a.state === 'ENDED_UNKNOWN' ? ' O resultado continua não confirmado.' : ''}
          </Text>
        ),
      )}
      {a.lateReport && (
        <Text variant="body-sm" color="secondary">
          Depois disso, em <DateTimeText iso={a.lateReport.reportedAt} />, a máquina voltou e informou que {LATE_REPORT_STATE[a.lateReport.state] ?? a.lateReport.state}
          {a.lateReport.exitCode != null ? `, com código de saída ${a.lateReport.exitCode}` : ''}. A informação chegou fora do prazo: fica registrada aqui e não
          muda o estado desta tentativa.
        </Text>
      )}
      {a.communication === 'LOST' && (
        <Text variant="body-sm" color="secondary">
          Sem comunicação com a máquina no momento. O estado é o último que ela informou. Se ela não voltar dentro do prazo, a tentativa será encerrada como
          resultado não confirmado (ou como não iniciada, se ainda não tinha começado).
        </Text>
      )}
      {/* registros: de tentativa que iniciou (em andamento ou terminada), só para quem pode ver registros */}
      {canReadLogs && a.startedAt && <RemoteLogs org={org} executionId={executionOf(a.attemptId)} attemptId={a.attemptId} attemptNumber={a.attemptNumber} />}
      {/* resultados: só de tentativa que iniciou e terminou, e só para quem pode ver registros */}
      {canReadLogs && a.startedAt && finished(a.state) && (
        <RemoteResults org={org} executionId={executionOf(a.attemptId)} attemptId={a.attemptId} attemptNumber={a.attemptNumber} />
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
      <Text variant="body-sm" color="secondary">
        A execução remota aceita apenas pacotes Python externos compatíveis. Pacotes no formato Studio não são executados remotamente nesta versão.
      </Text>
      {!externalPackage && (
        <Alert tone="warning" title="Esta versão não pode ser executada remotamente">
          O pacote desta versão está no formato Studio. A execução remota aceita apenas pacotes Python externos compatíveis, por isso não é possível
          solicitar a execução desta versão numa máquina.
        </Alert>
      )}
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {poll.error != null && <Alert tone="warning">Não foi possível atualizar agora. O que está na tela é da última leitura.</Alert>}
      {data.candidates.length > 0 && (
        <div className="pw-prod__scroll" role="region" aria-label="Máquinas para execução remota desta versão" tabIndex={0}>
          <Table columns={columns} data={data.candidates} rowKey="agentId" size="sm" caption="Máquinas habilitadas do ambiente de trabalho e o que falta para solicitar em cada uma." />
        </div>
      )}
      {data.executions.map((x) => {
        const last = x.attempts[x.attempts.length - 1];
        const done = finished(x.state);
        return (
          <Card key={x.remoteExecutionId} variant="outlined" padding="md" aria-label={`Solicitação de ${new Date(x.requestedAt).toLocaleString('pt-BR')}`}>
            <Stack gap={2}>
              <div className="pw-form__row">
                {x.state === 'QUEUED' && x.waitingForSlot ? (
                  <Badge tone="warning">{WAITING_SLOT_LABEL}</Badge>
                ) : (
                  <Badge tone={ATTEMPT_STATE[x.state].tone}>{ATTEMPT_STATE[x.state].label}</Badge>
                )}
                {last?.processes === 'ACTIVE' && <Badge tone="warning">Finalizando</Badge>}
                {last?.processes === 'UNCERTAIN' && <Badge tone="warning">Ocupação incerta</Badge>}
                <Text variant="body-sm" color="secondary">
                  Solicitada em <DateTimeText iso={x.requestedAt} />
                </Text>
              </div>
              {x.state === 'QUEUED' && x.waitingForSlot && (
                <Text variant="body-sm" color="secondary">
                  {WAITING_SLOT_TEXT}
                </Text>
              )}
              {x.cancelRequestedAt && !done && (
                <Alert tone="info">Cancelamento pedido. A execução só para quando a máquina receber o pedido e informar; até lá o estado não muda.</Alert>
              )}
              <ul className="pw-plain-list" aria-label="Tentativas">
                {x.attempts.map(attemptLine)}
              </ul>
              {done && unreconciled(x) && <Alert tone="warning">{processesPending(x) ? RETRY_BLOCKED_PROCESSES_TEXT : RETRY_BLOCKED_TEXT}</Alert>}
              {done && unreconciled(x) && !canReconcile && <Text variant="body-sm" color="secondary">{RECONCILE.ADMIN_ONLY}</Text>}
              {(canExecute || canReconcile) && (
                <div className="pw-form__row">
                  {canExecute && !done && !x.cancelRequestedAt && (
                    <Button size="sm" variant="ghost" onClick={() => setCancelling(x)}>
                      Pedir cancelamento
                    </Button>
                  )}
                  {canExecute && done && !x.cancelRequestedAt && last && !unreconciled(x) && (
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
                  {canReconcile && done && !x.cancelRequestedAt && last && unreconciled(x) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setReconcileReason('');
                        setReconcileText('');
                        setReconcileAck(false);
                        setReconciling({ execution: x, attemptId: last.attemptId, attemptNumber: last.attemptNumber });
                      }}
                    >
                      {RECONCILE.BUTTON}
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
        open={!!accepting}
        ready={acceptAck && (licensed || acceptUntilOk)}
        title={accepting ? `Solicitar a execução da ${versionLabel} em ${accepting.agentName}?` : ''}
        guard={{ operation: 'remote-execution.request', target: requestKey }}
        confirmLabel="Solicitar execução"
        stepUp={orgStepUp(org)}
        action={() =>
          accepting
            ? requestRemoteExecution(org, workspaceId, {
                automationVersionId: version.automationVersionId,
                agentId: accepting.agentId,
                requestKey,
                authorizeVersion: true,
                ...(!licensed && acceptUntilDate ? { authorizationValidUntil: acceptUntilDate.toISOString() } : {}),
              })
            : Promise.reject()
        }
        onDone={() => {
          const asked = acceptUntilDate?.toISOString() ?? null;
          const worker = accepting?.workerId;
          setAccepting(null);
          setNotice({ tone: 'success', text: 'Versão aceita para este Worker e solicitação registrada. A máquina recebe na próxima consulta.' });
          poll.refresh();
          // a validade EFETIVA da autorização criada: se saiu menor que a pedida, a tela diz (a redução nunca fica em silêncio)
          void listLocalRunAuthorizations(org, workspaceId)
            .then((l) => {
              const made = l.items
                .filter((a) => a.workerId === worker && a.automationVersionId === version.automationVersionId && !a.revokedAt)
                .sort((a, b) => String(b.grantedAt).localeCompare(String(a.grantedAt)))[0];
              if (!made?.validUntil) return;
              const reduced = asked ? reducedValidityText(asked, made.validUntil) : null;
              setNotice({
                tone: reduced ? 'warning' : 'success',
                text: `Versão aceita para este Worker e solicitação registrada. ${reduced ?? `O aceite vale até ${new Date(made.validUntil).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.`}`,
              });
            })
            .catch(() => undefined);
        }}
        onClose={() => setAccepting(null)}
        refusalText={remoteRefusal}
        uncertainText="Não foi possível confirmar a autorização e a solicitação. Atualize a página e confira as autorizações e a lista antes de repetir."
        onUnauthenticated={expired}
      >
        <Stack gap={3}>
          <Text>
            A máquina recebe a solicitação na próxima consulta. Antes de iniciar, a Platform confere a licença e o aceite desta versão para o Worker dela.
          </Text>
          <Text>{ACCEPT_VERSION.SCOPE}</Text>
          {licensed ? (
            <Text variant="body-sm" color="secondary">
              {ACCEPT_VERSION.UNTIL_LICENSED}
            </Text>
          ) : (
            <Input
              label="Aceite válido até"
              type="date"
              fullWidth
              value={acceptUntil}
              onChange={(e) => setAcceptUntil(e.target.value)}
              hint={ACCEPT_VERSION.UNTIL_LEGACY}
              error={acceptUntil && !acceptUntilOk ? 'Escolha uma data futura dentro de 366 dias.' : undefined}
            />
          )}
          <Checkbox
            label={accepting ? ACCEPT_VERSION.ACK(versionLabel, accepting.workerName) : ''}
            checked={acceptAck}
            onChange={(e) => setAcceptAck(e.target.checked)}
          />
        </Stack>
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
              options={environments.items.map((e) => ({
                value: e.environmentId,
                label: `Python ${e.pythonVersion} · ${PYTHON_KIND[e.kind] ?? e.kind} · código ${environmentCode(e.environmentId)}${e.environmentId === choosing?.python?.environmentId ? ' (atual)' : ''}`,
              }))}
            />
          )}
          {environments.status === 'ready' && environments.items.length > 0 && (
            <Text variant="body-sm" color="secondary">
              Ambientes com a mesma versão se distinguem pelo código. O mesmo código aparece no computador, em &quot;Execução remota&quot;, ao lado da pasta de cada
              ambiente. A pasta não é enviada à Platform.
            </Text>
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
          {retrying?.state === 'ENDED_UNKNOWN' && (
            <Alert tone="warning">
              A tentativa anterior terminou com resultado não confirmado: a automação pode ter feito parte do trabalho, ou todo ele. A Platform não sabe e não
              decide por você. Confira o que ela fez antes de executar de novo.
            </Alert>
          )}
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

      <StepUpDialog<RemoteExecution>
        open={!!reconciling}
        ready={!!reconcileReason && reconcileText.trim().length >= 20 && reconcileText.trim().length <= 2000 && reconcileAck}
        title={RECONCILE.TITLE}
        guard={{ operation: 'remote-execution.reconcile', target: reconciling ? reconciling.attemptId : undefined }}
        confirmLabel={RECONCILE.CONFIRM}
        stepUp={orgStepUp(org)}
        action={() =>
          reconciling && reconcileReason
            ? reconcileRemoteAttempt(org, reconciling.execution.remoteExecutionId, reconciling.attemptId, reconcileReason, reconcileText.trim())
            : Promise.reject()
        }
        onDone={() => {
          setReconciling(null);
          setNotice({ tone: 'success', text: RECONCILE.DONE });
          poll.refresh();
        }}
        onClose={() => setReconciling(null)}
        refusalText={(e) => (isApiError(e, 'forbidden') ? RECONCILE.FORBIDDEN : remoteRefusal(e))}
        uncertainText="Não foi possível confirmar a declaração. Atualize a lista e confira antes de repetir."
        onUnauthenticated={expired}
      >
        <Stack gap={3}>
          <Text>{RECONCILE.INTRO}</Text>
          <Alert tone="warning">{RECONCILE.WARNING}</Alert>
          <Select
            label={RECONCILE.REASON_LABEL}
            fullWidth
            value={reconcileReason}
            placeholder="Escolha o que foi verificado"
            onChange={(e) => setReconcileReason(e.target.value as ReconciliationReason)}
            options={Object.entries(RECONCILIATION_REASON).map(([value, label]) => ({ value, label }))}
          />
          <Textarea
            label={RECONCILE.VERIFICATION_LABEL}
            required
            fullWidth
            maxLength={2000}
            value={reconcileText}
            onChange={(e) => setReconcileText(e.target.value)}
          />
          <Text variant="body-sm" color="secondary">
            {RECONCILE.VERIFICATION_HINT}
          </Text>
          <Checkbox label={RECONCILE.ACK} checked={reconcileAck} onChange={(e) => setReconcileAck(e.target.checked)} />
        </Stack>
      </StepUpDialog>
    </section>
  );
}
