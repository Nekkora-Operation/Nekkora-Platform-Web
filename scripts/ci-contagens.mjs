// CI (FRONT-V1-002): publica as contagens efetivas como anotação do GitHub (visível no resumo do run, sem login),
// a partir dos relatórios JSON do Vitest e do Playwright. Uso: node scripts/ci-contagens.mjs vitest|playwright <arquivo>
import { readFileSync } from 'node:fs';

const [kind, file] = process.argv.slice(2);
const r = JSON.parse(readFileSync(file, 'utf8'));
let line;
if (kind === 'vitest') {
  // arquivo que nem carrega (erro de import/coleta) não entra em numFailedTests: conta à parte
  const quebrados = (r.numFailedTestSuites ?? 0) + (r.numRuntimeErrorTestSuites ?? 0);
  line = `vitest: ${r.numPassedTests}/${r.numTotalTests} testes aprovados, ${r.numFailedTests} falhas, ${r.numPendingTests} pulados, ${r.testResults.length} arquivos, ${quebrados} arquivos com falha, ${r.success ? 'sucesso' : 'FALHOU'}`;
} else if (kind === 'playwright') {
  const s = r.stats;
  // erros fora dos testes (webServer, global setup) não aparecem nas contagens
  const erros = (r.errors ?? []).length;
  line = `playwright (API simulada): ${s.expected} aprovados, ${s.unexpected} falhas, ${s.flaky} instáveis, ${s.skipped} pulados, ${erros} erros fora dos testes`;
} else {
  throw new Error('uso: ci-contagens.mjs vitest|playwright <arquivo>');
}
console.log(`::notice title=Contagens (${kind})::${line} — ${process.env.GITHUB_SHA ?? 'local'}`);
