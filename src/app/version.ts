/**
 * Versão em execução (PLATFORM-LOCAL-002): o que a pessoa está testando. Os valores vêm do vite.config.ts
 * (`__NEKKORA_BUILD__`): commit e branch do Web lidos do git ao iniciar o Vite ou o build, a Nekkora-lib fixada em
 * lib.lock.json e o commit da API informado pelo runner local (NEKKORA_API_COMMIT). Só identificação; nada decide acesso.
 */
export interface BuildInfo {
  webCommit: string | null;
  webBranch: string | null;
  webDirty: boolean;
  apiCommit: string | null;
  lib: string | null;
}

export const UNKNOWN = 'desconhecida';

export function buildInfo(): BuildInfo {
  return typeof __NEKKORA_BUILD__ === 'undefined'
    ? { webCommit: null, webBranch: null, webDirty: false, apiCommit: null, lib: null }
    : __NEKKORA_BUILD__;
}

/** "main" é a linha integrada; qualquer outra branch é candidata (ainda sem merge). */
export function channelOf(info: BuildInfo): { label: string; candidate: boolean } {
  if (!info.webBranch || info.webBranch === 'HEAD') return { label: 'origem não identificada', candidate: true };
  if (info.webBranch === 'main') return { label: 'main', candidate: false };
  return { label: `candidata (branch ${info.webBranch})`, candidate: true };
}

/** Linha curta para o rodapé: "Web 1a2b3c4 · candidata (branch x) · API e04a57c". */
export function versionLine(info: BuildInfo = buildInfo()): string {
  const web = info.webCommit ? `${info.webCommit}${info.webDirty ? ' com alterações locais' : ''}` : UNKNOWN;
  return [`Web ${web}`, channelOf(info).label, `API ${info.apiCommit ?? UNKNOWN}`].join(' · ');
}
