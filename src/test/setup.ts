import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { setPersistentSubjectForTest } from '../admin/writeStore';
import { setOperationRegistryForTest } from '../api/pendingOps';

// Margem de espera (FRONT-V1-002): com a suíte inteira em paralelo (~15 workers jsdom numa máquina já ocupada) a
// renderização depois de uma resposta passou de 1 s em testes de f5, flows e f6a*; isolados, todos passam. Não é
// repetição: cada espera continua única, só com prazo compatível com a carga medida.
configure({ asyncUtilTimeout: 3_000 });

// registro de operações incertas (localStorage): cada teste começa sem registros de testes anteriores
beforeEach(() => {
  if (typeof window === 'undefined') return; // testes do simulador rodam em node
  window.localStorage.clear();
  setOperationRegistryForTest(null);
  setPersistentSubjectForTest('m:teste-do-registro');
});
