import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { setOperationRegistryForTest } from '../api/pendingOps';

// registro de operações incertas (localStorage): cada teste começa sem registros de testes anteriores
beforeEach(() => {
  if (typeof window === 'undefined') return; // testes do simulador rodam em node
  window.localStorage.clear();
  setOperationRegistryForTest(null);
});
