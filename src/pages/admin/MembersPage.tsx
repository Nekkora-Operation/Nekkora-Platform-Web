import { useState } from 'react';
import { Button, Card, Stack, StateView, Table, type TableColumn } from 'nekkora-lib';
import { listMembers } from '../../api/admin';
import type { Member, MembershipStatus } from '../../api/v1';
import { useSession } from '../../area/session';
import { useCursorList } from '../../hooks/useCursorList';
import { DateTimeText, LoadErrorState, PageHeader, useExpiresOn } from '../product/shared';
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
 * Membros internos da organização (M01, exige `org.manage`), só leitura. Ordem do contrato: data de entrada no vínculo,
 * do mais antigo ao mais novo. Filtro de estado do vínculo na URL; paginação por cursor sem total.
 *
 * As ações (suspender, reativar, redefinir MFA) entram nas próximas missões (F6a-2 em diante). Contas externas não são
 * membros: aparecem só nas concessões.
 */
export function MembersPage() {
  const { org } = useSession();
  const filters = useUrlFilters<MembershipStatus>({ statuses: MEMBERSHIP_STATUS_ORDER });
  const [refresh, setRefresh] = useState(0);
  const list = useCursorList<Member>(
    (cursor) => listMembers(org, { limit: ADMIN_PAGE, cursor, status: filters.statuses.length ? [...filters.statuses] : undefined }),
    (m) => m.membershipId,
    [org, filters.key, refresh],
  );
  useExpiresOn(list.error);
  const forbidden = useAccessDenied(list);

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
          <AccountStatusBadge status={m.accountStatus} />
          {!m.emailVerified && <span className="pw-prod__muted">E-mail não confirmado</span>}
        </span>
      ),
    },
    { key: 'vinculo', header: 'Vínculo', render: (m) => <MembershipStatusBadge status={m.membershipStatus} /> },
    { key: 'mfa', header: 'MFA', render: (m) => (m.mfaConfigured ? 'Configurado' : <span className="pw-prod__muted">Não configurado</span>) },
    { key: 'desde', header: 'Membro desde', render: (m) => <DateTimeText iso={m.createdAt} /> },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Membros"
        subtitle="Pessoas da organização com conta interna. Somente consulta."
        onRefresh={forbidden ? undefined : () => setRefresh((n) => n + 1)}
        refreshing={list.status === 'loading' && refresh > 0}
      />
      {forbidden ? (
        <ForbiddenState area="os membros desta organização" onRetry={list.reload} />
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
    </Stack>
  );
}
