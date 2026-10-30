/**
 * Ciclo de vida das automações (PLATFORM-AUTOMATION-LIFECYCLE-001; migration 028): automação, versão DRAFT, artefato
 * (pacote do Studio, ZIP) recebido e CONFERIDO pela API, e publicação com step-up. Publicar não autoriza nem dispara
 * execução. Respostas conferidas contra o esquema do status recebido.
 *
 * O navegador nunca abre, executa nem extrai o ZIP: só envia os bytes escolhidos pela pessoa. A conferência do pacote
 * (manifesto, hashes, impressão) é do servidor, que é a autoridade.
 */
import { sessionCsrf } from './auth';
import { ApiError, apiErrorFrom, request, safeRequestId, type RequestOptions } from './http';
import { validated, type OperationId } from './validate';
import type { components } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type LifecycleAutomation = S['LifecycleAutomation'];
export type LifecycleVersion = S['LifecycleVersion'];
export type LifecycleArtifact = S['LifecycleArtifact'];
export type PackageRejectedReason = S['PackageRejected']['reason'];

/** Limite do contrato para o corpo do artefato. */
export const ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;
const id = (v: string) => encodeURIComponent(v);

async function send<T>(org: string, operationId: OperationId, path: string, options: RequestOptions = {}): Promise<T> {
  const write = options.method && options.method !== 'GET';
  const { status, data } = await request<unknown>(`${base(org)}${path}`, write ? { ...options, csrf: await sessionCsrf(org) } : options);
  return validated<T>(operationId, data, status);
}

/** automation.manage no workspace; workspace inativo: 409; sem acesso: 404. */
export function createAutomation(org: string, workspaceId: string, name: string): Promise<LifecycleAutomation> {
  return send(org, 'createAutomation', `/workspaces/${id(workspaceId)}/automations`, { method: 'POST', body: { name } });
}

/** Versão DRAFT (número atribuído pelo banco). `runtime` padrão python3.12. */
export function createAutomationVersion(org: string, automationId: string, draft?: { runtime?: string; arguments?: string[] }): Promise<LifecycleVersion> {
  return send(org, 'createAutomationVersion', `/automations/${id(automationId)}/versions`, { method: 'POST', body: draft ?? {} });
}

export function getAutomationVersion(org: string, versionId: string): Promise<LifecycleVersion> {
  return send(org, 'getAutomationVersion', `/automation-versions/${id(versionId)}`);
}

/** Só DRAFT; publicada é imutável (409). */
export function updateAutomationVersionDraft(org: string, versionId: string, draft: { runtime?: string; arguments?: string[] }): Promise<LifecycleVersion> {
  return send(org, 'updateAutomationVersionDraft', `/automation-versions/${id(versionId)}`, { method: 'PATCH', body: draft });
}

export interface UploadHandle {
  promise: Promise<LifecycleVersion>;
  /** Interrompe o envio no navegador. Se os bytes já chegaram, a API pode ter recebido: reconciliar pela leitura da versão. */
  abort: () => void;
}

/**
 * Envia o ZIP (application/zip, Content-Length do próprio arquivo) com progresso. Recusa do pacote: 422
 * (`ApiError.code === 'package_rejected'`, `reason` do vocabulário do contrato); versão publicada: 409; armazenamento não
 * configurado: 503. Os mesmos bytes de novo: idempotente no servidor — mas a interface NUNCA reenvia sozinha.
 */
export function uploadArtifact(org: string, versionId: string, file: Blob, onProgress: (sent: number, total: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = (async () => {
    const csrf = await sessionCsrf(org);
    return new Promise<LifecycleVersion>((resolve, reject) => {
      xhr.open('PUT', `${base(org)}/automation-versions/${id(versionId)}/artifact`);
      xhr.setRequestHeader('Content-Type', 'application/zip');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.withCredentials = false; // mesma origem: os cookies vão sozinhos
      xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
      xhr.onerror = () => reject(new ApiError('network', 0));
      xhr.onabort = () => reject(new ApiError('network', 0));
      xhr.onload = () => {
        const requestId = safeRequestId(xhr.getResponseHeader('X-Request-Id'));
        let body: unknown;
        try {
          body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
        } catch {
          body = undefined;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(validated<LifecycleVersion>('putAutomationVersionArtifact', body, xhr.status));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(apiErrorFrom(xhr.status, body, xhr.getResponseHeader('Retry-After'), requestId));
        }
      };
      xhr.send(file);
    });
  })();
  return { promise, abort: () => xhr.abort() };
}

/**
 * Publicação (automation.publish + step-up). A pessoa confirma o que conferiu: sha256 dos BYTES e impressão do PACOTE.
 * Diferentes do rascunho atual (o artefato mudou depois da conferência): 409, sem aceitar o conteúdo novo.
 * Repetição com a mesma expectativa (resposta perdida): 200 com a versão já publicada.
 */
export function publishAutomationVersion(org: string, versionId: string, expected: { sha256: string; fingerprint: string }): Promise<LifecycleVersion> {
  return send(org, 'publishAutomationVersion', `/automation-versions/${id(versionId)}/publish`, {
    method: 'POST',
    body: { expectedArtifactSha256: expected.sha256, expectedPackageFingerprint: expected.fingerprint },
  });
}

/** SHA-256 local dos bytes escolhidos (auxiliar: a conferência do servidor é a autoridade). */
export async function localSha256(file: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null; // contexto sem Web Crypto
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Motivos de recusa do pacote (vocabulário fechado do contrato) em português simples. */
export const PACKAGE_REASON: Record<PackageRejectedReason, string> = {
  vazio: 'o arquivo está vazio',
  tamanho_excedido: 'o arquivo passa do limite de 50 MiB',
  zip_malformado: 'o arquivo não é um ZIP válido',
  zip_nao_suportado: 'o ZIP usa um formato não suportado (por exemplo, ZIP64)',
  zip_cifrado: 'o ZIP está cifrado (com senha)',
  zip_ambiguo: 'o ZIP tem estrutura ambígua',
  zip_corrompido: 'o ZIP está corrompido',
  ligacao_simbolica: 'o ZIP contém ligação simbólica',
  caminho_inseguro: 'o ZIP contém caminho absoluto ou com ".."',
  nome_repetido: 'o ZIP contém nomes de arquivo repetidos',
  arquivos_demais: 'o ZIP tem arquivos demais',
  manifesto_ausente: 'falta o manifest.json do Studio',
  manifesto_grande: 'o manifest.json é grande demais',
  manifesto_malformado: 'o manifest.json não pôde ser lido',
  manifesto_fora_do_contrato: 'o manifest.json não segue o contrato do Studio (1.4 ou mais novo)',
  modo_de_execucao_invalido: 'o modo de execução declarado é inválido',
  framework_invalido: 'o framework declarado é inválido',
  linha_de_comando_invalida: 'a linha de comando declarada é inválida',
  segredos_nao_suportados: 'o pacote pede segredos, o que ainda não é suportado',
  lista_de_arquivos_ausente: 'falta a lista de arquivos no manifesto',
  hash_declarado_invalido: 'um hash declarado no manifesto é inválido',
  entrada_ausente: 'falta o arquivo de entrada (main.py)',
  arquivo_listado_ausente: 'um arquivo listado no manifesto não está no ZIP',
  hash_divergente: 'o conteúdo de um arquivo não confere com o hash declarado',
};
