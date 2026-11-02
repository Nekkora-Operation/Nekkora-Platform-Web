import * as lib from 'nekkora-lib';
import { describe, expect, it } from 'vitest';

/**
 * Reprodução mínima dos dois problemas encaminhados à Nekkora-lib (docs/encaminhamentos/LIB-01-field-input-file.md),
 * contra o pacote fixado em lib.lock.json. Quando a lib corrigir, este teste falha de propósito: aí a composição
 * local da VersionPage (classes nk-field + input nativo) deve ser trocada pelo componente da lib.
 */
describe('Nekkora-lib 0.2.0 — lacunas encaminhadas', () => {
  it('LIB-01a: Field não é exportado (só Fieldset)', () => {
    expect('Field' in lib).toBe(false);
    expect('Fieldset' in lib).toBe(true);
  });
  // LIB-01b (Input type="file") só se reproduz em navegador real (o jsdom aceita a escrita de value):
  // tools/repro/lib-01/run.mjs.
});
