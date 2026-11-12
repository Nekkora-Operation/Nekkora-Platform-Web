import { Alert, Button } from 'nekkora-lib';

/**
 * R1 — as permissões do workspace não puderam ser conferidas (429 do limitador, rede, falha das permissões da
 * organização). Não é "sem permissão": as ações que dependem delas ficam fora até a conferência, e a pessoa pode tentar
 * de novo. Nada é enviado por esta tela.
 */
export function PermissionsUnverified({ actions, onRetry }: { actions: string; onRetry: () => void }) {
  return (
    <Alert
      tone="warning"
      title="Não foi possível verificar suas permissões neste workspace agora."
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Tentar novamente
        </Button>
      }
    >
      {actions} só aparecem depois dessa verificação. Isso não quer dizer que você não tem permissão. Nada foi feito.
    </Alert>
  );
}
