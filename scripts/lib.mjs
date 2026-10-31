// Nekkora-lib com referência fixa (FRONT-V1-002). Lê lib.lock.json, prepara um checkout ISOLADO em .deps/nekkora-lib
// (nunca o ../Nekkora-lib de outra sessão), faz o build e o pacote como o CI da lib, e exige o sha256 publicado na
// evidência da release. O frontend instala esse tarball (package.json: file:.deps/pack/...), e o package-lock fixa a
// integridade sha512 — `npm ci` recusa qualquer outro conteúdo.
//
//   node scripts/lib.mjs prepare   checkout + build + pacote + conferência (idempotente)
//   node scripts/lib.mjs verify    só confere o tarball já preparado
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'lib.lock.json'), 'utf8'));
const deps = join(root, '.deps');
const src = join(deps, 'nekkora-lib');
const pack = join(deps, 'pack');
const tarball = join(pack, `nekkora-lib-${lock.version}.tgz`);
const win = process.platform === 'win32';

function run(cmd, args, cwd, { capture = false } = {}) {
  const stdio = capture ? ['ignore', 'pipe', 'inherit'] : 'inherit';
  // npm no Windows é um .cmd (precisa de shell): linha única, argumentos entre aspas
  const r =
    win && cmd === 'npm'
      ? spawnSync([cmd, ...args.map((a) => `"${a}"`)].join(' '), { cwd, encoding: 'utf8', stdio, shell: true })
      : spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} falhou (${r.status})`);
  return (r.stdout ?? '').trim();
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function verify() {
  if (!existsSync(tarball)) throw new Error(`${tarball} não existe: rode "node scripts/lib.mjs prepare"`);
  const got = sha256(tarball);
  if (got !== lock.tarballSha256) throw new Error(`sha256 do pacote ${got} ≠ ${lock.tarballSha256} (lib.lock.json)`);
  console.log(`nekkora-lib ${lock.version} @ ${lock.commit.slice(0, 12)}: sha256 ${got} confere`);
}

function prepare() {
  if (existsSync(tarball) && sha256(tarball) === lock.tarballSha256) return verify();
  mkdirSync(deps, { recursive: true });
  if (existsSync(src)) {
    const head = run('git', ['rev-parse', 'HEAD'], src, { capture: true });
    const dirty = run('git', ['status', '--porcelain', '--untracked-files=no'], src, { capture: true });
    if (head !== lock.commit || dirty) {
      console.log(`.deps/nekkora-lib em ${head.slice(0, 12)}${dirty ? ' com alterações' : ''}: recriando no commit fixado`);
      rmSync(src, { recursive: true, force: true });
    }
  }
  if (!existsSync(src)) {
    run('git', ['clone', '--quiet', '--no-checkout', '--config', 'core.autocrlf=false', lock.repository, src], root);
    run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', lock.commit], src);
  }
  // como o passo "build reproduzível" do CI da lib
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], src);
  run('npm', ['run', 'build'], src);
  rmSync(pack, { recursive: true, force: true });
  mkdirSync(pack, { recursive: true });
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', pack], src, { capture: true });
  const made = readdirSync(pack).filter((f) => f.endsWith('.tgz'));
  if (made.length !== 1 || join(pack, made[0]) !== tarball) throw new Error(`pacote inesperado: ${made.join(', ')}`);
  verify();
}

const cmd = process.argv[2];
try {
  if (cmd === 'prepare') prepare();
  else if (cmd === 'verify') verify();
  else throw new Error('uso: node scripts/lib.mjs prepare|verify');
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exit(1);
}
