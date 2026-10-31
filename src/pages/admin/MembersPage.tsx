import { useEffect, useRef, useState } from 'react';
import { Button, Card, Stack, StateView, StatusRegion, Table, Text, type TableColumn } from 'nekkora-lib';
import { listMembers } from '../../api/admin';
import { isApiError } from '../../api/http';
import type { Member, MembershipStatus } from '../../api/v1';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import {
  clearSettled,
  dismissWrite,
  isMemberEntry,
  isMfaEntry,
  rootError,
  targetRef,
  useWriteEntries,
  writeEntry,
  type MemberEntry,
  type MfaEntry,
  type WriteEntry,
} from '../../admin/writeStore';
import { useCursorList } from '../../hooks/useCursorList';
import { DateTimeText, LoadErrorState, PageHeader, RouteLink, useExpiresOn } from '../product/shared';
import { orgPath } from '../../auth/organization';
import type { MemberAccessNav } from '../access/MemberAccessPage';
import { ACTION_LABEL, effectiveStatus, findMember, MEMBER_UNCERTAIN_COPY, MemberActionDialog, type ActionDialogState } from './memberActions';
import { effectiveMfaConfigured, findMfa, MFA_UNCERTAIN_COPY, MfaResetDialog, mfaTarget, type MfaResetDialogState } from './mfaResetActions';
import { UncertainPanel, type UncertainCopy } from './uncertainPanel';
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

type MembersPageEntry = MemberEntry | MfaEntry;

/**
 * Membros internos da organização (M01, exige `org.manage`). Ordem do contrato: data de entrada no vínculo, do mais
 * antigo ao mais novo. Filtro de estado do vínculo na URL; paginação por cursor sem total.
 *
 * F6a-2: suspender e reativar (escritas do contrato 8.7, `org.manage`). As ações aparecem pela P01 (permissão), pelo
 * estado da conta e pela identidade (nunca sobre a própria conta); a API decide de qualquer forma. Envio, recusa,
 * resultado incerto e conferência ficam no registro de escritas (src/admin/writeStore.ts), que sobrevive à navegação.
 *
 * F6a-4: redefinir o MFA (`identity.mfa.reset`), com step-up TOTP imediatamente antes, no próprio diálogo. Registro
 * próprio (tipo `mfa`), separado da suspensão da mesma conta. Enquanto houver escrita em envio ou incerta numa conta, a
 * linha não oferece outra ação sobre ela.
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
  // registros de membros e de MFA de membros: concessões têm chave própria e não aparecem aqui
  const all = useWriteEntries(org);
  const entries = all.filter(isMemberEntry);
  const mfaEntries = all.filter(isMfaEntry);
  const byUser = new Map(entries.map((e) => [e.target.userId, e]));
  const mfaByUser = new Map(mfaEntries.map((e) => [e.target.userId, e]));
  const [dialog, setDialog] = useState<ActionDialogState | null>(null);
  const [mfaDialog, setMfaDialog] = useState<MfaResetDialogState | null>(null);
  const mfaOpenSeq = useRef(0);
  const [announce, setAnnounce] = useState<{ text: string; n: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Alvo do último diálogo aberto: o foco é devolvido DEPOIS de o diálogo fechar, quando o estado `dialog` já é nulo. */
  const focusTarget = useRef<string | null>(null);

  // lista relida do servidor (entrada na tela, filtros, Atualizar): concluídos e recusados deixam de sobrepor a leitura
  useEffect(() => {
    clearSettled(org, 'member');
    clearSettled(org, 'mfa');
  }, [org, filters.key, refresh]);

  const orgPermissions = permissions.status === 'ready' ? permissions.data.organization.permissions : [];
  const canManage = orgPermissions.includes('org.manage');
  const canReset = orgPermissions.includes('identity.mfa.reset');
  const self = permissions.status === 'ready' ? permissions.data.membershipId : null;

  // sessão expirada numa escrita (inclusive na confirmação de identidade): nada foi aplicado → fluxo de sessão expirada
  const isExpired = (e: WriteEntry) =>
    (e.phase === 'refused' && isApiError(rootError(e.error), 'unauthenticated')) || isApiError(rootError(e.refusedRetry), 'unauthenticated');
  const expiredEntry = [...entries, ...mfaEntries].find(isExpired);
  useEffect(() => {
    if (!expiredEntry) return;
    const { kind, id } = targetRef(expiredEntry.target);
    dismissWrite(org, id, kind);
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
  const mfaDialogEntry = mfaDialog ? mfaByUser.get(mfaDialog.target.userId) : undefined;
  useEffect(() => {
    if (!mfaDialog || mfaDialog.startedId === null || !mfaDialogEntry || mfaDialogEntry.id !== mfaDialog.startedId) return;
    if (mfaDialogEntry.phase === 'done') {
      setAnnounce((a) => ({ text: ACTION_LABEL['mfa-reset'].done(mfaDialog.target.displayName), n: (a?.n ?? 0) + 1 }));
      setMfaDialog(null);
    }
  }, [mfaDialog, mfaDialogEntry]);

  // acesso negado: nenhum diálogo, aviso ou ação fica disponível (o envio já iniciado continua no registro)
  useEffect(() => {
    if (!forbidden) return;
    setDialog(null);
    setMfaDialog(null);
  }, [forbidden]);

  const open = (action: ActionDialogState['action'], member: Member, retry = false) => {
    focusTarget.current = member.userId;
    setDialog({ action, member, retry, startedId: null });
  };
  const openMfa = (target: MfaResetDialogState['target'], retry = false) => {
    focusTarget.current = target.userId;
    setMfaDialog({ target, retry, startedId: null, openId: ++mfaOpenSeq.current });
  };
  const retryFrom = (e: MembersPageEntry) => {
    if (isMfaEntry(e)) return openMfa(e.target, true);
    const member = list.items.find((m) => m.userId === e.target.userId);
    open(e.action, member ?? ({ userId: e.target.userId, membershipId: e.target.membershipId, displayName: e.target.displayName } as Member), true);
  };

  const actionCell = (m: Member) => {
    const e = byUser.get(m.userId);
    const f = mfaByUser.get(m.userId);
    // uma escrita em envio ou incerta na conta: nenhuma outra ação sobre ela nesta linha
    if (e?.phase === 'sending' || f?.phase === 'sending') return <Text variant="body-sm" color="secondary">Enviando…</Text>;
    if (e?.phase === 'uncertain' || f?.phase === 'uncertain') return <Text variant="body-sm" color="secondary">Resultado não confirmado</Text>;
    if (m.membershipId === self) return <span className="pw-prod__muted">Sua conta</span>;
    const status = effectiveStatus(m, e);
    const accountAction = !canManage ? null : status === 'active' ? (
      <Button size="sm" variant="secondary" data-membro-acao={m.userId} aria-label={`Suspender ${m.displayName}`} onClick={() => open('suspend', m)}>
        Suspender
      </Button>
    ) : status === 'suspended' ? (
      <Button size="sm" variant="secondary" data-membro-acao={m.userId} aria-label={`Reativar ${m.displayName}`} onClick={() => open('reactivate', m)}>
        Reativar
      </Button>
    ) : null;
    const mfaAction =
      canReset && effectiveMfaConfigured(m, f) ? (
        <Button size="sm" variant="secondary" data-mfa-acao={m.userId} aria-label={`Redefinir MFA de ${m.displayName}`} onClick={() => openMfa(mfaTarget(m))}>
          Redefinir MFA
        </Button>
      ) : null;
    if (!accountAction && !mfaAction) return <span className="pw-prod__muted">—</span>;
    return (
      <span className="pw-admin__row-actions">
        {accountAction}
        {mfaAction}
      </span>
    );
  };

  const columns: TableColumn<Member>[] = [
    {
      key: 'pessoa',
      header: 'Pessoa',
      render: (m) => (
        <span className="pw-admin__person">
          {canManage ? (
            <RouteLink to={orgPath.memberAccess(org, m.userId)} state={{ displayName: m.displayName } satisfies MemberAccessNav} aria-label={`Acessos de ${m.displayName}`}>
              {m.displayName}
            </RouteLink>
          ) : (
            <span>{m.displayName}</span>
          )}
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
    {
      key: 'mfa',
      header: 'MFA',
      render: (m) => (effectiveMfaConfigured(m, mfaByUser.get(m.userId)) ? 'Configurado' : <span className="pw-prod__muted">Não configurado</span>),
    },
    { key: 'desde', header: 'Membro desde', render: (m) => <DateTimeText iso={m.createdAt} /> },
    ...(canManage || canReset ? [{ key: 'acoes', header: 'Ações', render: actionCell }] : []),
  ];

  const pending: MembersPageEntry[] = [...entries, ...mfaEntries].filter((e) => e.phase === 'uncertain' || (e.phase === 'sending' && e.retry));
  const copyFor = (e: MembersPageEntry) => (isMfaEntry(e) ? MFA_UNCERTAIN_COPY : MEMBER_UNCERTAIN_COPY) as UncertainCopy<MembersPageEntry>;
  const listRegion = () => document.querySelector<HTMLElement>('[aria-label="Lista de membros"]');

  return (
    <Stack gap={5}>
      <PageHeader
        title="Membros"
        subtitle={canManage || canReset ? 'Pessoas da organização com conta interna.' : 'Pessoas da organização com conta interna. Somente consulta.'}
        onRefresh={forbidden ? undefined : () => setRefresh((n) => n + 1)}
        refreshing={list.status === 'loading' && refresh > 0}
      />
      <StatusRegion aria-label="Resultado das ações" message={announce?.text} announceKey={announce?.n} />
      {!forbidden && (
        <UncertainPanel
          ref={panelRef}
          org={org}
          entries={pending}
          copy={copyFor}
          find={(e, interrupted) => (isMfaEntry(e) ? findMfa(org, e, interrupted) : findMember(org, e, interrupted))}
          onRetry={retryFrom}
          onDismiss={(e) => {
            const { kind, id } = targetRef(e.target);
            dismissWrite(org, id, kind);
          }}
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
      <MfaResetDialog
        org={org}
        dialog={forbidden ? null : mfaDialog}
        entry={mfaDialogEntry}
        onStarted={(id) => setMfaDialog((d) => (d ? { ...d, startedId: id } : d))}
        onClose={() => setMfaDialog(null)}
        // depois da redefinição o botão some (MFA não configurado): o foco vai à outra ação da mesma linha; com resultado
        // incerto, ao aviso; por último, à lista
        returnFocus={() => {
          const id = focusTarget.current;
          if (!id) return null;
          const own = document.querySelector<HTMLElement>(`[data-mfa-acao="${id}"]`);
          if (own) return own;
          if (writeEntry(org, id, 'mfa')?.phase === 'uncertain') return null;
          return document.querySelector<HTMLElement>(`[data-membro-acao="${id}"]`);
        }}
        fallbackFocus={() => {
          const id = focusTarget.current;
          if (id && writeEntry(org, id, 'mfa')?.phase === 'uncertain' && panelRef.current) return panelRef.current;
          return listRegion();
        }}
      />
    </Stack>
  );
}
