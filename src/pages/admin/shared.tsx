import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Button, Checkbox, Fieldset, LoadMore, StateView } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import type { GrantStatus, Member, MembershipStatus } from '../../api/v1';
import type { CursorList } from '../../hooks/useCursorList';
import { errorText } from '../product/shared';

/** Itens por página nas listas administrativas. */
export const ADMIN_PAGE = 25;

export const MEMBERSHIP_STATUS_ORDER: MembershipStatus[] = ['active', 'pending', 'suspended', 'revoked'];
export const MEMBERSHIP_STATUS_LABEL: Record<MembershipStatus, string> = { pending: 'Pendente', active: 'Ativo', suspended: 'Suspenso', revoked: 'Revogado' };
const MEMBERSHIP_STATUS_TONE: Record<MembershipStatus, 'success' | 'warning' | 'neutral' | 'danger'> = {
  active: 'success',
  pending: 'neutral',
  suspended: 'warning',
  revoked: 'danger',
};

export const ACCOUNT_STATUS_LABEL: Record<Member['accountStatus'], string> = { pending: 'Pendente', active: 'Ativa', suspended: 'Suspensa', closed: 'Encerrada' };
const ACCOUNT_STATUS_TONE: Record<Member['accountStatus'], 'success' | 'warning' | 'neutral' | 'danger'> = {
  active: 'success',
  pending: 'neutral',
  suspended: 'warning',
  closed: 'danger',
};

export const GRANT_STATUS_ORDER: GrantStatus[] = ['active', 'pending', 'suspended', 'revoked'];
export const GRANT_STATUS_LABEL: Record<GrantStatus, string> = { pending: 'Pendente', active: 'Ativa', suspended: 'Suspensa', revoked: 'Revogada' };
const GRANT_STATUS_TONE: Record<GrantStatus, 'success' | 'warning' | 'neutral' | 'danger'> = {
  active: 'success',
  pending: 'neutral',
  suspended: 'warning',
  revoked: 'danger',
};

export function MembershipStatusBadge({ status }: { status: MembershipStatus }) {
  return (
    <Badge tone={MEMBERSHIP_STATUS_TONE[status]} size="sm">
      {MEMBERSHIP_STATUS_LABEL[status]}
    </Badge>
  );
}

export function AccountStatusBadge({ status }: { status: Member['accountStatus'] }) {
  return (
    <Badge tone={ACCOUNT_STATUS_TONE[status]} size="sm">
      {ACCOUNT_STATUS_LABEL[status]}
    </Badge>
  );
}

export function GrantStatusBadge({ status }: { status: GrantStatus }) {
  return (
    <Badge tone={GRANT_STATUS_TONE[status]} size="sm">
      {GRANT_STATUS_LABEL[status]}
    </Badge>
  );
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Parâmetros aceitos por uma tela: estados (repetíveis, de uma lista fechada) e identificadores únicos (UUID). */
export interface UrlFilterSpec<S extends string> {
  statuses: readonly S[];
  ids?: readonly string[];
}

/** Endereço canônico dos filtros: só estados da lista (na ordem dela, sem repetição) e UUIDs válidos. */
function normalize<S extends string>(spec: UrlFilterSpec<S>, raw: string) {
  const p = new URLSearchParams(raw);
  const chosen = spec.statuses.filter((s) => p.getAll('estado').includes(s));
  const values: Record<string, string | null> = {};
  for (const k of spec.ids ?? []) {
    const v = p.get(k);
    values[k] = v && UUID_RE.test(v) ? v.toLowerCase() : null;
  }
  return encode(spec, chosen, values);
}

function encode<S extends string>(spec: UrlFilterSpec<S>, statuses: readonly S[], ids: Record<string, string | null>): string {
  const out = new URLSearchParams();
  for (const s of spec.statuses) if (statuses.includes(s)) out.append('estado', s);
  for (const k of spec.ids ?? []) if (ids[k]) out.set(k, ids[k]!);
  return out.toString();
}

/**
 * Filtros na URL (recarga, voltar e link copiado reabrem a mesma lista). O endereço é normalizado: estados fora da
 * lista, repetidos ou identificadores malformados são descartados (com `replace`), para nunca virarem 400 da API por
 * causa de um link editado à mão. A ordem dos estados é a da lista da tela.
 *
 * O filtro em vigor é estado LOCAL espelhado na URL (como em Execuções): a URL do BrowserRouter muda depois do evento,
 * e um controle que dependesse só dela voltaria ao valor anterior entre o clique e a navegação. Mudança EXTERNA do
 * endereço (menu, voltar) — isto é, diferente da última escrita por esta tela — reabre os filtros a partir dela.
 */
export function useUrlFilters<S extends string>(spec: UrlFilterSpec<S>) {
  const [sp, setSp] = useSearchParams();
  const [current, setCurrent] = useState(() => normalize(spec, sp.toString()));
  /** Último endereço escrito por esta tela. */
  const written = useRef<string | null>(null);

  // a ordem importa: a detecção de mudança externa roda antes da escrita (mesmo padrão de Execuções)
  useEffect(() => {
    const raw = sp.toString();
    if (written.current !== null && raw !== written.current) setCurrent(normalize(spec, raw));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);

  useEffect(() => {
    written.current = current;
    if (current !== sp.toString()) setSp(new URLSearchParams(current), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const { statuses, ids } = useMemo(() => {
    const p = new URLSearchParams(current);
    const values: Record<string, string | null> = {};
    for (const k of spec.ids ?? []) values[k] = p.get(k);
    return { statuses: spec.statuses.filter((s) => p.getAll('estado').includes(s)), ids: values };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const normalized = current;
  const write = (nextStatuses: S[], nextIds: Record<string, string | null>) => setCurrent(encode(spec, nextStatuses, nextIds));

  return {
    statuses,
    ids,
    /** chave estável dos filtros em vigor (dependência da lista) */
    key: normalized,
    toggleStatus: (s: S, on: boolean) => write(on ? [...statuses, s] : statuses.filter((x) => x !== s), ids),
    setId: (k: string, v: string | null) => write(statuses, { ...ids, [k]: v }),
    clear: () => write([], {}),
  };
}

/** Grupo de caixas de estado (nenhuma marcada = todos). */
export function StatusFilter<S extends string>({
  legend,
  order,
  labels,
  selected,
  onToggle,
}: {
  legend: string;
  order: readonly S[];
  labels: Record<S, string>;
  selected: readonly S[];
  onToggle: (s: S, on: boolean) => void;
}) {
  return (
    <Fieldset legend={legend} variant="plain" description="Nenhum marcado = todos os estados." columns={4}>
      {order.map((s) => (
        <Checkbox key={s} label={labels[s]} checked={selected.includes(s)} onChange={(e) => onToggle(s, e.target.checked)} />
      ))}
    </Fieldset>
  );
}

/** A lista recusou o acesso (403): a tela não mostra dados nem ações; quem decide é a API. */
export const isForbidden = (e: unknown) => isApiError(e, 'forbidden');

/**
 * Acesso negado em QUALQUER página da lista (R1): na primeira página o hook fica em `error`; ao "carregar mais", ele
 * mantém `ready`, os itens anteriores e o erro. Nos dois casos a tela passa ao estado de acesso negado e esconde dados,
 * filtros e paginação. A trava só cai quando uma NOVA primeira leitura começa (`loading`, lista esvaziada pelo hook);
 * se essa leitura também for recusada, volta a negar. Assim os dados anteriores nunca reaparecem sem uma leitura
 * autorizada. Cursor recusado (400) e falha transitória continuam no tratamento próprio da lista; 401 segue o fluxo
 * de sessão expirada.
 */
export function useAccessDenied<T>(list: CursorList<T>): boolean {
  const denied = isForbidden(list.error);
  const [latched, setLatched] = useState(false);
  useEffect(() => {
    if (denied) setLatched(true);
    else if (list.status === 'loading') setLatched(false);
  }, [denied, list.status]);
  return denied || latched;
}

export function ForbiddenState({ area, onRetry }: { area: string; onRetry?: () => void }) {
  return (
    <StateView
      status="neutral"
      title={`Você não tem permissão para ver ${area}.`}
      description="O acesso a esta área depende das permissões da sua conta na organização. Se precisar, fale com um administrador."
      actions={
        onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Verificar novamente
          </Button>
        ) : undefined
      }
    />
  );
}

/** "Carregar mais" das listas administrativas, com falha e continuação recusada (cursor) tratadas como nas outras listas. */
export function AdminLoadMore<T>({ list, one, many }: { list: CursorList<T>; one: string; many: string }) {
  return (
    <LoadMore
      hasMore={list.hasMore}
      loading={list.status === 'loading-more'}
      onLoadMore={list.loadMore}
      count={list.items.length}
      itemLabel={list.items.length === 1 ? one : many}
      error={list.error && !isApiError(list.error, 'unauthenticated') ? `${errorText(list.error).title} A lista exibida continua válida.` : undefined}
      stale={list.cursorRejected ? 'A lista mudou desde a última página (ou a continuação expirou).' : undefined}
      onRestart={list.reload}
    />
  );
}
