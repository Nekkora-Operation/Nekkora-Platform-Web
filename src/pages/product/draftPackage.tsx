import { ApiError, isApiError } from '../../api/http';
import { PACKAGE_REASON, type LifecycleArtifact, type PackageRejectedReason } from '../../api/lifecycle';
import { DateTimeText } from './shared';

/**
 * PLATFORM-AGENT-V2-002, T09 — peças comuns do envio do pacote do rascunho (página "Nova versão", página da versão e
 * criação da automação): validação do comando, texto das recusas e a descrição curta do pacote que ficou na Platform.
 */

export const mib = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MiB`;

/** Mesmas regras do "Comando do rascunho": python3.N; até 20 argumentos de até 200 caracteres. */
export function checkCommand(runtime: string, args: string): { ok: true; runtime?: string; arguments: string[] } | { ok: false; text: string } {
  const list = args
    .split('\n')
    .map((a) => a.trim())
    .filter(Boolean);
  const rt = runtime.trim();
  if (rt && !/^python3\.[0-9]{1,2}$/.test(rt)) return { ok: false, text: 'Use o formato python3.N (por exemplo, python3.12).' };
  if (list.length > 20 || list.some((a) => a.length > 200)) return { ok: false, text: 'Até 20 argumentos, cada um com até 200 caracteres.' };
  return { ok: true, ...(rt ? { runtime: rt } : {}), arguments: list };
}

/** Motivo da recusa do pacote (422), em português simples. */
export function packageReason(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.code !== 'package_rejected') return null;
  return (e.reason ? PACKAGE_REASON[e.reason as PackageRejectedReason] : undefined) ?? 'motivo não informado';
}

/**
 * Recusa do envio. `kept`: o que continua valendo na Platform — `previous` (o rascunho já tinha um pacote, preservado),
 * `empty` (o rascunho continua sem pacote) ou `nothing` (não havia rascunho: nenhuma versão foi criada).
 */
export function draftRefusal(e: unknown, kept: 'previous' | 'empty' | 'nothing'): string {
  const stays =
    kept === 'previous'
      ? 'O pacote anterior continua valendo no rascunho, sem mudança.'
      : kept === 'empty'
        ? 'O rascunho continua sem pacote.'
        : 'Nenhuma versão foi criada: o rascunho só passa a existir quando a Platform aceita o pacote.';
  const reason = packageReason(e);
  if (reason) return `O pacote foi recusado pela conferência da Platform: ${reason}. ${stays} Corrija o arquivo e envie de novo.`;
  if (e instanceof ApiError && e.status === 413) return `O arquivo passa do limite aceito (50 MiB). Nada foi gravado. ${stays}`;
  if (isApiError(e, 'service_unavailable'))
    return `O armazenamento de pacotes não está disponível neste ambiente (ou está temporariamente fora). Nada foi gravado. ${stays} Tente mais tarde ou procure a operação.`;
  if (isApiError(e, 'conflict')) return `A automação ou o workspace não está ativo, ou o rascunho já foi publicado. Nada foi gravado. ${stays}`;
  if (isApiError(e, 'forbidden', 'not_found')) return 'Você não tem permissão para enviar pacotes nesta automação. Nada foi gravado.';
  if (isApiError(e, 'rate_limited')) return 'Muitas tentativas em pouco tempo. Aguarde antes de enviar de novo.';
  return `O envio não foi aceito. ${stays}`;
}

/** "SHA-256 1a2b3c4d…, 10 arquivos, recebido em …": o bastante para reconhecer qual pacote ficou. */
export function PackageBrief({ artifact }: { artifact: LifecycleArtifact | null | undefined }) {
  if (!artifact?.sha256) return <>nenhum pacote</>;
  const files = artifact.filesCount;
  return (
    <>
      o pacote com SHA-256 <code className="pw-hash">{artifact.sha256.slice(0, 12)}…</code>
      {files !== undefined && files !== null && `, ${files} ${files === 1 ? 'arquivo' : 'arquivos'}`}
      {artifact.receivedAt && (
        <>
          , recebido em <DateTimeText iso={artifact.receivedAt} />
        </>
      )}
    </>
  );
}
