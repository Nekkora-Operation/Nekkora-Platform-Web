import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, CodeInput, ConfirmDialog, Input, Stack, Text } from 'nekkora-lib';
import { ApiError, hasReason, isApiError } from '../api/http';
import { NO_TAB_LOCK_TEXT, operations, opKey, type OpView } from '../api/pendingOps';
import { stepUpMethods } from '../api/stepUpMethod';
import { useOperationScope } from './operationScope';

const TOTP_DIGITS = 6;

/** Desfecho de um ato sensível confirmado com step-up. */
export type StepUpOutcome = 'refused-identity' | 'refused' | 'uncertain' | 'unauthenticated';

/**
 * PLATFORM-V2-001, T01 — na sessão de ORGANIZAÇÃO, uma confirmação aceita vale por uma hora (janela fixa, no servidor) para
 * as ações sensíveis comuns. O diálogo envia o ato sem pedir o fator; só quando a API responde 403 forbidden + step_up_required (nada
 * foi feito) ele pede o código (ou a senha, na sessão sem MFA), mantendo os campos do ato, e envia o ato UMA vez depois da
 * confirmação aceita. Na sessão de identidade continua como antes: o fator imediatamente antes do ato.
 */
export const STEP_UP_NEEDED_TEXT = 'Para continuar, confirme a sua identidade. Nada foi feito ainda. A confirmação vale por uma hora nas ações sensíveis desta organização.';
/**
 * Quais ações aproveitam a hora (as que a API confere com a janela de 60 min, AccessActions.requireStepUp) e quais não:
 * a redefinição do MFA de outra pessoa (prova própria de 5 min) e tudo o que é da sessão de identidade (Minha conta,
 * criar organização, vincular conta, aceitar convite), que continua com 5 min no banco. Dito na tela para não prometer
 * uma hora e surpreender a pessoa em Minha conta.
 */
export const ORG_HOUR_SCOPE_TEXT =
  'A hora vale para: publicar versões, convidar e reenviar convites, atribuir e trocar papéis, aprovar, renovar ou manter na revisão acessos de clientes, emitir códigos e revogar Agents, autorizar computadores e execuções, e pedir ou cancelar execuções. Não vale para redefinir a autenticação de outra pessoa, que pede um código dos últimos 5 minutos, nem para Minha conta: trocar a senha ou o fator e as outras ações da sua conta continuam pedindo a confirmação, que vale 5 minutos.';
export const IDENTITY_SCOPE_TEXT =
  'Nesta área da sua conta, a confirmação vale 5 minutos. A confirmação de uma hora vale só para ações dentro de uma organização.';
const STEP_UP_STILL_NEEDED_TEXT = 'A Platform ainda pede a confirmação para este ato. Nada foi feito. Confirme de novo.';

/**
 * A1 (LICENCIAMENTO-002): limite de pedidos (429) na confirmação ou no ato. É recusa documentada: nada foi feito. O diálogo
 * continua aberto com os campos do ato, diz quando dá para tentar de novo pelo Retry-After da API e só libera o botão
 * depois desse tempo. Nada é repetido automaticamente.
 */
export function rateLimitedText(e: unknown): string {
  const s = e instanceof ApiError ? e.retryAfterSeconds : undefined;
  return s
    ? `Muitas tentativas em pouco tempo. Nada foi feito. Você poderá tentar de novo em ${s} ${s === 1 ? 'segundo' : 'segundos'}; os dados preenchidos continuam aqui.`
    : 'Muitas tentativas em pouco tempo. Nada foi feito. Aguarde alguns segundos antes de tentar de novo; os dados preenchidos continuam aqui.';
}

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
  /**
   * A1: consulta do ESTADO ATUAL quando o resultado ficou incerto (agora ou numa tentativa anterior registrada). Só leitura;
   * nunca reenvia. `true` = o ato está em vigor na Platform; `false` = a leitura não mostra o ato. Só para atos idempotentes
   * (repetir com os mesmos valores devolve o mesmo resultado): um envio atrasado ainda pode chegar depois da leitura.
   */
  verify?: () => Promise<boolean>;
  /** A consulta mostrou o ato em vigor: a tela atualiza e fecha o diálogo como concluído. */
  onVerified?: () => void;
}

/** Conferência do estado depois de um resultado incerto. */
type Check = 'idle' | 'checking' | 'absent' | 'failed';

/** Registro da operação, como o diálogo o vê. */
type OpRecord =
  | { status: 'idle' }
  | { status: 'ready'; key: string; view: OpView | null }
  | { status: 'unavailable' }
  /** Sem Web Locks: sem exclusão entre abas, o envio protegido não começa (FRONT-V1-004). */
  | { status: 'no-locks' };

/**
 * Área de identidade: o registro é por sessão, não por pessoa (lacuna aberta, Nekkora-Platform-API#40). A pessoa sabe
 * disso na hora em que a incerteza aparece.
 */
const IDENTITY_SESSION_ONLY =
  'Este aviso vale nesta sessão (recarregar ou abrir outra aba não o apaga), mas não aparece mais depois de sair e entrar de novo: confira o resultado antes de repetir.';

const timeOf = (at: number) => new Date(at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Confirmação de ato sensível. Identidade: step-up IMEDIATAMENTE antes (prova de até 5 min); um envio = step-up e, só se ele
 * for aceito, o ato. Organização (T01): o ato primeiro; o fator só quando a API responder step_up_required. Recusa do step-up = nada enviado. Falha sem resposta no ato = incerteza declarada: o
 * diálogo bloqueia nova confirmação (sem reenvio silencioso) e pede conferência. O código vive só no campo e é limpo
 * ao usar e ao fechar.
 */
export function StepUpDialog<T>(props: StepUpDialogProps<T>) {
  const {
    open,
    title,
    confirmLabel,
    tone,
    children,
    ready = true,
    stepUp,
    action,
    onDone,
    onClose,
    refusalText,
    uncertainText,
    onUnauthenticated,
    onOutcome,
    guard,
    verify,
    onVerified,
  } = props;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: StepUpOutcome; text: string } | null>(null);
  const [record, setRecord] = useState<OpRecord>({ status: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  // 429: instante a partir do qual o botão volta a valer (Retry-After); o relógio só anda enquanto há espera
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [check, setCheck] = useState<Check>('idle');
  const alive = useRef(true);
  const scope = useOperationScope();
  const operation = guard?.operation;
  const target = guard?.target;

  useEffect(() => {
    if (!open) return;
    setCode('');
    setOutcome(null);
    setNotice(null);
    setRetryAt(null);
    setCheck('idle');
  }, [open]);

  useEffect(() => {
    if (retryAt === null) return;
    setNow(Date.now());
    const t = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= retryAt) window.clearInterval(t);
    }, 1000);
    return () => window.clearInterval(t);
  }, [retryAt]);
  const waitSeconds = retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
  const rateLimited = (e: unknown) => {
    const s = e instanceof ApiError ? e.retryAfterSeconds : undefined;
    setRetryAt(s ? Date.now() + s * 1000 : null);
    return rateLimitedText(e);
  };

  // registro da operação: lido ao abrir e acompanhado (outra aba, conclusão de um envio que continuou fora da tela)
  useEffect(() => {
    if (!open || !operation) {
      setRecord({ status: 'idle' });
      return;
    }
    if (!operations().exclusive()) {
      setRecord({ status: 'no-locks' });
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

  // T01: na organização, o fator só é pedido quando a API disser que falta (step_up_required)
  const onDemand = !!stepUp && !!scope.org;
  const [asking, setAsking] = useState(!onDemand);
  useEffect(() => {
    if (open) setAsking(!onDemand);
  }, [open, onDemand]);
  const needsCode = !!stepUp && asking;
  // API 029: sem autenticação em duas etapas, a sessão confirma com a SENHA (o cliente chama a rota certa)
  const byPassword = needsCode && stepUpMethods.get(scope.org) === 'password';
  const secretReady = !needsCode || (byPassword ? code.length > 0 : code.length === TOTP_DIGITS);
  const recorded = record.status === 'ready' ? record.view : null;
  const blockedByRecord = !!guard && (record.status !== 'ready' || recorded?.state === 'unknown' || recorded?.state === 'pending');
  const recordKey = record.status === 'ready' ? record.key : null;

  // A1: resultado incerto -> o estado atual é consultado (só leitura) antes de oferecer nova tentativa
  const verifyRef = useRef(verify);
  verifyRef.current = verify;
  const runCheck = async () => {
    const read = verifyRef.current;
    if (!read) return;
    setCheck('checking');
    try {
      const done = await read();
      if (!alive.current) return;
      if (done) {
        // a Platform mostra o ato em vigor: não há nova tentativa a proteger; o registro da incerteza é encerrado
        if (recordKey) operations().acknowledge(recordKey);
        setCheck('idle');
        setOutcome(null);
        onVerified?.();
      } else setCheck('absent');
    } catch (e) {
      if (!alive.current) return;
      if (isApiError(e, 'unauthenticated')) return onUnauthenticated();
      setCheck('failed');
    }
  };
  const uncertainNow = outcome?.kind === 'uncertain' || recorded?.state === 'unknown';
  useEffect(() => {
    if (open && verify && uncertainNow && check === 'idle') void runCheck();
    // a conferência roda uma vez por incerteza; "Conferir de novo" chama de novo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, uncertainNow, !!verify]);
  const release = () => {
    if (recordKey) operations().acknowledge(recordKey);
    setOutcome(null);
    setCheck('idle');
  };
  const confirm = async () => {
    if (!secretReady || !ready || outcome?.kind === 'uncertain' || blockedByRecord || waitSeconds > 0) return;
    const typed = code;
    setCode(''); // código (ou senha) sai da tela assim que é usado
    setOutcome(null);
    setNotice(null);
    setRetryAt(null);
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
        else if (begun.reason === 'no-locks') setRecord({ status: 'no-locks' });
        else setRecord({ status: 'ready', key: record.key, view: { state: begun.reason === 'busy' ? 'pending' : 'unknown', at: begun.at ?? Date.now() } });
        return;
      }
      finish = begun.finish;
    }
    setBusy(true);
    try {
      try {
        if (stepUp && needsCode) {
          await stepUp(typed);
          // A1: na organização a confirmação aceita vale por uma hora; se o ato for recusado sem efeito (ex.: 429), a nova
          // tentativa vai sem pedir outro código, que só volta a ser pedido se a API disser que falta (step_up_required)
          if (onDemand && alive.current) setAsking(false);
        }
      } catch (e) {
        finish('not-sent');
        if (!alive.current) return;
        if (isApiError(e, 'unauthenticated')) return onUnauthenticated();
        onOutcome?.('refused-identity');
        setOutcome({
          kind: 'refused-identity',
          text: isApiError(e, 'rate_limited')
            ? rateLimited(e)
            : byPassword
              ? 'Não foi possível confirmar sua identidade com esta senha. Confira a senha e tente de novo. Nada foi feito.'
              : 'Não foi possível confirmar sua identidade com este código. Confira o código atual do aplicativo. Nada foi feito.',
        });
        return;
      }
      let result: T;
      try {
        result = await action();
      } catch (e) {
        if (onDemand && hasReason(e, 'forbidden', 'step_up_required')) {
          // recusa documentada sem efeito: o registro fecha como recusado e a pessoa confirma e decide de novo
          finish('refused');
          if (!alive.current) return;
          const already = needsCode;
          setAsking(true);
          setOutcome({ kind: 'refused', text: already ? STEP_UP_STILL_NEEDED_TEXT : STEP_UP_NEEDED_TEXT });
          return;
        }
        const kind = classifyActionError(e);
        // a conclusão é registrada mesmo que a pessoa já tenha saído da tela
        finish(kind === 'uncertain' ? 'unknown' : 'refused');
        if (!alive.current) return;
        if (kind === 'unauthenticated') return onUnauthenticated();
        onOutcome?.(kind);
        setOutcome({ kind, text: kind === 'uncertain' ? uncertainText : isApiError(e, 'rate_limited') ? rateLimited(e) : refusalText(e) });
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
      confirmLabel={waitSeconds > 0 ? `Tentar de novo em ${waitSeconds} s` : confirmLabel}
      tone={tone}
      busy={busy}
      confirmDisabled={!ready || !secretReady || outcome?.kind === 'uncertain' || blockedByRecord || waitSeconds > 0}
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
            identityArea={!scope.org}
            uncertainText={uncertainText}
            check={verify ? check : null}
            onCheck={() => void runCheck()}
            onAcknowledge={() => {
              if (record.status === 'ready') operations().acknowledge(record.key);
              setCheck('idle');
            }}
          />
        )}
        {outcome?.kind === 'uncertain' ? (
          <Alert tone="warning" live="off" title="Resultado não confirmado">
            <Stack gap={2}>
              <span>
                Nada será repetido automaticamente.{' '}
                {verify ? 'O estado atual é conferido antes de qualquer nova tentativa.' : 'Feche e confira o estado atual antes de decidir.'}
                {guard && !scope.org && <> {IDENTITY_SESSION_ONLY}</>}
              </span>
              {verify && <CheckStatus check={check} onCheck={() => void runCheck()} onRelease={release} />}
            </Stack>
          </Alert>
        ) : (
          needsCode &&
          !blockedByRecord &&
          (byPassword ? (
            <Input
              label="Sua senha"
              type="password"
              autoComplete="current-password"
              fullWidth
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
              hint={
                onDemand
                  ? 'A sua conta não usa autenticação em duas etapas: a senha confirma a sua identidade por uma hora nas ações sensíveis desta organização. Você pode ativar a autenticação em duas etapas em Segurança da conta.'
                  : 'A sua conta não usa autenticação em duas etapas: a senha confirma a sua identidade imediatamente antes do ato. Você pode ativar a autenticação em duas etapas em Segurança da conta.'
              }
            />
          ) : (
          <CodeInput
            label="Código do seu aplicativo autenticador"
            hint={
              onDemand
                ? 'Confirma a sua identidade por uma hora nas ações sensíveis desta organização. Códigos de recuperação não são aceitos aqui.'
                : 'Confirma a sua identidade imediatamente antes do ato. Códigos de recuperação não são aceitos aqui.'
            }
            length={TOTP_DIGITS}
            value={code}
            onValueChange={setCode}
            disabled={busy}
          />
          ))
        )}
        {needsCode && !blockedByRecord && outcome?.kind !== 'uncertain' && <Text>{onDemand ? ORG_HOUR_SCOPE_TEXT : IDENTITY_SCOPE_TEXT}</Text>}
      </Stack>
    </ConfirmDialog>
  );
}

/**
 * A1: resultado da consulta do estado atual depois de um resultado incerto. Mesmo quando a leitura não mostra o ato, a nova
 * tentativa continua sendo decisão da pessoa (o registro só some por liberação explícita).
 */
function CheckStatus({ check, onCheck, onRelease }: { check: Check; onCheck: () => void; onRelease?: () => void }) {
  if (check === 'checking' || check === 'idle')
    return (
      <Text variant="body-sm" role="status">
        Conferindo o estado atual na Platform…
      </Text>
    );
  if (check === 'failed')
    return (
      <Stack gap={2}>
        <Text variant="body-sm" role="status">
          Não foi possível conferir o estado atual agora. Nada será liberado sem essa conferência ou a sua decisão.
        </Text>
        <span>
          <Button variant="secondary" size="sm" onClick={onCheck}>
            Conferir de novo
          </Button>
        </span>
      </Stack>
    );
  return (
    <Stack gap={2}>
      <Text variant="body-sm" role="status">
        Conferido agora: a Platform não mostra este ato em vigor. Uma tentativa atrasada ainda pode chegar; repetir com os mesmos valores devolve o mesmo
        resultado.
      </Text>
      {onRelease && (
        <span>
          <Button variant="secondary" size="sm" onClick={onRelease}>
            Liberar nova tentativa
          </Button>
        </span>
      )}
    </Stack>
  );
}

/** O que o registro diz sobre esta operação antes de confirmar. */
function RecordNotice({
  record,
  identityArea,
  uncertainText,
  check,
  onCheck,
  onAcknowledge,
}: {
  record: OpRecord;
  identityArea: boolean;
  uncertainText: string;
  /** Com consulta de estado (A1): o resultado dela; sem consulta, `null`. */
  check: Check | null;
  onCheck: () => void;
  onAcknowledge: () => void;
}) {
  if (record.status === 'idle') return null;
  if (record.status === 'no-locks')
    return (
      <Alert tone="warning" live="polite" title="Operação indisponível neste navegador">
        {NO_TAB_LOCK_TEXT}
      </Alert>
    );
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
          {identityArea && <span>{IDENTITY_SESSION_ONLY}</span>}
          {check !== null && <CheckStatus check={check} onCheck={onCheck} />}
          <span>
            Liberar permite enviar de novo. Não confirma o resultado da tentativa anterior nem garante que não haverá duplicidade.
          </span>
          {(check === null || check === 'absent' || check === 'failed') && (
            <span>
              <Button variant="secondary" size="sm" onClick={onAcknowledge}>
                Já conferi o estado atual; liberar nova tentativa
              </Button>
            </span>
          )}
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
