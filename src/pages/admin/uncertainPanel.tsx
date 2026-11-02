import { forwardRef, useRef } from 'react';
import { Alert, Button, Text } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { beginCheck, finishCheck, sessionEpoch, targetRef, type CheckState, type WriteEntry } from '../../admin/writeStore';

/** Resultado de procurar o alvo pelo id na leitura atual (sem filtros). Informa o estado; não prova a escrita. */
export type FindResult =
  | { kind: 'found'; state: Pick<Extract<CheckState, { status: 'found' }>, 'accountStatus' | 'grantStatus' | 'mfaConfigured'> }
  | { kind: 'absent' }
  | { kind: 'incomplete' }
  | { kind: 'interrupted' };

/** Textos do aviso por tipo de recurso (membros: os mesmos da F6a-2). */
export interface UncertainCopy<E extends WriteEntry> {
  /** Ex.: "Suspensão de Caio Mendes", "Revogação da concessão de …". */
  label: (e: E) => string;
  /** Estado lido, ex.: "conta suspensa", "concessão revogada". */
  current: (state: Extract<FindResult, { kind: 'found' }>['state']) => string;
  /** "a conta" / "a concessão" (como ela está agora). */
  noun: string;
  /** "este membro não foi encontrado" / "esta concessão não foi encontrada". */
  absent: string;
  /** "de membros" / "de concessões" (a leitura recusada). */
  listName: string;
  refusalText: (e: unknown) => string;
  previousStillUncertain: string;
}

function checkText<E extends WriteEntry>(check: CheckState | undefined, copy: UncertainCopy<E>): string | null {
  if (!check) return null;
  const at = 'at' in check ? new Date(check.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  switch (check.status) {
    case 'checking':
      return 'Conferindo o estado atual…';
    case 'found':
      return `Estado atual lido às ${at}: ${copy.current(check)}. Isto informa como ${copy.noun} está agora; não confirma o resultado do pedido.`;
    case 'absent':
      return `Leitura às ${at}: ${copy.absent} na lista atual. Isso não indica sucesso nem falha do pedido.`;
    case 'failed':
      return check.reason === 'interrupted'
        ? 'Conferência interrompida. Nada foi alterado.'
        : check.reason === 'forbidden'
          ? `Não foi possível conferir agora: a leitura ${copy.listName} foi recusada.`
          : check.reason === 'incomplete'
            ? 'Não foi possível conferir agora: a lista não pôde ser percorrida até o fim.'
            : 'Não foi possível conferir agora.';
  }
}

/**
 * Registros de resultado NÃO confirmado (e as novas tentativas em curso) de um tipo de recurso na organização. Ficam
 * visíveis até uma decisão explícita: conferir, tentar de novo (com confirmação) ou dispensar o aviso. Sobrevivem à
 * navegação entre telas da mesma sessão. A conferência é da sessão em que começou: numa troca de sessão ela para de ler
 * e o resultado é descartado.
 */
function UncertainPanelInner<E extends WriteEntry>(
  {
    org,
    entries,
    copy,
    find,
    onRetry,
    onDismiss,
    onUnauthenticated,
    onForbidden,
  }: {
    org: string;
    entries: E[];
    /** Textos do aviso; uma função escolhe os textos POR REGISTRO (ex.: Membros mostra suspensões e redefinições de MFA). */
    copy: UncertainCopy<E> | ((e: E) => UncertainCopy<E>);
    find: (e: E, interrupted: () => boolean) => Promise<FindResult>;
    onRetry: (e: E) => void;
    onDismiss: (e: E) => void;
    onUnauthenticated: () => void;
    /** A leitura da conferência foi recusada (403): a tela passa a acesso negado até nova leitura autorizada. */
    onForbidden: () => void;
  },
  ref: React.ForwardedRef<HTMLDivElement>,
) {
  const interrupts = useRef(new Map<number, boolean>());
  if (!entries.length) return null;

  const check = async (e: E) => {
    const { kind, id } = targetRef(e.target);
    const token = beginCheck(org, id, e.id, kind);
    if (token === null) return;
    interrupts.current.set(token, false);
    const started = sessionEpoch();
    const sameSession = () => sessionEpoch() === started;
    const at = () => Date.now();
    try {
      const r = await find(e, () => interrupts.current.get(token) === true || !sameSession());
      if (!sameSession()) return;
      if (r.kind === 'found') finishCheck(org, id, { status: 'found', token, ...r.state, at: at() }, kind);
      else if (r.kind === 'absent') finishCheck(org, id, { status: 'absent', token, at: at() }, kind);
      else finishCheck(org, id, { status: 'failed', token, reason: r.kind === 'interrupted' ? 'interrupted' : 'incomplete', at: at() }, kind);
    } catch (err) {
      if (!sameSession()) return;
      if (isApiError(err, 'unauthenticated')) {
        finishCheck(org, id, { status: 'failed', token, reason: 'error', at: at() }, kind);
        onUnauthenticated();
        return;
      }
      const reason = isApiError(err, 'forbidden') ? 'forbidden' : isApiError(err, 'invalid_request') ? 'incomplete' : 'error';
      finishCheck(org, id, { status: 'failed', token, reason, at: at() }, kind);
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
            const c = typeof copy === 'function' ? copy(e) : copy;
            const label = c.label(e);
            const text = checkText(e.check, c);
            return (
              <li key={e.id} className="pw-admin__uncertain-item">
                <Text>
                  {label}: {sending ? 'nova tentativa em envio…' : 'resultado não confirmado.'}
                </Text>
                {!sending && e.refusedRetry !== undefined && (
                  <Text variant="body-sm" color="secondary">
                    Nova tentativa recusada: {c.refusalText(e.refusedRetry)} {c.previousStillUncertain}
                  </Text>
                )}
                {!sending && text && (
                  <Text variant="body-sm" color="secondary">
                    {text}
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
                {!sending && (
                  <Text variant="body-sm" color="secondary">
                    Dispensar o aviso libera uma nova tentativa. Não confirma o resultado anterior nem garante que não haverá
                    duplicidade.
                  </Text>
                )}
              </li>
            );
          })}
        </ul>
      </Alert>
    </div>
  );
}

export const UncertainPanel = forwardRef(UncertainPanelInner) as <E extends WriteEntry>(
  props: Parameters<typeof UncertainPanelInner<E>>[0] & { ref?: React.Ref<HTMLDivElement> },
) => ReturnType<typeof UncertainPanelInner>;
