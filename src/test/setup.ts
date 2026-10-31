import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { setPersistentSubjectForTest } from '../admin/writeStore';
import { browserDeps, createOperationRegistry, setOperationRegistryForTest } from '../api/pendingOps';
import { fakeLocks } from './fakeLocks';

// Margem de espera (FRONT-V1-002): com a suíte inteira em paralelo (~15 workers jsdom numa máquina já ocupada) a
// renderização depois de uma resposta passou de 1 s em testes de f5, flows e f6a*; isolados, todos passam. Não é
// repetição: cada espera continua única, só com prazo compatível com a carga medida.
configure({ asyncUtilTimeout: 3_000 });

// registro de operações incertas (localStorage): cada teste começa sem registros de testes anteriores
beforeEach(() => {
  if (typeof window === 'undefined') return; // testes do simulador rodam em node
  window.localStorage.clear();
  // jsdom não tem Web Locks, e sem eles o registro não deixa enviar (FRONT-V1-004). Aqui todas as "abas" estão no mesmo
  // processo JS, onde um gerenciador em memória é exclusão de verdade; a exclusão entre abas reais do navegador é provada
  // em e2e/corrida-abas.spec.ts (Chromium, com e sem Web Locks)
  const locks = fakeLocks();
  setOperationRegistryForTest(createOperationRegistry({ ...browserDeps, locks: () => locks }));
  setPersistentSubjectForTest('m:teste-do-registro');
});
