/**
 * PLATFORM-FLUXO-002 (070/071): área do cliente. Lê SÓ o Portal (/portal/api/v1), pela sessão de identidade: a pessoa entra com a
 * conta Nekkora e vê, em cada organização, só o que foi compartilhado com ela — o DASHBOARD de execução (indicadores e estado em
 * linguagem simples) e os ARQUIVOS DE RETORNO autorizados. Registros técnicos, máquinas, ambientes e detalhes de tentativa não
 * existem nesta API. O Portal reconfere vínculo, concessões e o conteúdo a cada chamada (revogar, reduzir ou suspender vale na
 * próxima consulta). Somente GET.
 */
import { readJson } from './validate';
import { queryString } from './query';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type ClientOrganization = S['PortalClientOrganization'];
export type SharedAutomation = S['PortalSharedAutomation'];
export type SharedSummary = S['PortalSharedSummary'];
export type SharedExecution = S['PortalSharedExecution'];
export type SharedExecutionPage = S['PortalSharedExecutionPage'];
export type SharedFile = S['PortalSharedFile'];
export type SharedFilePage = S['PortalSharedFilePage'];
export type SharedOutcome = S['PortalOutcome'];

/** Período [de, até) em ISO; sem ele, o Portal usa os últimos 30 dias. */
export type Period = { from?: string; to?: string };

const root = '/portal/api/v1';
const base = (org: string) => `${root}/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

export async function listClientOrganizations(): Promise<ClientOrganization[]> {
  return (await readJson<{ items: ClientOrganization[] }>('portalClientOrganizations', `${root}/me/client-organizations`)).items;
}

export async function listSharedAutomations(org: string): Promise<SharedAutomation[]> {
  return (await readJson<{ items: SharedAutomation[] }>('portalSharedAutomations', `${base(org)}/shared-automations`)).items;
}

/** Só com o dashboard compartilhado (sem ele: 403). */
export function getSharedSummary(org: string, automationId: string, period: Period = {}): Promise<SharedSummary> {
  return readJson<SharedSummary>('portalSharedSummary', `${base(org)}/shared-automations/${id(automationId)}/summary${queryString(period)}`);
}

/** Só com o dashboard compartilhado (sem ele: 403). */
export function listSharedExecutions(org: string, automationId: string, q: Period & { cursor?: string; limit?: number } = {}): Promise<SharedExecutionPage> {
  return readJson<SharedExecutionPage>('portalSharedExecutions', `${base(org)}/shared-automations/${id(automationId)}/executions${queryString(q)}`);
}

/** Arquivos de retorno autorizados (todas as automações com arquivos, ou uma), pelo período da execução e busca no nome. */
export function listSharedFiles(org: string, q: Period & { automationId?: string; q?: string; cursor?: string; limit?: number } = {}): Promise<SharedFilePage> {
  return readJson<SharedFilePage>('portalSharedFiles', `${base(org)}/shared-files${queryString(q)}`);
}

/** Endereço do arquivo (o navegador baixa como anexo; escopo e permissão são conferidos pelo Portal nessa chamada). */
export function sharedFileHref(org: string, attemptId: string, number: number): string {
  return `${base(org)}/shared-files/${id(attemptId)}/${number}/content`;
}

/** Até onde "Visualizar" lê um arquivo na página (maior que isso: só baixar). */
export const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

export type PreviewKind = 'text' | 'image' | 'pdf';

/** O que dá para mostrar na própria página, pela extensão; o resto só se baixa. Nunca HTML, SVG ou script. */
export function previewKind(fileName: string): PreviewKind | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (['txt', 'csv', 'log', 'json'].includes(ext)) return 'text';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return null;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };

/**
 * Lê os bytes para "Visualizar" (o Portal sempre responde como anexo; a página mostra o conteúdo como texto, imagem ou PDF, sem
 * executar nada). Erros do Portal viram o status para a tela explicar (403/404/409/503).
 */
export async function fetchSharedFile(org: string, attemptId: string, number: number, fileName: string): Promise<{ text: string } | { blob: Blob }> {
  const res = await fetch(sharedFileHref(org, attemptId, number), { credentials: 'same-origin', headers: { Accept: 'application/octet-stream' } });
  if (!res.ok) throw new PreviewError(res.status);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > PREVIEW_MAX_BYTES) throw new PreviewError(413);
  const kind = previewKind(fileName);
  if (kind === 'text') return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) };
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return { blob: new Blob([bytes], { type: MIME[ext] ?? 'application/octet-stream' }) };
}

export class PreviewError extends Error {
  constructor(readonly status: number) {
    super(`preview ${status}`);
  }
}
