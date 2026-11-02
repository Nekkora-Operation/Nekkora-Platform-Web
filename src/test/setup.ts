import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Margem de espera (FRONT-V1-002/003): com a suíte inteira em paralelo a renderização depois de uma resposta passou de
// 1 s (f5, flows, f6a*), inclusive no runner do CI; isolados, todos passam. Não é repetição: cada espera continua
// única, só com prazo compatível com a carga medida.
configure({ asyncUtilTimeout: 3_000 });
