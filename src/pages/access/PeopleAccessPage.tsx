import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { Stack } from 'nekkora-lib';
import { useSearchParams } from 'react-router';
import { useInternalArea } from '../../area/InternalShell';
import { PageHeader } from '../product/shared';
import { AccessHistoryPage } from './AccessHistoryPage';
import { PeoplePage } from './PeoplePage';

export type PeopleAccessTab = 'pessoas' | 'compartilhamentos' | 'historico';

/**
 * O molde comum das abas: título, abas e painel. Cada aba o chama com o próprio "Atualizar" (nenhum quando a pessoa não tem
 * acesso àquela aba) — assim o estado de acesso negado e a atualização valem no mesmo instante em que a aba os conhece.
 */
export type PageFrame = (p: { onRefresh?: () => void; refreshing?: boolean; children: ReactNode }) => ReactElement;

/**
 * "Pessoas e acessos" (PLATFORM-FLUXO-002): uma página, um título e três abas no mesmo padrão de Execuções, com a aba no
 * endereço (`?aba=`):
 * - Pessoas: membros, convites e pessoas de cliente na MESMA tabela (o convite e "Gerenciar acessos" continuam nela);
 * - Compartilhamentos: os acessos de clientes (por automação e, do modelo anterior, por ambiente inteiro) e os pedidos de
 *   compartilhamento de membros para aprovar ou recusar;
 * - Histórico: os atos de acesso, com filtros.
 * Sem abas internas. Cada aba aparece para quem tem a permissão dela (Pessoas: org.manage; Compartilhamentos:
 * external_access.manage; Histórico: uma das duas); trocar de aba limpa os filtros da anterior.
 */
export function PeopleAccessPage() {
  const [sp, setSp] = useSearchParams();
  const { permissions } = useInternalArea();
  const perms = permissions.status === 'ready' ? permissions.data.organization.permissions : [];
  const canManage = perms.includes('org.manage');
  const canExternal = perms.includes('external_access.manage');
  const tabs: { id: PeopleAccessTab; label: string }[] = [
    ...(canManage || permissions.status !== 'ready' ? [{ id: 'pessoas' as const, label: 'Pessoas' }] : []),
    ...(canExternal ? [{ id: 'compartilhamentos' as const, label: 'Compartilhamentos' }] : []),
    ...(canManage || canExternal ? [{ id: 'historico' as const, label: 'Histórico' }] : []),
  ];
  const asked = sp.get('aba');
  const tab: PeopleAccessTab =
    tabs.find((t) => t.id === asked)?.id ?? (asked === 'historico' || asked === 'compartilhamentos' ? (asked as PeopleAccessTab) : tabs[0]?.id ?? 'pessoas');
  const go = (t: PeopleAccessTab) => setSp(t === 'pessoas' ? {} : { aba: t });
  // teclado: o foco vai para a aba escolhida DEPOIS que a nova aba foi montada (a barra é desenhada pela aba aberta)
  const focusAfter = useRef<PeopleAccessTab | null>(null);
  useEffect(() => {
    if (focusAfter.current !== tab) return;
    focusAfter.current = null;
    document.getElementById(`aba-${tab}`)?.focus();
  }, [tab]);

  const frame: PageFrame = ({ onRefresh, refreshing, children }) => (
    <Stack gap={5}>
      <PageHeader
        title="Pessoas e acessos"
        subtitle={
          tab === 'pessoas'
            ? 'Membros, convites e pessoas de clientes. Convites pendentes aparecem primeiro.'
            : tab === 'compartilhamentos'
              ? 'O que está compartilhado com pessoas de fora e os pedidos que aguardam aprovação.'
              : 'Quem fez cada ato de acesso, quando e com qual alcance. Somente consulta.'
        }
        onRefresh={onRefresh}
        refreshing={refreshing}
      />
      {tabs.length > 1 && (
        <div className="pw-exec__tabs" role="tablist" aria-label="Pessoas e acessos">
          {tabs.map((t, i) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`aba-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="painel-pessoas-acessos"
              tabIndex={tab === t.id ? 0 : -1}
              className={`pw-exec__tab${tab === t.id ? ' pw-exec__tab--active' : ''}`}
              onClick={() => go(t.id)}
              onKeyDown={(ev) => {
                if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
                const next = tabs[(i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id;
                focusAfter.current = next;
                go(next);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div id="painel-pessoas-acessos" role="tabpanel" aria-labelledby={tabs.length > 1 ? `aba-${tab}` : undefined}>
        {children}
      </div>
    </Stack>
  );

  return tab === 'pessoas' ? <PeoplePage frame={frame} /> : <AccessHistoryPage key={tab} tab={tab} frame={frame} />;
}
