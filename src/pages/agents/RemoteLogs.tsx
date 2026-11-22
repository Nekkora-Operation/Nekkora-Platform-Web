import { useState } from 'react';
import { Alert, Button, Stack, Text } from 'nekkora-lib';
import { listRemoteAttemptLogs, type RemoteAttemptLogs } from '../../api/remoteExecutions';
import { isApiError } from '../../api/http';

type Line = RemoteAttemptLogs['items'][number];

/** O canal em palavras. STDERR é um canal, não um nível: a tela não pinta linha de erro nem conclui nada pelo texto. */
const CHANNEL: Record<Line['channel'], string> = { STDOUT: 'saída', STDERR: 'saída de erro', EXECUTOR: 'aplicativo da máquina' };

/**
 * PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T05 — os registros de UMA tentativa remota: as linhas que o processo da automação
 * escreveu na saída padrão e na saída de erro, na ordem em que a máquina as capturou. Lidos sob demanda (exigem logs.read),
 * em páginas. A tela diz o que a Platform sabe: se o envio ainda não foi fechado, se alguma linha foi cortada, quantas
 * foram descartadas por limite e se o texto foi removido pela retenção. Nada disso muda o resultado da execução. O texto é
 * mostrado como texto, nunca interpretado.
 */
function counts(page: RemoteAttemptLogs) {
  return {
    total: page.total,
    automationLines: page.automationLines,
    systemLines: page.systemLines,
    nextAfter: page.nextAfter,
    closure: page.closure,
    retentionLoss: page.retentionLoss,
    expiration: page.expiration,
    availability: page.availability,
  };
}

const n = (v: number) => v.toLocaleString('pt-BR');

/**
 * O que a Platform guarda, separado: o que o processo da automação escreveu e os avisos do próprio aplicativo da máquina (por
 * exemplo, o aviso de limite atingido). Os avisos ocupam lugar no limite de linhas, mas não são saída da automação.
 */
export function storedText(automationLines: number, systemLines: number): string {
  const automation = automationLines === 1 ? '1 linha é da automação' : `${n(automationLines)} linhas são da automação`;
  if (systemLines === 0) return `${automation}.`;
  return `${automation} e ${systemLines === 1 ? '1 é aviso' : `${n(systemLines)} são avisos`} do aplicativo da máquina.`;
}

/** A conta que fecha: escritas pela automação = guardadas + descartadas. Só é dita com o envio fechado e sem aviso de perda. */
export function writtenText(automationLines: number, droppedLines: number, lost: boolean): string {
  if (lost) return '';
  return `A automação escreveu ${n(automationLines + droppedLines)} linhas: ${n(automationLines)} guardadas e ${n(droppedLines)} descartadas.`;
}

const DELIVERY_END: Record<string, string> = {
  CLOSED: 'a máquina concluiu o envio',
  LOSS_NOTICE: 'a máquina avisou que não tinha mais o que enviar',
  LINK_ENDED: 'o vínculo da máquina foi encerrado',
};

type Availability = RemoteAttemptLogs['availability'];
/** Data e hora no calendário de quem lê (a data limite é um instante, não só um dia). */
const moment = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/**
 * LICENCIAMENTO-002 — até quando o conteúdo fica disponível na Platform, ANTES de vencer. A contagem começa no fim da entrega
 * (calculado pelo servidor). Vencido, quem fala é o texto do vencimento ({@link logsExpiredText}/resultsExpiredText): aqui, nulo.
 * {@code what}: "Os registros" ou "Os arquivos de resultado".
 */
export function availabilityText(a: Availability | undefined, what: string): string | null {
  if (!a || a.state === 'EXPIRED') return null;
  const days = a.days === 1 ? '1 dia' : `${n(a.days)} dias`;
  switch (a.state) {
    case 'WAITING_DELIVERY':
      return `${what} ficam disponíveis na Platform por ${days} depois do fim da entrega. A contagem ainda não começou: a execução não terminou.`;
    case 'SCHEDULED':
      return a.availableUntil && a.startsAt
        ? `Disponível até ${moment(a.availableUntil)}: a Platform guarda ${what.toLowerCase()} por ${days} contados do fim da entrega (${DELIVERY_END[a.deliveryEnd ?? ''] ?? a.deliveryEnd} em ${moment(a.startsAt)}). Depois disso, o conteúdo é removido.`
        : null;
    case 'INCOMPLETE_DELIVERY':
      return a.availableUntil && a.startsAt
        ? `A máquina ainda não concluiu o envio. Se nada mais chegar, ${what.toLowerCase()} ficam disponíveis até ${moment(a.availableUntil)} (${days} sem progresso desde ${moment(a.startsAt)}); um novo envio adia essa data.`
        : null;
    case 'UNCERTAIN':
      return `O resultado desta execução não foi confirmado. Enquanto não for reconciliado, ${what.toLowerCase()} não expiram.`;
    case 'NO_RETENTION':
      return `Neste ambiente a Platform não remove ${what.toLowerCase()} automaticamente.`;
    default:
      return null;
  }
}

type Expiration = NonNullable<RemoteAttemptLogs['expiration']>;
const expirationDay = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC' });

/** O prazo, de onde ele contou e o que ficou. Usado pelos registros e pelos resultados. */
export function expiredPeriodText(x: Expiration): string {
  const days = x.retentionDays === 1 ? '1 dia' : `${n(x.retentionDays)} dias`;
  if (x.deliveryEnd === 'NO_PROGRESS')
    return `A entrega ficou incompleta: a máquina não concluiu o envio e passaram ${days} sem progresso (o último foi em ${expirationDay(x.deliveryEndedAt)}). Isso não indica que tudo foi recebido.`;
  return `A Platform guarda esse conteúdo por ${days} depois do fim da entrega (${DELIVERY_END[x.deliveryEnd] ?? x.deliveryEnd} em ${expirationDay(x.deliveryEndedAt)}).`;
}

export function logsExpiredText(x: Expiration): string {
  const what = x.items === 1 ? 'O texto de 1 linha' : `O texto de ${n(x.items)} linhas`;
  const done = x.confirmedAt ? `${what} expirou em ${expirationDay(x.expiredAt)} e foi removido da Platform.` : `${what} expirou em ${expirationDay(x.expiredAt)}; a remoção está em andamento.`;
  return `${done} ${expiredPeriodText(x)} Fica o registro de que cada linha existiu, com o instante e o canal. O histórico e o resultado da execução não mudam.`;
}

export function RemoteLogs({ org, executionId, attemptId, attemptNumber }: { org: string; executionId: string; attemptId: string; attemptNumber: number }) {
  const [state, setState] = useState<
    { status: 'closed' } | { status: 'loading' } | { status: 'error'; text: string } | { status: 'ready'; lines: Line[]; total: number; automationLines: number; systemLines: number; nextAfter: number | null; closure: RemoteAttemptLogs['closure']; retentionLoss: RemoteAttemptLogs['retentionLoss']; expiration: RemoteAttemptLogs['expiration']; availability: Availability | undefined }
  >({ status: 'closed' });
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function load() {
    setState({ status: 'loading' });
    setProblem(null);
    try {
      const page = await listRemoteAttemptLogs(org, executionId, attemptId, 0);
      setState({ status: 'ready', lines: page.items, ...counts(page) });
    } catch (e) {
      setState({ status: 'error', text: problemText(e) });
    }
  }

  /** Busca o que vem depois da última linha já mostrada: a página seguinte, ou o que chegou desde a última leitura. */
  async function loadAfter() {
    if (state.status !== 'ready') return;
    setMore(true);
    setProblem(null);
    try {
      const last = state.lines.length ? state.lines[state.lines.length - 1].sequence : 0;
      const page = await listRemoteAttemptLogs(org, executionId, attemptId, last);
      setState({ status: 'ready', lines: [...state.lines, ...page.items.filter((l) => l.sequence > last)], ...counts(page) });
    } catch (e) {
      setProblem(problemText(e));
    } finally {
      setMore(false);
    }
  }

  if (state.status === 'closed' || state.status === 'loading') {
    return (
      <div>
        <Button size="sm" variant="ghost" loading={state.status === 'loading'} onClick={() => void load()} aria-label={`Ver registros da tentativa ${attemptNumber}`}>
          Ver registros
        </Button>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <Stack gap={2}>
        <Alert tone="warning">{state.text}</Alert>
        <div>
          <Button size="sm" variant="ghost" onClick={() => void load()} aria-label={`Tentar de novo os registros da tentativa ${attemptNumber}`}>
            Tentar de novo
          </Button>
        </div>
      </Stack>
    );
  }
  const { lines, total, automationLines, systemLines, nextAfter, closure, retentionLoss, expiration, availability } = state;
  const until = availabilityText(availability, 'Os registros');
  const pending = total - lines.length;
  return (
    <Stack gap={2}>
      {lines.length === 0 ? (
        <Text variant="body-sm">{closure ? 'O processo desta execução não escreveu nada na saída.' : 'Nenhuma linha chegou até agora.'}</Text>
      ) : (
        <>
          <Text variant="body-sm" color="secondary">
            {lines.length === total ? `${count(total)} na Platform.` : `Mostrando ${lines.length.toLocaleString('pt-BR')} de ${count(total)} na Platform.`}{' '}
            {storedText(automationLines, systemLines)} A ordem é a da captura pela máquina.
            &quot;Saída de erro&quot; é o canal em que o processo escreveu; sozinho, não indica falha.
          </Text>
          <ol className="pw-plain-list pw-log" aria-label={`Registros da tentativa ${attemptNumber}`}>
            {lines.map((l) => (
              <li key={l.sequence}>
                <Text variant="body-sm" color="secondary">
                  {l.sequence} · {time(l.capturedAt)} · {CHANNEL[l.channel]}
                  {l.truncated ? ' · linha cortada no limite de 8 KiB' : ''}
                </Text>
                {l.textRemoved ? (
                  <Text variant="body-sm" color="secondary">
                    O texto desta linha expirou e foi removido da Platform; ficou só o registro de que ela existiu.
                  </Text>
                ) : (
                  <pre className="pw-log-line">{l.message}</pre>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {!closure && (
        <Text variant="body-sm" color="secondary">
          A máquina ainda não informou que terminou de enviar os registros: a execução pode estar em andamento, pode haver linha a caminho, ou ela não voltou a falar
          com a Platform.
        </Text>
      )}
      {closure && closure.droppedLines > 0 && (
        <Alert tone="warning">
          {closure.droppedLines === 1 ? '1 linha da automação não foi guardada' : `${closure.droppedLines.toLocaleString('pt-BR')} linhas da automação não foram guardadas`}: a
          saída desta execução passou do limite de registros (50.000 linhas ou 20 MiB por execução). {writtenText(automationLines, closure.droppedLines, !!retentionLoss)} A
          execução continuou e o resultado dela não mudou.
        </Alert>
      )}
      {expiration && <Alert tone="info">{logsExpiredText(expiration)}</Alert>}
      {until && (
        <Text variant="body-sm" color="secondary">
          {until}
        </Text>
      )}
      {retentionLoss && (
        <Alert tone="warning">
          A máquina avisou, em {day(retentionLoss.reportedAt)}, que removeu os registros que ainda guardava desta execução: venceu o prazo de guarda dela sem a
          Platform ter confirmado o recebimento de tudo. Ela tinha capturado {count(retentionLoss.localCount)}; a Platform tem {total.toLocaleString('pt-BR')}. O que
          não chegou não pode mais ser recuperado pela Platform. Isso não muda o resultado da execução.
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div>
        {nextAfter != null || pending > 0 ? (
          <Button size="sm" variant="ghost" loading={more} onClick={() => void loadAfter()} aria-label={`Carregar mais registros da tentativa ${attemptNumber}`}>
            Carregar mais linhas
          </Button>
        ) : (
          <Button size="sm" variant="ghost" loading={more} onClick={() => void loadAfter()} aria-label={`Atualizar os registros da tentativa ${attemptNumber}`}>
            Atualizar registros
          </Button>
        )}
      </div>
    </Stack>
  );
}

/** O dia em que o aviso da máquina chegou à Platform, no calendário de quem lê. */
function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'data não informada' : d.toLocaleDateString('pt-BR');
}

function count(n: number): string {
  return n === 1 ? '1 linha' : `${n.toLocaleString('pt-BR')} linhas`;
}

/** Hora da captura, no relógio de quem lê. É o relógio da máquina que capturou: serve para ordenar por perto, não para auditar. */
function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function problemText(e: unknown): string {
  if (isApiError(e, 'forbidden') || isApiError(e, 'not_found')) return 'Você não tem permissão para ver os registros desta execução.';
  if (isApiError(e, 'rate_limited')) return 'Muitos pedidos seguidos. Aguarde um pouco e tente de novo.';
  if (isApiError(e, 'network')) return 'Não foi possível conectar à Platform.';
  return 'Não foi possível ler os registros agora.';
}
