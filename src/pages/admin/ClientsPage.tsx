import { useEffect, useState } from 'react';
import { Alert, Button, Card, Link, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { Link as RouterLink } from 'react-router';
import { listClients } from '../../api/admin';
import { getClientDetail, type ClientDetail, type ClientRecord } from '../../api/clientAccess';
import { isApiError } from '../../api/http';
import type { Client, ResourceStatus } from '../../api/v1';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { useCursorList } from '../../hooks/useCursorList';
import { DateTimeText, LoadErrorState, PageHeader, RESOURCE_STATUS_LABEL, ResourceStatusBadge, useExpiresOn } from '../product/shared';
import { ClientFormDialog, machineScopeText, permissionsText } from '../access/clientShared';
import { ADMIN_PAGE, AdminLoadMore, ForbiddenState, useAccessDenied, StatusFilter, useUrlFilters } from './shared';
import '../access/people.css';

const CLIENT_STATUS_ORDER: ResourceStatus[] = ['active', 'suspended', 'archived'];

type Detail = { status: 'loading' } | { status: 'ready'; data: ClientDetail } | { status: 'error'; error: unknown };

/**
 * "Gerenciar clientes" (PLATFORM-FLUXO-002, 070), dentro de "Pessoas e acessos": o cadastro de clientes atendidos (empresa ou
 * pessoa), separado das pessoas convidadas e das concessões. Lista em ordem alfabética (contrato M03), filtro de situação no
 * endereço, cadastro e edição em modal (`org.manage` OU `external_access.manage`); nada é apagado — suspender ou arquivar
 * barra a área do cliente. "Ver detalhes" (?cliente=) mostra as pessoas vinculadas, as automações compartilhadas e os
 * convites pendentes. Vincular alguém ao cadastro não dá acesso a nada por si só.
 */
export function ClientsPage() {
  const { org, expired } = useSession();
  const { permissions } = useInternalArea();
  const filters = useUrlFilters<ResourceStatus>({ statuses: CLIENT_STATUS_ORDER, ids: ['cliente'] });
  const [refresh, setRefresh] = useState(0);
  const list = useCursorList<Client>(
    (cursor) => listClients(org, { limit: ADMIN_PAGE, cursor, status: filters.statuses.length ? [...filters.statuses] : undefined }),
    (c) => c.clientId,
    [org, filters.statuses.join(','), refresh],
  );
  useExpiresOn(list.error);
  const forbidden = useAccessDenied(list);
  const perms = permissions.status === 'ready' ? permissions.data.organization.permissions : [];
  const canEdit = perms.includes('org.manage') || perms.includes('external_access.manage');
  const seesGrants = perms.includes('external_access.manage');
  const [editing, setEditing] = useState<{ client: ClientRecord | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // detalhe (?cliente=<id>), também depois de recarregar
  const selected = filters.ids.cliente;
  const [detail, setDetail] = useState<Detail | null>(null);
  useEffect(() => {
    if (!selected) return setDetail(null);
    let alive = true;
    setDetail({ status: 'loading' });
    getClientDetail(org, selected).then(
      (data) => alive && setDetail({ status: 'ready', data }),
      (error: unknown) => {
        if (!alive) return;
        if (isApiError(error, 'unauthenticated')) return expired();
        setDetail({ status: 'error', error });
      },
    );
    return () => {
      alive = false;
    };
  }, [org, selected, refresh, expired]);

  const columns: TableColumn<Client>[] = [
    { key: 'nome', header: 'Cliente', render: (c) => c.name },
    { key: 'estado', header: 'Situação', render: (c) => <ResourceStatusBadge status={c.status} /> },
    { key: 'atualizado', header: 'Atualizado em', render: (c) => <DateTimeText iso={c.updatedAt} /> },
    {
      key: 'acoes',
      header: 'Ações',
      align: 'right',
      render: (c) => (
        <span className="pw-admin__row-actions">
          <Button size="sm" variant="secondary" data-cliente-detalhe={c.clientId} aria-label={`Ver detalhes de ${c.name}`} onClick={() => filters.setId('cliente', c.clientId)}>
            Ver detalhes
          </Button>
          {canEdit && (
            <Button size="sm" variant="ghost" aria-label={`Editar ${c.name}`} onClick={() => setEditing({ client: c as ClientRecord })}>
              Editar
            </Button>
          )}
        </span>
      ),
    },
  ];

  const detailPanel = () => {
    if (!detail) return null;
    const close = () => {
      const id = selected;
      filters.setId('cliente', null);
      window.setTimeout(() => (id ? document.querySelector<HTMLElement>(`[data-cliente-detalhe="${id}"]`)?.focus() : null), 0);
    };
    return (
      <Card variant="outlined" padding="lg">
        <section aria-labelledby="cliente-detalhe-titulo" className="pw-clients__detail">
          {detail.status === 'loading' ? (
            <StateView status="loading" title="Carregando o cliente…" />
          ) : detail.status === 'error' ? (
            <Alert tone="warning" title={isApiError(detail.error, 'not_found') ? 'Cliente não encontrado nesta organização.' : 'Não foi possível carregar o cliente.'}>
              <Button size="sm" variant="ghost" onClick={close}>
                Fechar
              </Button>
            </Alert>
          ) : (
            <Stack gap={4}>
              <div className="pw-clients__detail-head">
                <Text as="h2" variant="h3" id="cliente-detalhe-titulo">
                  {detail.data.name}
                </Text>
                <ResourceStatusBadge status={detail.data.status} />
                <Button size="sm" variant="ghost" onClick={close}>
                  Fechar detalhes
                </Button>
              </div>
              <section aria-labelledby="cliente-pessoas">
                <Text as="h3" variant="h4" id="cliente-pessoas">
                  Pessoas vinculadas
                </Text>
                {detail.data.people.length === 0 ? (
                  <Text color="secondary">Ninguém vinculado ainda. Convide em Pessoas e acessos, como Cliente.</Text>
                ) : (
                  <ul className="pw-clients__list">
                    {detail.data.people.map((p) => (
                      <li key={p.clientMembershipId}>
                        <Text>
                          {p.person.name} <span className="pw-prod__muted">({p.person.email})</span>
                          {p.status !== 'active' && <span className="pw-prod__muted"> · {p.status === 'suspended' ? 'suspenso' : p.status === 'revoked' ? 'retirado' : 'pendente'}</span>}
                        </Text>
                        {p.grants.length > 0 && (
                          <ul className="pw-clients__sublist">
                            {p.grants.map((g) => (
                              <li key={g.grantId}>
                                <Text variant="body-sm" color="secondary">
                                  {g.kind === 'workspace'
                                    ? `Ambiente de trabalho ${g.workspace.name} inteiro`
                                    : `${g.automation?.name} · ${machineScopeText(g.machine?.name)} · ${permissionsText(g.canReadLogs, g.canDownloadResults)}`}
                                  {g.situation === 'pending' ? ' · aguardando aprovação' : ''}
                                </Text>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section aria-labelledby="cliente-automacoes">
                <Text as="h3" variant="h4" id="cliente-automacoes">
                  Automações compartilhadas
                </Text>
                {detail.data.sharedAutomations.length === 0 ? (
                  <Text color="secondary">Nenhuma automação compartilhada com pessoas deste cliente.</Text>
                ) : (
                  <ul className="pw-clients__list">
                    {detail.data.sharedAutomations.map((s) => (
                      <li key={s.automation.automationId}>
                        <Text>
                          {s.automation.name} <span className="pw-prod__muted">· {s.workspace.name} · {s.people === 1 ? '1 pessoa' : `${s.people} pessoas`}</span>
                        </Text>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {detail.data.pendingInvitations.length > 0 && (
                <section aria-labelledby="cliente-convites">
                  <Text as="h3" variant="h4" id="cliente-convites">
                    Convites pendentes
                  </Text>
                  <ul className="pw-clients__list">
                    {detail.data.pendingInvitations.map((i) => (
                      <li key={i.invitationId}>
                        <Text>
                          {i.email} <span className="pw-prod__muted">· {i.automationName} · vale até </span>
                          <DateTimeText iso={i.expiresAt} />
                        </Text>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {seesGrants && (
                <Link as={RouterLink} to={orgPath.accessHistory(org, { cliente: detail.data.clientId })} arrow>
                  Ver concessões e histórico deste cliente
                </Link>
              )}
            </Stack>
          )}
        </section>
      </Card>
    );
  };

  return (
    <Stack gap={5}>
      <PageHeader
        title="Clientes"
        subtitle={canEdit ? 'Empresas ou pessoas atendidas pela organização. Cadastre, edite e veja quem está vinculado.' : 'Clientes atendidos pela organização. Somente consulta.'}
        onRefresh={forbidden ? undefined : () => setRefresh((n) => n + 1)}
        refreshing={list.status === 'loading' && refresh > 0}
      />
      <nav aria-label="Voltar">
        <Link as={RouterLink} to={orgPath.people(org)}>
          ← Pessoas e acessos
        </Link>
      </nav>
      {notice && (
        <Alert tone="success" role="status">
          {notice}
        </Alert>
      )}
      {forbidden ? (
        <ForbiddenState area="os clientes desta organização" onRetry={list.reload} />
      ) : (
        <>
          {canEdit && (
            <div>
              <Button onClick={() => setEditing({ client: null })}>Cadastrar cliente</Button>
            </div>
          )}
          {detailPanel()}
          <Card variant="surface" padding="md">
            <form aria-label="Filtros de clientes" onSubmit={(e) => e.preventDefault()}>
              <StatusFilter legend="Situação" order={CLIENT_STATUS_ORDER} labels={RESOURCE_STATUS_LABEL} selected={filters.statuses} onToggle={filters.toggleStatus} />
            </form>
          </Card>
          {list.status === 'loading' ? (
            <StateView status="loading" title="Carregando clientes…" />
          ) : list.status === 'error' ? (
            <LoadErrorState error={list.error} onRetry={list.reload} />
          ) : list.items.length === 0 ? (
            <StateView
              status="neutral"
              title={filters.statuses.length ? 'Nenhum cliente com esses estados.' : 'Nenhum cliente cadastrado.'}
              actions={filters.statuses.length ? <Button variant="secondary" size="sm" onClick={filters.clear}>Limpar filtros</Button> : undefined}
            />
          ) : (
            <>
              <div className="pw-prod__scroll" role="region" aria-label="Lista de clientes" tabIndex={0}>
                <Table columns={columns} data={list.items} rowKey="clientId" size="sm" caption="Clientes em ordem alfabética." />
              </div>
              <AdminLoadMore list={list} one="cliente" many="clientes" />
            </>
          )}
        </>
      )}
      <ClientFormDialog
        org={org}
        open={!!editing}
        client={editing?.client ?? null}
        onClose={() => setEditing(null)}
        onSaved={(c) => {
          setEditing(null);
          setNotice(editing?.client ? `Cliente ${c.name} atualizado.` : `Cliente ${c.name} cadastrado.`);
          setRefresh((n) => n + 1);
        }}
        onUnauthenticated={expired}
      />
    </Stack>
  );
}
