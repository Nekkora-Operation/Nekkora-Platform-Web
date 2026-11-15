import { useState } from 'react';
import { Alert, Button, Stack, Text } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { downloadVersionArtifact } from '../../api/lifecycle';

/**
 * "Baixar pacote" de uma versão PUBLICADA (AGENT-CLIENT-PACOTES-001, T03). Só aparece para quem pode baixar pela Web
 * (automation.manage, conferido de novo pela API a cada pedido). Os bytes são os guardados pela Platform, conferidos pelo
 * SHA-256 mostrado na página antes de o arquivo ser entregue. Baixar não executa, não publica e não altera a versão.
 */
export function DownloadPackage({ org, versionId, sha256, fileName }: { org: string; versionId: string; sha256: string; fileName: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setProblem(null);
    try {
      const blob = await downloadVersionArtifact(org, versionId, sha256);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap={2}>
      <div>
        <Button variant="secondary" loading={busy} onClick={() => void download()}>
          Baixar pacote
        </Button>
      </div>
      <Text variant="body-sm" color="secondary">
        Baixa o arquivo .zip desta versão publicada, como a Platform o guardou. Baixar não executa nada.
      </Text>
      {problem && <Alert tone="danger" title={problem} />}
    </Stack>
  );
}

function message(e: unknown): string {
  if (isApiError(e, 'forbidden')) return 'Você não tem permissão para baixar o pacote desta versão.';
  if (isApiError(e, 'not_found')) return 'Esta versão não está mais disponível para você.';
  if (isApiError(e, 'conflict')) return 'O arquivo deste pacote não está disponível na Platform no momento. Nada foi baixado.';
  if (isApiError(e, 'unauthenticated')) return 'Sua sessão terminou. Entre novamente para baixar.';
  if (isApiError(e, 'rate_limited')) return 'Muitos pedidos seguidos. Aguarde um pouco e tente de novo.';
  if (isApiError(e, 'network')) return 'Não foi possível conectar à Platform. Nada foi baixado.';
  if (isApiError(e, 'unexpected')) return 'O arquivo recebido não confere com o SHA-256 desta versão. Nada foi salvo.';
  return 'Não foi possível baixar o pacote agora. Tente de novo em instantes.';
}
