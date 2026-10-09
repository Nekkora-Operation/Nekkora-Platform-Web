import { useEffect, useRef, useState } from 'react';
import { Button, Card, Stack, StateView, StatusRegion, Table, Text, type TableColumn } from 'nekkora-lib';
import { listMembers } from '../../api/admin';
import { isApiError } from '../../api/http';
import type { Member, MembershipStatus } from '../../api/v1';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { clearSettled, dismissWrite, useWriteEntries, type WriteEntry } from '../../admin/writeStore';
import { useCursorList } from '../../hooks/useCursorList';
import { DateTimeText, LoadErrorState, PageHeader, useExpiresOn } from '../product/shared';
import { ACTION_LABEL, effectiveStatus, MemberActionDialog, UncertainPanel, type ActionDialogState } from './memberActions';
import {
  ADMIN_PAGE,
  AccountStatusBadge,
  AdminLoadMore,
  ForbiddenState,
  useAccessDenied,
  MEMBERSHIP_STATUS_LABEL,
  MEMBERSHIP_STATUS_ORDER,
  MembershipStatusBadge,
  StatusFilter,
  useUrlFilters,
} from './shared';
import './admin.css';

/**
 * Membros internos da organização (M01, exige `org.manage`). Ordem do contrato: data de entrada no vínculo, do mais
 * antigo ao mais novo. Filtro de estado do vínculo na URL; paginação por cursor sem total.
 *
 * F6a-2: suspender e reativar (escritas do contrato 8.7, `org.manage`). As ações aparecem pela P01 (permissão), pelo
 * estado da conta e pela identidade (nunca sobre a própria conta); a API decide de qualquer forma. Envio, recusa,
 * resultado incerto e conferência ficam no registro de escritas (src/admin/writeStore.ts), que sobrevive à navegação.
 */
export function MembersPage() {
  const { org, expired } = useSession();
  const { permissions } = useInternalArea();
  const filters = useUrlFilters<MembershipStatus>({ statuses: MEMBERSHIP_STATUS_ORDER });
  const [refresh, setRefresh] = useState(0);
  const list = useCursorList<Member>(
    (cursor) => listMembers(org, { limit: ADMIN_PAGE, cursor, status: filters.statuses.length ? [...filters.statuses] : undefined }),
    (m) => m.membershipId,
    [org, filters.key, refresh],
  );
  useExpiresOn(list.error);
  const listDenied = useAccessDenied(list);
  /**
   * Conferência recusada (403): acesso negado até uma NOVA leitura iniciada EXPLICITAMENTE pela pessoa ("Verificar
   * novamente") e concluída com autorização. Nenhuma leitura é feita sozinha (R2).
   */
  const [checkDenied, setCheckDenied] = useState(false);
  /** Leitura pedida pela pessoa no estado de acesso negado e ainda não concluída. */
  const [recheck, setRecheck] = useState(false);
  const forbidden = listDenied || checkDenied;
  useEffect(() => {
    if (!recheck || list.status !== 'ready') return;
    setRecheck(false);
    if (!list.error) setCheckDenied(false);
  }, [recheck, list.status, list.error]);
  const verifyAgain = () => {
    setRecheck(true);
    list.reload();
  };
  const entries = useWriteEntries(org);
  const byUser = new Map(entries.map((e) => [e.target.userId, e]));
  const [dialog, setDialog] = useState<ActionDialogState | null>(null);
  const [announce, setAnnounce] = useState<{ text: string; n: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Alvo do último diálogo aberto: o foco é devolvido DEPOIS de o diálogo fechar, quando o estado `dialog` já é nulo. */
  const focusTarget = useRef<string | null>(null);

  // lista relida do servidor (entrada na tela, filtros, Atualizar): concluídos e recusados deixam de sobrepor a leitura
  useEffect(() => clearSettled(org), [org, filters.key, refresh]);

  const canManage = permissions.status === 'ready' && permissions.data.organization.permissions.includes('org.manage');
  const self = permissions.status === 'ready' ? permissions.data.membershipId : null;

  // sessão expirada numa escrita: não foi aplicada (a sessão é validada antes dos efeitos) → fluxo de sessão expirada
  const expiredEntry = entries.find(
    (e) => (e.phase === 'refused' && isApiError(e.error, 'unauthenticated')) || isApiError(e.refusedRetry, 'unauthenticated'),
  );
  useEffect(() => {
    if (!expiredEntry) return;
    dismissWrite(org, expiredEntry.target.userId);
    expired();
  }, [expiredEntry, org, expired]);

  // concluído pelo envio deste diálogo: fecha e anuncia (a releitura da lista não é necessária para mostrar o 204)
  const dialogEntry = dialog ? byUser.get(dialog.member.userId) : undefined;
  useEffect(() => {
    if (!dialog || dialog.startedId === null || !dialogEntry || dialogEntry.id !== dialog.startedId) return;
    if (dialogEntry.phase === 'done') {
      setAnnounce((a) => ({ text: ACTION_LABEL[dialogEntry.action].done(dialog.member.displayName), n: (a?.n ?? 0) + 1 }));
      setDialog(null);
    }
  }, [dialog, dialogEntry]);

  // acesso negado: nenhum diálogo, aviso ou ação fica disponível (o envio já iniciado continua no registro)
  useEffect(() => {
    if (forbidden) setDialog(null);
  }, [forbidden]);

  const open = (action: ActionDialogState['action'], member: Member, retry = false) => {
    focusTarget.current = member.userId;
    setDialog({ action, member, retry, startedId: null });
  };
  const retryFrom = (e: WriteEntry) => {
    const member = list.items.find((m) => m.userId === e.target.userId);
    open(e.action, member ?? ({ userId: e.target.userId, membershipId: e.target.membershipId, displayName: e.target.displayName } as Member), true);
  };

  const actionCell = (m: Member) => {
    const e = byUser.get(m.userId);
    if (e?.phase === 'sending') return <Text variant="body-sm" color="secondary">Enviando…</Text>;
    if (e?.phase === 'uncertain') return <Text variant="body-sm" color="secondary">Resultado não confirmado</Text>;
    if (m.membershipId === self) return <span className="pw-prod__muted">Sua conta</span>;
    const status = effectiveStatus(m, e);
    if (status === 'active')
      return (
        <Button size="sm" variant="secondary" data-membro-acao={m.userId} aria-label={`Suspender ${m.displayName}`} onClick={() => open('suspend', m)}>
          Suspender
        </Button>
      );
    if (status === 'suspended')
      return (
        <Button size="sm" variant="secondary" data-membro-acao={m.userId} aria-label={`Reativar ${m.displayName}`} onClick={() => open('reactivate', m)}>
          Reativar
        </Button>
      );
    return <span className="pw-prod__muted">—</span>;
  };

  const columns: TableColumn<Member>[] = [
    {
      key: 'pessoa',
      header: 'Pessoa',
      render: (m) => (
        <span className="pw-admin__person">
          <span>{m.displayName}</span>
          <span className="pw-prod__muted">{m.email}</span>
        </span>
      ),
    },
    {
      key: 'papel',
      header: 'Papel na organização',
      render: (m) =>
        m.organizationRoles.includes('ORG_ADMIN') ? 'Administração da organização' : <span className="pw-prod__muted">Sem papel organizacional</span>,
    },
    {
      key: 'conta',
      header: 'Conta',
      render: (m) => (
        <span className="pw-admin__person">
          <AccountStatusBadge status={effectiveStatus(m, byUser.get(m.userId))} />
          {!m.emailVerified && <span className="pw-prod__muted">E-mail não confirmado</span>}
        </span>
      ),
    },
    { key: 'vinculo', header: 'Vínculo', render: (m) => <MembershipStatusBadge status={m.membershipStatus} /> },
    { key: 'mfa', header: 'MFA', render: (m) => (m.mfaConfigured ? 'Configurado' : <span className="pw-prod__muted">Não configurado</span>) },
    { key: 'desde', header: 'Membro desde', render: (m) => <DateTimeText iso={m.createdAt} /> },
    ...(canManage ? [{ key: 'acoes', header: 'Ações', render: actionCell }] : []),
  ];

  const pending = entries.filter((e) => e.phase === 'uncertain' || (e.phase === 'sending' && e.retry));
  const listRegion = () => document.querySelector<HTMLElement>('[aria-label="Lista de membros"]');

  return (
    <Stack gap={5}>
      <PageHeader
        title="Membros"
        subtitle={canManage ? 'Pessoas da organização com conta interna.' : 'Pessoas da organização com conta interna. Somente consulta.'}
        onRefresh={forbidden ? undefined : () => setRefresh((n) => n + 1)}
        refreshing={list.status === 'loading' && refresh > 0}
      />
      <StatusRegion aria-label="Resultado das ações" message={announce?.text} announceKey={announce?.n} />
      {!forbidden && (
        <UncertainPanel
          ref={panelRef}
          org={org}
          entries={pending}
          onRetry={retryFrom}
          onDismiss={(e) => dismissWrite(org, e.target.userId)}
          onUnauthenticated={expired}
          onForbidden={() => setCheckDenied(true)}
        />
      )}
      {forbidden ? (
        <ForbiddenState area="os membros desta organização" onRetry={verifyAgain} />
      ) : (
        <>
          <Card variant="surface" padding="md">
            <form aria-label="Filtros de membros" onSubmit={(e) => e.preventDefault()}>
              <StatusFilter
                legend="Estado do vínculo"
                order={MEMBERSHIP_STATUS_ORDER}
                labels={MEMBERSHIP_STATUS_LABEL}
                selected={filters.statuses}
                onToggle={filters.toggleStatus}
              />
            </form>
          </Card>
          {list.status === 'loading' ? (
            <StateView status="loading" title="Carregando membros…" />
          ) : list.status === 'error' ? (
            <LoadErrorState error={list.error} onRetry={list.reload} />
          ) : list.items.length === 0 ? (
            <StateView
              status="neutral"
              title={filters.statuses.length ? 'Nenhum membro com esses estados.' : 'Nenhum membro encontrado.'}
              actions={filters.statuses.length ? <Button variant="secondary" size="sm" onClick={filters.clear}>Limpar filtros</Button> : undefined}
            />
          ) : (
            <>
              <div className="pw-prod__scroll" role="region" aria-label="Lista de membros" tabIndex={0}>
                <Table columns={columns} data={list.items} rowKey="membershipId" size="sm" caption="Membros, do vínculo mais antigo ao mais novo." />
              </div>
              <AdminLoadMore list={list} one="membro" many="membros" />
            </>
          )}
        </>
      )}
      <MemberActionDialog
        org={org}
        dialog={forbidden ? null : dialog}
        entry={dialogEntry}
        onStarted={(id) => setDialog((d) => (d ? { ...d, startedId: id } : d))}
        onClose={() => setDialog(null)}
        // o botão de origem muda (Suspender → Reativar) ou some (resultado incerto): o foco vai ao botão novo da mesma
        // linha; sem ele, ao aviso de resultados não confirmados; por último, à lista
        returnFocus={() => (focusTarget.current ? document.querySelector<HTMLElement>(`[data-membro-acao="${focusTarget.current}"]`) : null)}
        fallbackFocus={() => panelRef.current ?? listRegion()}
      />
    </Stack>
  );
}
