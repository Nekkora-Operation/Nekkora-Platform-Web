import { type ReactNode } from 'react';
import { Alert, ConfirmDialog, Stack, Text } from 'nekkora-lib';
import { listMembers, reactivateUser, suspendUser } from '../../api/admin';
import { isApiError } from '../../api/http';
import type { Member } from '../../api/v1';
import { startWrite, type MemberEntry, type WriteAction, type WriteEntry } from '../../admin/writeStore';
import type { FindResult, UncertainCopy } from './uncertainPanel';
import { ACCOUNT_STATUS_LABEL } from './shared';

/** Páginas lidas, no máximo, ao procurar um membro pelo id (100 por página). */
const CHECK_PAGE_LIMIT = 100;
const CHECK_MAX_PAGES = 50;

export const ACTION_LABEL: Record<WriteAction, { verb: string; noun: string; done: (name: string) => string }> = {
  suspend: { verb: 'Suspender', noun: 'Suspensão', done: (n) => `Conta de ${n} suspensa.` },
  reactivate: { verb: 'Reativar', noun: 'Reativação', done: (n) => `Conta de ${n} reativada.` },
  revoke: { verb: 'Revogar', noun: 'Revogação', done: (n) => `Concessão de ${n} revogada.` },
  'mfa-reset': { verb: 'Redefinir MFA', noun: 'Redefinição de MFA', done: (n) => `MFA de ${n} redefinido.` },
};

/** Estado da conta depois de uma escrita CONFIRMADA (204); antes disso, vale o que a lista leu. */
export function effectiveStatus(m: Member, entry: WriteEntry | undefined): Member['accountStatus'] {
  if (entry?.phase === 'done') return entry.action === 'suspend' ? 'suspended' : 'active';
  return m.accountStatus;
}

/** Mensagem de recusa comprovada (status documentado). Sem detalhe que a API não deu. */
export function refusalText(e: unknown): string {
  if (isApiError(e, 'not_found')) return 'Este membro não foi encontrado nesta organização. A lista pode estar desatualizada.';
  if (isApiError(e, 'rate_limited')) return 'Muitas tentativas em pouco tempo. Aguarde um pouco e tente de novo.';
  if (isApiError(e, 'invalid_request')) return 'O pedido não foi aceito. Atualize a lista e tente de novo.';
  return 'A ação não foi permitida. Suas permissões podem ter mudado, ou esta conta não pode ser alterada por você.';
}

export const PREVIOUS_STILL_UNCERTAIN = 'A tentativa anterior continua sem resultado confirmado.';

export const UNCERTAIN_TEXT =
  'Não foi possível confirmar o resultado. O pedido pode ter sido aplicado ou não. Confira o estado atual antes de decidir tentar de novo.';

/**
 * Procura o membro pelo id na lista SEM filtros, página por página. Informa o estado atual; NÃO prova o resultado da
 * escrita. Para ao achar, ao fim da lista, ao limite de páginas ou se interrompida.
 */
export async function findMemberById(
  org: string,
  membershipId: string,
  interrupted: () => boolean,
): Promise<{ kind: 'found'; member: Member } | { kind: 'absent' } | { kind: 'incomplete' } | { kind: 'interrupted' }> {
  let cursor: string | undefined;
  for (let i = 0; i < CHECK_MAX_PAGES; i++) {
    if (interrupted()) return { kind: 'interrupted' };
    const page = await listMembers(org, { limit: CHECK_PAGE_LIMIT, cursor });
    if (interrupted()) return { kind: 'interrupted' };
    const member = page.items.find((m) => m.membershipId === membershipId);
    if (member) return { kind: 'found', member };
    if (!page.nextCursor) return { kind: 'absent' };
    cursor = page.nextCursor;
  }
  return { kind: 'incomplete' };
}

/** Diálogo de confirmação de suspender/reativar (também a "nova tentativa" depois de resultado incerto). */
export interface ActionDialogState {
  action: WriteAction;
  member: Member;
  retry: boolean;
  /** número do envio feito por ESTE diálogo (null = ainda não confirmou) */
  startedId: number | null;
}

export function MemberActionDialog({
  org,
  dialog,
  entry,
  onStarted,
  onClose,
  returnFocus,
  fallbackFocus,
}: {
  org: string;
  dialog: ActionDialogState | null;
  entry: WriteEntry | undefined;
  onStarted: (id: number) => void;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
  fallbackFocus: () => HTMLElement | null;
}) {
  const mine = dialog && entry && dialog.startedId !== null && entry.id === dialog.startedId ? entry : undefined;
  const busy = mine?.phase === 'sending';
  const name = dialog?.member.displayName ?? '';
  const action = dialog?.action ?? 'suspend';

  const confirm = () => {
    if (!dialog) return;
    const { member } = dialog;
    const target = { userId: member.userId, membershipId: member.membershipId, displayName: member.displayName };
    const send = () => (dialog.action === 'suspend' ? suspendUser(org, member.userId) : reactivateUser(org, member.userId));
    const id = startWrite(org, dialog.action, target, send, { retry: dialog.retry });
    if (id !== null) onStarted(id);
  };

  let error: ReactNode;
  if (mine?.phase === 'refused' && !isApiError(mine.error, 'unauthenticated')) error = refusalText(mine.error);
  if (mine?.phase === 'uncertain') error = mine.refusedRetry !== undefined ? `${refusalText(mine.refusedRetry)} ${PREVIOUS_STILL_UNCERTAIN}` : UNCERTAIN_TEXT;

  const consequences =
    action === 'suspend' ? (
      <Stack gap={2}>
        <Text>A conta de {name} deixa de entrar na organização, e as sessões abertas dela são encerradas agora.</Text>
        <Text variant="body-sm" color="secondary">
          Reativar depois devolve o acesso à conta, mas não restaura as sessões encerradas.
        </Text>
      </Stack>
    ) : (
      <Stack gap={2}>
        <Text>A conta de {name} volta a poder entrar na organização.</Text>
        <Text variant="body-sm" color="secondary">
          A reativação não restaura sessões encerradas nem concessões revogadas: a pessoa entra de novo e as concessões
          precisam ser feitas outra vez, se for o caso.
        </Text>
      </Stack>
    );

  return (
    <ConfirmDialog
      open={dialog !== null}
      title={dialog?.retry ? `Tentar de novo: ${ACTION_LABEL[action].verb.toLowerCase()} ${name}?` : `${ACTION_LABEL[action].verb} ${name}?`}
      confirmLabel={dialog?.retry ? `${ACTION_LABEL[action].verb} de novo` : ACTION_LABEL[action].verb}
      tone={action === 'suspend' ? 'danger' : 'primary'}
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
      {consequences}
    </ConfirmDialog>
  );
}

/** Textos do aviso de incerteza para membros (os mesmos da F6a-2). */
export const MEMBER_UNCERTAIN_COPY: UncertainCopy<MemberEntry> = {
  label: (e) => `${ACTION_LABEL[e.action].noun} de ${e.target.displayName}`,
  current: (s) => `conta ${s.accountStatus ? ACCOUNT_STATUS_LABEL[s.accountStatus].toLowerCase() : 'em estado desconhecido'}`,
  noun: 'a conta',
  absent: 'este membro não foi encontrado',
  listName: 'de membros',
  refusalText,
  previousStillUncertain: PREVIOUS_STILL_UNCERTAIN,
};

/** Conferência de membro: procura pelo id na lista sem filtros. */
export async function findMember(org: string, e: MemberEntry, interrupted: () => boolean): Promise<FindResult> {
  const r = await findMemberById(org, e.target.membershipId, interrupted);
  return r.kind === 'found' ? { kind: 'found', state: { accountStatus: r.member.accountStatus } } : r;
}
