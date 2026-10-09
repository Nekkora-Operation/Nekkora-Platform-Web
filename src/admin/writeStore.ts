import { useSyncExternalStore } from 'react';
import { csrfStore } from '../api/csrf';
import { isApiError } from '../api/http';
import type { GrantStatus, Member } from '../api/v1';

/**
 * Escritas administrativas (F6a-2 em diante): registro em MEMÓRIA da aba, por organização e alvo, compartilhado entre
 * telas. Fica fora dos componentes de propósito:
 *
 * - **trava síncrona**: enquanto um envio para o alvo estiver em curso, outro não começa (clique ou Enter duplicado,
 *   outro diálogo, outra tela) — a verificação acontece antes de qualquer `await`;
 * - **resposta antiga não altera outra ação**: cada envio tem um número; a conclusão só vale se ainda for o envio atual
 *   DAQUELE alvo DAQUELA organização;
 * - **sair da página não cancela no servidor**: o envio continua, e o resultado (inclusive incerto) fica registrado para
 *   quando a pessoa voltar;
 * - **nenhuma repetição automática**: só `start` envia, e nova tentativa depois de resultado incerto exige `retry`
 *   (decisão explícita na interface);
 * - **resultado incerto não é apagado em silêncio**: só some por uma nova tentativa CONCLUÍDA (204) ou por `dismiss`
 *   (decisão explícita). Uma nova tentativa RECUSADA (403, 404…) comprova só a recusa dela: a incerteza anterior
 *   continua, com a recusa registrada à parte (`refusedRetry`). Recarregar a página apaga a memória da aba;
 * - **uma sessão por registro** (F6a-2-R1): o registro pertence à sessão da aba. Nas fronteiras de sessão (login que
 *   emite sessão nova, logout, sessão expirada — `csrfStore.onSessionBoundary`) ele é zerado e a "época" muda: nada é
 *   reaproveitado entre sessões, nem da mesma pessoa, e conclusões ou conferências de antes da troca são ignoradas.
 *
 * Nada aqui decide autorização: a API decide, e a interface só apresenta o que ela respondeu.
 */

export type WriteAction = 'suspend' | 'reactivate' | 'revoke' | 'mfa-reset';
export type WritePhase = 'sending' | 'done' | 'refused' | 'uncertain';

/**
 * Tipo do recurso alvo (F6a-3). Faz parte da CHAVE do registro: membro e concessão nunca colidem, mesmo com o mesmo
 * identificador.
 */
export type ResourceKind = 'member' | 'grant' | 'mfa';

/** Membro (F6a-2). Sem `kind` = membro (compatível com o registro da F6a-2). */
export interface MemberTarget {
  kind?: 'member';
  userId: string;
  membershipId: string;
  displayName: string;
}

/** Concessão de acesso externo (F6a-3). */
export interface GrantTarget {
  kind: 'grant';
  grantId: string;
  /** Conta externa da concessão. */
  displayName: string;
  email: string;
  clientName: string;
  workspaceName: string;
}

/**
 * MFA de um membro (F6a-4). Recurso próprio na chave: a redefinição de MFA e a suspensão da MESMA conta têm registros
 * separados (conferência, dispensa e nova tentativa de cada uma).
 */
export interface MfaTarget {
  kind: 'mfa';
  userId: string;
  membershipId: string;
  displayName: string;
  email: string;
}

export type WriteTarget = MemberTarget | GrantTarget | MfaTarget;

export type MemberEntry = WriteEntry & { target: MemberTarget };
export type GrantEntry = WriteEntry & { target: GrantTarget };
export type MfaEntry = WriteEntry & { target: MfaTarget };
export const isMemberEntry = (e: WriteEntry): e is MemberEntry => e.target.kind === undefined || e.target.kind === 'member';
export const isGrantEntry = (e: WriteEntry): e is GrantEntry => e.target.kind === 'grant';
export const isMfaEntry = (e: WriteEntry): e is MfaEntry => e.target.kind === 'mfa';

/** Tipo e identificador do alvo (o que entra na chave). */
export function targetRef(t: WriteTarget): { kind: ResourceKind; id: string } {
  if (t.kind === 'grant') return { kind: 'grant', id: t.grantId };
  return { kind: t.kind === 'mfa' ? 'mfa' : 'member', id: t.userId };
}

/** Conferência do estado atual depois de resultado incerto. Informa o estado lido; NÃO prova o resultado da escrita. */
export type CheckState =
  | { status: 'checking'; token: number }
  | { status: 'found'; token: number; accountStatus?: Member['accountStatus']; grantStatus?: GrantStatus; mfaConfigured?: boolean; at: number }
  | { status: 'absent'; token: number; at: number }
  | { status: 'failed'; token: number; reason: 'error' | 'forbidden' | 'interrupted' | 'incomplete'; at: number };

export interface WriteEntry {
  id: number;
  org: string;
  action: WriteAction;
  target: WriteTarget;
  phase: WritePhase;
  /** Erro da última conclusão (recusada ou incerta). */
  error?: unknown;
  /** O envio é uma nova tentativa depois de resultado incerto (decisão explícita). */
  retry: boolean;
  /** Nova tentativa RECUSADA depois de resultado incerto: a recusa dela, mantida à parte da incerteza anterior. */
  refusedRetry?: unknown;
  check?: CheckState;
}

const entries = new Map<string, WriteEntry>();
const listeners = new Set<() => void>();
let seq = 0;
let checkSeq = 0;
let version = 0;
/** Época da sessão da aba: muda a cada fronteira de sessão. */
let epoch = 0;

/** Época atual (quem faz leituras em várias etapas confere se ainda é a mesma sessão). */
export const sessionEpoch = () => epoch;

/**
 * Guarda de sequência (F6a-4-R1): fixa a época da sessão de AGORA; a função devolvida lança `NotApplied('session')`
 * se a sessão mudou desde então (login, logout, expiração ou aviso de outra aba). Para ser chamada antes de cada POST
 * de uma sequência com várias etapas, inclusive depois de esperar o CSRF.
 */
export function sessionGuard(): () => void {
  const started = epoch;
  return () => {
    if (epoch !== started) throw new NotApplied('session', new Error('a sessão mudou durante a sequência'));
  };
}

function resetSession() {
  entries.clear();
  epoch++;
  emit();
}
csrfStore.onSessionBoundary(resetSession);

const keyOf = (org: string, id: string, kind: ResourceKind = 'member') => `${org}|${kind}|${id}`;

function emit() {
  version++;
  for (const l of listeners) l();
}

/**
 * Recusa comprovada: a API respondeu com um status documentado que não aplica a ação (permissão, alvo, parâmetro,
 * limite). Sessão expirada (401) também não aplica (a sessão é validada antes dos efeitos), mas segue o fluxo próprio.
 * Todo o resto — rede interrompida, 5xx, resposta de gateway sem corpo, resposta fora do contrato — é INCERTO.
 */
export function classify(e: unknown): 'refused' | 'uncertain' {
  if (e instanceof NotApplied) return 'refused';
  return isApiError(e, 'unauthenticated', 'forbidden', 'not_found', 'invalid_request', 'rate_limited') ? 'refused' : 'uncertain';
}

/**
 * Falha que comprovadamente aconteceu ANTES de o pedido de efeito ser enviado (F6a-4: a confirmação de identidade
 * falhou — recusada, sem resposta ou fora do contrato — e a redefinição nem foi enviada; F6a-4-R1: a sessão mudou no
 * meio da sequência, e ela parou antes do próximo POST). Nada foi aplicado ao alvo: é recusa, nunca incerteza,
 * qualquer que seja a causa. `cause` guarda o erro original (ex.: 401 → sessão expirada).
 */
export class NotApplied extends Error {
  constructor(
    readonly stage: 'step-up' | 'session',
    readonly cause: unknown,
  ) {
    super(`não aplicado (${stage})`);
    this.name = 'NotApplied';
  }
}

/** Erro original, sem o envoltório de `NotApplied` (para decidir 401, 429…). */
export const rootError = (e: unknown): unknown => (e instanceof NotApplied ? e.cause : e);

/**
 * Começa um envio. Devolve o número do envio, ou `null` se não começou: já há envio em curso para o alvo, ou o último
 * resultado foi incerto e `retry` não foi pedido.
 */
export function startWrite(org: string, action: WriteAction, target: WriteTarget, send: () => Promise<void>, { retry = false } = {}): number | null {
  const ref = targetRef(target);
  const key = keyOf(org, ref.id, ref.kind);
  const current = entries.get(key);
  if (current?.phase === 'sending') return null;
  if (current?.phase === 'uncertain' && !retry) return null;
  const id = ++seq;
  entries.set(key, { id, org, action, target, phase: 'sending', retry: current?.phase === 'uncertain' });
  emit();
  let promise: Promise<void>;
  try {
    promise = send();
  } catch (e) {
    promise = Promise.reject(e);
  }
  promise.then(
    () => settle(key, id, { phase: 'done', error: undefined }),
    (e: unknown) => settle(key, id, { phase: classify(e), error: e }),
  );
  return id;
}

function settle(key: string, id: number, patch: Pick<WriteEntry, 'phase' | 'error'>) {
  const e = entries.get(key);
  // resposta de um envio que não é mais o atual (outra ação, outra tentativa, registro dispensado): ignorada
  if (!e || e.id !== id || e.phase !== 'sending') return;
  if (e.retry && patch.phase === 'refused') {
    // a recusa da nova tentativa não esclarece se a anterior foi aplicada: continua incerto, com a recusa à parte
    entries.set(key, { ...e, phase: 'uncertain', refusedRetry: patch.error, check: undefined });
  } else {
    entries.set(key, { ...e, ...patch, refusedRetry: undefined, check: undefined });
  }
  emit();
}

/** Decisão explícita de dispensar o registro (não envia nada). Não vale durante o envio. */
export function dismissWrite(org: string, id: string, kind: ResourceKind = 'member') {
  const key = keyOf(org, id, kind);
  if (entries.get(key)?.phase === 'sending') return;
  if (entries.delete(key)) emit();
}

/**
 * Lista relida do servidor: concluídos e recusados DAQUELE tipo de recurso deixam de valer; incertos e envios em curso
 * continuam. Reler membros não apaga registros de concessões, e vice-versa.
 */
export function clearSettled(org: string, kind: ResourceKind = 'member') {
  let changed = false;
  for (const [k, e] of entries) {
    if (e.org === org && targetRef(e.target).kind === kind && (e.phase === 'done' || e.phase === 'refused')) {
      entries.delete(k);
      changed = true;
    }
  }
  if (changed) emit();
}

/** Abre uma conferência para o registro incerto `id`; devolve o token, ou null se o registro mudou. */
export function beginCheck(org: string, targetId: string, id: number, kind: ResourceKind = 'member'): number | null {
  const key = keyOf(org, targetId, kind);
  const e = entries.get(key);
  if (!e || e.id !== id || e.phase !== 'uncertain') return null;
  const token = ++checkSeq;
  entries.set(key, { ...e, check: { status: 'checking', token } });
  emit();
  return token;
}

/** Conclui a conferência `token` (respostas de conferências antigas são ignoradas). */
export function finishCheck(org: string, targetId: string, check: CheckState, kind: ResourceKind = 'member') {
  const key = keyOf(org, targetId, kind);
  const e = entries.get(key);
  if (!e || e.phase !== 'uncertain' || e.check?.token !== check.token) return;
  entries.set(key, { ...e, check });
  emit();
}

export function writeEntry(org: string, id: string, kind: ResourceKind = 'member'): WriteEntry | undefined {
  return entries.get(keyOf(org, id, kind));
}

/** Registros da organização (outra organização nunca aparece). */
export function useWriteEntries(org: string): WriteEntry[] {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return [...entries.values()].filter((e) => e.org === org);
}

/** Só testes: limpa o registro entre casos. */
export function resetWriteStore() {
  entries.clear();
  epoch++;
  version++;
}
