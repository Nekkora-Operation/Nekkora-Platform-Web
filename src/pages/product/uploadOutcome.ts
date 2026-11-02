import { ApiError, isApiError } from '../../api/http';

/**
 * Desfecho de um envio de pacote que falhou. `uncertain`: os bytes podem ter chegado (rede, resposta fora do contrato,
 * erro interno, proxy sem o corpo da API) — nada é reenviado sem a conferência. 413 é o limite de tamanho, recusado
 * antes de o corpo ser aceito, mesmo quando vem do proxy sem corpo.
 */
export function uploadOutcome(e: unknown): 'expired' | 'refused' | 'uncertain' {
  if (isApiError(e, 'unauthenticated')) return 'expired';
  if (e instanceof ApiError && e.status === 413) return 'refused';
  if (isApiError(e, 'network', 'unexpected', 'internal_error', 'gateway')) return 'uncertain';
  return e instanceof ApiError ? 'refused' : 'uncertain';
}
