import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { setPersistentSubjectForTest } from '../admin/writeStore';
import { browserDeps, createOperationRegistry, setOperationRegistryForTest } from '../api/pendingOps';

// Margem de espera (FRONT-V1-002): com a suíte inteira em paralelo (~15 workers jsdom numa máquina já ocupada) a
// renderização depois de uma resposta passou de 1 s em testes de f5, flows e f6a*; isolados, todos passam. Não é
// repetição: cada espera continua única, só com prazo compatível com a carga medida.
configure({ asyncUtilTimeout: 3_000 });

// registro de operações incertas (localStorage): cada teste começa sem registros de testes anteriores
beforeEach(() => {
  if (typeof window === 'undefined') return; // testes do simulador rodam em node
  window.localStorage.clear();
  // jsdom não tem Web Locks: o registro usa o modo sem locks; a espera aleatória desse modo (tempo de outra aba gravar)
  // fica imediata aqui, para os testes não dependerem do relógio — pendingOps.test.ts prova o modo com a espera real
  setOperationRegistryForTest(createOperationRegistry({ ...browserDeps, settle: () => Promise.resolve() }));
  setPersistentSubjectForTest('m:teste-do-registro');
});
