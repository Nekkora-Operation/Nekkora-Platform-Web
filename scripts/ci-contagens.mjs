// CI (FRONT-V1-002): publica as contagens efetivas como anotação do GitHub (visível no resumo do run, sem login),
// a partir dos relatórios JSON do Vitest e do Playwright. Uso: node scripts/ci-contagens.mjs vitest|playwright <arquivo>
import { readFileSync } from 'node:fs';

const [kind, file] = process.argv.slice(2);
const r = JSON.parse(readFileSync(file, 'utf8'));
let line;
if (kind === 'vitest') {
  line = `vitest: ${r.numPassedTests}/${r.numTotalTests} testes aprovados, ${r.numFailedTests} falhas, ${r.numPendingTests} pulados, ${r.testResults.length} arquivos`;
} else if (kind === 'playwright') {
  const s = r.stats;
  line = `playwright (API simulada): ${s.expected} aprovados, ${s.unexpected} falhas, ${s.flaky} instáveis, ${s.skipped} pulados`;
} else {
  throw new Error('uso: ci-contagens.mjs vitest|playwright <arquivo>');
}
console.log(`::notice title=Contagens (${kind})::${line} — ${process.env.GITHUB_SHA ?? 'local'}`);
