import { useState } from 'react';
import { Alert, Button, Stack, Text } from 'nekkora-lib';
import { downloadRemoteAttemptResult, listRemoteAttemptResults, type RemoteAttemptResults } from '../../api/remoteExecutions';
import { isApiError } from '../../api/http';

/**
 * PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T03 parte b — os arquivos de resultado de UMA tentativa: o que a automação gravou na
 * pasta de saída e a máquina enviou depois de executar. Lidos sob demanda (exigem logs.read). A tela diz o que a Platform
 * sabe: se o envio ainda não foi fechado, se algum arquivo ficou de fora por limite e se os bytes foram removidos. Um
 * arquivo que falta não muda o resultado da execução. Baixar não executa nada.
 */
export function RemoteResults({ org, executionId, attemptId, attemptNumber }: { org: string; executionId: string; attemptId: string; attemptNumber: number }) {
  const [state, setState] = useState<{ status: 'closed' } | { status: 'loading' } | { status: 'error'; text: string } | { status: 'ready'; data: RemoteAttemptResults }>({
    status: 'closed',
  });
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function load() {
    setState({ status: 'loading' });
    setProblem(null);
    try {
      setState({ status: 'ready', data: await listRemoteAttemptResults(org, executionId, attemptId) });
    } catch (e) {
      setState({ status: 'error', text: listProblem(e) });
    }
  }

  async function download(number: number, fileName: string, sha256: string) {
    setBusy(number);
    setProblem(null);
    try {
      const blob = await downloadRemoteAttemptResult(org, executionId, attemptId, number, sha256);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // só o nome do arquivo: a subpasta da saída não vira caminho no computador de quem baixa
      a.download = fileName.slice(fileName.lastIndexOf('/') + 1);
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setProblem(downloadProblem(e));
    } finally {
      setBusy(null);
    }
  }

  if (state.status === 'closed' || state.status === 'loading') {
    return (
      <div>
        <Button size="sm" variant="ghost" loading={state.status === 'loading'} onClick={() => void load()} aria-label={`Ver resultados da tentativa ${attemptNumber}`}>
          Ver resultados
        </Button>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <Stack gap={2}>
        <Alert tone="warning">{state.text}</Alert>
        <div>
          <Button size="sm" variant="ghost" onClick={() => void load()} aria-label={`Tentar de novo os resultados da tentativa ${attemptNumber}`}>
            Tentar de novo
          </Button>
        </div>
      </Stack>
    );
  }
  const { items, closure, retentionLoss } = state.data;
  return (
    <Stack gap={2}>
      {items.length === 0 ? (
        <Text variant="body-sm">{closure ? 'Esta execução não enviou arquivos de resultado.' : 'Nenhum arquivo de resultado chegou até agora.'}</Text>
      ) : (
        <ul className="pw-plain-list" aria-label={`Resultados da tentativa ${attemptNumber}`}>
          {items.map((r) => (
            <li key={r.number}>
              <Text variant="body-sm">
                {r.fileName} · {size(r.sizeBytes)}
              </Text>
              {r.available ? (
                <Button size="sm" variant="ghost" loading={busy === r.number} onClick={() => void download(r.number, r.fileName, r.sha256)} aria-label={`Baixar ${r.fileName}`}>
                  Baixar
                </Button>
              ) : (
                <Text variant="body-sm" color="secondary">
                  O arquivo foi removido da Platform; ficou só o registro de que existiu.
                </Text>
              )}
            </li>
          ))}
        </ul>
      )}
      {!closure && (
        <Text variant="body-sm" color="secondary">
          A máquina ainda não informou que terminou de enviar os resultados: pode haver arquivo a caminho, ou ela não voltou a falar com a Platform.
        </Text>
      )}
      {closure && closure.skippedByLimit > 0 && (
        <Alert tone="warning">
          {closure.skippedByLimit === 1 ? '1 arquivo não foi enviado' : `${closure.skippedByLimit} arquivos não foram enviados`} pela máquina: passaram do limite de
          resultados (50 arquivos, 20 MiB cada, 50 MiB no total). Isso não muda o resultado da execução; os arquivos continuam no computador que executou.
        </Alert>
      )}
      {retentionLoss && (
        <Alert tone="warning">
          A máquina avisou, em {day(retentionLoss.reportedAt)}, que removeu a pasta de saída desta execução: venceu o prazo de guarda dela sem a Platform ter
          confirmado o recebimento de tudo. Havia {retentionLoss.localCount === 1 ? '1 arquivo' : `${retentionLoss.localCount.toLocaleString('pt-BR')} arquivos`} lá; a
          Platform tem {items.length === 1 ? '1' : items.length.toLocaleString('pt-BR')}. O que não chegou não pode mais ser recuperado pela Platform. Isso não muda o
          resultado da execução.
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div>
        <Button size="sm" variant="ghost" onClick={() => void load()} aria-label={`Atualizar os resultados da tentativa ${attemptNumber}`}>
          Atualizar resultados
        </Button>
      </div>
    </Stack>
  );
}

/** O dia em que o aviso da máquina chegou à Platform, no calendário de quem lê. */
function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'data não informada' : d.toLocaleDateString('pt-BR');
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MiB`;
}

function listProblem(e: unknown): string {
  if (isApiError(e, 'forbidden') || isApiError(e, 'not_found')) return 'Você não tem permissão para ver os resultados desta execução.';
  if (isApiError(e, 'rate_limited')) return 'Muitos pedidos seguidos. Aguarde um pouco e tente de novo.';
  return 'Não foi possível ler os resultados agora.';
}

function downloadProblem(e: unknown): string {
  if (isApiError(e, 'forbidden') || isApiError(e, 'not_found')) return 'Você não tem permissão para baixar este arquivo, ou ele não existe mais.';
  if (isApiError(e, 'conflict')) return 'O arquivo não está mais guardado na Platform. Nada foi baixado.';
  if (isApiError(e, 'rate_limited')) return 'Muitos pedidos seguidos. Aguarde um pouco e tente de novo.';
  if (isApiError(e, 'network')) return 'Não foi possível conectar à Platform. Nada foi baixado.';
  if (isApiError(e, 'unexpected')) return 'O arquivo recebido não confere com o SHA-256 registrado. Nada foi salvo.';
  return 'Não foi possível baixar o arquivo agora. Tente de novo em instantes.';
}
