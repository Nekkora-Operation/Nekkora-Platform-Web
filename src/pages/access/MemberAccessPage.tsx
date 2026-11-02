import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { Alert, Button, Card, Select, Stack, StateView, Text } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { assignRole, listMemberRoles, replaceRole, revokeMembership, revokeRole, type MemberRoles, type RoleAssignment, type RoleCode } from '../../api/access';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { orgPath } from '../../auth/organization';
import { StepUpDialog } from '../../components/StepUpDialog';
import { MembershipStatusBadge } from '../admin/shared';
import { LoadErrorState, NotFoundState, PageHeader, useBackTarget } from '../product/shared';
import '../../identity/identity.css';
import { accessRefusal, isWorkspaceRole, orgStepUp, ROLE_LABEL, ROLE_OPTIONS } from './shared';

type State = { status: 'loading' } | { status: 'ready'; data: MemberRoles } | { status: 'error'; error: unknown };

type Pending =
  | { kind: 'assign'; role: RoleCode; workspaceId?: string }
  | { kind: 'replace'; assignment: RoleAssignment; role: RoleCode }
  | { kind: 'revoke'; assignment: RoleAssignment }
  | { kind: 'membership' };

/** Nome vindo da lista de membros (estado de navegação): só apresentação; a API identifica pelo id. */
export interface MemberAccessNav {
  displayName?: string;
}

const MEMBERSHIP_LABEL: Record<MemberRoles['membershipState'], 'pending' | 'active' | 'suspended' | 'revoked'> = {
  PENDENTE: 'pending',
  ATIVO: 'active',
  SUSPENSO: 'suspended',
  RETIRADO: 'revoked',
};

/**
 * /o/{org}/administracao/membros/:userId — papéis e vínculo de um membro (org.manage). Atribuir e alterar exigem step-up;
 * revogar papel e retirar o vínculo não. A API recusa o próprio ator e a retirada do último administrador (403) — a
 * tela não tenta adivinhar: mostra a recusa.
 */
export function MemberAccessPage() {
  const { org, expired } = useSession();
  const { workspaces } = useInternalArea();
  const { userId = '' } = useParams();
  const nav = (useLocation().state as MemberAccessNav | null) ?? {};
  const back = useBackTarget(orgPath.members(org));
  const [state, setState] = useState<State>({ status: 'loading' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [newRole, setNewRole] = useState<RoleCode | ''>('');
  const [newWorkspace, setNewWorkspace] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setState({ status: 'loading' });
    try {
      const data = await listMemberRoles(org, userId);
      if (gen === generation.current) setState({ status: 'ready', data });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      setState({ status: 'error', error: e });
    }
  }, [org, userId, expired]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  const name = nav.displayName ?? 'este membro';
  const wsName = (id: string | null) => (id ? (workspaces.items.find((w) => w.workspaceId === id)?.name ?? `workspace ${id.slice(0, 8)}…`) : '');
  const done = (text: string) => {
    setPending(null);
    setNotice({ tone: 'success', text });
    void load();
  };
  const uncertain = () => setNotice({ tone: 'warning', text: 'O resultado do último ato não foi confirmado. A lista abaixo foi recarregada: confira antes de repetir.' });

  if (state.status === 'loading') return <StateView status="loading" title="Carregando acessos…" />;
  if (state.status === 'error') {
    if (isApiError(state.error, 'not_found', 'invalid_request')) return <NotFoundState title="Membro não encontrado" back={{ to: back, label: 'Voltar para membros' }} />;
    return <LoadErrorState error={state.error} onRetry={() => void load()} page />;
  }

  const { data } = state;
  const active = data.membershipState === 'ATIVO';
  const roleRow = (a: RoleAssignment) => (
    <li key={a.assignmentId} className="pw-identity__org">
      <div className="pw-identity__org-main">
        <Text>{ROLE_LABEL[a.role] ?? a.role}</Text>
        <Text variant="body-sm" color="secondary">
          {a.workspaceId ? `Workspace ${wsName(a.workspaceId)}` : 'Toda a organização'}
        </Text>
      </div>
      {active && (
        <div className="pw-form__row">
          {ROLE_OPTIONS.filter((o) => o.value !== a.role && (o.scope === 'workspace') === !!a.workspaceId).map((o) => (
            <Button key={o.value} size="sm" variant="secondary" onClick={() => setPending({ kind: 'replace', assignment: a, role: o.value })}>
              Mudar para {o.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'revoke', assignment: a })}>
            Revogar
          </Button>
        </div>
      )}
    </li>
  );

  return (
    <Stack gap={5} className="pw-identity">
      <PageHeader title={`Acessos de ${name}`} back={{ to: back, label: 'Voltar para membros' }} onRefresh={() => void load()} />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <div className="pw-form__row">
        <Text>Vínculo:</Text>
        <MembershipStatusBadge status={MEMBERSHIP_LABEL[data.membershipState]} />
      </div>
      {!active && <Alert tone="info">Com o vínculo fora de "ativo", papéis não podem ser atribuídos. Readmissão só por convite novo.</Alert>}

      <Card variant="outlined" padding="lg">
        <Stack gap={3}>
          <Text as="h2" variant="h4">
            Papéis ativos
          </Text>
          {data.organizationRoles.length + data.workspaceRoles.length === 0 ? (
            <Text color="secondary">Nenhum papel ativo.</Text>
          ) : (
            <ul className="pw-identity__orgs" aria-label="Papéis ativos">
              {[...data.organizationRoles, ...data.workspaceRoles].map(roleRow)}
            </ul>
          )}
        </Stack>
      </Card>

      {active && (
        <Card variant="outlined" padding="lg">
          <div className="pw-identity__form">
            <Text as="h2" variant="h4">
              Atribuir papel
            </Text>
            <Select
              label="Papel"
              fullWidth
              value={newRole}
              placeholder="Escolha um papel"
              onChange={(e) => {
                setNewRole(e.target.value as RoleCode);
                setNewWorkspace('');
              }}
              options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
            {isWorkspaceRole(newRole) && (
              <Select
                label="Workspace"
                fullWidth
                value={newWorkspace}
                placeholder="Escolha um workspace"
                onChange={(e) => setNewWorkspace(e.target.value)}
                options={workspaces.items.filter((w) => w.status === 'active').map((w) => ({ value: w.workspaceId, label: w.name }))}
              />
            )}
            <div>
              <Button
                disabled={!newRole || (isWorkspaceRole(newRole) && !newWorkspace)}
                onClick={() => newRole && setPending({ kind: 'assign', role: newRole, workspaceId: newWorkspace || undefined })}
              >
                Atribuir
              </Button>
            </div>
          </div>
        </Card>
      )}

      {data.membershipState !== 'RETIRADO' && (
        <Card variant="outlined" padding="lg">
          <Stack gap={3}>
            <Text as="h2" variant="h4">
              Retirar da organização
            </Text>
            <Text color="secondary">
              Revoga todos os papéis e encerra as sessões desta pessoa na organização. A identidade Nekkora dela, a senha e o
              autenticador não mudam. Voltar só com um convite novo.
            </Text>
            <div>
              <Button variant="danger" onClick={() => setPending({ kind: 'membership' })}>
                Retirar vínculo
              </Button>
            </div>
          </Stack>
        </Card>
      )}

      <StepUpDialog
        open={pending?.kind === 'assign'}
        title={pending?.kind === 'assign' ? `Atribuir ${ROLE_LABEL[pending.role]} a ${name}?` : ''}
        guard={{ operation: 'role.assign', target: pending?.kind === 'assign' ? `${userId}|${pending.role}|${pending.workspaceId ?? ''}` : undefined }}
        confirmLabel="Atribuir papel"
        stepUp={orgStepUp(org)}
        action={() => (pending?.kind === 'assign' ? assignRole(org, userId, pending.role, pending.workspaceId) : Promise.reject())}
        onDone={() => {
          setNewRole('');
          setNewWorkspace('');
          done('Papel atribuído. A pessoa recebe um aviso; o acesso vale na próxima requisição dela.');
        }}
        onClose={() => setPending(null)}
        refusalText={(e) => accessRefusal(e, { conflict: 'O vínculo ou a conta desta pessoa não está ativo.', forbidden: 'Você não pode atribuir este papel (permissão, o próprio acesso ou confirmação vencida).' })}
        uncertainText="Não foi possível confirmar a atribuição. Feche e confira os papéis atuais antes de repetir."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && uncertain()}
      >
        {pending?.kind === 'assign' && <Text>{pending.workspaceId ? `Escopo: workspace ${wsName(pending.workspaceId)}.` : 'Escopo: toda a organização.'}</Text>}
      </StepUpDialog>

      <StepUpDialog
        open={pending?.kind === 'replace'}
        title={pending?.kind === 'replace' ? `Mudar ${ROLE_LABEL[pending.assignment.role]} para ${ROLE_LABEL[pending.role]}?` : ''}
        guard={{ operation: 'role.replace', target: pending?.kind === 'replace' ? pending.assignment.assignmentId : undefined }}
        confirmLabel="Mudar papel"
        stepUp={orgStepUp(org)}
        action={() => (pending?.kind === 'replace' ? replaceRole(org, pending.assignment.assignmentId, pending.role) : Promise.reject())}
        onDone={() => done('Papel alterado no mesmo escopo.')}
        onClose={() => setPending(null)}
        refusalText={(e) => accessRefusal(e, { conflict: 'A pessoa já tem o papel novo neste escopo.' })}
        uncertainText="Não foi possível confirmar a mudança. Feche e confira os papéis atuais antes de repetir."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && uncertain()}
      >
        <Text>O papel atual é revogado e o novo é criado no mesmo ato e no mesmo escopo.</Text>
      </StepUpDialog>

      <StepUpDialog
        open={pending?.kind === 'revoke'}
        title={pending?.kind === 'revoke' ? `Revogar ${ROLE_LABEL[pending.assignment.role]} de ${name}?` : ''}
        guard={{ operation: 'role.revoke', target: pending?.kind === 'revoke' ? pending.assignment.assignmentId : undefined }}
        confirmLabel="Revogar papel"
        tone="danger"
        action={() => (pending?.kind === 'revoke' ? revokeRole(org, pending.assignment.assignmentId) : Promise.reject())}
        onDone={() => done('Papel revogado. Deixa de valer na próxima requisição da pessoa.')}
        onClose={() => setPending(null)}
        refusalText={(e) => accessRefusal(e, { forbidden: 'A revogação não foi permitida (por exemplo, o último administrador da organização ou o seu próprio papel).' })}
        uncertainText="Não foi possível confirmar a revogação. Feche e confira os papéis atuais."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && uncertain()}
      >
        <Text>As sessões da pessoa não são encerradas; o papel deixa de valer na próxima requisição dela.</Text>
      </StepUpDialog>

      <StepUpDialog
        open={pending?.kind === 'membership'}
        title={`Retirar ${name} da organização?`}
        guard={{ operation: 'membership.revoke', target: userId }}
        confirmLabel="Retirar vínculo"
        tone="danger"
        action={() => revokeMembership(org, userId)}
        onDone={() => done('Vínculo retirado. Os papéis foram revogados e as sessões da pessoa nesta organização, encerradas.')}
        onClose={() => setPending(null)}
        refusalText={(e) => accessRefusal(e, { forbidden: 'A retirada não foi permitida (por exemplo, o último administrador da organização ou você mesma/o).' })}
        uncertainText="Não foi possível confirmar a retirada. Feche e confira o vínculo atual."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && uncertain()}
      >
        <Text>Todos os papéis são revogados e as sessões da pessoa nesta organização são encerradas agora. Não é possível desfazer: só um convite novo readmite.</Text>
      </StepUpDialog>
    </Stack>
  );
}
