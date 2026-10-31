import { type ReactNode } from 'react';
import { Alert, ConfirmDialog, Stack, Text } from 'nekkora-lib';
import { listClientGrants, revokeClientGrant } from '../../api/admin';
import { isApiError } from '../../api/http';
import type { ClientGrant, GrantStatus } from '../../api/v1';
import { registryRefusalText, startWrite, type GrantEntry, type GrantTarget, type WriteEntry } from '../../admin/writeStore';
import { GRANT_STATUS_LABEL } from './shared';
import type { FindResult, UncertainCopy } from './uncertainPanel';

/** Páginas lidas, no máximo, ao procurar uma concessão pelo id (100 por página). */
const CHECK_PAGE_LIMIT = 100;
const CHECK_MAX_PAGES = 50;

/** Estados em que a revogação é oferecida (o AdminService aceita qualquer estado diferente de revogada). */
export const REVOCABLE: readonly GrantStatus[] = ['pending', 'active', 'suspended'];

export const grantTarget = (g: ClientGrant): GrantTarget => ({
  kind: 'grant',
  grantId: g.grantId,
  displayName: g.externalAccount.displayName,
  email: g.externalAccount.email,
  clientName: g.client.name,
  workspaceName: g.workspace.name,
});

/** "Ana (cliente Acme, workspace Logística)": identifica a concessão, não só a conta. */
export const grantLabel = (t: GrantTarget) => `${t.displayName} (cliente ${t.clientName}, workspace ${t.workspaceName})`;

/** Estado depois de uma revogação CONFIRMADA (204); antes disso, vale o que a lista leu. */
export function effectiveGrantStatus(g: ClientGrant, entry: WriteEntry | undefined): GrantStatus {
  return entry?.phase === 'done' ? 'revoked' : g.status;
}

/** Mensagem de recusa comprovada (status documentado). Sem detalhe que a API não deu. */
export function grantRefusalText(e: unknown): string {
  const registry = registryRefusalText(e);
  if (registry) return registry;
  if (isApiError(e, 'not_found')) return 'Esta concessão não foi encontrada nesta organização. A lista pode estar desatualizada.';
  if (isApiError(e, 'rate_limited')) return 'Muitas tentativas em pouco tempo. Aguarde um pouco e tente de novo.';
  if (isApiError(e, 'invalid_request')) return 'O pedido não foi aceito. Atualize a lista e tente de novo.';
  return 'A ação não foi permitida. Suas permissões podem ter mudado.';
}

const PREVIOUS_STILL_UNCERTAIN = 'A tentativa anterior continua sem resultado confirmado.';
const UNCERTAIN_TEXT =
  'Não foi possível confirmar o resultado. O pedido pode ter sido aplicado ou não. Confira o estado atual antes de decidir tentar de novo.';

/** Textos do aviso de incerteza para concessões. */
export const GRANT_UNCERTAIN_COPY: UncertainCopy<GrantEntry> = {
  label: (e) => `Revogação da concessão de ${grantLabel(e.target)}`,
  current: (s) => `concessão ${s.grantStatus ? GRANT_STATUS_LABEL[s.grantStatus].toLowerCase() : 'em estado desconhecido'}`,
  noun: 'a concessão',
  absent: 'esta concessão não foi encontrada',
  listName: 'de concessões',
  refusalText: grantRefusalText,
  previousStillUncertain: PREVIOUS_STILL_UNCERTAIN,
};

/**
 * Procura a concessão pelo id na lista SEM filtros, página por página. Informa o estado atual; NÃO prova o resultado
 * da revogação. Para ao achar, ao fim da lista, ao limite de páginas ou se interrompida.
 */
export async function findGrant(org: string, e: GrantEntry, interrupted: () => boolean): Promise<FindResult> {
  let cursor: string | undefined;
  for (let i = 0; i < CHECK_MAX_PAGES; i++) {
    if (interrupted()) return { kind: 'interrupted' };
    const page = await listClientGrants(org, { limit: CHECK_PAGE_LIMIT, cursor });
    if (interrupted()) return { kind: 'interrupted' };
    const grant = page.items.find((g) => g.grantId === e.target.grantId);
    if (grant) return { kind: 'found', state: { grantStatus: grant.status } };
    if (!page.nextCursor) return { kind: 'absent' };
    cursor = page.nextCursor;
  }
  return { kind: 'incomplete' };
}

/** Diálogo de revogação (também a "nova tentativa" depois de resultado incerto). */
export interface RevokeDialogState {
  target: GrantTarget;
  retry: boolean;
  /** número do envio feito por ESTE diálogo (null = ainda não confirmou) */
  startedId: number | null;
}

export function RevokeGrantDialog({
  org,
  dialog,
  entry,
  onStarted,
  onClose,
  returnFocus,
  fallbackFocus,
}: {
  org: string;
  dialog: RevokeDialogState | null;
  entry: WriteEntry | undefined;
  onStarted: (id: number) => void;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
  fallbackFocus: () => HTMLElement | null;
}) {
  const mine = dialog && entry && dialog.startedId !== null && entry.id === dialog.startedId ? entry : undefined;
  const busy = mine?.phase === 'sending';
  const t = dialog?.target;

  const confirm = () => {
    if (!dialog) return;
    const { target } = dialog;
    const id = startWrite(org, 'revoke', target, () => revokeClientGrant(org, target.grantId), { retry: dialog.retry });
    if (id !== null) onStarted(id);
  };

  let error: ReactNode;
  if (mine?.phase === 'refused' && !isApiError(mine.error, 'unauthenticated')) error = grantRefusalText(mine.error);
  if (mine?.phase === 'uncertain') error = mine.refusedRetry !== undefined ? `${grantRefusalText(mine.refusedRetry)} ${PREVIOUS_STILL_UNCERTAIN}` : UNCERTAIN_TEXT;

  return (
    <ConfirmDialog
      open={dialog !== null}
      title={dialog?.retry ? `Tentar de novo: revogar a concessão de ${t?.displayName}?` : `Revogar a concessão de ${t?.displayName}?`}
      confirmLabel={dialog?.retry ? 'Revogar de novo' : 'Revogar'}
      tone="danger"
      busy={busy}
      confirmDisabled={mine?.phase === 'uncertain' || mine?.phase === 'done'}
      error={error}
      onConfirm={confirm}
      onCancel={onClose}
      returnFocus={returnFocus}
      fallbackFocus={fallbackFocus}
      size="md"
    >
      {dialog?.retry && (
        <Alert tone="warning" live="off" title="O resultado anterior não foi confirmado.">
          A tentativa anterior pode ter sido aplicada. Confirmar envia um novo pedido; nada é repetido sem esta confirmação.
        </Alert>
      )}
      {t && (
        <Stack gap={2}>
          <dl className="pw-admin__grant-id">
            <div>
              <dt>Conta externa</dt>
              <dd>
                {t.displayName} ({t.email})
              </dd>
            </div>
            <div>
              <dt>Cliente</dt>
              <dd>{t.clientName}</dd>
            </div>
            <div>
              <dt>Workspace</dt>
              <dd>{t.workspaceName}</dd>
            </div>
          </dl>
          <Text>
            Esta concessão deixa de dar à conta {t.displayName} acesso ao workspace {t.workspaceName} do cliente {t.clientName}.
          </Text>
          <Text variant="body-sm" color="secondary">
            Só esta concessão muda: outras concessões da mesma conta e a própria conta continuam como estão. Não há como
            desfazer a revogação nesta área.
          </Text>
        </Stack>
      )}
    </ConfirmDialog>
  );
}
