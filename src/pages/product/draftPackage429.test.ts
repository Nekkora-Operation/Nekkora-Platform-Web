import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/http';
import { draftRefusal } from './draftPackage';

/** A1 (LICENCIAMENTO-002): envio do pacote recusado pelo limite de pedidos (429) diz quando enviar de novo. */
describe('envio do pacote com 429', () => {
  it('com Retry-After: nada foi gravado, o que continua valendo e o tempo informado pela API', () => {
    expect(draftRefusal(new ApiError('rate_limited', 429, 7), 'nothing')).toBe(
      'Muitas tentativas em pouco tempo. Nada foi gravado. Nenhuma versão foi criada: o rascunho só passa a existir quando a Platform aceita o pacote. Você poderá enviar de novo em 7 segundos.',
    );
    expect(draftRefusal(new ApiError('rate_limited', 429, 1), 'previous')).toMatch(/O pacote anterior continua valendo no rascunho, sem mudança\. Você poderá enviar de novo em 1 segundo\.$/);
  });

  it('sem Retry-After (limite do gateway): pede para aguardar, sem inventar um tempo', () => {
    expect(draftRefusal(new ApiError('rate_limited', 429), 'empty')).toBe('Muitas tentativas em pouco tempo. Aguarde antes de enviar de novo.');
  });
});
