import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
// @ts-expect-error módulo .mjs da ferramenta do laboratório (sem tipos)
import { compose } from '../../tools/lab/lab.mjs';
import { LAB } from './lab';

/**
 * AMBIENTE-PYTHON-001 — apoio dos roteiros do laboratório frontlab-amb001: a pasta do laboratório (índice local, robôs,
 * cópia do Client e o condutor), o SQL de conferência e os comandos ao executável.
 */
export const LABDIR = resolve(process.env.AMB_LAB_DIR ?? join(process.cwd(), '..', 'lab'));
export const GUARDADO = join(homedir(), '.nekkora', 'front-lab', LAB, 'pessoas-ambiente.json');
/** Os complementos do compose: licenças (operadora) e a chave do ambiente por execução. */
export const EXTRAS = ['compose.licencas.yml', 'compose.ambiente.yml'];
export const ROBOS = [
  { nome: 'Robô dependências', zip: 'dependencias-v1.zip' },
  { nome: 'Robô demorado', zip: 'demorado.zip' },
  { nome: 'Robô inexistente', zip: 'inexistente.zip' },
  { nome: 'Robô incompatível', zip: 'incompativel.zip' },
  { nome: 'Robô hash', zip: 'hash.zip' },
  { nome: 'Robô download', zip: 'download.zip' },
  { nome: 'Robô longo', zip: 'longo.zip' },
  { nome: 'Robô navegador', zip: 'navegador.zip' },
  { nome: 'Robô sem navegador', zip: 'sem-navegador.zip' },
  { nome: 'Robô preparado', zip: 'preparado.zip' },
];

export const sql = (q: string) =>
  (compose(LAB, ['exec', '-T', 'postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'nekkora', '-d', 'nekkora', '-c', q]) as string).trim();

const SAIDA = join(LABDIR, 'exe-saida', 'exe.jsonl');
export type Linha = Record<string, any>;
export const linhas = (): Linha[] =>
  existsSync(SAIDA)
    ? readFileSync(SAIDA, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Linha)
    : [];

/** Um comando ao condutor da cópia do executável; espera a linha da resposta. */
export async function comando(c: string, codigo?: string, timeout = 240_000): Promise<Linha> {
  const antes = linhas().length;
  if (codigo) writeFileSync(join(LABDIR, 'exe-saida', 'codigo.txt'), codigo);
  writeFileSync(join(LABDIR, 'exe-saida', 'comando.txt'), c);
  const etapa = c.split(' ')[0];
  await expect.poll(() => linhas().slice(antes).some((l) => l.etapa === etapa || l.etapa === 'falha'), { timeout, intervals: [300] }).toBe(true);
  const l = linhas().slice(antes).find((x) => x.etapa === etapa || x.etapa === 'falha')!;
  expect(l.erroDoRoteiro ?? l.erro ?? null, JSON.stringify(l)).toBeNull();
  return l;
}

export const EVID = join(LABDIR, 'evidencias');
export function log(arquivo: string, k: string, v: unknown) {
  mkdirSync(EVID, { recursive: true });
  const line = `${new Date().toISOString()} ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
  appendFileSync(join(EVID, arquivo), `${line}\n`);
  console.log(line);
}

// ------------------------------------------------------------------ a cópia do executável (abrir, fechar, encerrar por PID)
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
let exe: ChildProcess | null = null;
/** Abre a cópia de laboratório (condutor). Devolve a linha "aberto" (com o PID do processo do aplicativo). */
export async function abrirExe(): Promise<Linha> {
  const antes = linhas().length;
  exe = spawn(join(LABDIR, 'exe', 'Nekkora Agent Client', 'Nekkora Agent Client.exe'), [], { detached: true, stdio: 'ignore' });
  exe.unref();
  await expect.poll(() => linhas().slice(antes).some((l) => l.etapa === 'aberto' || l.etapa === 'falha'), { timeout: 120_000, intervals: [300] }).toBe(true);
  const l = linhas().slice(antes).find((x) => x.etapa === 'aberto' || x.etapa === 'falha')!;
  expect(l.erro ?? null, JSON.stringify(l)).toBeNull();
  return l;
}
export const vivo = (pid: number) => {
  try {
    return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid));
  } catch {
    return false;
  }
};
/** A pessoa fecha a janela (o mesmo caminho do botão de fechar); espera o processo terminar. */
export async function fecharExe(pid: number): Promise<Linha> {
  const antes = linhas().length;
  writeFileSync(join(LABDIR, 'exe-saida', 'comando.txt'), 'fechar');
  await expect.poll(() => linhas().slice(antes).some((x) => x.etapa === 'fechando'), { timeout: 30_000, intervals: [300] }).toBe(true);
  const l = linhas().slice(antes).find((x) => x.etapa === 'fechando')!;
  await expect.poll(() => vivo(pid), { timeout: 90_000, intervals: [500] }).toBe(false);
  exe = null;
  return l;
}
/** Queda do aplicativo: encerra SÓ o processo deste PID (nunca por nome de imagem). */
export async function derrubarExe(pid: number) {
  execFileSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' });
  await expect.poll(() => vivo(pid), { timeout: 30_000, intervals: [300] }).toBe(false);
  exe = null;
}
/** O último PID que o condutor informou. */
export const pidAtual = (): number => Number([...linhas()].reverse().find((l) => l.etapa === 'aberto')!.pid);

// ------------------------------------------------------------------ o índice local
const CONTROLE = join(LABDIR, 'indice', 'controle.json');
export function controle(c: Record<string, unknown>) {
  writeFileSync(CONTROLE, JSON.stringify(c));
}
export const acessos = (): string[] =>
  existsSync(join(LABDIR, 'indice', 'acessos.log')) ? readFileSync(join(LABDIR, 'indice', 'acessos.log'), 'utf8').split('\n').filter(Boolean) : [];
