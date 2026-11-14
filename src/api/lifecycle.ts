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
import { listAutomationVersions } from './product';

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

export interface DraftExpectation {
  /** Rascunho que a pessoa vê. Ausente: espera que a automação NÃO tenha rascunho (o envio aceito cria a versão). */
  draftVersionId?: string;
  /** SHA-256 do pacote atual do rascunho esperado. Ausente: o rascunho esperado ainda não tem pacote. */
  sha256?: string | null;
  /** Só valem quando o envio cria o rascunho; para um rascunho existente, o comando muda pelo PATCH da versão. */
  runtime?: string;
  arguments?: string[];
}

/** Caminho do PUT do pacote do rascunho, com a expectativa na query (T09). */
export function draftPackagePath(org: string, automationId: string, expect: DraftExpectation): string {
  const q = new URLSearchParams();
  if (expect.draftVersionId) {
    q.set('expectedDraftVersionId', expect.draftVersionId);
    if (expect.sha256) q.set('expectedSha256', expect.sha256);
  } else {
    if (expect.runtime) q.set('runtime', expect.runtime);
    for (const a of expect.arguments ?? []) q.append('argument', a);
  }
  const qs = q.toString();
  return `${base(org)}/automations/${id(automationId)}/draft/artifact${qs ? `?${qs}` : ''}`;
}

/**
 * O rascunho atual da automação, lido da API (ou `null`). No máximo um por automação (032) e sempre o de maior número
 * (só nasce quando não há outro, com MAX+1): é o primeiro da lista, ordenada por número decrescente.
 */
export async function readAutomationDraft(org: string, automationId: string): Promise<LifecycleVersion | null> {
  const page = await listAutomationVersions(org, automationId, { limit: 1 });
  const draft = (page.items ?? []).find((v) => v.status === 'draft');
  return draft ? getAutomationVersion(org, draft.automationVersionId) : null;
}

/**
 * PLATFORM-AGENT-V2-002, T09 — envia o ZIP do rascunho da automação (application/zip, Content-Length do próprio arquivo),
 * com progresso. Um único rascunho por automação: sem rascunho, o ZIP ACEITO cria a versão DRAFT (201); com rascunho, só
 * substitui o pacote da MESMA versão se a expectativa conferir (200). Expectativa vencida (outra aba ou pessoa enviou, ou o
 * rascunho foi publicado): 409 `conflict` + `draft_changed`, nada sobrescrito. Pacote recusado: 422 (`package_rejected`,
 * `reason` do vocabulário do contrato), nada criado e o pacote anterior preservado; armazenamento não configurado: 503.
 * Os mesmos bytes de novo: 200 com o mesmo rascunho — mas a interface NUNCA reenvia sozinha.
 */
export function uploadDraftPackage(org: string, automationId: string, file: Blob, expect: DraftExpectation, onProgress: (sent: number, total: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = (async () => {
    const csrf = await sessionCsrf(org);
    return new Promise<LifecycleVersion>((resolve, reject) => {
      xhr.open('PUT', draftPackagePath(org, automationId, expect));
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
            resolve(validated<LifecycleVersion>('putAutomationDraftPackage', body, xhr.status));
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
/**
 * Bytes do pacote de uma versão (GET .../artifact/content; exige automation.manage). A API relê e confere os bytes; aqui o
 * SHA-256 recebido é conferido de novo contra o que a página da versão mostra, antes de entregar o arquivo à pessoa. Não
 * executa nada e não altera a versão.
 */
export async function downloadVersionArtifact(org: string, versionId: string, expectedSha256: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/o/${org}/automation-versions/${versionId}/artifact/content`, {
      method: 'GET',
      headers: { Accept: 'application/zip, application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError('network', 0);
  }
  const requestId = safeRequestId(res.headers.get('X-Request-Id'));
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw apiErrorFrom(res.status, body, res.headers.get('Retry-After'), requestId);
  }
  const blob = await res.blob();
  const sha = await localSha256(blob);
  // sem como conferir (navegador sem crypto.subtle) ou conteúdo diferente do anunciado: não entrega o arquivo
  if (!sha || sha !== expectedSha256 || res.headers.get('X-Artifact-Sha256') !== expectedSha256) throw new ApiError('unexpected', res.status, undefined, requestId);
  return new Blob([blob], { type: 'application/zip' });
}

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
