import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorFrom } from '../../api/http';
import { uploadOutcome } from './uploadOutcome';

describe('desfecho do envio de pacote', () => {
  it('proxy sem o corpo da API (502/503/504) é incerto, nunca "nada foi gravado"', () => {
    for (const status of [502, 503, 504]) expect(uploadOutcome(apiErrorFrom(status, undefined, null)), String(status)).toBe('uncertain');
  });

  it('503 com o corpo documentado da API é recusa (armazenamento indisponível); 413 sem corpo também', () => {
    expect(uploadOutcome(apiErrorFrom(503, { error: 'service_unavailable' }, null))).toBe('refused');
    expect(uploadOutcome(apiErrorFrom(413, undefined, null))).toBe('refused');
    expect(uploadOutcome(apiErrorFrom(422, { error: 'package_rejected', reason: 'manifest_invalid' }, null))).toBe('refused');
  });

  it('rede, resposta fora do contrato e erro interno são incertos; 401 encerra a sessão', () => {
    expect(uploadOutcome(new ApiError('network', 0))).toBe('uncertain');
    expect(uploadOutcome(new ApiError('unexpected', 200))).toBe('uncertain');
    expect(uploadOutcome(apiErrorFrom(500, { error: 'internal_error' }, null))).toBe('uncertain');
    expect(uploadOutcome(new TypeError('falhou'))).toBe('uncertain');
    expect(uploadOutcome(apiErrorFrom(401, { error: 'unauthenticated' }, null))).toBe('expired');
  });
});
