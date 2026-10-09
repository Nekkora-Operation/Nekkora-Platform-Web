import { forwardRef, useRef, type ReactNode } from 'react';
import { Alert, Button, ConfirmDialog, Stack, Text } from 'nekkora-lib';
import { listMembers, reactivateUser, suspendUser } from '../../api/admin';
import { isApiError } from '../../api/http';
import type { Member } from '../../api/v1';
import {
  beginCheck,
  finishCheck,
  sessionEpoch,
  startWrite,
  type CheckState,
  type WriteAction,
  type WriteEntry,
} from '../../admin/writeStore';
import { ACCOUNT_STATUS_LABEL } from './shared';

/** Páginas lidas, no máximo, ao procurar um membro pelo id (100 por página). */
const CHECK_PAGE_LIMIT = 100;
const CHECK_MAX_PAGES = 50;

export const ACTION_LABEL: Record<WriteAction, { verb: string; noun: string; done: (name: string) => string }> = {
  suspend: { verb: 'Suspender', noun: 'Suspensão', done: (n) => `Conta de ${n} suspensa.` },
  reactivate: { verb: 'Reativar', noun: 'Reativação', done: (n) => `Conta de ${n} reativada.` },
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

function checkText(check: CheckState | undefined): string | null {
  if (!check) return null;
  const at = 'at' in check ? new Date(check.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  switch (check.status) {
    case 'checking':
      return 'Conferindo o estado atual…';
    case 'found':
      return `Estado atual lido às ${at}: conta ${ACCOUNT_STATUS_LABEL[check.accountStatus].toLowerCase()}. Isto informa como a conta está agora; não confirma o resultado do pedido.`;
    case 'absent':
      return `Leitura às ${at}: este membro não foi encontrado na lista atual. Isso não indica sucesso nem falha do pedido.`;
    case 'failed':
      return check.reason === 'interrupted'
        ? 'Conferência interrompida. Nada foi alterado.'
        : check.reason === 'forbidden'
          ? 'Não foi possível conferir agora: a leitura de membros foi recusada.'
          : check.reason === 'incomplete'
            ? 'Não foi possível conferir agora: a lista não pôde ser percorrida até o fim.'
            : 'Não foi possível conferir agora.';
  }
}

/**
 * Registros de resultado NÃO confirmado (e as novas tentativas em curso) da organização. Ficam visíveis até uma decisão
 * explícita: conferir, tentar de novo (com confirmação) ou dispensar o aviso. Sobrevivem à navegação entre telas.
 */
export const UncertainPanel = forwardRef<
  HTMLDivElement,
  {
    org: string;
    entries: WriteEntry[];
    onRetry: (e: WriteEntry) => void;
    onDismiss: (e: WriteEntry) => void;
    onUnauthenticated: () => void;
    /** A leitura de membros da conferência foi recusada (403): a tela passa a acesso negado até nova leitura autorizada. */
    onForbidden: () => void;
  }
>(function UncertainPanel({ org, entries, onRetry, onDismiss, onUnauthenticated, onForbidden }, ref) {
  const interrupts = useRef(new Map<number, boolean>());
  if (!entries.length) return null;

  const check = async (e: WriteEntry) => {
    const token = beginCheck(org, e.target.userId, e.id);
    if (token === null) return;
    interrupts.current.set(token, false);
    // a conferência é da sessão em que começou: numa troca de sessão ela para de ler e o resultado é descartado
    const started = sessionEpoch();
    const sameSession = () => sessionEpoch() === started;
    const at = () => Date.now();
    try {
      const r = await findMemberById(org, e.target.membershipId, () => interrupts.current.get(token) === true || !sameSession());
      if (!sameSession()) return;
      if (r.kind === 'found') finishCheck(org, e.target.userId, { status: 'found', token, accountStatus: r.member.accountStatus, at: at() });
      else if (r.kind === 'absent') finishCheck(org, e.target.userId, { status: 'absent', token, at: at() });
      else finishCheck(org, e.target.userId, { status: 'failed', token, reason: r.kind === 'interrupted' ? 'interrupted' : 'incomplete', at: at() });
    } catch (err) {
      if (!sameSession()) return;
      if (isApiError(err, 'unauthenticated')) {
        finishCheck(org, e.target.userId, { status: 'failed', token, reason: 'error', at: at() });
        onUnauthenticated();
        return;
      }
      const reason = isApiError(err, 'forbidden') ? 'forbidden' : isApiError(err, 'invalid_request') ? 'incomplete' : 'error';
      finishCheck(org, e.target.userId, { status: 'failed', token, reason, at: at() });
      if (reason === 'forbidden') onForbidden();
    } finally {
      interrupts.current.delete(token);
    }
  };

  return (
    <div ref={ref} tabIndex={-1} className="pw-admin__uncertain" role="region" aria-label="Ações sem resultado confirmado">
      <Alert tone="warning" live="polite" title="Ações sem resultado confirmado">
        <ul className="pw-admin__uncertain-list">
          {entries.map((e) => {
            const sending = e.phase === 'sending';
            const checking = e.check?.status === 'checking';
            const label = `${ACTION_LABEL[e.action].noun} de ${e.target.displayName}`;
            return (
              <li key={e.id} className="pw-admin__uncertain-item">
                <Text>
                  {label}: {sending ? 'nova tentativa em envio…' : 'resultado não confirmado.'}
                </Text>
                {!sending && e.refusedRetry !== undefined && (
                  <Text variant="body-sm" color="secondary">
                    Nova tentativa recusada: {refusalText(e.refusedRetry)} {PREVIOUS_STILL_UNCERTAIN}
                  </Text>
                )}
                {!sending && checkText(e.check) && (
                  <Text variant="body-sm" color="secondary">
                    {checkText(e.check)}
                  </Text>
                )}
                {!sending && (
                  <div className="pw-admin__uncertain-actions">
                    {checking ? (
                      <Button size="sm" variant="ghost" onClick={() => e.check && interrupts.current.set(e.check.token, true)} aria-label={`Interromper a conferência: ${label}`}>
                        Interromper conferência
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => void check(e)} aria-label={`Conferir estado atual: ${label}`}>
                        Conferir estado atual
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" disabled={checking} onClick={() => onRetry(e)} aria-label={`Tentar de novo: ${label}`}>
                      Tentar de novo…
                    </Button>
                    <Button size="sm" variant="ghost" disabled={checking} onClick={() => onDismiss(e)} aria-label={`Dispensar aviso: ${label}`}>
                      Dispensar aviso
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Alert>
    </div>
  );
});
