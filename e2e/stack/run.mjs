// Lançador multiplataforma dos scripts da stack (npm no Windows usa cmd.exe, que não entende "VAR=x cmd").
// Uso: node e2e/stack/run.mjs up [origem]  |  node e2e/stack/run.mjs down
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [action, origin] = process.argv.slice(2);
if (action !== 'up' && action !== 'down') {
  console.error('uso: node e2e/stack/run.mjs up [origem] | down');
  process.exit(2);
}

// No Windows, "bash" no PATH pode ser o do WSL (roda fora do Docker Desktop): prefere o Git Bash.
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')];
  for (const root of roots.filter(Boolean)) {
    const candidate = join(root, 'Git', 'bin', 'bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  console.error('Git Bash não encontrado. Instale o Git for Windows (https://git-scm.com) ou rode o script pelo Git Bash.');
  process.exit(1);
}

const script = join(dirname(fileURLToPath(import.meta.url)), `${action}.sh`).replace(/\\/g, '/');
const env = { ...process.env };
if (origin) env.WEB_ORIGEM = origin;
const result = spawnSync(findBash(), [script], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
