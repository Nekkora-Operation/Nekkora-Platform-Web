// Confere, antes de dev/build/test, se a Nekkora-lib ligada em node_modules (file:../Nekkora-lib) exporta tudo
// o que o frontend importa. Sem isso, um build antigo ou outro branch da lib deixa a página em branco
// ("does not provide an export named ...") sem aviso no terminal.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const link = join(root, 'node_modules', 'nekkora-lib');

function fail(lines) {
  console.error(['', '✖ Nekkora-lib incompatível com este frontend', ...lines.map((l) => `  ${l}`), ''].join('\n'));
  process.exit(1);
}

if (!existsSync(link)) fail(['node_modules/nekkora-lib não existe. Rode "npm install" (a lib deve estar em ../Nekkora-lib).']);
const lib = realpathSync(link);

// nomes importados de 'nekkora-lib' no código do app (sem os "type ...")
const needed = new Set();
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      for (const m of readFileSync(p, 'utf8').matchAll(/import\s*\{([^}]*)\}\s*from\s*'nekkora-lib'/g)) {
        for (const part of m[1].split(',')) {
          const n = part.trim();
          if (n && !n.startsWith('type ')) needed.add(n.split(/\s+as\s+/)[0]);
        }
      }
    }
  }
})(join(root, 'src'));

const exportsOf = (file, pattern) => {
  if (!existsSync(file)) return new Set();
  const names = new Set();
  for (const m of readFileSync(file, 'utf8').matchAll(pattern)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n && !n.startsWith('type ')) names.add(n);
    }
  }
  return names;
};
const missingIn = (set) => [...needed].filter((n) => !set.has(n));

const dist = join(lib, 'dist', 'nekkora-lib.js');
let missing = missingIn(exportsOf(dist, /export\s*\{([^}]*)\}/g));
if (missing.length === 0) process.exit(0);

// pode ser só build velho (ex.: depois de um git pull na lib): recompila e confere de novo.
if (existsSync(join(lib, 'src'))) {
  console.log(`Nekkora-lib: build desatualizado (faltam ${missing.join(', ')}). Recompilando ${lib}…`);
  const r = spawnSync('npm', ['run', 'build'], { cwd: lib, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(['A recompilação da lib falhou (veja acima).']);
  missing = missingIn(exportsOf(dist, /export\s*\{([^}]*)\}/g));
  if (missing.length === 0) process.exit(0);
}

const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: lib, encoding: 'utf8' }).stdout?.trim();
fail([
  `Faltam na lib: ${missing.join(', ')}.`,
  `A lib em ${lib} está no branch "${branch || '?'}", que não tem esses componentes.`,
  'Use o branch da lib que acompanha este frontend e recompile:',
  '  cd ../Nekkora-lib && git checkout claude/compassionate-knuth-7isa9u && npm install && npm run build',
]);
