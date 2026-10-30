import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, CodeInput, ConfirmDialog, Stack } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';
import { operations, opKey, type OpView } from '../api/pendingOps';
import { useOperationScope } from './operationScope';

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
  /**
   * Registro persistente da operação (FRONT-V1-002): gravado ANTES do envio, por pessoa, organização, operação e alvo.
   * Resultado desconhecido continua bloqueando a confirmação depois de navegar, recarregar ou em outra aba, até a pessoa
   * conferir e liberar de forma explícita.
   */
  guard?: { operation: string; target?: string };
}

/** Registro da operação, como o diálogo o vê. */
type OpRecord = { status: 'idle' } | { status: 'ready'; key: string; view: OpView | null } | { status: 'unavailable' };

const timeOf = (at: number) => new Date(at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Confirmação de ato sensível com step-up IMEDIATAMENTE antes (contrato: prova de até 5 min, só TOTP). Um envio = step-up
 * e, só se ele for aceito, o ato. Recusa do step-up = nada enviado. Falha sem resposta no ato = incerteza declarada: o
 * diálogo bloqueia nova confirmação (sem reenvio silencioso) e pede conferência. O código vive só no campo e é limpo
 * ao usar e ao fechar.
 */
export function StepUpDialog<T>(props: StepUpDialogProps<T>) {
  const { open, title, confirmLabel, tone, children, ready = true, stepUp, action, onDone, onClose, refusalText, uncertainText, onUnauthenticated, onOutcome, guard } =
    props;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: StepUpOutcome; text: string } | null>(null);
  const [record, setRecord] = useState<OpRecord>({ status: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const scope = useOperationScope();
  const operation = guard?.operation;
  const target = guard?.target;

  useEffect(() => {
    if (!open) return;
    setCode('');
    setOutcome(null);
    setNotice(null);
  }, [open]);

  // registro da operação: lido ao abrir e acompanhado (outra aba, conclusão de um envio que continuou fora da tela)
  useEffect(() => {
    if (!open || !operation) {
      setRecord({ status: 'idle' });
      return;
    }
    let current = true;
    let key: string | null = null;
    const refresh = async () => {
      if (!key) {
        const subject = await scope.subject();
        if (!current) return;
        if (!subject) return setRecord({ status: 'unavailable' });
        key = await opKey({ subject, org: scope.org, operation, target });
      }
      const view = await operations().inspect(key);
      if (current) setRecord({ status: 'ready', key, view });
    };
    void refresh();
    const stop = operations().subscribe(() => void refresh());
    return () => {
      current = false;
      stop();
    };
  }, [open, operation, target, scope]);
  useEffect(() => {
    // montagem dupla (StrictMode) passa pela limpeza: a remontagem precisa voltar a valer
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const needsCode = !!stepUp;
  const recorded = record.status === 'ready' ? record.view : null;
  const blockedByRecord = !!guard && (record.status !== 'ready' || recorded?.state === 'unknown' || recorded?.state === 'pending');
  const confirm = async () => {
    if ((needsCode && code.length !== TOTP_DIGITS) || !ready || outcome?.kind === 'uncertain' || blockedByRecord) return;
    const typed = code;
    setCode(''); // código de uso único: sai da tela assim que é usado
    setOutcome(null);
    setNotice(null);
    // registro ANTES de qualquer envio: trava esta e as outras abas e sobrevive a uma interrupção no meio
    let finish: (state: 'confirmed' | 'refused' | 'unknown' | 'not-sent') => void = () => {};
    if (guard && record.status === 'ready') {
      const begun = await operations().begin(record.key);
      if (!begun.ok) {
        if (!alive.current) return;
        if (begun.reason === 'storage')
          setNotice(
            'Este navegador não permitiu registrar a operação antes do envio. Para não arriscar uma repetição sem saber o resultado, nada foi enviado. Libere o armazenamento deste site e tente de novo.',
          );
        else setRecord({ status: 'ready', key: record.key, view: { state: begun.reason === 'busy' ? 'pending' : 'unknown', at: begun.at ?? Date.now() } });
        return;
      }
      finish = begun.finish;
    }
    setBusy(true);
    try {
      try {
        if (stepUp) await stepUp(typed);
      } catch (e) {
        finish('not-sent');
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
        const kind = classifyActionError(e);
        // a conclusão é registrada mesmo que a pessoa já tenha saído da tela
        finish(kind === 'uncertain' ? 'unknown' : 'refused');
        if (!alive.current) return;
        if (kind === 'unauthenticated') return onUnauthenticated();
        onOutcome?.(kind);
        setOutcome({ kind, text: kind === 'uncertain' ? uncertainText : refusalText(e) });
        return;
      }
      finish('confirmed');
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
      confirmDisabled={!ready || (needsCode && code.length !== TOTP_DIGITS) || outcome?.kind === 'uncertain' || blockedByRecord}
      error={outcome?.text ?? notice ?? undefined}
      onConfirm={confirm}
      onCancel={() => {
        setCode('');
        onClose();
      }}
      size="md"
    >
      <Stack gap={3}>
        {children}
        {guard && outcome?.kind !== 'uncertain' && (
          <RecordNotice
            record={record}
            uncertainText={uncertainText}
            onAcknowledge={() => {
              if (record.status === 'ready') operations().acknowledge(record.key);
            }}
          />
        )}
        {outcome?.kind === 'uncertain' ? (
          <Alert tone="warning" live="off" title="Resultado não confirmado">
            Nada será repetido automaticamente. Feche e confira o estado atual antes de decidir.
          </Alert>
        ) : (
          needsCode &&
          !blockedByRecord && (
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

/** O que o registro diz sobre esta operação antes de confirmar. */
function RecordNotice({ record, uncertainText, onAcknowledge }: { record: OpRecord; uncertainText: string; onAcknowledge: () => void }) {
  if (record.status === 'idle') return null;
  if (record.status === 'unavailable')
    return (
      <Alert tone="info" live="polite">
        Preparando a proteção contra repetição desta operação…
      </Alert>
    );
  const view = record.view;
  if (!view) return null;
  if (view.state === 'pending')
    return (
      <Alert tone="info" live="polite" title="Envio em andamento">
        Esta operação foi enviada às {timeOf(view.at)} nesta ou em outra aba e ainda não terminou. Aguarde o resultado; nada será enviado de novo.
      </Alert>
    );
  if (view.state === 'unknown')
    return (
      <Alert tone="warning" live="polite" title="Resultado não confirmado">
        <Stack gap={2}>
          <span>
            Uma tentativa enviada às {timeOf(view.at)} ficou sem resposta confirmada. Nada será repetido automaticamente. {uncertainText} Não encontrar o
            resultado numa lista não comprova que nada foi feito.
          </span>
          {view.old && <span>Este registro tem mais de 72 horas e continua sem confirmação: o tempo não resolve a dúvida.</span>}
          <span>
            Liberar permite enviar de novo. Não confirma o resultado da tentativa anterior nem garante que não haverá duplicidade.
          </span>
          <span>
            <Button variant="secondary" size="sm" onClick={onAcknowledge}>
              Já conferi o estado atual; liberar nova tentativa
            </Button>
          </span>
        </Stack>
      </Alert>
    );
  if (view.state === 'confirmed')
    return (
      <Alert tone="success" live="off">
        A tentativa anterior desta operação, às {timeOf(view.at)}, foi confirmada pela Platform.
      </Alert>
    );
  return null;
}
