import { Alert } from 'nekkora-lib';
import { useOptionalSession } from '../area/session';

/**
 * RELEASE-2.2: a execução pela Platform (execução remota, pelo novo Nekkora Agent Client) só aparece como opção onde a API diz
 * que está disponível (`me.remoteExecutionAvailable`). Ausente (API anterior ao campo) = indisponível. Quem decide continua
 * sendo cada rota da API (409 remote_execution_unavailable); isto só evita oferecer o que seria recusado.
 */
export function useRemoteExecutionAvailable(): boolean {
  // fora da área autenticada (ou com uma API anterior ao campo): indisponível
  return useOptionalSession()?.me.remoteExecutionAvailable === true;
}

export const REMOTE_UNAVAILABLE_TITLE = 'Execução pela Platform indisponível nesta versão';
export const REMOTE_UNAVAILABLE_BODY =
  'Ela chega com o novo Nekkora Agent Client, que ainda não foi publicado. Executar pelo Nekkora Agent, no próprio computador, continua como hoje.';

/** Aviso no lugar dos controles da execução pela Platform; `detail` diz o que ficou de fora naquela tela. */
export function RemoteUnavailableNotice({ detail }: { detail?: string }) {
  return (
    <Alert tone="info" title={REMOTE_UNAVAILABLE_TITLE}>
      {detail ? `${detail} ` : ''}
      {REMOTE_UNAVAILABLE_BODY}
    </Alert>
  );
}
