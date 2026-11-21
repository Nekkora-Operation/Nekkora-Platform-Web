import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Select, Stack, StateView, Text } from 'nekkora-lib';
import { Link as RouterLink } from 'react-router';
import { isApiError } from '../../api/http';
import {
  listAccessGrants,
  listClientShareOptions,
  reactivateClientMembership,
  reduceClientAutomationGrant,
  requestClientAutomationGrant,
  retireClientMembership,
  revokeClientAutomationGrant,
  suspendClientMembership,
  type AccessGrant,
  type ClientShareOption,
  type PersonClient,
} from '../../api/clientAccess';
import { orgPath } from '../../auth/organization';
import { StepUpDialog } from '../../components/StepUpDialog';
import { clientRefusal, machineScopeText, permissionsText } from './clientShared';
import { orgStepUp } from './shared';

/** O que mudou, depois de salvar: as concessões relidas (ou nulas, se a releitura falhou), a situação do vínculo e o que ficou de fora. */
export interface ClientAccessSaved {
  grants: AccessGrant[] | null;
  status: PersonClient['status'];
  partial: string | null;
  requested: boolean;
}

/** `logs` guarda o DASHBOARD de execução (071: registros técnicos não se compartilham); `results`, os arquivos de retorno. */
interface GrantDraft {
  grant: AccessGrant;
  revoke: boolean;
  logs: boolean;
  results: boolean;
}

type MembershipChange = '' | 'suspend' | 'reactivate' | 'retire';
type Load = { status: 'loading' } | { status: 'ready'; grants: AccessGrant[]; options: ClientShareOption[] } | { status: 'error'; error: unknown };

/**
 * "Gerenciar acessos" de uma pessoa de cliente (PLATFORM-FLUXO-002, 070): as automações compartilhadas com ela, num rascunho.
 * Salvar aplica pelas rotas da API; Cancelar fecha sem enviar nada.
 * - Revogar remove só aquele acesso; os demais continuam.
 * - Dashboard de execução e arquivos de retorno só podem ser DESLIGADOS aqui; ligar é um pedido novo, aprovado por outra pessoa.
 *   Registros técnicos não se compartilham (071). Desligar os dois é revogar.
 * - Compartilhar outra automação é um pedido (D-GRANT-1): fica pendente até outra pessoa aprovar em "Acessos e histórico".
 * - Vínculo: suspender (a próxima consulta do cliente já é recusada), reativar (confirmação da hora) ou retirar desta
 *   organização (revoga as concessões dele; a identidade Nekkora continua).
 * Ordem do envio: reativar (pede a confirmação) primeiro, depois revogações, reduções, o pedido novo e a suspensão; retirar vai
 * sozinho. Falha depois de algo aplicado: o resultado diz o que ficou de fora.
 */
export function ClientAccessDialog({
  org,
  target,
  onClose,
  onSaved,
  onUnauthenticated,
}: {
  org: string;
  target: PersonClient | null;
  onClose: () => void;
  onSaved: (clientMembershipId: string, saved: ClientAccessSaved) => void;
  onUnauthenticated: () => void;
}) {
  const membershipId = target?.clientMembershipId ?? '';
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [rows, setRows] = useState<GrantDraft[]>([]);
  const [membership, setMembership] = useState<MembershipChange>('');
  const [share, setShare] = useState({ automationId: '', workerId: '', logs: true, results: false });

  useEffect(() => {
    if (!target) return;
    let alive = true;
    setLoad({ status: 'loading' });
    setRows([]);
    setMembership('');
    setShare({ automationId: '', workerId: '', logs: true, results: false });
    Promise.all([listAccessGrants(org, { personId: target.userId, situation: ['pending', 'active', 'suspended'], limit: 100 }), listClientShareOptions(org)]).then(
      ([page, opts]) => {
        if (!alive) return;
        const grants = page.items.filter((g) => g.clientMembershipId === target.clientMembershipId);
        setLoad({ status: 'ready', grants, options: opts.automations });
        setRows(grants.map((g) => ({ grant: g, revoke: false, logs: g.canViewDashboard, results: g.canDownloadResults })));
      },
      (e: unknown) => {
        if (!alive) return;
        if (isApiError(e, 'unauthenticated')) return onUnauthenticated();
        setLoad({ status: 'error', error: e });
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, target?.clientMembershipId]);

  const name = target?.displayName || 'esta pessoa';
  const options = load.status === 'ready' ? load.options : [];
  const shareOption = options.find((o) => o.automationId === share.automationId);
  const shareMachine = shareOption?.machines.find((m) => m.workerId === share.workerId);
  const scopeOf = (g: AccessGrant) =>
    g.kind === 'workspace' ? `Ambiente de trabalho ${g.workspace.name} inteiro (concessão anterior)` : `${g.automation?.name} · ${g.workspace.name} · ${machineScopeText(g.machine?.name)}`;

  const changes = useMemo(() => {
    if (membership === 'retire') return ['Retirar esta pessoa do cliente nesta organização (as concessões dela são revogadas)'];
    const out: string[] = [];
    if (membership === 'reactivate') out.push('Reativar o vínculo');
    for (const r of rows) {
      if (r.revoke || (!r.logs && !r.results)) out.push(r.grant.situation === 'pending' ? `Cancelar o pedido: ${r.grant.automation?.name}` : `Revogar: ${scopeOf(r.grant)}`);
      else if (r.logs !== r.grant.canViewDashboard || r.results !== r.grant.canDownloadResults)
        out.push(`Reduzir ${r.grant.automation?.name} para: ${permissionsText(r.logs, r.results).toLowerCase()}`);
    }
    if (shareOption && (share.logs || share.results))
      out.push(
        `Pedir acompanhamento de ${shareOption.name} (${machineScopeText(shareMachine?.name)}; ${permissionsText(share.logs, share.results).toLowerCase()}) — fica pendente até outra pessoa aprovar`,
      );
    if (membership === 'suspend') out.push('Suspender o vínculo (a pessoa deixa de ver o que foi compartilhado)');
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, membership, share, shareOption, shareMachine]);

  const save = async (): Promise<ClientAccessSaved> => {
    type Op = { text: string; run: () => Promise<unknown> };
    const ops: Op[] = [];
    let status: PersonClient['status'] = target!.status;
    if (membership === 'retire') {
      ops.push({ text: 'retirar o vínculo', run: () => retireClientMembership(org, membershipId).then(() => (status = 'revoked')) });
    } else {
      if (membership === 'reactivate') ops.push({ text: 'reativar o vínculo', run: () => reactivateClientMembership(org, membershipId).then(() => (status = 'active')) });
      for (const r of rows) if (r.revoke || (!r.logs && !r.results)) ops.push({ text: `revogar ${r.grant.automation?.name ?? r.grant.workspace.name}`, run: () => revokeClientAutomationGrant(org, r.grant.grantId) });
      for (const r of rows)
        if (!r.revoke && (r.logs || r.results) && (r.logs !== r.grant.canViewDashboard || r.results !== r.grant.canDownloadResults))
          ops.push({ text: `reduzir ${r.grant.automation?.name}`, run: () => reduceClientAutomationGrant(org, r.grant.grantId, { canViewDashboard: r.logs, canDownloadResults: r.results }) });
      if (shareOption && (share.logs || share.results))
        ops.push({
          text: `pedir ${shareOption.name}`,
          run: () =>
            requestClientAutomationGrant(org, {
              clientMembershipId: membershipId,
              automationId: shareOption.automationId,
              workerId: share.workerId || null,
              canViewDashboard: share.logs,
              canDownloadResults: share.results,
            }),
        });
      if (membership === 'suspend') ops.push({ text: 'suspender o vínculo', run: () => suspendClientMembership(org, membershipId).then(() => (status = 'suspended')) });
    }
    let partial: string | null = null;
    for (let i = 0; i < ops.length; i++) {
      try {
        await ops[i].run();
      } catch (e) {
        if (i === 0) throw e;
        if (isApiError(e, 'unauthenticated')) throw e;
        partial = `${ops.slice(i).map((o) => o.text).join('; ')}. ${clientRefusal(e)}`;
        break;
      }
    }
    const grants = await listAccessGrants(org, { personId: target!.userId, situation: ['pending', 'active', 'suspended'], limit: 100 })
      .then((p) => p.items.filter((g) => g.clientMembershipId === membershipId))
      .catch(() => null);
    return { grants, status, partial, requested: !!shareOption && (share.logs || share.results) && partial === null };
  };

  const editor = () => {
    if (load.status === 'loading') return <StateView status="loading" title="Carregando acessos…" />;
    if (load.status === 'error')
      return (
        <Alert tone="warning" title="Não foi possível carregar os acessos desta pessoa.">
          Feche e tente de novo. Nada foi alterado.
        </Alert>
      );
    const retired = target!.status === 'revoked';
    const locked = membership === 'retire' || retired;
    return (
      <Stack gap={4}>
        <Text color="secondary">
          Cliente: {target!.clientName}. Só acompanhamento: sem execução, publicação ou administração.
        </Text>
        {!target!.linkedToIdentity && (
          <Alert tone="info">Conta de cliente antiga (sem identidade Nekkora). Os acessos dela continuam como estavam.</Alert>
        )}
        {retired && <Alert tone="info">Esta pessoa foi retirada do cliente nesta organização. Para voltar, só com um convite novo.</Alert>}
        <section aria-labelledby={`cliente-acessos-${membershipId}`}>
          <Text as="h3" variant="h4" id={`cliente-acessos-${membershipId}`}>
            Automações compartilhadas
          </Text>
          {rows.length === 0 ? (
            <Text color="secondary">Nenhuma automação compartilhada.</Text>
          ) : (
            <ul className="pw-access__list" aria-label="Automações compartilhadas">
              {rows.map((r, i) => {
                const g = r.grant;
                const set = (patch: Partial<GrantDraft>) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <li key={g.grantId} className={`pw-access__item pw-access__item--stack${r.revoke ? ' pw-access__item--removed' : ''}`}>
                    <div className="pw-access__scope">
                      <Text>{scopeOf(g)}</Text>
                      {g.situation === 'pending' && (
                        <Badge tone="info" size="sm">
                          Aguardando aprovação
                        </Badge>
                      )}
                      {r.revoke && (
                        <Badge tone="danger" size="sm">
                          {g.situation === 'pending' ? 'Pedido será cancelado' : 'Será revogado'}
                        </Badge>
                      )}
                    </div>
                    {g.kind === 'automation' && g.situation === 'active' && (
                      <div className="pw-access__perms">
                        <Checkbox
                          label="Dashboard de execução"
                          checked={r.logs}
                          disabled={locked || r.revoke || !g.canViewDashboard}
                          onChange={(e) => set({ logs: e.target.checked })}
                        />
                        <Checkbox
                          label="Arquivos de retorno"
                          checked={r.results}
                          disabled={locked || r.revoke || !g.canDownloadResults}
                          onChange={(e) => set({ results: e.target.checked })}
                        />
                        {(!g.canViewDashboard || !g.canDownloadResults) && (
                          <Text variant="body-sm" color="secondary">
                            Aqui só se desliga. Para ligar, peça de novo em "Compartilhar outra automação" (outra pessoa aprova).
                          </Text>
                        )}
                      </div>
                    )}
                    {g.kind === 'automation' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={locked}
                        aria-label={`${r.revoke ? 'Manter' : g.situation === 'pending' ? 'Cancelar pedido de' : 'Revogar'} ${g.automation?.name}`}
                        onClick={() => set({ revoke: !r.revoke, logs: g.canViewDashboard, results: g.canDownloadResults })}
                      >
                        {r.revoke ? 'Manter' : g.situation === 'pending' ? 'Cancelar pedido' : 'Revogar'}
                      </Button>
                    ) : (
                      <RouterLink
                        to={`${orgPath.workspaceGrants(org)}?cliente=${encodeURIComponent(g.client.clientId)}&workspace=${encodeURIComponent(g.workspace.workspaceId)}`}
                      >
                        Decidir (concessão por ambiente)
                      </RouterLink>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {!locked && target!.status === 'active' && (
          <details className="pw-people__details">
            <summary>Compartilhar outra automação</summary>
            <Stack gap={3}>
              <Text variant="body-sm" color="secondary">
                Vira um pedido: só vale depois que OUTRA pessoa aprovar em Acessos e histórico. A mesma pessoa, sem convite novo.
              </Text>
              <Select
                label="Automação"
                value={share.automationId}
                placeholder="Escolha a automação"
                onChange={(e) => setShare({ ...share, automationId: e.target.value, workerId: '' })}
                options={options.map((o) => ({ value: o.automationId, label: `${o.name} · ${o.workspaceName}` }))}
              />
              <Select
                label="Máquina"
                value={share.workerId}
                disabled={!shareOption}
                onChange={(e) => setShare({ ...share, workerId: e.target.value })}
                options={[{ value: '', label: 'Todas as máquinas desta automação' }, ...(shareOption?.machines ?? []).map((m) => ({ value: m.workerId, label: m.name }))]}
              />
              <Checkbox label="Dashboard de execução" checked={share.logs} disabled={!shareOption} onChange={(e) => setShare({ ...share, logs: e.target.checked })} />
              <Checkbox label="Ver e baixar os arquivos de retorno" checked={share.results} disabled={!shareOption} onChange={(e) => setShare({ ...share, results: e.target.checked })} />
              {shareOption && !share.logs && !share.results && (
                <Text variant="body-sm" color="secondary">
                  Escolha ao menos um conteúdo.
                </Text>
              )}
              {shareOption && (
                <Button variant="ghost" size="sm" onClick={() => setShare({ automationId: '', workerId: '', logs: true, results: false })}>
                  Desfazer o pedido
                </Button>
              )}
            </Stack>
          </details>
        )}

        {!retired && (
          <Select
            label="Vínculo com o cliente"
            value={membership}
            onChange={(e) => setMembership(e.target.value as MembershipChange)}
            options={[
              { value: '', label: target!.status === 'suspended' ? 'Manter suspenso' : 'Manter ativo' },
              ...(target!.status === 'active' ? [{ value: 'suspend', label: 'Suspender' }] : []),
              ...(target!.status === 'suspended' ? [{ value: 'reactivate', label: 'Reativar (pede a confirmação da hora)' }] : []),
              { value: 'retire', label: 'Retirar desta organização' },
            ]}
            hint="Afeta só esta organização; a identidade Nekkora da pessoa continua."
          />
        )}

        <div role="status" aria-live="polite">
          {changes.length === 0 ? (
            <Text variant="body-sm" color="secondary">
              Nenhuma mudança. Cancelar fecha sem alterar nada.
            </Text>
          ) : (
            <Stack gap={1}>
              <Text variant="body-sm">Ao salvar:</Text>
              <ul className="pw-access__changes" aria-label="Mudanças a salvar">
                {changes.map((c) => (
                  <li key={c}>
                    <Text variant="body-sm">{c}</Text>
                  </li>
                ))}
              </ul>
            </Stack>
          )}
        </div>
      </Stack>
    );
  };

  return (
    <StepUpDialog
      open={!!target}
      title={`Gerenciar acessos de ${name}`}
      confirmLabel={membership === 'retire' ? 'Retirar e salvar' : 'Salvar acessos'}
      tone={membership === 'retire' ? 'danger' : 'primary'}
      ready={load.status === 'ready' && changes.length > 0}
      guard={{ operation: 'client.access.save', target: membershipId }}
      stepUp={orgStepUp(org)}
      action={save}
      onDone={(saved) => onSaved(membershipId, saved)}
      onClose={onClose}
      refusalText={(e) => clientRefusal(e, 'O vínculo ou a concessão mudou enquanto você editava.')}
      uncertainText="Não foi possível confirmar se os acessos foram salvos. Feche e confira os acessos atuais antes de repetir."
      onUnauthenticated={onUnauthenticated}
    >
      {target && editor()}
    </StepUpDialog>
  );
}
