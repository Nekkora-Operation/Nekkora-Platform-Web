import { useId } from 'react';
import { Alert, Button, DescriptionList, Input, Stack, Text } from 'nekkora-lib';
import { DateTimeText } from './shared';

/**
 * PLATFORM-V2-001, T05 — confirmação da publicação compreensível. Por padrão: automação, versão, arquivo validado e a
 * consequência (a versão publicada não muda; publicar não executa). A identificação técnica (SHA-256 e impressão) fica num
 * detalhe opcional, para quem precisa comparar o arquivo; a comparação é opcional e, divergente, impede prosseguir. A
 * integridade é conferida SEMPRE no servidor: a publicação leva o par conferido e a API recusa se o pacote mudar.
 */
export interface Reviewed {
  sha256: string;
  fingerprint: string;
  fingerprintRule: string | null;
  kind: 'STUDIO' | 'EXTERNAL_PYTHON';
  sizeBytes: number | null;
  filesCount: number | null;
  /** Python externo: nome e versão DECLARADOS pelo projeto (não são a versão da Platform). */
  packageName: string | null;
  packageVersion: string | null;
  receivedAt: string | null;
  /** Nome do arquivo escolhido neste navegador, só quando o SHA-256 local é o do pacote recebido. */
  fileName: string | null;
}

export type Comparison = { status: 'empty' } | { status: 'sha256' } | { status: 'fingerprint' } | { status: 'mismatch' } | { status: 'malformed' };

const HEX64 = /^[0-9a-f]{64}$/;

/** Compara o valor colado (sem espaços, sem distinção de caixa) com o SHA-256 do ZIP e com a impressão do conteúdo. */
export function compareTechnical(raw: string, reviewed: Pick<Reviewed, 'sha256' | 'fingerprint'> | null): Comparison {
  const v = raw.replace(/\s+/g, '').toLowerCase();
  if (!v || !reviewed) return { status: 'empty' };
  if (v === reviewed.sha256) return { status: 'sha256' };
  if (v === reviewed.fingerprint) return { status: 'fingerprint' };
  return HEX64.test(v) ? { status: 'mismatch' } : { status: 'malformed' };
}

/** Tamanho legível: KiB abaixo de 1 MiB (um pacote pequeno não aparece como "0.00 MiB"). */
const size = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);

function Hash({ value }: { value: string }) {
  return <code className="pw-break pw-hash">{value}</code>;
}

export function PublishSummary(props: {
  automation: string;
  versionNumber: number | undefined;
  reviewed: Reviewed;
  technical: boolean;
  onToggleTechnical: () => void;
  compare: string;
  onCompare: (v: string) => void;
  comparison: Comparison;
}) {
  const { automation, versionNumber, reviewed: r, technical, onToggleTechnical, compare, onCompare, comparison } = props;
  const panel = useId();
  const kind = r.kind === 'EXTERNAL_PYTHON' ? 'Python externo (sem framework Nekkora)' : 'Formato Studio';
  const fileFacts = [kind, r.sizeBytes !== null ? size(r.sizeBytes) : null, r.filesCount !== null ? `${r.filesCount} ${r.filesCount === 1 ? 'arquivo' : 'arquivos'}` : null]
    .filter(Boolean)
    .join(' · ');
  const compareError =
    comparison.status === 'mismatch'
      ? 'Não confere com o SHA-256 nem com a impressão do pacote recebido. Não publique: confira o arquivo.'
      : comparison.status === 'malformed'
        ? 'Cole um valor de 64 caracteres hexadecimais (SHA-256 ou impressão).'
        : undefined;
  const compareOk =
    comparison.status === 'sha256'
      ? 'Confere com o SHA-256 do arquivo ZIP.'
      : comparison.status === 'fingerprint'
        ? 'Confere com a impressão do conteúdo.'
        : undefined;

  return (
    <Stack gap={3}>
      <DescriptionList
        items={[
          { key: 'automacao', term: 'Automação', description: automation },
          { key: 'versao', term: 'Versão na Platform', description: versionNumber !== undefined ? `Versão ${versionNumber}` : '—' },
          ...(r.kind === 'EXTERNAL_PYTHON' && (r.packageName || r.packageVersion)
            ? [{ key: 'projeto', term: 'Declarado pelo projeto', description: `${r.packageName ?? '—'} ${r.packageVersion ?? ''}`.trim() }]
            : []),
          {
            key: 'arquivo',
            term: 'Arquivo validado',
            description: (
              <>
                {r.fileName ? `${r.fileName} · ` : ''}
                {fileFacts}
                {r.receivedAt && (
                  <>
                    {' · recebido em '}
                    <DateTimeText iso={r.receivedAt} />
                  </>
                )}
              </>
            ),
            wide: true,
          },
        ]}
      />
      <Alert tone="info" title="Depois de publicada, esta versão não poderá ser alterada.">
        Mudanças de pacote ou de comando exigirão uma nova versão. Publicar não executa a automação nem autoriza a execução.
      </Alert>
      <div>
        <Button size="sm" variant="ghost" aria-expanded={technical} aria-controls={panel} onClick={onToggleTechnical}>
          {technical ? 'Ocultar identificação técnica' : 'Conferir identificação técnica'}
        </Button>
      </div>
      <div id={panel} hidden={!technical}>
        {technical && (
          <Stack gap={3}>
            <Text variant="body-sm" color="secondary">
              Opcional, para comparar com o arquivo que você tem. O SHA-256 identifica o arquivo ZIP (os bytes). A impressão
              identifica o conteúdo reconhecido pelo Agent: um ZIP refeito com o mesmo conteúdo pode ter outro SHA-256 e a
              mesma impressão. A Platform confere a integridade de qualquer forma antes de publicar.
            </Text>
            <DescriptionList
              items={[
                { key: 'sha', term: 'SHA-256 do arquivo ZIP', description: <Hash value={r.sha256} />, wide: true },
                { key: 'fp', term: `Impressão do conteúdo (${r.fingerprintRule ?? 'regra não informada'})`, description: <Hash value={r.fingerprint} />, wide: true },
              ]}
            />
            <Input
              label="Comparar com um valor (opcional)"
              hint="Cole o SHA-256 ou a impressão informada pelo Studio, pelo Agent ou por quem enviou o arquivo."
              value={compare}
              onChange={(e) => onCompare(e.target.value)}
              error={compareError}
              success={compareOk}
              spellCheck={false}
              autoComplete="off"
            />
          </Stack>
        )}
      </div>
    </Stack>
  );
}
