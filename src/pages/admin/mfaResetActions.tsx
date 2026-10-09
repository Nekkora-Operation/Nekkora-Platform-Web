import { useEffect, useState, type ReactNode } from 'react';
import { Alert, CodeInput, ConfirmDialog, RadioGroup, Stack, Text } from 'nekkora-lib';
import { resetUserMfa } from '../../api/admin';
import { stepUp } from '../../api/auth';
import { isApiError } from '../../api/http';
import type { Member, MfaResetReason } from '../../api/v1';
import { NotApplied, rootError, sessionGuard, startWrite, type MfaEntry, type MfaTarget, type WriteEntry } from '../../admin/writeStore';
import { findMemberById } from './memberActions';
import type { FindResult, UncertainCopy } from './uncertainPanel';

const TOTP_DIGITS = 6;

/** Motivos codificados do contrato (MfaResetRequest), na ordem do enum. */
export const MFA_RESET_REASONS: { value: MfaResetReason; label: string }[] = [
  { value: 'DISPOSITIVO_PERDIDO', label: 'Dispositivo perdido' },
  { value: 'DISPOSITIVO_TROCADO', label: 'Dispositivo trocado' },
  { value: 'SUSPEITA_COMPROMETIMENTO', label: 'Suspeita de comprometimento' },
  { value: 'OUTRO', label: 'Outro motivo' },
];

export const mfaTarget = (m: Member): MfaTarget => ({
  kind: 'mfa',
  userId: m.userId,
  membershipId: m.membershipId,
  displayName: m.displayName,
  email: m.email,
});

/** MFA depois de uma redefinição CONFIRMADA (204); antes disso, vale o que a lista leu. */
export function effectiveMfaConfigured(m: Member, entry: WriteEntry | undefined): boolean {
  return entry?.phase === 'done' ? false : m.mfaConfigured;
}

/**
 * Recusa comprovada, sem detalhe que a API não deu. A confirmação de identidade recusada (403) tem mensagem NEUTRA: a
 * API não diz o motivo (código, conta sem fator, CSRF…) e a interface não o atribui ao código TOTP.
 */
export function mfaRefusalText(e: unknown, name: string): string {
  const nothing = `Nada foi alterado na conta de ${name}.`;
  const cause = rootError(e);
  if (e instanceof NotApplied) {
    if (isApiError(cause, 'rate_limited')) return `Muitas tentativas em pouco tempo. Aguarde um pouco e tente de novo. ${nothing}`;
    if (isApiError(cause, 'forbidden', 'invalid_request')) return `Não foi possível confirmar sua identidade. ${nothing}`;
    return `Não foi possível confirmar sua identidade agora. ${nothing}`;
  }
  if (isApiError(cause, 'not_found')) return 'Este membro não foi encontrado nesta organização. A lista pode estar desatualizada.';
  if (isApiError(cause, 'rate_limited')) return `Muitas tentativas em pouco tempo. Aguarde um pouco e tente de novo. ${nothing}`;
  if (isApiError(cause, 'invalid_request')) return `O pedido não foi aceito. Atualize a lista e tente de novo. ${nothing}`;
  return `A redefinição não foi permitida. Suas permissões podem ter mudado. ${nothing}`;
}

const PREVIOUS_STILL_UNCERTAIN = 'A tentativa anterior continua sem resultado confirmado.';
const UNCERTAIN_TEXT =
  'Não foi possível confirmar o resultado. A redefinição pode ter sido aplicada ou não. Confira o estado atual antes de decidir tentar de novo.';

/** Textos do aviso de incerteza para a redefinição de MFA. */
export const MFA_UNCERTAIN_COPY: UncertainCopy<MfaEntry> = {
  label: (e) => `Redefinição de MFA de ${e.target.displayName}`,
  current: (s) => (s.mfaConfigured === undefined ? 'MFA em estado desconhecido' : s.mfaConfigured ? 'MFA configurado' : 'MFA não configurado'),
  noun: 'a conta',
  absent: 'este membro não foi encontrado',
  listName: 'de membros',
  refusalText: (e) => mfaRefusalText(e, 'este membro'),
  previousStillUncertain: PREVIOUS_STILL_UNCERTAIN,
};

/** Conferência: procura o membro pelo id na lista sem filtros. O estado do MFA lido NÃO prova o resultado do pedido. */
export async function findMfa(org: string, e: MfaEntry, interrupted: () => boolean): Promise<FindResult> {
  const r = await findMemberById(org, e.target.membershipId, interrupted);
  return r.kind === 'found' ? { kind: 'found', state: { mfaConfigured: r.member.mfaConfigured } } : r;
}

/** Diálogo de redefinição (também a "nova tentativa" depois de resultado incerto). */
export interface MfaResetDialogState {
  target: MfaTarget;
  retry: boolean;
  /** número do envio feito por ESTE diálogo (null = ainda não confirmou) */
  startedId: number | null;
  /** muda a cada abertura: motivo e código recomeçam vazios */
  openId: number;
}

/**
 * Confirmação da redefinição de MFA com step-up IMEDIATAMENTE antes: um envio = step-up (TOTP) e, só se ele for
 * aceito (204), a redefinição com o motivo. Falha no step-up = nada enviado ao alvo (`NotApplied`, recusa). O código
 * vive só no campo e no envio atual: é limpo ao confirmar e ao fechar, e nunca entra no registro de escritas.
 */
export function MfaResetDialog({
  org,
  dialog,
  entry,
  onStarted,
  onClose,
  returnFocus,
  fallbackFocus,
}: {
  org: string;
  dialog: MfaResetDialogState | null;
  entry: WriteEntry | undefined;
  onStarted: (id: number) => void;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
  fallbackFocus: () => HTMLElement | null;
}) {
  const [reason, setReason] = useState<MfaResetReason | null>(null);
  const [code, setCode] = useState('');
  const openId = dialog?.openId;
  useEffect(() => {
    setReason(null);
    setCode('');
  }, [openId]);

  const mine = dialog && entry && dialog.startedId !== null && entry.id === dialog.startedId ? entry : undefined;
  const busy = mine?.phase === 'sending';
  const t = dialog?.target;
  const name = t?.displayName ?? '';

  const confirm = () => {
    if (!dialog || !reason || code.length !== TOTP_DIGITS) return;
    const { target } = dialog;
    const typed = code;
    const chosen = reason;
    setCode(''); // o código não fica na tela depois de usado (é de uso único na API)
    // a sequência pertence à sessão em que começou: se ela mudar (inclusive com uma sessão nova já válida), nenhum POST
    // seguinte sai — conferido no início, entre as etapas e depois de cada espera pelo CSRF
    const sameSession = sessionGuard();
    const send = async () => {
      sameSession();
      try {
        await stepUp(org, typed, { beforeSend: sameSession });
      } catch (e) {
        throw e instanceof NotApplied ? e : new NotApplied('step-up', e);
      }
      sameSession();
      await resetUserMfa(org, target.userId, chosen, { beforeSend: sameSession });
    };
    const id = startWrite(org, 'mfa-reset', target, send, { retry: dialog.retry });
    if (id !== null) onStarted(id);
  };

  let error: ReactNode;
  if (mine?.phase === 'refused' && !isApiError(rootError(mine.error), 'unauthenticated')) error = mfaRefusalText(mine.error, name);
  if (mine?.phase === 'uncertain')
    error = mine.refusedRetry !== undefined ? `${mfaRefusalText(mine.refusedRetry, name)} ${PREVIOUS_STILL_UNCERTAIN}` : UNCERTAIN_TEXT;

  return (
    <ConfirmDialog
      open={dialog !== null}
      title={dialog?.retry ? `Tentar de novo: redefinir o MFA de ${name}?` : `Redefinir o MFA de ${name}?`}
      confirmLabel={dialog?.retry ? 'Redefinir de novo' : 'Redefinir MFA'}
      tone="danger"
      busy={busy}
      confirmDisabled={!reason || code.length !== TOTP_DIGITS || mine?.phase === 'uncertain' || mine?.phase === 'done'}
      error={error}
      onConfirm={confirm}
      onCancel={() => {
        setCode('');
        onClose();
      }}
      returnFocus={returnFocus}
      fallbackFocus={fallbackFocus}
      size="md"
    >
      {dialog?.retry && (
        <Alert tone="warning" live="off" title="O resultado anterior não foi confirmado.">
          A tentativa anterior pode ter sido aplicada. Confirmar envia um novo pedido: se a anterior foi aplicada, a
          redefinição acontece de novo, com novo registro na auditoria, novos avisos por e-mail e novo encerramento das
          sessões que a conta tiver aberto desde então. Nada é repetido sem esta confirmação.
        </Alert>
      )}
      {t && (
        <Stack gap={3}>
          <dl className="pw-admin__grant-id">
            <div>
              <dt>Conta</dt>
              <dd>
                {t.displayName} ({t.email})
              </dd>
            </div>
          </dl>
          <Stack gap={2}>
            <Text>
              O autenticador e os códigos de recuperação desta conta deixam de valer, e as sessões abertas dela são
              encerradas agora. No próximo acesso, será preciso cadastrar o autenticador de novo.
            </Text>
            <Text variant="body-sm" color="secondary">
              A conta recebe um aviso por e-mail. Se ela administra a organização, as demais pessoas que administram a
              organização também são avisadas. O motivo escolhido fica registrado.
            </Text>
          </Stack>
          <RadioGroup
            legend="Motivo da redefinição"
            options={MFA_RESET_REASONS}
            value={reason}
            onChange={(v) => setReason(v as MfaResetReason)}
            required
            disabled={busy}
          />
          <CodeInput
            label="Código do seu aplicativo autenticador"
            hint="Confirma a sua identidade imediatamente antes da redefinição. Códigos de recuperação não são aceitos aqui."
            length={TOTP_DIGITS}
            value={code}
            onValueChange={setCode}
            disabled={busy}
          />
        </Stack>
      )}
    </ConfirmDialog>
  );
}
