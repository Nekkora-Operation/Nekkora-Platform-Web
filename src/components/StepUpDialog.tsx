import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, CodeInput, ConfirmDialog, Stack } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';

const TOTP_DIGITS = 6;

/** Desfecho de um ato sensível confirmado com step-up. */
export type StepUpOutcome = 'refused-identity' | 'refused' | 'uncertain' | 'unauthenticated';

/**
 * Classifica a falha do ATO (o step-up já foi aceito). Recusa documentada (4xx, 429, 503 de dependência fora) = nada
 * aconteceu. Sem resposta, 5xx ou resposta 2xx fora do contrato = resultado DESCONHECIDO: o ato pode ter acontecido.
 */
export function classifyActionError(e: unknown): Exclude<StepUpOutcome, 'refused-identity'> {
  if (isApiError(e, 'unauthenticated')) return 'unauthenticated';
  // gateway: 502/503/504 sem o corpo da API — o pedido pode ter sido aplicado; só a recusa documentada é "nada foi feito"
  if (e instanceof ApiError && (e.code === 'network' || e.code === 'unexpected' || e.code === 'internal_error' || e.code === 'gateway')) return 'uncertain';
  return 'refused';
}

export interface StepUpDialogProps<T> {
  open: boolean;
  title: ReactNode;
  confirmLabel: ReactNode;
  tone?: 'primary' | 'danger';
  /** Consequências do ato, mostradas antes da confirmação. */
  children?: ReactNode;
  /** Campos próprios do ato estão válidos (além do código). */
  ready?: boolean;
  /**
   * Step-up da sessão em uso (identidade ou organização). Só o 204 confirma. Ausente: o ato não exige step-up (só a
   * confirmação explícita, com as mesmas regras de recusa e incerteza).
   */
  stepUp?: (code: string) => Promise<void>;
  /** O ato. Chamado UMA vez por confirmação, só depois do step-up aceito; nunca repetido automaticamente. */
  action: () => Promise<T>;
  onDone: (result: T) => void;
  onClose: () => void;
  /** Texto da recusa do ato (o step-up foi aceito; nada foi feito). */
  refusalText: (e: unknown) => string;
  /** Texto do resultado desconhecido: o que conferir antes de decidir tentar de novo. */
  uncertainText: string;
  /** A sessão caiu: a tela leva à nova entrada. */
  onUnauthenticated: () => void;
  /** Avisado de cada desfecho sem sucesso (a tela pode, por exemplo, guardar a incerteza depois que o diálogo fechar). */
  onOutcome?: (kind: StepUpOutcome) => void;
}

/**
 * Confirmação de ato sensível com step-up IMEDIATAMENTE antes (contrato: prova de até 5 min, só TOTP). Um envio = step-up
 * e, só se ele for aceito, o ato. Recusa do step-up = nada enviado. Falha sem resposta no ato = incerteza declarada: o
 * diálogo bloqueia nova confirmação (sem reenvio silencioso) e pede conferência. O código vive só no campo e é limpo
 * ao usar e ao fechar.
 */
export function StepUpDialog<T>(props: StepUpDialogProps<T>) {
  const { open, title, confirmLabel, tone, children, ready = true, stepUp, action, onDone, onClose, refusalText, uncertainText, onUnauthenticated, onOutcome } =
    props;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: StepUpOutcome; text: string } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    if (!open) return;
    setCode('');
    setOutcome(null);
  }, [open]);
  useEffect(() => {
    // montagem dupla (StrictMode) passa pela limpeza: a remontagem precisa voltar a valer
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const needsCode = !!stepUp;
  const confirm = async () => {
    if ((needsCode && code.length !== TOTP_DIGITS) || !ready || outcome?.kind === 'uncertain') return;
    const typed = code;
    setCode(''); // código de uso único: sai da tela assim que é usado
    setOutcome(null);
    setBusy(true);
    try {
      try {
        if (stepUp) await stepUp(typed);
      } catch (e) {
        if (!alive.current) return;
        if (isApiError(e, 'unauthenticated')) return onUnauthenticated();
        onOutcome?.('refused-identity');
        setOutcome({
          kind: 'refused-identity',
          text: isApiError(e, 'rate_limited')
            ? 'Muitas tentativas em pouco tempo. Aguarde um pouco antes de tentar de novo. Nada foi feito.'
            : 'Não foi possível confirmar sua identidade com este código. Confira o código atual do aplicativo. Nada foi feito.',
        });
        return;
      }
      let result: T;
      try {
        result = await action();
      } catch (e) {
        if (!alive.current) return;
        const kind = classifyActionError(e);
        if (kind === 'unauthenticated') return onUnauthenticated();
        onOutcome?.(kind);
        setOutcome({ kind, text: kind === 'uncertain' ? uncertainText : refusalText(e) });
        return;
      }
      if (alive.current) onDone(result);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      title={title}
      confirmLabel={confirmLabel}
      tone={tone}
      busy={busy}
      confirmDisabled={!ready || (needsCode && code.length !== TOTP_DIGITS) || outcome?.kind === 'uncertain'}
      error={outcome?.text}
      onConfirm={confirm}
      onCancel={() => {
        setCode('');
        onClose();
      }}
      size="md"
    >
      <Stack gap={3}>
        {children}
        {outcome?.kind === 'uncertain' ? (
          <Alert tone="warning" live="off" title="Resultado não confirmado">
            Nada será repetido automaticamente. Feche e confira o estado atual antes de decidir.
          </Alert>
        ) : (
          needsCode && (
          <CodeInput
            label="Código do seu aplicativo autenticador"
            hint="Confirma a sua identidade imediatamente antes do ato. Códigos de recuperação não são aceitos aqui."
            length={TOTP_DIGITS}
            value={code}
            onValueChange={setCode}
            disabled={busy}
          />
          )
        )}
      </Stack>
    </ConfirmDialog>
  );
}
