import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Select, Stack, StateView, Text } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { assignRole, listMemberRoles, replaceRole, revokeMembership, revokeRole, type MemberRoles, type RoleAssignment, type RoleCode } from '../../api/access';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal, isWorkspaceRole, orgStepUp, ROLE_LABEL, ROLE_OPTIONS } from './shared';

/** Quem tem os acessos gerenciados: o id da conta e o nome (só apresentação; a API identifica pelo id). */
export interface AccessTarget {
  userId: string;
  displayName?: string | null;
}

/** O que mudou, depois de salvar: os papéis lidos de novo (ou nulo, se a releitura falhou) e se o vínculo foi retirado. */
export interface AccessSaved {
  roles: MemberRoles | null;
  retired: boolean;
  /** Parte das mudanças não foi aplicada: o que ficou de fora e por quê (as anteriores ficaram valendo). */
  partial: string | null;
}

interface Row {
  assignment: RoleAssignment;
  role: RoleCode;
  remove: boolean;
}
interface Addition {
  key: number;
  role: RoleCode;
  workspaceId: string | null;
}

type Load = { status: 'loading' } | { status: 'ready'; data: MemberRoles } | { status: 'error'; error: unknown };

/**
 * "Gerenciar acessos" (PLATFORM-FLUXO-002): os papéis e os ambientes de um membro num modal, sem sair da lista. As
 * mudanças ficam num RASCUNHO; "Salvar acessos" as aplica pelas rotas de sempre (atribuir e trocar pedem a confirmação
 * da hora, como antes; revogar e retirar não), e "Cancelar" fecha sem enviar nada. A API continua decidindo: o próprio
 * acesso, o último administrador e a autoridade sobre o papel são recusados por ela, e a tela mostra a recusa.
 *
 * Ordem do envio: primeiro o que pede confirmação (trocar, atribuir) — se a confirmação faltar, a recusa vem antes de
 * qualquer efeito —; depois as revogações; retirar da organização vai sozinho. Se uma mudança falhar depois de outras já
 * aplicadas, as aplicadas valem e o resultado diz exatamente o que ficou de fora.
 */
export function MemberAccessDialog({
  org,
  target,
  workspaces,
  onClose,
  onSaved,
  onUnauthenticated,
}: {
  org: string;
  target: AccessTarget | null;
  workspaces: { workspaceId: string; name: string; status: string }[];
  onClose: () => void;
  onSaved: (userId: string, saved: AccessSaved) => void;
  onUnauthenticated: () => void;
}) {
  const userId = target?.userId ?? '';
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [rows, setRows] = useState<Row[]>([]);
  const [additions, setAdditions] = useState<Addition[]>([]);
  const [retire, setRetire] = useState(false);
  const [newRole, setNewRole] = useState<RoleCode | ''>('');
  const [newWorkspace, setNewWorkspace] = useState('');
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    setLoad({ status: 'loading' });
    setRows([]);
    setAdditions([]);
    setRetire(false);
    setNewRole('');
    setNewWorkspace('');
    listMemberRoles(org, target.userId).then(
      (data) => {
        if (!alive) return;
        setLoad({ status: 'ready', data });
        setRows([...data.organizationRoles, ...data.workspaceRoles].map((a) => ({ assignment: a, role: a.role, remove: false })));
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
  }, [org, target?.userId]);

  const wsName = (id: string | null) => (id ? (workspaces.find((w) => w.workspaceId === id)?.name ?? `ambiente de trabalho ${id.slice(0, 8)}…`) : 'toda a organização');
  const label = (role: RoleCode, workspaceId: string | null) => `${ROLE_LABEL[role] ?? role} · ${wsName(workspaceId)}`;
  const name = target?.displayName || 'este membro';
  const data = load.status === 'ready' ? load.data : null;
  const active = data?.membershipState === 'ATIVO';

  const changes = useMemo(() => {
    const out: string[] = [];
    if (retire) return ['Retirar da organização (todos os papéis são revogados)'];
    for (const r of rows) {
      if (r.remove) out.push(`Revogar ${label(r.assignment.role, r.assignment.workspaceId)}`);
      else if (r.role !== r.assignment.role) out.push(`Trocar ${label(r.assignment.role, r.assignment.workspaceId)} por ${ROLE_LABEL[r.role]}`);
    }
    for (const a of additions) out.push(`Atribuir ${label(a.role, a.workspaceId)}`);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, additions, retire, workspaces]);

  // ambientes onde a pessoa já terá um papel depois do rascunho: não oferecidos de novo (a API recusaria o repetido)
  const taken = new Set([
    ...rows.filter((r) => !r.remove && r.assignment.workspaceId).map((r) => r.assignment.workspaceId!),
    ...additions.filter((a) => a.workspaceId).map((a) => a.workspaceId!),
  ]);
  const hasOrgAdmin = rows.some((r) => !r.remove && r.role === 'ORG_ADMIN') || additions.some((a) => a.role === 'ORG_ADMIN');
  const workspaceOptions = workspaces.filter((w) => w.status === 'active' && !taken.has(w.workspaceId)).map((w) => ({ value: w.workspaceId, label: w.name }));
  const roleOptions = ROLE_OPTIONS.filter((o) => (o.scope === 'organization' ? !hasOrgAdmin : true)).map((o) => ({ value: o.value, label: o.label }));
  const canAdd = !!newRole && (!isWorkspaceRole(newRole) || !!newWorkspace);

  const save = async (): Promise<AccessSaved> => {
    type Op = { text: string; run: () => Promise<unknown> };
    const ops: Op[] = [];
    if (retire) {
      ops.push({ text: 'retirar da organização', run: () => revokeMembership(org, userId) });
    } else {
      for (const r of rows) if (!r.remove && r.role !== r.assignment.role) ops.push({ text: `trocar por ${ROLE_LABEL[r.role]}`, run: () => replaceRole(org, r.assignment.assignmentId, r.role) });
      for (const a of additions) ops.push({ text: `atribuir ${label(a.role, a.workspaceId)}`, run: () => assignRole(org, userId, a.role, a.workspaceId ?? undefined) });
      for (const r of rows) if (r.remove) ops.push({ text: `revogar ${label(r.assignment.role, r.assignment.workspaceId)}`, run: () => revokeRole(org, r.assignment.assignmentId) });
    }
    let partial: string | null = null;
    for (let i = 0; i < ops.length; i++) {
      try {
        await ops[i].run();
      } catch (e) {
        // nada aplicado ainda: a recusa é do diálogo (nada foi feito); com algo aplicado, o resultado diz o que ficou de fora
        if (i === 0) throw e;
        if (isApiError(e, 'unauthenticated')) throw e;
        partial = `${ops.slice(i).map((o) => o.text).join('; ')}. ${accessRefusal(e)}`;
        break;
      }
    }
    const roles = await listMemberRoles(org, userId).catch(() => null);
    return { roles, retired: retire && partial === null, partial };
  };

  const editor = () => {
    if (load.status === 'loading') return <StateView status="loading" title="Carregando acessos…" />;
    if (load.status === 'error')
      return (
        <Alert tone="warning" title={isApiError(load.error, 'not_found', 'invalid_request') ? 'Membro não encontrado nesta organização.' : 'Não foi possível carregar os acessos.'}>
          Feche e tente de novo. Nada foi alterado.
        </Alert>
      );
    const d = load.data;
    return (
      <Stack gap={4}>
        {!active && (
          <Alert tone="info">
            {d.membershipState === 'RETIRADO'
              ? 'Esta pessoa foi retirada da organização. Para voltar, só com um convite novo.'
              : 'Com o vínculo fora de "ativo", papéis não podem ser atribuídos nem trocados.'}
          </Alert>
        )}
        <section aria-labelledby={`acessos-atuais-${userId}`}>
          <Text as="h3" variant="h4" id={`acessos-atuais-${userId}`}>
            Acessos atuais
          </Text>
          {rows.length === 0 ? (
            <Text color="secondary">Nenhum acesso ativo.</Text>
          ) : (
            <ul className="pw-access__list" aria-label="Acessos atuais">
              {rows.map((r, i) => {
                const sameScope = ROLE_OPTIONS.filter((o) => (o.scope === 'workspace') === !!r.assignment.workspaceId);
                return (
                  <li key={r.assignment.assignmentId} className={`pw-access__item${r.remove ? ' pw-access__item--removed' : ''}`}>
                    <div className="pw-access__scope">
                      <Text>{wsName(r.assignment.workspaceId)}</Text>
                      {r.remove && (
                        <Badge tone="danger" size="sm">
                          Será revogado
                        </Badge>
                      )}
                    </div>
                    {sameScope.length > 1 ? (
                      <Select
                        label={`Perfil em ${wsName(r.assignment.workspaceId)}`}
                        value={r.role}
                        disabled={!active || r.remove || retire}
                        onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, role: e.target.value as RoleCode } : x)))}
                        options={sameScope.map((o) => ({ value: o.value, label: o.label }))}
                      />
                    ) : (
                      <Text>{ROLE_LABEL[r.role]}</Text>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={retire || d.membershipState === 'RETIRADO'}
                      aria-label={`${r.remove ? 'Manter' : 'Revogar'} ${label(r.assignment.role, r.assignment.workspaceId)}`}
                      onClick={() => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, remove: !x.remove, role: x.assignment.role } : x)))}
                    >
                      {r.remove ? 'Manter' : 'Revogar'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {active && (
          <section aria-labelledby={`acessos-novo-${userId}`}>
            <Text as="h3" variant="h4" id={`acessos-novo-${userId}`}>
              Acrescentar acesso
            </Text>
            {additions.length > 0 && (
              <ul className="pw-access__list" aria-label="Acessos a acrescentar">
                {additions.map((a) => (
                  <li key={a.key} className="pw-access__item">
                    <div className="pw-access__scope">
                      <Text>{label(a.role, a.workspaceId)}</Text>
                      <Badge tone="info" size="sm">
                        Será atribuído
                      </Badge>
                    </div>
                    <Button size="sm" variant="ghost" aria-label={`Desfazer ${label(a.role, a.workspaceId)}`} onClick={() => setAdditions((xs) => xs.filter((x) => x.key !== a.key))}>
                      Desfazer
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="pw-access__add">
              <Select
                label="Perfil"
                value={newRole}
                placeholder="Escolha um perfil"
                disabled={retire}
                onChange={(e) => {
                  setNewRole(e.target.value as RoleCode);
                  setNewWorkspace('');
                }}
                options={roleOptions}
              />
              {isWorkspaceRole(newRole) && (
                <Select
                  label="Ambiente de trabalho"
                  value={newWorkspace}
                  placeholder={workspaceOptions.length ? 'Escolha um ambiente de trabalho' : 'Nenhum ambiente disponível'}
                  disabled={retire}
                  onChange={(e) => setNewWorkspace(e.target.value)}
                  options={workspaceOptions}
                />
              )}
              <Button
                variant="secondary"
                disabled={!canAdd || retire}
                onClick={() => {
                  if (!newRole) return;
                  setAdditions((xs) => [...xs, { key: seq, role: newRole, workspaceId: isWorkspaceRole(newRole) ? newWorkspace : null }]);
                  setSeq((n) => n + 1);
                  setNewRole('');
                  setNewWorkspace('');
                }}
              >
                Acrescentar
              </Button>
            </div>
          </section>
        )}

        {d.membershipState !== 'RETIRADO' && (
          <Checkbox
            label="Retirar esta pessoa da organização"
            hint="Revoga todos os papéis e encerra as sessões dela nesta organização. A identidade Nekkora não muda. Voltar, só com um convite novo."
            checked={retire}
            onChange={(e) => setRetire(e.target.checked)}
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
      confirmLabel={retire ? 'Retirar e salvar' : 'Salvar acessos'}
      tone={retire ? 'danger' : 'primary'}
      ready={load.status === 'ready' && changes.length > 0}
      guard={{ operation: 'member.access.save', target: userId }}
      stepUp={orgStepUp(org)}
      action={save}
      onDone={(saved) => onSaved(userId, saved)}
      onClose={onClose}
      refusalText={(e) =>
        accessRefusal(e, {
          conflict: 'O vínculo ou a conta desta pessoa mudou, ou ela já tem esse papel.',
          forbidden: 'O ato não foi permitido (por exemplo, o seu próprio acesso, o último administrador da organização ou a confirmação vencida).',
        })
      }
      uncertainText="Não foi possível confirmar se os acessos foram salvos. Feche e confira os acessos atuais antes de repetir."
      onUnauthenticated={onUnauthenticated}
    >
      {target && editor()}
    </StepUpDialog>
  );
}
