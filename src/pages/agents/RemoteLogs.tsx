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
export function RemoteLogs({ org, executionId, attemptId, attemptNumber }: { org: string; executionId: string; attemptId: string; attemptNumber: number }) {
  const [state, setState] = useState<
    { status: 'closed' } | { status: 'loading' } | { status: 'error'; text: string } | { status: 'ready'; lines: Line[]; total: number; nextAfter: number | null; closure: RemoteAttemptLogs['closure'] }
  >({ status: 'closed' });
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function load() {
    setState({ status: 'loading' });
    setProblem(null);
    try {
      const page = await listRemoteAttemptLogs(org, executionId, attemptId, 0);
      setState({ status: 'ready', lines: page.items, total: page.total, nextAfter: page.nextAfter, closure: page.closure });
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
      setState({ status: 'ready', lines: [...state.lines, ...page.items.filter((l) => l.sequence > last)], total: page.total, nextAfter: page.nextAfter, closure: page.closure });
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
  const { lines, total, nextAfter, closure } = state;
  const pending = total - lines.length;
  return (
    <Stack gap={2}>
      {lines.length === 0 ? (
        <Text variant="body-sm">{closure ? 'O processo desta execução não escreveu nada na saída.' : 'Nenhuma linha chegou até agora.'}</Text>
      ) : (
        <>
          <Text variant="body-sm" color="secondary">
            {lines.length === total ? `${count(total)} na Platform.` : `Mostrando ${lines.length.toLocaleString('pt-BR')} de ${count(total)} na Platform.`} A ordem é a da captura pela máquina.
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
                    O texto desta linha foi removido da Platform; ficou só o registro de que ela existiu.
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
          {closure.droppedLines === 1 ? '1 linha não foi guardada' : `${closure.droppedLines.toLocaleString('pt-BR')} linhas não foram guardadas`}: a saída desta
          execução passou do limite de registros (50.000 linhas ou 20 MiB por execução). A execução continuou e o resultado dela não mudou.
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
