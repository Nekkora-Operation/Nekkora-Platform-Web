/**
 * F4-R1: formatação de datas recebidas. Toda data aceita pelo validador do contrato precisa ser apresentável, sem
 * lançar e sem trocar por outro instante.
 */
import { describe, expect, it } from 'vitest';
import { isDateTime } from '../../api/validate';
import { formatDateTime } from './format';

describe('formatDateTime', () => {
  it('data comum: convertida para o fuso do navegador, com o deslocamento', () => {
    const r = formatDateTime('2026-10-03T12:00:00Z');
    expect(r.asReceived).toBe(false);
    expect(r.offset).toMatch(/^UTC[+−]\d{2}:\d{2}$/);
  });

  it('segundo bissexto aceito pelo contrato: mostrado como recebido, sem lançar e sem virar outro instante', () => {
    for (const [iso, text, offset] of [
      ['2016-12-31T23:59:60Z', '31/12/2016, 23:59:60', 'UTC+00:00'],
      ['2016-12-31T20:59:60-03:00', '31/12/2016, 20:59:60', 'UTC−03:00'],
      ['2016-12-31T20:59:60.5-0300', '31/12/2016, 20:59:60', 'UTC−03:00'],
      ['2016-12-31t23:59:60z', '31/12/2016, 23:59:60', 'UTC+00:00'],
    ] as const) {
      expect(isDateTime(iso), iso).toBe(true); // o validador aceita
      expect(Number.isNaN(new Date(iso).getTime()), iso).toBe(true); // o Date não representa
      expect(formatDateTime(iso), iso).toEqual({ text, offset, asReceived: true });
    }
  });

  it('todas as datas válidas da tabela do validador formatam sem lançar', () => {
    for (const iso of ['2024-02-29T00:00:00Z', '2000-02-29T12:00:00Z', '2026-10-03T12:00:00.123456789Z', '2026-10-03T12:00:00-03:00', '2016-12-31T23:59:60Z', '2016-12-31T20:59:60-03:00', '2026-10-03t12:00:00z']) {
      expect(() => formatDateTime(iso), iso).not.toThrow();
      expect(formatDateTime(iso).text, iso).not.toBe('');
    }
  });

  it('texto fora de qualquer formato (não deveria chegar, o cliente valida antes): mostrado como veio, sem lançar', () => {
    expect(formatDateTime('nao-e-data')).toEqual({ text: 'nao-e-data', offset: '', asReceived: true });
  });
});
