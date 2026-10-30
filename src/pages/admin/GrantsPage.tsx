import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Grid, Select, Stack, StateView, StatusRegion, Table, Text, type TableColumn } from 'nekkora-lib';
import { GrantDecisionButtons, GrantDecisionDialog, type GrantDecision } from '../access/grantDecisions';
import { listClientGrants, listClients } from '../../api/admin';
import { isApiError } from '../../api/http';
import type { ClientGrant, GrantStatus } from '../../api/v1';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { clearSettled, dismissWrite, isGrantEntry, useWriteEntries, writeEntry, type GrantEntry } from '../../admin/writeStore';
import { useCursorList } from '../../hooks/useCursorList';
import { useResource } from '../../hooks/useResource';
import { DateTimeText, errorOf, LoadErrorState, PageHeader, RouteLink, useExpiresOn } from '../product/shared';
import {
  effectiveGrantStatus,
  findGrant,
  GRANT_UNCERTAIN_COPY,
  grantLabel,
  grantTarget,
  REVOCABLE,
  RevokeGrantDialog,
  type RevokeDialogState,
} from './grantActions';
import {
  ADMIN_PAGE,
  AdminLoadMore,
  ForbiddenState,
  GRANT_STATUS_LABEL,
  GRANT_STATUS_ORDER,
  GrantStatusBadge,
  useAccessDenied,
  StatusFilter,
  useUrlFilters,
} from './shared';
import { UncertainPanel } from './uncertainPanel';
import './admin.css';

/** Valor explícito de "todos" (o Select da lib pinta o vazio como placeholder). */
const ALL = 'todos';
/** Clientes carregados para o filtro (máximo do contrato numa página). */
const CLIENT_OPTIONS_LIMIT = 100;

/**
 * Concessões de acesso externo (M02, `external_access.manage`), da mais recente para a mais antiga. Filtros na URL:
 * estado (vários), cliente e workspace. Cliente ou workspace inexistente ou de outra organização dá lista vazia (exceção
 * documentada DC-05), não erro.
 *
 * F6a-3: revogar (contrato 8.7, `external_access.manage`). A ação aparece pela P01 e pelo estado (não revogada); a API
 * decide de qualquer forma. Só o 204 é sucesso (inclusive para concessão já revogada). Envio, recusa, resultado incerto e
 * conferência ficam no registro de escritas, com chave própria de concessão (não colide com membros).
 */


export function GrantsPage() {
  const { org, expired } = useSession();
  const { workspaces, permissions } = useInternalArea();
  const filters = useUrlFilters<GrantStatus>({ statuses: GRANT_STATUS_ORDER, ids: ['cliente', 'workspace'] });
  const clientId = filters.ids.cliente;
  const workspaceId = filters.ids.workspace;
  const [refresh, setRefresh] = useState(0);
  const list = useCursorList<ClientGrant>(
    (cursor) =>
      listClientGrants(org, {
        limit: ADMIN_PAGE,
        cursor,
        status: filters.statuses.length ? [...filters.statuses] : undefined,
        clientId: clientId ?? undefined,
        workspaceId: workspaceId ?? undefined,
      }),
    (g) => g.grantId,
    [org, filters.key, refresh],
  );
  const clients = useResource(() => listClients(org, { limit: CLIENT_OPTIONS_LIMIT }), [org]);
  useExpiresOn(list.error, errorOf(clients));
  const listDenied = useAccessDenied(list);
  /**
   * Conferência recusada (403): acesso negado até uma NOVA leitura iniciada EXPLICITAMENTE pela pessoa ("Verificar
   * novamente") e concluída com autorização. Nenhuma leitura é feita sozinha.
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
  // só registros de concessões: membros têm chave própria e não aparecem aqui
  const entries = useWriteEntries(org).filter(isGrantEntry);
  const byGrant = new Map(entries.map((e) => [e.target.grantId, e]));
  const [dialog, setDialog] = useState<RevokeDialogState | null>(null);
  const [announce, setAnnounce] = useState<{ text: string; n: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Alvo do último diálogo aberto: o foco é devolvido DEPOIS de o diálogo fechar, quando o estado `dialog` já é nulo. */
  const focusTarget = useRef<string | null>(null);

  // lista relida do servidor (entrada na tela, filtros, Atualizar): concluídos e recusados deixam de sobrepor a leitura
  useEffect(() => clearSettled(org, 'grant'), [org, filters.key, refresh]);

  const canManage = permissions.status === 'ready' && permissions.data.organization.permissions.includes('external_access.manage');
  // M2 (024): decisões além da revogação — aprovar, pedir/aprovar renovação, revisar, pedir de novo
  const [decision, setDecision] = useState<{ grant: ClientGrant; decision: GrantDecision } | null>(null);
  const [decisionNotice, setDecisionNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  /**
   * Concessões com decisão de resultado desconhecido: os botões de decisão da linha não voltam até a pessoa reler a
   * lista por "Atualizar" (a leitura automática mostra o estado, mas não é a conferência da pessoa).
   */
  const [uncertainDecisions, setUncertainDecisions] = useState<ReadonlySet<string>>(new Set());

  // sessão expirada numa escrita: não foi aplicada (a sessão é validada antes dos efeitos) → fluxo de sessão expirada
  const expiredEntry = entries.find(
    (e) => (e.phase === 'refused' && isApiError(e.error, 'unauthenticated')) || isApiError(e.refusedRetry, 'unauthenticated'),
  );
  useEffect(() => {
    if (!expiredEntry) return;
    dismissWrite(org, expiredEntry.target.grantId, 'grant');
    expired();
  }, [expiredEntry, org, expired]);

  // concluído pelo envio deste diálogo: fecha e anuncia (a releitura da lista não é necessária para mostrar o 204)
  const dialogEntry = dialog ? byGrant.get(dialog.target.grantId) : undefined;
  useEffect(() => {
    if (!dialog || dialog.startedId === null || !dialogEntry || dialogEntry.id !== dialog.startedId) return;
    if (dialogEntry.phase === 'done') {
      setAnnounce((a) => ({ text: `Concessão de ${grantLabel(dialog.target)} revogada.`, n: (a?.n ?? 0) + 1 }));
      setDialog(null);
    }
  }, [dialog, dialogEntry]);

  // acesso negado: nenhum diálogo, aviso ou ação fica disponível (o envio já iniciado continua no registro)
  useEffect(() => {
    if (forbidden) setDialog(null);
  }, [forbidden]);

  const open = (target: RevokeDialogState['target'], retry = false) => {
    focusTarget.current = target.grantId;
    setDialog({ target, retry, startedId: null });
  };
  const retryFrom = (e: GrantEntry) => open(e.target, true);

  const actionCell = (g: ClientGrant) => {
    const e = byGrant.get(g.grantId);
    if (e?.phase === 'sending') return <Text variant="body-sm" color="secondary">Enviando…</Text>;
    if (e?.phase === 'uncertain') return <Text variant="body-sm" color="secondary">Resultado não confirmado</Text>;
    const decisions =
      e?.phase === 'done' ? null : uncertainDecisions.has(g.grantId) ? (
        <Text variant="body-sm" color="secondary">
          Decisão não confirmada
        </Text>
      ) : (
        <GrantDecisionButtons grant={g} onPick={(d) => setDecision({ grant: g, decision: d })} />
      );
    if (!REVOCABLE.includes(effectiveGrantStatus(g, e))) return decisions ?? <span className="pw-prod__muted">—</span>;
    return (
      <span className="pw-admin__row-actions">
      {decisions}
      <Button
        size="sm"
        variant="secondary"
        data-concessao-acao={g.grantId}
        aria-label={`Revogar a concessão de ${grantLabel(grantTarget(g))}`}
        onClick={() => open(grantTarget(g))}
      >
        Revogar
      </Button>
      </span>
    );
  };

  // revogação confirmada numa lista filtrada sem "Revogada": a linha deixa de corresponder ao filtro e sai da vista
  const visible = filters.statuses.length
    ? list.items.filter((g) => filters.statuses.includes(effectiveGrantStatus(g, byGrant.get(g.grantId))))
    : list.items;
  /**
   * Fim CONFIRMADO da lista: sem próxima página e sem continuação recusada. Com o cursor recusado o hook também zera a
   * próxima página (hasMore=false), mas a lista não terminou: o aviso e o recomeço manual continuam disponíveis.
   */
  const listEnded = !list.hasMore && !list.cursorRejected;
  const anyFilter = filters.statuses.length > 0 || !!clientId || !!workspaceId;

  const clientItems = clients.status === 'ready' ? clients.data.items : [];
  const clientOptions = [
    { value: ALL, label: 'Todos os clientes' },
    ...clientItems.map((c) => ({ value: c.clientId, label: c.name })),
    // cliente vindo do endereço e fora da parte carregada
    ...(clientId && !clientItems.some((c) => c.clientId === clientId) ? [{ value: clientId, label: `Cliente ${clientId.slice(0, 8)}` }] : []),
  ];
  const wsOptions = [
    { value: ALL, label: 'Todos os workspaces' },
    ...workspaces.items.map((w) => ({ value: w.workspaceId, label: w.name })),
    ...(workspaceId && !workspaces.items.some((w) => w.workspaceId === workspaceId) ? [{ value: workspaceId, label: `Workspace ${workspaceId.slice(0, 8)}` }] : []),
  ];

  const columns: TableColumn<ClientGrant>[] = [
    {
      key: 'conta',
      header: 'Conta externa',
      render: (g) => (
        <span className="pw-admin__person">
          {/* destino do foco depois da revogação, quando o botão da linha some */}
          <span className="pw-admin__row-anchor" tabIndex={-1} data-concessao-linha={g.grantId}>
            {g.externalAccount.displayName}
          </span>
          <span className="pw-prod__muted">{g.externalAccount.email}</span>
        </span>
      ),
    },
    { key: 'cliente', header: 'Cliente', render: (g) => g.client.name },
    { key: 'workspace', header: 'Workspace', render: (g) => <RouteLink to={orgPath.workspace(org, g.workspace.workspaceId)}>{g.workspace.name}</RouteLink> },
    {
      key: 'estado',
      header: 'Estado',
      render: (g) => (
        <span className="pw-admin__person">
          <GrantStatusBadge status={effectiveGrantStatus(g, byGrant.get(g.grantId))} />
          {g.revokedAt && (
            <span className="pw-prod__muted">
              em <DateTimeText iso={g.revokedAt} />
            </span>
          )}
        </span>
      ),
    },
    { key: 'inicio', header: 'Início', render: (g) => <DateTimeText iso={g.startsAt} /> },
    { key: 'expira', header: 'Expira em', render: (g) => <DateTimeText iso={g.expiresAt} empty={<span>Sem expiração</span>} /> },
    { key: 'revisao', header: 'Próxima revisão', render: (g) => <DateTimeText iso={g.nextReviewAt} /> },
    { key: 'acesso', header: 'Último acesso', render: (g) => <DateTimeText iso={g.lastAccessAt} empty={<span>Nunca acessou</span>} /> },
    ...(canManage ? [{ key: 'acoes', header: 'Ações', render: actionCell }] : []),
  ];

  const pending = entries.filter((e) => e.phase === 'uncertain' || (e.phase === 'sending' && e.retry));
  const listRegion = () => document.querySelector<HTMLElement>('[aria-label="Lista de concessões"]');

  return (
    <Stack gap={5}>
      <PageHeader
        title="Concessões"
        subtitle={
          canManage
            ? 'Acessos de contas externas aos workspaces dos clientes.'
            : 'Acessos de contas externas aos workspaces dos clientes. Somente consulta.'
        }
        onRefresh={
          forbidden
            ? undefined
            : () => {
                setUncertainDecisions(new Set());
                setRefresh((n) => n + 1);
              }
        }
        refreshing={list.status === 'loading' && refresh > 0}
      />
      <StatusRegion aria-label="Resultado das ações" message={announce?.text} announceKey={announce?.n} />
      {!forbidden && (
        <UncertainPanel
          ref={panelRef}
          org={org}
          entries={pending}
          copy={GRANT_UNCERTAIN_COPY}
          find={(e, interrupted) => findGrant(org, e, interrupted)}
          onRetry={retryFrom}
          onDismiss={(e) => dismissWrite(org, e.target.grantId, 'grant')}
          onUnauthenticated={expired}
          onForbidden={() => setCheckDenied(true)}
        />
      )}
      {forbidden ? (
        <ForbiddenState area="as concessões desta organização" onRetry={verifyAgain} />
      ) : (
        <>
          <Card variant="surface" padding="md">
            <form className="pw-admin__filters" aria-label="Filtros de concessões" onSubmit={(e) => e.preventDefault()}>
              <Grid columns={2} minColumnWidth="220px" gap={4}>
                <Select
                  label="Cliente"
                  value={clientId ?? ALL}
                  onChange={(e) => filters.setId('cliente', e.target.value === ALL ? null : e.target.value)}
                  disabled={clients.status === 'loading'}
                  hint={
                    clients.status === 'loading'
                      ? 'Carregando clientes…'
                      : clients.status === 'error'
                        ? 'Não foi possível carregar a lista de clientes.'
                        : clients.data.nextCursor
                          ? `Mostrando os ${CLIENT_OPTIONS_LIMIT} primeiros clientes.`
                          : undefined
                  }
                  options={clientOptions}
                  fullWidth
                />
                <Select
                  label="Workspace"
                  value={workspaceId ?? ALL}
                  onChange={(e) => filters.setId('workspace', e.target.value === ALL ? null : e.target.value)}
                  disabled={workspaces.status === 'loading'}
                  hint={
                    workspaces.status === 'loading'
                      ? 'Carregando workspaces…'
                      : workspaces.status === 'error'
                        ? 'Não foi possível carregar a lista de workspaces.'
                        : workspaces.status === 'ready' && !workspaces.complete
                          ? 'Mostrando a parte já carregada dos workspaces.'
                          : undefined
                  }
                  options={wsOptions}
                  fullWidth
                />
              </Grid>
              <StatusFilter legend="Estado" order={GRANT_STATUS_ORDER} labels={GRANT_STATUS_LABEL} selected={filters.statuses} onToggle={filters.toggleStatus} />
            </form>
          </Card>
          {list.status === 'loading' ? (
            <StateView status="loading" title="Carregando concessões…" />
          ) : list.status === 'error' ? (
            <LoadErrorState error={list.error} onRetry={list.reload} />
          ) : visible.length === 0 && listEnded ? (
            // lista ENCERRADA (fim confirmado pela API) e nada visível
            <StateView
              status="neutral"
              title={anyFilter ? 'Nenhuma concessão com esses filtros.' : 'Nenhuma concessão registrada.'}
              actions={anyFilter ? <Button variant="secondary" size="sm" onClick={filters.clear}>Limpar filtros</Button> : undefined}
            />
          ) : (
            <>
              {visible.length === 0 ? (
                // nada visível ENTRE AS CARREGADAS e a lista NÃO terminou (há próxima página ou a continuação foi recusada):
                // a continuação ou o recomeço ficam disponíveis no AdminLoadMore, sem nenhuma leitura automática
                <div className="pw-admin__partial-empty" role="region" aria-label="Lista de concessões" tabIndex={0}>
                  <Text>Nenhuma concessão com esses filtros entre as carregadas até agora.</Text>
                  <Text variant="body-sm" color="secondary">
                    {list.cursorRejected
                      ? 'Não foi possível continuar a lista. Recomece para ver as demais.'
                      : 'A lista continua: use “Carregar mais” para ver as próximas.'}
                  </Text>
                </div>
              ) : (
                <div className="pw-prod__scroll" role="region" aria-label="Lista de concessões" tabIndex={0}>
                  <Table columns={columns} data={visible} rowKey="grantId" size="sm" caption="Concessões, da mais recente para a mais antiga." />
                </div>
              )}
              <AdminLoadMore list={list} count={visible.length} one="concessão" many="concessões" />
            </>
          )}
        </>
      )}
      {decisionNotice && <Alert tone={decisionNotice.tone}>{decisionNotice.text}</Alert>}
      <GrantDecisionDialog
        org={org}
        grant={forbidden ? null : (decision?.grant ?? null)}
        decision={decision?.decision ?? null}
        onClose={() => setDecision(null)}
        onDone={(text) => {
          setDecision(null);
          setDecisionNotice({ tone: 'success', text });
          setRefresh((n) => n + 1);
        }}
        onUncertain={() => {
          const id = decision?.grant.grantId;
          if (id) setUncertainDecisions((s) => new Set(s).add(id));
          setDecisionNotice({ tone: 'warning', text: 'O resultado da última decisão não foi confirmado. Atualize a lista e confira antes de decidir de novo.' });
          setRefresh((n) => n + 1);
        }}
        onUnauthenticated={expired}
        onRefused={() => setRefresh((n) => n + 1)}
      />
      <RevokeGrantDialog
        org={org}
        dialog={forbidden ? null : dialog}
        entry={dialogEntry}
        onStarted={(id) => setDialog((d) => (d ? { ...d, startedId: id } : d))}
        onClose={() => setDialog(null)}
        // o botão de origem some depois da revogação (ou com resultado incerto): o foco vai à própria linha; com
        // resultado incerto, ao aviso; se a linha saiu da vista pelo filtro, à lista; por último, ao <main> (padrão)
        returnFocus={() => {
          const id = focusTarget.current;
          if (!id) return null;
          const button = document.querySelector<HTMLElement>(`[data-concessao-acao="${id}"]`);
          if (button) return button;
          if (writeEntry(org, id, 'grant')?.phase === 'uncertain') return null;
          return document.querySelector<HTMLElement>(`[data-concessao-linha="${id}"]`);
        }}
        fallbackFocus={() => {
          const id = focusTarget.current;
          if (id && writeEntry(org, id, 'grant')?.phase === 'uncertain' && panelRef.current) return panelRef.current;
          return listRegion();
        }}
      />
    </Stack>
  );
}
