import { useState } from 'react';
import { Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { listAccessEvents, type AccessEvent } from '../../api/access';
import { useSession } from '../../area/session';
import { useCursorList } from '../../hooks/useCursorList';
import { AdminLoadMore, ForbiddenState, useAccessDenied } from '../admin/shared';
import { DateTimeText, LoadErrorState, PageHeader, useExpiresOn } from '../product/shared';
import { ROLE_LABEL } from './shared';

const TYPE_LABEL: Record<AccessEvent['type'], string> = {
  CONVITE_EMITIDO: 'Convite emitido',
  CONVITE_REVOGADO: 'Convite revogado',
  CONVITE_REENVIADO: 'Convite reenviado',
  CONVITE_ACEITO: 'Convite aceito',
  PAPEL_ATRIBUIDO: 'Papel atribuído',
  PAPEL_REVOGADO: 'Papel revogado',
  PAPEL_ALTERADO: 'Papel alterado',
  VINCULO_RETIRADO: 'Vínculo retirado',
  CONCESSAO_CRIADA: 'Concessão pedida',
  CONCESSAO_APROVADA: 'Concessão aprovada',
  CONCESSAO_RENOVADA: 'Renovação aprovada',
  CONCESSAO_REVISADA: 'Concessão revisada',
  CONCESSAO_REVOGADA: 'Concessão revogada',
  CONCESSAO_RENOVACAO_SOLICITADA: 'Renovação pedida',
};

const short = (v: string | null) => (v ? `${v.slice(0, 8)}…` : '—');

/**
 * /o/{org}/administracao/auditoria — atos de acesso, do mais recente ao mais antigo (org.manage). A API devolve só
 * identificadores e códigos (sem e-mail nem token): a tela não tenta completar com outras fontes.
 */
export function AccessEventsPage() {
  const { org } = useSession();
  const [refresh, setRefresh] = useState(0);
  const list = useCursorList<AccessEvent>((cursor) => listAccessEvents(org, { limit: 25, cursor }), (e) => e.eventId, [org, refresh]);
  const denied = useAccessDenied(list);
  useExpiresOn(list.error);

  if (denied) return <ForbiddenState area="a auditoria de acessos" onRetry={list.reload} />;

  const columns: TableColumn<AccessEvent>[] = [
    { key: 'quando', header: 'Quando', render: (e) => <DateTimeText iso={e.createdAt} /> },
    { key: 'ato', header: 'Ato', render: (e) => TYPE_LABEL[e.type] ?? e.type },
    {
      key: 'detalhe',
      header: 'Detalhe',
      render: (e) => (
        <Text variant="body-sm">
          {[
            e.role && `papel ${ROLE_LABEL[e.role] ?? e.role}`,
            e.previousRole && `antes ${ROLE_LABEL[e.previousRole] ?? e.previousRole}`,
            e.decision && `decisão ${e.decision}`,
            e.workspaceId && `workspace ${short(e.workspaceId)}`,
          ]
            .filter(Boolean)
            .join(' · ') || '—'}
        </Text>
      ),
    },
    { key: 'autor', header: 'Autor', render: (e) => (e.byInvitee ? 'A pessoa convidada' : <span title={e.actorUserId ?? ''}>{short(e.actorUserId)}</span>) },
    { key: 'alvo', header: 'Alvo', render: (e) => <span title={e.targetUserId ?? ''}>{short(e.targetUserId)}</span> },
  ];

  return (
    <Stack gap={5}>
      <PageHeader title="Auditoria de acessos" subtitle="Convites, papéis, vínculos e concessões registrados pela API." onRefresh={() => setRefresh((n) => n + 1)} />
      {list.status === 'loading' ? (
        <StateView status="loading" title="Carregando auditoria…" />
      ) : list.status === 'error' && list.items.length === 0 ? (
        <LoadErrorState error={list.error} onRetry={list.reload} />
      ) : list.items.length === 0 ? (
        <StateView status="neutral" title="Nenhum ato de acesso registrado ainda." />
      ) : (
        <>
          <div className="pw-prod__scroll" role="region" aria-label="Atos de acesso" tabIndex={0}>
            <Table columns={columns} data={list.items} rowKey="eventId" size="sm" caption="Atos de acesso, do mais recente ao mais antigo." />
          </div>
          <AdminLoadMore list={list} one="ato" many="atos" />
        </>
      )}
    </Stack>
  );
}
