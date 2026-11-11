import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { Alert, Badge, Button, Stack, Text } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { DateTimeText } from '../product/shared';

/**
 * PLATFORM-AGENT-V2-003, T11 — vínculo, comunicação e situação do Worker são TRÊS dimensões, sempre mostradas separadas:
 *  - vínculo: a situação do Agent na Platform (ACTIVE = vinculada; revogado só depois que uma pessoa revoga);
 *  - comunicação: o último contato AUTENTICADO, pelo relógio do servidor (a API diz CONNECTED só com o Agent ativo,
 *    vinculado e contato nos últimos 180 s; o Agent bate a cada 60 s);
 *  - situação do Worker: administrativa (ativo, suspenso, aposentado).
 * Offline não é desvinculado, nem execução encerrada. Falha ao consultar a API não vira offline: a tela mostra os dados da
 * última leitura como NÃO CONFIRMADOS.
 */

/** Releitura automática enquanto a página está visível (a API dá o estado; a tela não calcula conexão pelo relógio local). */
export const REFRESH_MS = 30_000;

type Status = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';

export const LINK: Record<Status, { label: string; tone: 'success' | 'warning' | 'neutral' | 'danger' }> = {
  ACTIVE: { label: 'Vinculada', tone: 'success' },
  PENDING: { label: 'Vínculo pendente', tone: 'neutral' },
  SUSPENDED: { label: 'Vínculo suspenso', tone: 'warning' },
  REVOKED: { label: 'Vínculo revogado', tone: 'danger' },
};

/** Explicação comum às duas listas (Workers e Máquinas vinculadas). */
export const PRESENCE_TEXT =
  'Vínculo e comunicação são coisas diferentes. Online quer dizer que a máquina fez contato com a Platform nos últimos 3 minutos (o Agent faz contato a cada minuto). Offline quer dizer que não há contato recente: não que a máquina foi desligada ou desvinculada, nem que uma execução terminou; a falta de contato não revoga a credencial, não libera o Worker e não retira workspaces. Desvincular no Agent não avisa a Platform: aqui a máquina continua vinculada, fica offline e só deixa de estar vinculada quando alguém revogar o vínculo. A lista se atualiza sozinha a cada 30 segundos enquanto a página está aberta.';

export const timeText = (at: number) => new Date(at).toLocaleTimeString('pt-BR');

export type Freshness = { fetchedAt: number | null; failure: { at: number; error: unknown } | null };

/** Vínculo da máquina (situação do Agent na Platform). */
export function LinkBadge({ status }: { status?: Status | null }) {
  if (!status) return null;
  return (
    <span>
      <Badge tone={LINK[status].tone}>{LINK[status].label}</Badge>
    </span>
  );
}

/**
 * Comunicação da máquina. Só se aplica com o vínculo ativo; sem nenhum contato, "ainda sem comunicação" (nunca online antes
 * do primeiro contato); com a última consulta falhando, "não confirmada", com o que a última leitura dizia.
 */
export function CommunicationCell({
  status,
  connectivity,
  lastHeartbeatAt,
  freshness,
}: {
  status?: Status | null;
  connectivity?: string | null;
  lastHeartbeatAt?: string | null;
  freshness: Freshness;
}) {
  const last = (
    <Text variant="body-sm" color="secondary">
      Último contato: <DateTimeText iso={lastHeartbeatAt ?? null} empty="nenhum" />
    </Text>
  );
  if (status !== 'ACTIVE')
    return (
      <Stack gap={1}>
        <Text variant="body-sm">{status === 'REVOKED' ? 'Não se aplica: vínculo revogado' : 'Não se aplica: vínculo não está ativo'}</Text>
        {lastHeartbeatAt && last}
      </Stack>
    );
  const said = !lastHeartbeatAt ? 'ainda sem comunicação' : connectivity === 'CONNECTED' ? 'online' : 'offline';
  if (freshness.failure && freshness.fetchedAt)
    return (
      <Stack gap={1}>
        <span>
          <Badge tone="warning">Não confirmada</Badge>
        </span>
        <Text variant="body-sm" color="secondary">
          Na leitura das {timeText(freshness.fetchedAt)}: {said}
        </Text>
        {last}
      </Stack>
    );
  return (
    <Stack gap={1}>
      <span>
        {!lastHeartbeatAt ? (
          <Badge tone="neutral">Ainda sem comunicação</Badge>
        ) : (
          <Badge tone={connectivity === 'CONNECTED' ? 'success' : 'neutral'} dot>
            {connectivity === 'CONNECTED' ? 'Online' : 'Offline'}
          </Badge>
        )}
      </span>
      {last}
    </Stack>
  );
}

/** Aviso de dados não confirmados (a última releitura falhou): nada é marcado offline por isso. */
export function FreshnessNotice({ freshness, onRetry }: { freshness: Freshness; onRetry: () => void }) {
  if (!freshness.fetchedAt) return null;
  if (!freshness.failure)
    return (
      <Text variant="body-sm" color="secondary" aria-live="off">
        Atualizado às {timeText(freshness.fetchedAt)}. A lista se atualiza sozinha a cada 30 segundos enquanto a página está aberta.
      </Text>
    );
  const limited = isApiError(freshness.failure.error, 'rate_limited');
  return (
    <Alert tone="warning" live="polite" title="Dados não confirmados">
      <Stack gap={2}>
        <span>
          {limited
            ? `Muitas consultas em pouco tempo: a Platform pediu para aguardar (às ${timeText(freshness.failure.at)}).`
            : `Não foi possível atualizar a lista às ${timeText(freshness.failure.at)}.`}{' '}
          Os dados abaixo são da leitura das {timeText(freshness.fetchedAt)} e a comunicação das máquinas não está confirmada. Nenhuma máquina foi
          considerada offline por causa disso; a próxima tentativa é automática.
        </span>
        <span>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Tentar agora
          </Button>
        </span>
      </Stack>
    </Alert>
  );
}

type ListState<T> = { status: 'loading' } | { status: 'ready'; items: T[] } | { status: 'error'; error: unknown };

/**
 * Lista com releitura automática: `load` mostra o carregamento (abertura, depois de um ato); a releitura (a cada
 * REFRESH_MS com a página visível, ao voltar para a aba ou em "Tentar agora") troca os itens só quando a API responde e,
 * se falhar, mantém os itens e marca a falha. Uma requisição por vez; nada com a aba oculta.
 */
export function useLiveList<T>(fetchItems: () => Promise<T[]>, deps: DependencyList, onUnauthenticated: () => void) {
  const [list, setList] = useState<ListState<T>>({ status: 'loading' });
  const [freshness, setFreshness] = useState<Freshness>({ fetchedAt: null, failure: null });
  const generation = useRef(0);
  const busy = useRef(false);
  const fetchedAt = useRef<number | null>(null);
  const fetchRef = useRef(fetchItems);
  fetchRef.current = fetchItems;
  const expiredRef = useRef(onUnauthenticated);
  expiredRef.current = onUnauthenticated;

  const load = useCallback(async () => {
    const gen = ++generation.current;
    busy.current = true;
    setList({ status: 'loading' });
    try {
      const items = await fetchRef.current();
      if (gen !== generation.current) return;
      fetchedAt.current = Date.now();
      setList({ status: 'ready', items });
      setFreshness({ fetchedAt: fetchedAt.current, failure: null });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expiredRef.current();
      setList({ status: 'error', error: e });
    } finally {
      if (gen === generation.current) busy.current = false;
    }
  }, deps);

  const refresh = useCallback(async () => {
    if (busy.current || fetchedAt.current === null) return;
    const gen = generation.current;
    busy.current = true;
    try {
      const items = await fetchRef.current();
      if (gen !== generation.current) return;
      fetchedAt.current = Date.now();
      setList({ status: 'ready', items });
      setFreshness({ fetchedAt: fetchedAt.current, failure: null });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expiredRef.current();
      setFreshness((f) => ({ ...f, failure: { at: Date.now(), error: e } }));
    } finally {
      if (gen === generation.current) busy.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
      busy.current = false;
    };
  }, [load]);

  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const timer = setInterval(() => {
      if (visible()) void refresh();
    }, REFRESH_MS);
    const onVisibility = () => {
      if (visible() && fetchedAt.current !== null && Date.now() - fetchedAt.current >= REFRESH_MS) void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  return { list, freshness, load, refresh };
}
