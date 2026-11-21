import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Fieldset, Input, Link, Select, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { Link as RouterLink } from 'react-router';
import { listPeople } from '../../api/access';
import { listClients } from '../../api/admin';
import {
  approveClientAutomationGrant,
  listAccessGrants,
  listAccessHistory,
  listClientShareOptions,
  revokeClientAutomationGrant,
  type AccessGrant,
  type AccessGrantSituation,
  type AccessHistoryCategory,
  type AccessHistoryEvent,
} from '../../api/clientAccess';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { StepUpDialog } from '../../components/StepUpDialog';
import { useCursorList } from '../../hooks/useCursorList';
import { DateTimeText, LoadErrorState, PageHeader, useExpiresOn } from '../product/shared';
import { ADMIN_PAGE, AdminLoadMore, ForbiddenState, useAccessDenied, useUrlFilters } from '../admin/shared';
import { clientRefusal, machineScopeText, permissionsText } from './clientShared';
import { orgStepUp, ROLE_LABEL } from './shared';
import './people.css';

const SITUATIONS: AccessGrantSituation[] = ['pending', 'active', 'suspended', 'revoked'];
const SITUATION_LABEL: Record<AccessGrantSituation, string> = { pending: 'Aguardando aprovação', active: 'Ativa', suspended: 'Suspensa', revoked: 'Revogada' };
const SITUATION_TONE: Record<AccessGrantSituation, 'info' | 'success' | 'warning' | 'neutral'> = { pending: 'info', active: 'success', suspended: 'warning', revoked: 'neutral' };
const CATEGORIES: AccessHistoryCategory[] = ['grants', 'invitations', 'client_links', 'clients', 'roles'];
const CATEGORY_LABEL: Record<AccessHistoryCategory, string> = {
  grants: 'Concessões',
  invitations: 'Convites',
  client_links: 'Vínculos de cliente',
  clients: 'Cadastro de clientes',
  roles: 'Perfis de membros',
};
const EVENT_LABEL: Record<AccessHistoryEvent['type'], string> = {
  CONVITE_EMITIDO: 'Convite emitido',
  CONVITE_REVOGADO: 'Convite revogado',
  CONVITE_REENVIADO: 'Convite reenviado',
  CONVITE_ACEITO: 'Convite aceito',
  PAPEL_ATRIBUIDO: 'Perfil atribuído',
  PAPEL_REVOGADO: 'Perfil revogado',
  PAPEL_ALTERADO: 'Perfil trocado',
  VINCULO_RETIRADO: 'Retirado da organização',
  CONCESSAO_CRIADA: 'Concessão de ambiente pedida',
  CONCESSAO_APROVADA: 'Concessão de ambiente aprovada',
  CONCESSAO_RENOVADA: 'Concessão de ambiente renovada',
  CONCESSAO_REVISADA: 'Concessão de ambiente revisada',
  CONCESSAO_REVOGADA: 'Concessão de ambiente revogada',
  CONCESSAO_RENOVACAO_SOLICITADA: 'Renovação pedida',
  CLIENTE_CONCESSAO_SOLICITADA: 'Compartilhamento pedido',
  CLIENTE_CONCESSAO_APROVADA: 'Compartilhamento aprovado',
  CLIENTE_CONCESSAO_APLICADA_NO_ACEITE: 'Compartilhamento aplicado no aceite',
  CLIENTE_CONCESSAO_REDUZIDA: 'Permissões reduzidas',
  CLIENTE_CONCESSAO_REVOGADA: 'Compartilhamento revogado',
  VINCULO_CLIENTE_SUSPENSO: 'Vínculo de cliente suspenso',
  VINCULO_CLIENTE_REATIVADO: 'Vínculo de cliente reativado',
  VINCULO_CLIENTE_RETIRADO: 'Vínculo de cliente retirado',
  CLIENTE_CADASTRADO: 'Cliente cadastrado',
  CLIENTE_ALTERADO: 'Cliente alterado',
};

type FilterKey = AccessGrantSituation | AccessHistoryCategory;
type Act = { kind: 'approve' | 'revoke'; grant: AccessGrant };

/** Data local (yyyy-mm-dd) → início do dia (de) ou início do dia seguinte (até, exclusivo), em ISO com fuso. */
const dayStart = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayAfter = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  const t = new Date(`${d}T00:00:00`);
  t.setDate(t.getDate() + 1);
  return t.toISOString();
};

/**
 * "Acessos e histórico" (PLATFORM-FLUXO-002, 070), aberto de "Pessoas e acessos". Duas abas, com os filtros no endereço:
 * - Concessões: os acessos de clientes, das duas espécies (por automação, 070; por ambiente inteiro, modelo anterior), com
 *   pessoa, cliente, ambiente de trabalho, automação, restrição por máquina e permissões. Pedido pendente: aprovar (outra
 *   pessoa, confirmação da hora) ou cancelar; ativa: revogar. A concessão por ambiente inteiro continua com as decisões de
 *   antes, na página própria. "Ver histórico" abre a outra aba filtrada pela concessão (também revogada).
 * - Histórico: somente consulta — responsável, data, alvo e mudanças, inclusive o uso da exceção do convite de Cliente.
 *   Quem só gerencia acesso de clientes vê só os atos de cliente; a auditoria inteira continua com quem administra.
 */
export function AccessHistoryPage() {
  const { org, expired } = useSession();
  const { workspaces, permissions } = useInternalArea();
  const filters = useUrlFilters<FilterKey>({
    statuses: [...SITUATIONS, ...CATEGORIES],
    ids: ['pessoa', 'cliente', 'workspace', 'automacao', 'maquina', 'concessao'],
    texts: ['aba', 'de', 'ate'],
  });
  const tab = filters.ids.aba === 'historico' ? 'historico' : 'concessoes';
  const situations = filters.statuses.filter((s): s is AccessGrantSituation => (SITUATIONS as string[]).includes(s));
  const categories = filters.statuses.filter((s): s is AccessHistoryCategory => (CATEGORIES as string[]).includes(s));
  const [refresh, setRefresh] = useState(0);
  const common = {
    personId: filters.ids.pessoa ?? undefined,
    clientId: filters.ids.cliente ?? undefined,
    workspaceId: filters.ids.workspace ?? undefined,
    automationId: filters.ids.automacao ?? undefined,
    workerId: filters.ids.maquina ?? undefined,
    from: dayStart(filters.ids.de ?? ''),
    to: dayAfter(filters.ids.ate ?? ''),
  };
  const deps = [org, tab, filters.key, refresh];
  const grants = useCursorList<AccessGrant>(
    (cursor) =>
      tab === 'concessoes'
        ? listAccessGrants(org, { ...common, situation: situations.length ? situations : undefined, cursor, limit: ADMIN_PAGE })
        : Promise.resolve({ items: [], nextCursor: null }),
    (g) => g.grantId,
    deps,
  );
  const [scope, setScope] = useState<'all' | 'client_access' | null>(null);
  const history = useCursorList<AccessHistoryEvent>(
    async (cursor) => {
      if (tab !== 'historico') return { items: [], nextCursor: null };
      const page = await listAccessHistory(org, {
        ...common,
        grantId: filters.ids.concessao ?? undefined,
        category: categories.length ? categories : undefined,
        cursor,
        limit: ADMIN_PAGE,
      });
      setScope(page.scope);
      return page;
    },
    (e) => e.eventId,
    deps,
  );
  const list = tab === 'concessoes' ? grants : history;
  useExpiresOn(list.error);
  const forbidden = useAccessDenied(list as typeof grants);
  const perms = permissions.status === 'ready' ? permissions.data.organization.permissions : [];
  const canAct = perms.includes('external_access.manage');

  // opções dos filtros (cada uma pode faltar por permissão: o filtro some, a lista continua)
  const [clients, setClients] = useState<{ value: string; label: string }[]>([]);
  const [automations, setAutomations] = useState<{ value: string; label: string; machines: { workerId: string; name: string }[] }[]>([]);
  const [people, setPeople] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    let alive = true;
    listClients(org, { limit: 100 }).then((p) => alive && setClients(p.items.map((c) => ({ value: c.clientId, label: c.name }))), () => undefined);
    listClientShareOptions(org).then(
      (o) => alive && setAutomations(o.automations.map((a) => ({ value: a.automationId, label: `${a.name} · ${a.workspaceName}`, machines: a.machines }))),
      () => undefined,
    );
    listPeople(org, { limit: 100 }).then(
      (p) =>
        alive &&
        setPeople(
          p.items
            .map((x) => (x.member ? { value: x.member.userId, label: `${x.member.displayName} (${x.member.email})` } : x.client ? { value: x.client.userId, label: `${x.client.displayName} (${x.client.email}) · cliente` } : null))
            .filter((x): x is { value: string; label: string } => !!x),
        ),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [org]);
  const machines = [...new Map(automations.flatMap((a) => a.machines).map((m) => [m.workerId, m.name]))].map(([value, label]) => ({ value, label }));

  const [act, setAct] = useState<Act | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const setTab = (t: 'concessoes' | 'historico') => {
    filters.setText('aba', t === 'historico' ? 'historico' : '');
  };
  const showHistoryOf = (g: AccessGrant) => {
    filters.setMany({ concessao: g.grantId, aba: 'historico' });
    requestAnimationFrame(() => document.getElementById('aba-historico')?.focus());
  };

  const grantColumns: TableColumn<AccessGrant>[] = [
    {
      key: 'pessoa',
      header: 'Pessoa',
      render: (g) => (
        <span className="pw-admin__person">
          <span>{g.person.name}</span>
          <span className="pw-prod__muted pw-break">{g.person.email}</span>
        </span>
      ),
    },
    { key: 'cliente', header: 'Cliente', render: (g) => g.client.name },
    {
      key: 'escopo',
      header: 'Ambiente, automação e máquina',
      render: (g) => (
        <span className="pw-admin__person">
          <span>{g.workspace.name}</span>
          <span className="pw-prod__muted">{g.kind === 'workspace' ? 'Ambiente de trabalho inteiro (concessão anterior)' : g.automation?.name}</span>
          {g.kind === 'automation' && <span className="pw-prod__muted">{machineScopeText(g.machine?.name)}</span>}
        </span>
      ),
    },
    { key: 'permissoes', header: 'Permissões', render: (g) => permissionsText(g.canReadLogs, g.canDownloadResults) },
    {
      key: 'situacao',
      header: 'Situação',
      render: (g) => (
        <span className="pw-admin__person">
          <Badge tone={SITUATION_TONE[g.situation]} dot>
            {SITUATION_LABEL[g.situation]}
          </Badge>
          {g.basis === 'client_invitation' && <span className="pw-prod__muted">Pelo convite de cliente (exceção registrada)</span>}
          {g.requestedBy && g.situation === 'pending' && <span className="pw-prod__muted">Pedido por {g.requestedBy}</span>}
          {g.approvedBy && g.situation !== 'pending' && <span className="pw-prod__muted">Aprovado por {g.approvedBy}</span>}
        </span>
      ),
    },
    { key: 'data', header: 'Criada em', render: (g) => <DateTimeText iso={g.createdAt} /> },
    {
      key: 'acoes',
      header: 'Ações',
      align: 'right',
      render: (g) => (
        <span className="pw-admin__row-actions">
          <Button size="sm" variant="ghost" onClick={() => showHistoryOf(g)} aria-label={`Ver histórico da concessão de ${g.person.name}`}>
            Ver histórico
          </Button>
          {canAct && g.kind === 'automation' && g.situation === 'pending' && (
            <Button size="sm" variant="secondary" onClick={() => setAct({ kind: 'approve', grant: g })} aria-label={`Aprovar ${g.automation?.name} para ${g.person.name}`}>
              Aprovar
            </Button>
          )}
          {canAct && g.kind === 'automation' && g.situation !== 'revoked' && (
            <Button size="sm" variant="ghost" onClick={() => setAct({ kind: 'revoke', grant: g })} aria-label={`Revogar ${g.automation?.name} de ${g.person.name}`}>
              {g.situation === 'pending' ? 'Cancelar pedido' : 'Revogar'}
            </Button>
          )}
          {canAct && g.kind === 'workspace' && (
            <Link
              as={RouterLink}
              to={`${orgPath.workspaceGrants(org)}?cliente=${encodeURIComponent(g.client.clientId)}&workspace=${encodeURIComponent(g.workspace.workspaceId)}`}
            >
              Decidir
            </Link>
          )}
        </span>
      ),
    },
  ];

  const historyColumns: TableColumn<AccessHistoryEvent>[] = [
    { key: 'quando', header: 'Data', render: (e) => <DateTimeText iso={e.createdAt} /> },
    {
      key: 'ato',
      header: 'Ato',
      render: (e) => (
        <span className="pw-admin__person">
          <span>{EVENT_LABEL[e.type]}</span>
          {e.grantException && <span className="pw-prod__muted">Exceção do convite de cliente</span>}
        </span>
      ),
    },
    {
      key: 'responsavel',
      header: 'Responsável',
      render: (e) => (e.byInvitee ? 'A própria pessoa convidada' : e.actor ? `${e.actor.name ?? ''} (${e.actor.email ?? ''})` : '—'),
    },
    { key: 'alvo', header: 'Alvo', render: (e) => (e.target ? (e.target.name ? `${e.target.name} (${e.target.email})` : e.target.email) : '—') },
    {
      key: 'mudancas',
      header: 'Escopo e mudanças',
      render: (e) => (
        <span className="pw-admin__person">
          {e.client && <span>Cliente {e.client.name}</span>}
          {e.automation && <span>{e.automation.name}</span>}
          {e.workspace && <span className="pw-prod__muted">{e.workspace.name}</span>}
          {e.automation && <span className="pw-prod__muted">{machineScopeText(e.machine?.name)}</span>}
          {e.canReadLogs !== null && e.canDownloadResults !== null && (
            <span className="pw-prod__muted">{permissionsText(!!e.canReadLogs, !!e.canDownloadResults)}</span>
          )}
          {e.role && <span className="pw-prod__muted">{e.previousRole ? `${ROLE_LABEL[e.previousRole as keyof typeof ROLE_LABEL] ?? e.previousRole} → ` : ''}{ROLE_LABEL[e.role as keyof typeof ROLE_LABEL] ?? e.role}</span>}
          {e.decision && <span className="pw-prod__muted">Decisão: {e.decision === 'KEEP' ? 'manter' : e.decision === 'SUSPEND' ? 'suspender' : 'revogar'}</span>}
        </span>
      ),
    },
  ];

  const filtersForm = (
    <Card variant="surface" padding="md">
      <form aria-label="Filtros de acessos" onSubmit={(e) => e.preventDefault()} className="pw-access-history__filters">
        {people.length > 0 && (
          <Select label="Pessoa" value={filters.ids.pessoa ?? ''} onChange={(e) => filters.setId('pessoa', e.target.value || null)} options={[{ value: '', label: 'Todas' }, ...people]} fullWidth />
        )}
        {clients.length > 0 && (
          <Select label="Cliente" value={filters.ids.cliente ?? ''} onChange={(e) => filters.setId('cliente', e.target.value || null)} options={[{ value: '', label: 'Todos' }, ...clients]} fullWidth />
        )}
        <Select
          label="Ambiente de trabalho"
          value={filters.ids.workspace ?? ''}
          onChange={(e) => filters.setId('workspace', e.target.value || null)}
          options={[{ value: '', label: 'Todos' }, ...workspaces.items.map((w) => ({ value: w.workspaceId, label: w.name }))]}
          fullWidth
        />
        {automations.length > 0 && (
          <Select
            label="Automação"
            value={filters.ids.automacao ?? ''}
            onChange={(e) => filters.setId('automacao', e.target.value || null)}
            options={[{ value: '', label: 'Todas' }, ...automations]}
            fullWidth
          />
        )}
        {machines.length > 0 && (
          <Select label="Máquina" value={filters.ids.maquina ?? ''} onChange={(e) => filters.setId('maquina', e.target.value || null)} options={[{ value: '', label: 'Todas' }, ...machines]} fullWidth />
        )}
        <Input label="De" type="date" value={filters.ids.de ?? ''} onChange={(e) => filters.setText('de', e.target.value)} fullWidth />
        <Input label="Até" type="date" value={filters.ids.ate ?? ''} onChange={(e) => filters.setText('ate', e.target.value)} fullWidth />
        {tab === 'concessoes' ? (
          <Fieldset legend="Situação" variant="plain" description="Nenhuma marcada = todas, inclusive as revogadas." columns={4}>
            {SITUATIONS.map((s) => (
              <Checkbox key={s} label={SITUATION_LABEL[s]} checked={situations.includes(s)} onChange={(e) => filters.toggleStatus(s, e.target.checked)} />
            ))}
          </Fieldset>
        ) : (
          <Fieldset legend="Tipo de ato" variant="plain" description="Nenhum marcado = todos os que você pode consultar." columns={3}>
            {CATEGORIES.map((c) => (
              <Checkbox key={c} label={CATEGORY_LABEL[c]} checked={categories.includes(c)} onChange={(e) => filters.toggleStatus(c, e.target.checked)} />
            ))}
          </Fieldset>
        )}
        {filters.ids.concessao && tab === 'historico' && (
          <Alert tone="info">
            Mostrando o histórico de uma concessão.{' '}
            <Button size="sm" variant="ghost" onClick={() => filters.setId('concessao', null)}>
              Ver todos
            </Button>
          </Alert>
        )}
        <div>
          <Button size="sm" variant="ghost" onClick={() => filters.clear()}>
            Limpar filtros
          </Button>
        </div>
      </form>
    </Card>
  );

  const tabs: { id: 'concessoes' | 'historico'; label: string }[] = [
    { id: 'concessoes', label: 'Concessões' },
    { id: 'historico', label: 'Histórico' },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Acessos e histórico"
        subtitle="Acessos concedidos a clientes e o histórico de cada concessão, alteração e revogação."
        onRefresh={forbidden ? undefined : () => setRefresh((n) => n + 1)}
        refreshing={list.status === 'loading' && refresh > 0}
      />
      <nav aria-label="Voltar" className="pw-people__shortcuts">
        <Link as={RouterLink} to={orgPath.people(org)}>
          ← Pessoas e acessos
        </Link>
        {canAct && (
          <Link as={RouterLink} to={orgPath.workspaceGrants(org)} arrow>
            Concessões por ambiente inteiro (modelo anterior)
          </Link>
        )}
      </nav>
      {notice && (
        <Alert tone={notice.tone} role={notice.tone === 'success' ? 'status' : 'alert'}>
          {notice.text}
        </Alert>
      )}
      <div className="pw-exec__tabs" role="tablist" aria-label="Acessos e histórico">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`aba-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="painel-acessos"
            tabIndex={tab === t.id ? 0 : -1}
            className={`pw-exec__tab${tab === t.id ? ' pw-exec__tab--active' : ''}`}
            onClick={() => setTab(t.id)}
            onKeyDown={(ev) => {
              if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
                const other = t.id === 'concessoes' ? 'historico' : 'concessoes';
                setTab(other);
                requestAnimationFrame(() => document.getElementById(`aba-${other}`)?.focus());
              }
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="painel-acessos" role="tabpanel" aria-labelledby={`aba-${tab}`}>
        {forbidden ? (
          <ForbiddenState area={tab === 'concessoes' ? 'as concessões desta organização' : 'o histórico de acessos desta organização'} onRetry={list.reload} />
        ) : (
          <Stack gap={5}>
            {filtersForm}
            {tab === 'historico' && scope === 'client_access' && (
              <Text variant="body-sm" color="secondary">
                Você vê os atos de acesso de clientes. A auditoria completa (inclusive perfis de membros) é de quem administra a organização.
              </Text>
            )}
            {list.status === 'loading' ? (
              <StateView status="loading" title="Carregando…" />
            ) : list.status === 'error' ? (
              <LoadErrorState error={list.error} onRetry={list.reload} />
            ) : list.items.length === 0 ? (
              <StateView status="neutral" title={tab === 'concessoes' ? 'Nenhuma concessão com esses filtros.' : 'Nenhum ato com esses filtros.'} />
            ) : tab === 'concessoes' ? (
              <>
                <div className="pw-prod__scroll" role="region" aria-label="Lista de concessões de clientes" tabIndex={0}>
                  <Table columns={grantColumns} data={grants.items} rowKey="grantId" size="sm" caption="Concessões, da mais recente." />
                </div>
                <AdminLoadMore list={grants} one="concessão" many="concessões" />
              </>
            ) : (
              <>
                <div className="pw-prod__scroll" role="region" aria-label="Histórico de acessos" tabIndex={0}>
                  <Table columns={historyColumns} data={history.items} rowKey="eventId" size="sm" caption="Atos de acesso, do mais recente. Somente consulta." />
                </div>
                <AdminLoadMore list={history} one="ato" many="atos" />
              </>
            )}
          </Stack>
        )}
      </div>

      <StepUpDialog
        open={act?.kind === 'approve'}
        title={act?.kind === 'approve' ? `Aprovar o compartilhamento de ${act.grant.automation?.name} com ${act.grant.person.name}?` : ''}
        guard={{ operation: 'client.grant.approve', target: act?.grant.grantId }}
        confirmLabel="Aprovar"
        stepUp={orgStepUp(org)}
        action={() => (act?.kind === 'approve' ? approveClientAutomationGrant(org, act.grant.grantId) : Promise.reject())}
        onDone={() => {
          setAct(null);
          setNotice({ tone: 'success', text: 'Compartilhamento aprovado. A pessoa já vê a automação na próxima consulta.' });
          setRefresh((n) => n + 1);
        }}
        onClose={() => setAct(null)}
        refusalText={(e) => clientRefusal(e, 'O pedido mudou ou já foi decidido.')}
        uncertainText="Não foi possível confirmar a aprovação. Feche e confira a lista antes de tentar de novo."
        onUnauthenticated={expired}
      >
        {act?.kind === 'approve' && (
          <Text>
            {act.grant.client.name} · {act.grant.automation?.name} ({act.grant.workspace.name}) · {machineScopeText(act.grant.machine?.name)} ·{' '}
            {permissionsText(act.grant.canReadLogs, act.grant.canDownloadResults)}. Quem pediu não pode aprovar.
          </Text>
        )}
      </StepUpDialog>
      <StepUpDialog
        open={act?.kind === 'revoke'}
        title={act?.kind === 'revoke' ? `${act.grant.situation === 'pending' ? 'Cancelar o pedido' : 'Revogar o acesso'} de ${act.grant.person.name} a ${act.grant.automation?.name}?` : ''}
        guard={{ operation: 'client.grant.revoke', target: act?.grant.grantId }}
        confirmLabel={act?.grant.situation === 'pending' ? 'Cancelar pedido' : 'Revogar'}
        tone="danger"
        action={() => (act?.kind === 'revoke' ? revokeClientAutomationGrant(org, act.grant.grantId) : Promise.reject())}
        onDone={() => {
          setAct(null);
          setNotice({ tone: 'success', text: 'Acesso revogado. Os demais acessos da pessoa continuam valendo.' });
          setRefresh((n) => n + 1);
        }}
        onClose={() => setAct(null)}
        refusalText={(e) => clientRefusal(e)}
        uncertainText="Não foi possível confirmar a revogação. Feche e confira a lista."
        onUnauthenticated={expired}
      >
        <Text>Remove só este acesso; vale na próxima consulta da pessoa, mesmo com a sessão dela aberta.</Text>
      </StepUpDialog>
    </Stack>
  );
}
