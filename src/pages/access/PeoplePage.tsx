import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Input, Link, RadioGroup, Select, Stack, StateView, StatusRegion, Table, Text, type TableColumn } from 'nekkora-lib';
import { Link as RouterLink } from 'react-router';
import { isApiError } from '../../api/http';
import {
  issueInvitation,
  listPeople,
  resendInvitation,
  revokeInvitation,
  type MemberRoles,
  type PersonInvitation,
  type PersonItem,
  type PersonMember,
  type PersonRole,
  type PersonSituation,
  type RoleCode,
} from '../../api/access';
import type { Member } from '../../api/v1';
import { inviteClient, type PersonClient } from '../../api/clientAccess';
import { orgPath } from '../../auth/organization';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import {
  clearSettled,
  dismissWrite,
  isMemberEntry,
  isMfaEntry,
  restoreUncertain,
  rootError,
  targetRef,
  useWriteEntries,
  writeEntry,
  type MemberEntry,
  type MfaEntry,
  type WriteAction,
  type WriteEntry,
} from '../../admin/writeStore';
import { StepUpDialog } from '../../components/StepUpDialog';
import { useCursorList } from '../../hooks/useCursorList';
import { DateTimeText, LoadErrorState, useExpiresOn } from '../product/shared';
import { ACTION_LABEL, effectiveStatus, findMember, MEMBER_UNCERTAIN_COPY, MemberActionDialog, type ActionDialogState } from '../admin/memberActions';
import { effectiveMfaConfigured, findMfa, MFA_UNCERTAIN_COPY, MfaResetDialog, mfaTarget, type MfaResetDialogState } from '../admin/mfaResetActions';
import { UncertainPanel, type UncertainCopy } from '../admin/uncertainPanel';
import { ADMIN_PAGE, AccountStatusBadge, AdminLoadMore, ForbiddenState, StatusFilter, useAccessDenied, useUrlFilters } from '../admin/shared';
import type { PageFrame } from './PeopleAccessPage';
import { MemberAccessDialog, type AccessSaved, type AccessTarget } from './MemberAccessDialog';
import { ClientAccessDialog, type ClientAccessSaved } from './ClientAccessDialog';
import {
  ClientInviteFields,
  draftErrors,
  EMPTY_CLIENT_DRAFT,
  resolveDraft,
  type ClientInviteDraft,
  type ClientInviteOptions,
  type ClientInviteResolved,
} from './ClientInviteFields';
import { clientRefusal, inviteSummary, machineScopeText, permissionsText } from './clientShared';
import { accessRefusal, isWorkspaceRole, orgStepUp, REVOKE_REASON_LABEL, ROLE_LABEL, ROLE_OPTIONS } from './shared';
import '../admin/admin.css';
import '../../identity/identity.css';
import './people.css';

type PeopleEntry = MemberEntry | MfaEntry;

/** Situações do filtro, na ordem da tela; nenhuma marcada = a visualização padrão (pendentes e membros). */
export const SITUATION_ORDER: readonly PersonSituation[] = [
  'invitation_pending',
  'member_active',
  'member_suspended',
  'member_pending',
  'member_revoked',
  'client_active',
  'client_suspended',
  'client_revoked',
  'invitation_expired',
  'invitation_revoked',
  'invitation_accepted',
];
export const SITUATION_LABEL: Record<PersonSituation, string> = {
  invitation_pending: 'Convite pendente',
  invitation_expired: 'Convite vencido',
  invitation_revoked: 'Convite revogado',
  invitation_accepted: 'Convite aceito',
  member_pending: 'Membro com vínculo pendente',
  member_active: 'Membro ativo',
  member_suspended: 'Membro suspenso',
  member_revoked: 'Retirado da organização',
  client_active: 'Cliente ativo',
  client_suspended: 'Cliente suspenso',
  client_revoked: 'Cliente retirado',
};
const CLIENT_SITUATION: Record<PersonClient['status'], { label: string; tone: 'success' | 'neutral' | 'warning' | 'info' }> = {
  active: { label: 'Cliente ativo', tone: 'success' },
  pending: { label: 'Cliente com vínculo pendente', tone: 'info' },
  suspended: { label: 'Cliente suspenso', tone: 'warning' },
  revoked: { label: 'Cliente retirado', tone: 'neutral' },
};
const MEMBERSHIP_SITUATION: Record<PersonMember['membershipStatus'], { label: string; tone: 'success' | 'neutral' | 'warning' | 'info' }> = {
  active: { label: 'Membro ativo', tone: 'success' },
  pending: { label: 'Vínculo pendente', tone: 'info' },
  suspended: { label: 'Membro suspenso', tone: 'warning' },
  revoked: { label: 'Retirado', tone: 'neutral' },
};
const INVITATION_SITUATION: Record<PersonInvitation['state'], { label: string; tone: 'info' | 'neutral' | 'success' }> = {
  PENDENTE: { label: 'Convite pendente', tone: 'info' },
  EXPIRADO: { label: 'Convite vencido', tone: 'neutral' },
  REVOGADO: { label: 'Convite revogado', tone: 'neutral' },
  ACEITO: { label: 'Convite aceito', tone: 'neutral' },
};

/** O membro da lista unificada no formato das ações herdadas da página de Membros (suspender, reativar, MFA). */
const asMember = (m: PersonMember): Member => ({
  membershipId: m.membershipId,
  userId: m.userId,
  displayName: m.displayName,
  email: m.email,
  emailVerified: m.emailVerified,
  accountStatus: m.accountStatus,
  membershipStatus: m.membershipStatus,
  mfaConfigured: m.mfaConfigured,
  organizationRoles: m.roles.filter((r) => r.workspaceId === null && r.role === 'ORG_ADMIN').map(() => 'ORG_ADMIN' as const),
  createdAt: m.joinedAt,
});

type InvitationAct =
  | { kind: 'issue'; email: string; role: RoleCode | ''; workspaceId: string }
  | { kind: 'issue-client'; email: string; draft: ClientInviteDraft; resolved: ClientInviteResolved }
  | { kind: 'resend' | 'revoke'; invitation: PersonInvitation };

/**
 * /o/{org}/administracao/pessoas — "Pessoas e acessos" (PLATFORM-FLUXO-002): substitui Membros e Convites. No topo, o
 * convite (e-mail, perfil e, para perfil de ambiente, o ambiente; com a confirmação da hora). Abaixo, UMA tabela, sem
 * abas, com membros e convites (GET /people): pendentes primeiro, depois membros, do mais recente ao mais antigo em
 * cada grupo — a ordem é da API e vale para a lista inteira. Busca por nome/e-mail e filtro por situação no endereço;
 * convites vencidos, revogados e aceitos só pelo filtro (o aceito não repete o membro que ele criou).
 *
 * Ações: convite pendente — Reenviar e Revogar (as confirmações de sempre); membro — "Gerenciar acessos" (modal, aberto
 * também por ?acessos=<conta>, inclusive depois de recarregar), Suspender/Reativar e Redefinir MFA (como na antiga
 * página de Membros, com o mesmo registro de escritas incertas). Formulário e ações só para quem tem a permissão; a API
 * continua decidindo.
 */
/** A aba "Pessoas" de "Pessoas e acessos" (o título, as abas e o "Atualizar" ficam na página: PeopleAccessPage). */
export function PeoplePage({ frame }: { frame: PageFrame }) {
  const { org, expired } = useSession();
  const { permissions, workspaces } = useInternalArea();
  const filters = useUrlFilters<PersonSituation>({ statuses: SITUATION_ORDER, ids: ['acessos', 'cliente'], texts: ['q'] });
  const search = filters.ids.q ?? '';
  const [searchDraft, setSearchDraft] = useState(search);
  const [refresh, setRefresh] = useState(0);
  // convites ligados nesta Platform (vem na própria página da lista): sem eles, o formulário não aparece
  const [invitationsEnabled, setInvitationsEnabled] = useState(false);
  const list = useCursorList<PersonItem>(
    async (cursor) => {
      const page = await listPeople(org, {
        limit: ADMIN_PAGE,
        cursor,
        situation: filters.statuses.length ? [...filters.statuses] : undefined,
        q: search || undefined,
      });
      setInvitationsEnabled(page.invitationsEnabled);
      return page;
    },
    (p) => `${p.kind}:${p.id}`,
    // o modal (?acessos) não relê a lista: busca, filtros e posição continuam
    [org, filters.statuses.join(','), search, refresh],
  );
  // a busca vai ao endereço com uma pausa curta depois da digitação
  useEffect(() => setSearchDraft(search), [search]);
  useEffect(() => {
    if (searchDraft.trim() === search) return;
    const t = window.setTimeout(() => filters.setText('q', searchDraft), 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  const members = useMemo(() => list.items.filter((p): p is PersonItem & { member: PersonMember } => p.kind === 'member' && !!p.member), [list.items]);
  // linhas atualizadas pelo modal sem reler a lista (busca, filtros e posição continuam)
  const [patched, setPatched] = useState<Map<string, PersonMember>>(new Map());
  useEffect(() => setPatched(new Map()), [org, filters.statuses.join(','), search, refresh]);
  const memberOf = (p: PersonItem): PersonMember | null => (p.member ? (patched.get(p.member.membershipId) ?? p.member) : null);
  // o mesmo para as pessoas de cliente (070)
  const [patchedClients, setPatchedClients] = useState<Map<string, PersonClient>>(new Map());
  useEffect(() => setPatchedClients(new Map()), [org, filters.statuses.join(','), search, refresh]);
  const clientOf = (p: PersonItem): PersonClient | null => (p.client ? (patchedClients.get(p.client.clientMembershipId) ?? p.client) : null);

  const orgPermissions = permissions.status === 'ready' ? permissions.data.organization.permissions : [];
  const canManage = orgPermissions.includes('org.manage');
  // 070: convite de Cliente só por quem administra a organização E o acesso de clientes (a exceção da D-GRANT-1)
  const canExternal = orgPermissions.includes('external_access.manage');
  const canInviteClient = canManage && canExternal;
  const canReset = orgPermissions.includes('identity.mfa.reset');
  const self = permissions.status === 'ready' ? permissions.data.membershipId : null;

  useExpiresOn(list.error);
  // incerteza persistente (recarga, outra aba) volta para as linhas lidas (FRONT-V1-002)
  useEffect(() => {
    void restoreUncertain(org, [
      ...members.map((p) => ({ target: { userId: p.member.userId, membershipId: p.member.membershipId, displayName: p.member.displayName }, actions: ['suspend', 'reactivate', 'revoke'] as WriteAction[] })),
      ...members.map((p) => ({ target: mfaTarget(asMember(p.member)), actions: ['mfa-reset'] as WriteAction[] })),
    ]);
  }, [org, members, self]);
  const listDenied = useAccessDenied(list);
  const [checkDenied, setCheckDenied] = useState(false);
  const [recheck, setRecheck] = useState(false);
  const forbidden = listDenied || checkDenied;
  useEffect(() => {
    if (!recheck || list.status !== 'ready') return;
    setRecheck(false);
    if (!list.error) setCheckDenied(false);
  }, [recheck, list.status, list.error]);

  const all = useWriteEntries(org);
  const entries = all.filter(isMemberEntry);
  const mfaEntries = all.filter(isMfaEntry);
  const byUser = new Map(entries.map((e) => [e.target.userId, e]));
  const mfaByUser = new Map(mfaEntries.map((e) => [e.target.userId, e]));
  const [dialog, setDialog] = useState<ActionDialogState | null>(null);
  const [mfaDialog, setMfaDialog] = useState<MfaResetDialogState | null>(null);
  const mfaOpenSeq = useRef(0);
  const [announce, setAnnounce] = useState<{ text: string; n: number } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusTarget = useRef<string | null>(null);
  const say = (text: string) => setAnnounce((a) => ({ text, n: (a?.n ?? 0) + 1 }));

  useEffect(() => {
    clearSettled(org, 'member');
    clearSettled(org, 'mfa');
  }, [org, refresh]);

  const isExpired = (e: WriteEntry) =>
    (e.phase === 'refused' && isApiError(rootError(e.error), 'unauthenticated')) || isApiError(rootError(e.refusedRetry), 'unauthenticated');
  const expiredEntry = [...entries, ...mfaEntries].find(isExpired);
  useEffect(() => {
    if (!expiredEntry) return;
    const { kind, id } = targetRef(expiredEntry.target);
    dismissWrite(org, id, kind);
    expired();
  }, [expiredEntry, org, expired]);

  const dialogEntry = dialog ? byUser.get(dialog.member.userId) : undefined;
  useEffect(() => {
    if (!dialog || dialog.startedId === null || !dialogEntry || dialogEntry.id !== dialog.startedId) return;
    if (dialogEntry.phase === 'done') {
      say(ACTION_LABEL[dialogEntry.action].done(dialog.member.displayName));
      setDialog(null);
    }
  }, [dialog, dialogEntry]);
  const mfaDialogEntry = mfaDialog ? mfaByUser.get(mfaDialog.target.userId) : undefined;
  useEffect(() => {
    if (!mfaDialog || mfaDialog.startedId === null || !mfaDialogEntry || mfaDialogEntry.id !== mfaDialog.startedId) return;
    if (mfaDialogEntry.phase === 'done') {
      say(ACTION_LABEL['mfa-reset'].done(mfaDialog.target.displayName));
      setMfaDialog(null);
    }
  }, [mfaDialog, mfaDialogEntry]);
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
  const retryFrom = (e: PeopleEntry) => {
    if (isMfaEntry(e)) return openMfa(e.target, true);
    const found = members.find((p) => p.member.userId === e.target.userId);
    open(e.action, found ? asMember(found.member) : ({ userId: e.target.userId, membershipId: e.target.membershipId, displayName: e.target.displayName } as Member), true);
  };

  // ------------------------------------------------------------------ modal de acessos (?acessos=<conta>)
  const accessUser = filters.ids.acessos;
  const accessRow = accessUser ? members.find((p) => p.member.userId === accessUser) : undefined;
  const accessTarget: AccessTarget | null = canManage && accessUser ? { userId: accessUser, displayName: accessRow?.member.displayName ?? null } : null;
  const openAccess = (m: PersonMember) => {
    focusTarget.current = m.userId;
    filters.setId('acessos', m.userId);
  };
  const closeAccess = () => {
    filters.setId('acessos', null);
    const id = focusTarget.current;
    window.setTimeout(() => (id ? document.querySelector<HTMLElement>(`[data-acessos="${id}"]`)?.focus() : null), 0);
  };
  const toPersonRoles = (r: MemberRoles): PersonRole[] =>
    [...r.organizationRoles, ...r.workspaceRoles].map((a) => ({
      role: a.role,
      workspaceId: a.workspaceId,
      workspaceName: a.workspaceId ? (workspaces.items.find((w) => w.workspaceId === a.workspaceId)?.name ?? null) : null,
    }));
  const onAccessSaved = (userId: string, saved: AccessSaved) => {
    const row = members.find((p) => p.member.userId === userId);
    if (row) {
      const current = memberOf(row)!;
      const next: PersonMember = {
        ...current,
        roles: saved.roles ? toPersonRoles(saved.roles) : saved.retired ? [] : current.roles,
        membershipStatus: saved.retired ? 'revoked' : current.membershipStatus,
      };
      setPatched((m) => new Map(m).set(current.membershipId, next));
    }
    const name = row?.member.displayName ?? 'o membro';
    if (saved.partial) setNotice({ tone: 'warning', text: `Parte dos acessos de ${name} foi salva. Ficou de fora: ${saved.partial}` });
    else setNotice({ tone: 'success', text: saved.retired ? `${name} foi retirada(o) da organização.` : `Acessos de ${name} salvos.` });
    closeAccess();
  };

  // ------------------------------------------------------------------ acessos de cliente (?cliente=<vínculo>)
  const clientMembership = filters.ids.cliente;
  const clientRow = clientMembership ? list.items.find((p) => p.client?.clientMembershipId === clientMembership) : undefined;
  const clientTarget = canManage && clientRow ? clientOf(clientRow) : null;
  const openClientAccess = (c: PersonClient) => {
    focusTarget.current = c.clientMembershipId;
    filters.setId('cliente', c.clientMembershipId);
  };
  const closeClientAccess = () => {
    filters.setId('cliente', null);
    const id = focusTarget.current;
    window.setTimeout(() => (id ? document.querySelector<HTMLElement>(`[data-cliente="${id}"]`)?.focus() : null), 0);
  };
  const onClientSaved = (membershipId: string, saved: ClientAccessSaved) => {
    const row = list.items.find((p) => p.client?.clientMembershipId === membershipId);
    if (row) {
      const current = clientOf(row)!;
      setPatchedClients((m) => new Map(m).set(membershipId, { ...current, status: saved.status, grants: saved.grants ?? current.grants }));
    }
    const name = row?.client?.displayName ?? 'a pessoa';
    if (saved.partial) setNotice({ tone: 'warning', text: `Parte dos acessos de ${name} foi salva. Ficou de fora: ${saved.partial}` });
    else
      setNotice({
        tone: 'success',
        text: saved.requested
          ? `Acessos de ${name} salvos. O novo compartilhamento aguarda a aprovação de outra pessoa em Acessos e histórico.`
          : `Acessos de ${name} salvos.`,
      });
    closeClientAccess();
  };

  // ------------------------------------------------------------------ convites
  const [inviteType, setInviteType] = useState<'internal' | 'client'>('internal');
  const [clientDraft, setClientDraft] = useState<ClientInviteDraft>(EMPTY_CLIENT_DRAFT);
  const [clientOptions, setClientOptions] = useState<ClientInviteOptions | null>(null);
  const [clientErrors, setClientErrors] = useState<{ name?: string; automation?: string; content?: string }>({});
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleCode | ''>('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [formError, setFormError] = useState<{ email?: string; workspace?: string }>({});
  const [act, setAct] = useState<InvitationAct | null>(null);
  const workspaceOptions = workspaces.items.filter((w) => w.status === 'active').map((w) => ({ value: w.workspaceId, label: w.name }));
  const workspaceName = (id: string | null, fallback?: string | null) =>
    id ? (fallback ?? workspaces.items.find((w) => w.workspaceId === id)?.name ?? `ambiente de trabalho ${id.slice(0, 8)}…`) : null;
  // a pessoa já é membro interno (na lista carregada): o convite de Cliente não reduziria os acessos dela
  const internalMatch =
    inviteType === 'client' && email.trim() ? members.find((p) => p.member.email.toLowerCase() === email.trim().toLowerCase()) : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (inviteType === 'client') {
      const emailError = /^[^\s@]+@[^\s@]+$/.test(email.trim()) ? undefined : 'Informe um e-mail válido.';
      const cErrors = draftErrors(clientDraft);
      setFormError({ email: emailError });
      setClientErrors(cErrors);
      const resolved = clientOptions ? resolveDraft(clientDraft, clientOptions) : null;
      if (emailError || cErrors.name || cErrors.automation || cErrors.content || !resolved) return;
      setNotice(null);
      setAct({ kind: 'issue-client', email: email.trim(), draft: clientDraft, resolved });
      return;
    }
    const errors = {
      email: /^[^\s@]+@[^\s@]+$/.test(email.trim()) ? undefined : 'Informe um e-mail válido.',
      workspace: isWorkspaceRole(role) && !workspaceId ? 'Escolha o ambiente de trabalho do perfil.' : undefined,
    };
    setFormError(errors);
    if (errors.email || errors.workspace) return;
    setNotice(null);
    setAct({ kind: 'issue', email: email.trim(), role, workspaceId });
  };
  const actDone = (text: string) => {
    setAct(null);
    setNotice({ tone: 'success', text });
    // a tabela é lida de novo: o convite novo aparece no topo (pendentes primeiro)
    setRefresh((n) => n + 1);
  };
  const uncertain = (text: string) => setNotice({ tone: 'warning', text });

  // ------------------------------------------------------------------ tabela
  const roleText = (r: { role: string | null; workspaceId: string | null; workspaceName: string | null }) =>
    r.role ? `${ROLE_LABEL[r.role as RoleCode] ?? r.role}${r.workspaceId ? ` · ${workspaceName(r.workspaceId, r.workspaceName)}` : ''}` : 'Sem perfil (só o vínculo)';

  const memberActions = (m: PersonMember) => {
    const e = byUser.get(m.userId);
    const f = mfaByUser.get(m.userId);
    if (e?.phase === 'sending' || f?.phase === 'sending') return <Text variant="body-sm" color="secondary">Enviando…</Text>;
    if (e?.phase === 'uncertain' || f?.phase === 'uncertain') return <Text variant="body-sm" color="secondary">Resultado não confirmado</Text>;
    const member = asMember(m);
    const mine = m.membershipId === self;
    const status = effectiveStatus(member, e);
    // a própria conta fica sem ações (a API recusa mudar o próprio acesso); retirados não têm acesso a gerenciar
    const access = canManage && !mine && m.membershipStatus !== 'revoked' ? (
      <Button size="sm" variant="secondary" data-acessos={m.userId} aria-label={`Gerenciar acessos de ${m.displayName}`} onClick={() => openAccess(m)}>
        Gerenciar acessos
      </Button>
    ) : null;
    const accountAction =
      !canManage || mine ? null : status === 'active' ? (
        <Button size="sm" variant="ghost" data-membro-acao={m.userId} aria-label={`Suspender ${m.displayName}`} onClick={() => open('suspend', member)}>
          Suspender
        </Button>
      ) : status === 'suspended' ? (
        <Button size="sm" variant="ghost" data-membro-acao={m.userId} aria-label={`Reativar ${m.displayName}`} onClick={() => open('reactivate', member)}>
          Reativar
        </Button>
      ) : null;
    const mfaAction =
      canReset && !mine && effectiveMfaConfigured(member, f) ? (
        <Button size="sm" variant="ghost" data-mfa-acao={m.userId} aria-label={`Redefinir MFA de ${m.displayName}`} onClick={() => openMfa(mfaTarget(member))}>
          Redefinir MFA
        </Button>
      ) : null;
    if (!access && !accountAction && !mfaAction) return <span className="pw-prod__muted">{mine ? 'Sua conta' : '—'}</span>;
    return (
      <span className="pw-admin__row-actions pw-people__actions">
        {access}
        {accountAction}
        {mfaAction}
      </span>
    );
  };

  const clientActions = (c: PersonClient) =>
    canManage && c.status !== 'revoked' ? (
      <span className="pw-admin__row-actions pw-people__actions">
        <Button size="sm" variant="secondary" data-cliente={c.clientMembershipId} aria-label={`Gerenciar acessos de ${c.displayName}`} onClick={() => openClientAccess(c)}>
          Gerenciar acessos
        </Button>
      </span>
    ) : (
      <span className="pw-prod__muted">—</span>
    );

  const invitationActions = (i: PersonInvitation) => {
    if (!canManage || (i.state !== 'PENDENTE' && i.state !== 'EXPIRADO')) return <span className="pw-prod__muted">—</span>;
    return (
      <span className="pw-admin__row-actions pw-people__actions">
        {!i.revokedAt && !i.acceptedAt && (
          <Button size="sm" variant="secondary" onClick={() => setAct({ kind: 'resend', invitation: i })} aria-label={`Reenviar convite para ${i.email}`}>
            Reenviar
          </Button>
        )}
        {i.state === 'PENDENTE' && (
          <Button size="sm" variant="ghost" onClick={() => setAct({ kind: 'revoke', invitation: i })} aria-label={`Revogar convite para ${i.email}`}>
            Revogar
          </Button>
        )}
      </span>
    );
  };

  const columns: TableColumn<PersonItem>[] = [
    {
      key: 'pessoa',
      header: 'Pessoa/e-mail',
      render: (p) => {
        const m = memberOf(p);
        const c = clientOf(p);
        if (m || c)
          return (
            <span className="pw-admin__person">
              <span>{(m ?? c)!.displayName}</span>
              <span className="pw-prod__muted pw-break">{(m ?? c)!.email}</span>
            </span>
          );
        return (
          <span className="pw-admin__person">
            <span className="pw-break">{p.invitation!.email}</span>
            <span className="pw-prod__muted">
              {p.invitation!.audience === 'client' ? 'Convidada(o) como cliente, ainda sem acesso' : 'Convidada(o), ainda sem conta nesta organização'}
            </span>
          </span>
        );
      },
    },
    {
      key: 'perfil',
      header: 'Perfil',
      render: (p) => {
        const c = clientOf(p);
        if (c)
          return (
            <span className="pw-admin__person">
              <span>Cliente · {c.clientName}</span>
              {c.grants.length === 0 ? (
                <span className="pw-prod__muted">Nenhuma automação compartilhada</span>
              ) : (
                <ul className="pw-people__roles" aria-label={`Automações compartilhadas com ${c.displayName}`}>
                  {c.grants.map((g) => (
                    <li key={g.grantId}>
                      {g.kind === 'workspace' ? `Ambiente ${g.workspace.name} inteiro` : `Acompanha ${g.automation?.name}`}
                      {g.kind === 'automation' && <span className="pw-prod__muted"> · {g.machine ? `máquina ${g.machine.name}` : 'todas as máquinas'}</span>}
                      {g.situation === 'pending' && <span className="pw-prod__muted"> · aguardando aprovação</span>}
                    </li>
                  ))}
                </ul>
              )}
            </span>
          );
        const m = memberOf(p);
        if (!m) {
          const sc = p.invitation!.clientScope;
          if (sc)
            return (
              <span className="pw-admin__person">
                <span>
                  {sc.recipientName ? `${sc.recipientName} · ` : ''}Cliente · {sc.clientName}
                </span>
                <span className="pw-prod__muted">
                  {sc.automationName} ({sc.workspaceName}) · {sc.workerName ? `máquina ${sc.workerName}` : 'todas as máquinas'}
                </span>
                <span className="pw-prod__muted">{permissionsText(sc.canViewDashboard, sc.canDownloadResults)}</span>
              </span>
            );
          return roleText(p.invitation!);
        }
        if (m.roles.length === 0) return <span className="pw-prod__muted">Sem perfil</span>;
        return (
          <ul className="pw-people__roles" aria-label={`Perfis de ${m.displayName}`}>
            {m.roles.map((r) => (
              <li key={`${r.role}:${r.workspaceId ?? 'org'}`}>{r.workspaceId ? roleText(r) : 'Administração da organização'}</li>
            ))}
          </ul>
        );
      },
    },
    {
      key: 'situacao',
      header: 'Situação',
      render: (p) => {
        const c = clientOf(p);
        if (c) {
          const s = CLIENT_SITUATION[c.status];
          return (
            <span className="pw-admin__person">
              <Badge tone={s.tone} dot>
                {s.label}
              </Badge>
              {!c.linkedToIdentity && <span className="pw-prod__muted">Conta antiga, sem identidade Nekkora</span>}
            </span>
          );
        }
        const m = memberOf(p);
        if (m) {
          const s = MEMBERSHIP_SITUATION[m.membershipStatus];
          const e = byUser.get(m.userId);
          const account = effectiveStatus(asMember(m), e);
          return (
            <span className="pw-admin__person">
              <Badge tone={s.tone} dot>
                {s.label}
              </Badge>
              {account !== 'active' && <AccountStatusBadge status={account} />}
              {!m.emailVerified && <span className="pw-prod__muted">E-mail não confirmado</span>}
              <span className="pw-prod__muted">MFA: {effectiveMfaConfigured(asMember(m), mfaByUser.get(m.userId)) ? 'Configurado' : 'Não configurado'}</span>
            </span>
          );
        }
        const i = p.invitation!;
        const s = INVITATION_SITUATION[i.state];
        return (
          <span className="pw-admin__person">
            <Badge tone={s.tone} variant="outline">
              {i.audience === 'client' ? s.label.replace('Convite', 'Convite de cliente') : s.label}
            </Badge>
            {i.revokeReason && <span className="pw-prod__muted">{REVOKE_REASON_LABEL[i.revokeReason]}</span>}
          </span>
        );
      },
    },
    {
      key: 'data',
      header: 'Data',
      render: (p) => {
        const m = memberOf(p) ?? clientOf(p);
        if (m)
          return (
            <span className="pw-admin__person">
              <span className="pw-prod__muted">Entrou em</span>
              <DateTimeText iso={m.joinedAt} />
            </span>
          );
        const i = p.invitation!;
        return (
          <span className="pw-admin__person">
            <span className="pw-prod__muted">Convidada(o) em</span>
            <DateTimeText iso={i.createdAt} />
            {i.state === 'PENDENTE' && (
              <span className="pw-prod__muted">
                vale até <DateTimeText iso={i.expiresAt} />
              </span>
            )}
          </span>
        );
      },
    },
    ...(canManage || canReset
      ? [
          {
            key: 'acoes',
            header: 'Ações',
            align: 'right' as const,
            render: (p: PersonItem) => (p.member ? memberActions(memberOf(p)!) : p.client ? clientActions(clientOf(p)!) : invitationActions(p.invitation!)),
          },
        ]
      : []),
  ];

  const pending: PeopleEntry[] = [...entries, ...mfaEntries].filter((e) => e.phase === 'uncertain' || (e.phase === 'sending' && e.retry));
  const copyFor = (e: PeopleEntry) => (isMfaEntry(e) ? MFA_UNCERTAIN_COPY : MEMBER_UNCERTAIN_COPY) as UncertainCopy<PeopleEntry>;
  const listRegion = () => document.querySelector<HTMLElement>('[aria-label="Lista de pessoas e convites"]');
  const filtered = filters.statuses.length > 0 || !!search;

  return frame({
    onRefresh: forbidden ? undefined : () => setRefresh((n) => n + 1),
    refreshing: list.status === 'loading' && refresh > 0,
    children: (
    <Stack gap={5}>
      {(canManage || canExternal) && (
        <nav className="pw-people__shortcuts" aria-label="Cadastro de clientes">
          <Link as={RouterLink} to={orgPath.clientsManage(org)} arrow>
            Gerenciar clientes
          </Link>
        </nav>
      )}
      <StatusRegion aria-label="Resultado das ações" message={announce?.text} announceKey={announce?.n} />
      {notice && (
        <Alert tone={notice.tone} role={notice.tone === 'success' ? 'status' : 'alert'}>
          {notice.text}
        </Alert>
      )}
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
            dismissWrite(org, id, kind, { acknowledge: true });
          }}
          onUnauthenticated={expired}
          onForbidden={() => setCheckDenied(true)}
        />
      )}
      {forbidden ? (
        <ForbiddenState
          area="as pessoas e os convites desta organização"
          onRetry={() => {
            setRecheck(true);
            list.reload();
          }}
        />
      ) : (
        <>
          {canManage && invitationsEnabled && (
            <Card variant="outlined" padding="lg">
              <form className="pw-identity__form pw-people__invite" onSubmit={submit} noValidate aria-label="Novo convite">
                <Text as="h2" variant="h4">
                  Convidar pessoa
                </Text>
                {canInviteClient && (
                  <RadioGroup
                    legend="Convidar como"
                    orientation="horizontal"
                    value={inviteType}
                    onChange={(v) => {
                      setInviteType(v as 'internal' | 'client');
                      setFormError({});
                      setClientErrors({});
                    }}
                    options={[
                      { value: 'internal', label: 'Pessoa da equipe', description: 'Membro da organização, com perfil opcional.' },
                      {
                        value: 'client',
                        label: 'Pessoa externa (cliente)',
                        description: 'Vê o dashboard e/ou os arquivos de retorno de uma automação, sem criar nem operar nada.',
                      },
                    ]}
                  />
                )}
                <div className="pw-people__invite-fields">
                  {inviteType === 'client' && (
                    <Input
                      label="Nome da pessoa"
                      required
                      fullWidth
                      autoComplete="off"
                      value={clientDraft.name}
                      onChange={(e) => setClientDraft({ ...clientDraft, name: e.target.value })}
                      error={clientErrors.name}
                      maxLength={200}
                      hint="Aparece no primeiro acesso dela: não é pedido de novo."
                    />
                  )}
                  <Input label="E-mail da pessoa" type="email" required fullWidth value={email} onChange={(e) => setEmail(e.target.value)} error={formError.email} maxLength={254} />
                  {inviteType === 'client' ? (
                    <ClientInviteFields
                      org={org}
                      draft={clientDraft}
                      onChange={setClientDraft}
                      errors={clientErrors}
                      onOptions={setClientOptions}
                      onUnauthenticated={expired}
                    />
                  ) : (
                  <>
                  <Select
                    label="Perfil (opcional)"
                    fullWidth
                    value={role}
                    onChange={(e) => {
                      setRole(e.target.value as RoleCode | '');
                      setWorkspaceId('');
                    }}
                    options={[{ value: '', label: 'Sem perfil (só o vínculo)' }, ...ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))]}
                  />
                  {isWorkspaceRole(role) && (
                    <Select
                      label="Ambiente de trabalho do perfil"
                      fullWidth
                      required
                      value={workspaceId}
                      placeholder="Escolha um ambiente de trabalho"
                      onChange={(e) => setWorkspaceId(e.target.value)}
                      options={workspaceOptions}
                      error={formError.workspace}
                      hint={workspaces.status === 'ready' && !workspaces.complete ? 'A lista mostra os ambientes de trabalho já carregados.' : undefined}
                    />
                  )}
                  </>
                  )}
                </div>
                {internalMatch && (
                  <Alert tone="warning">
                    {internalMatch.member.displayName} já é membro interno desta organização. Um convite de Cliente não reduziria os acessos atuais
                    (o servidor recusa). Para mudar o que essa pessoa vê, use Gerenciar acessos na linha dela.
                  </Alert>
                )}
                <Text variant="body-sm" color="secondary">
                  O link vai só por e-mail e vale 7 dias. A pessoa aceita entrando com a identidade Nekkora do MESMO e-mail; quem ainda não tem cadastro é levado ao cadastro.
                </Text>
                <div>
                  <Button type="submit">Convidar</Button>
                </div>
              </form>
            </Card>
          )}

          <Card variant="surface" padding="md">
            <form aria-label="Busca e filtros de pessoas" onSubmit={(e) => e.preventDefault()} className="pw-people__filters">
              <Input
                label="Buscar por nome ou e-mail"
                type="search"
                value={searchDraft}
                maxLength={120}
                onChange={(e) => setSearchDraft(e.target.value)}
                fullWidth
              />
              <StatusFilter
                legend="Situação"
                description="Nenhuma marcada = convites pendentes e membros. Convites vencidos, revogados e aceitos só aparecem quando marcados."
                order={SITUATION_ORDER}
                labels={SITUATION_LABEL}
                selected={filters.statuses}
                onToggle={filters.toggleStatus}
              />
            </form>
          </Card>

          {list.status === 'loading' ? (
            <StateView status="loading" title="Carregando pessoas e convites…" />
          ) : list.status === 'error' ? (
            <LoadErrorState error={list.error} onRetry={list.reload} />
          ) : list.items.length === 0 ? (
            <StateView
              status="neutral"
              title={filtered ? 'Ninguém encontrado com essa busca ou situação.' : 'Nenhuma pessoa nem convite ainda.'}
              actions={
                filtered ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchDraft('');
                      filters.clear();
                    }}
                  >
                    Limpar busca e filtros
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="pw-prod__scroll" role="region" aria-label="Lista de pessoas e convites" tabIndex={0}>
                <Table
                  columns={columns}
                  data={list.items}
                  rowKey={(p) => `${p.kind}:${p.id}`}
                  size="sm"
                  caption="Convites pendentes primeiro; depois os membros. Em cada grupo, do mais recente ao mais antigo."
                />
              </div>
              <AdminLoadMore list={list} one="linha" many="linhas" />
            </>
          )}
        </>
      )}

      <ClientAccessDialog
        org={org}
        target={forbidden ? null : clientTarget}
        onClose={closeClientAccess}
        onSaved={onClientSaved}
        onUnauthenticated={expired}
      />

      <StepUpDialog
        open={act?.kind === 'issue-client'}
        title={act?.kind === 'issue-client' ? `Compartilhar ${act.resolved.automationName} com ${act.draft.name.trim()}?` : ''}
        guard={{ operation: 'invitation.issue.client', target: act?.kind === 'issue-client' ? act.email.trim().toLowerCase() : undefined }}
        confirmLabel="Compartilhar e enviar convite"
        stepUp={orgStepUp(org)}
        action={() =>
          act?.kind === 'issue-client'
            ? inviteClient(org, {
                email: act.email,
                name: act.draft.name.trim(),
                clientId: act.draft.clientId || null,
                automationId: act.draft.automationId,
                workerId: act.draft.workerId || null,
                canViewDashboard: act.draft.canViewDashboard,
                canDownloadResults: act.draft.canDownloadResults,
              })
            : Promise.reject()
        }
        onDone={() => {
          setEmail('');
          setClientDraft(EMPTY_CLIENT_DRAFT);
          actDone('Compartilhamento enviado por convite. O acesso só começa quando a pessoa aceitar.');
        }}
        onClose={() => setAct(null)}
        refusalText={(e) => clientRefusal(e, 'Já existe um convite aberto para este e-mail (use Reenviar).')}
        uncertainText="Não foi possível confirmar se o convite foi emitido. Feche e confira a lista antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && uncertain('O resultado do último convite não foi confirmado. Confira a lista antes de convidar de novo.')}
      >
        {act?.kind === 'issue-client' && (
          <Stack gap={2}>
            <Text>{inviteSummary(act.resolved.automationName, act.resolved.workspaceName, act.resolved.machineName, act.draft.name.trim())}</Text>
            <dl className="pw-people__confirm">
              <dt>Pessoa</dt>
              <dd>
                {act.draft.name.trim()} ({act.email})
              </dd>
              <dt>Automação</dt>
              <dd>{act.resolved.automationName}</dd>
              <dt>Ambiente de trabalho</dt>
              <dd>{act.resolved.workspaceName}</dd>
              <dt>Máquinas</dt>
              <dd>{act.resolved.machineName ?? 'Todas as máquinas desta automação'}</dd>
              <dt>Conteúdos</dt>
              <dd>{permissionsText(act.draft.canViewDashboard, act.draft.canDownloadResults)}</dd>
              <dt>Cliente (cadastro interno)</dt>
              <dd>{act.resolved.clientName ?? 'Criado ou reutilizado com o nome da pessoa'}</dd>
            </dl>
            <Text variant="body-sm" color="secondary">
              Compartilhamento aprovado por você (exceção registrada na auditoria). Nada é concedido antes do aceite; no aceite o servidor
              confere tudo de novo. Sem registros técnicos, execução, publicação ou administração.
            </Text>
          </Stack>
        )}
      </StepUpDialog>

      <MemberAccessDialog
        org={org}
        target={forbidden ? null : accessTarget}
        workspaces={workspaces.items}
        onClose={closeAccess}
        onSaved={onAccessSaved}
        onUnauthenticated={expired}
      />

      <StepUpDialog
        open={act?.kind === 'issue'}
        title={act?.kind === 'issue' ? `Convidar ${act.email}?` : ''}
        // alvo = e-mail convidado, só como parte do resumo da chave (mesma limitação de privacidade da antiga página de Convites)
        guard={{ operation: 'invitation.issue', target: act?.kind === 'issue' ? act.email.trim().toLowerCase() : undefined }}
        confirmLabel="Enviar convite"
        stepUp={orgStepUp(org)}
        action={() => (act?.kind === 'issue' ? issueInvitation(org, act.email, act.role || undefined, act.workspaceId || undefined) : Promise.reject())}
        onDone={() => {
          setEmail('');
          setRole('');
          setWorkspaceId('');
          actDone('Convite enviado. A pessoa recebe o link por e-mail.');
        }}
        onClose={() => setAct(null)}
        refusalText={(e) => accessRefusal(e, { conflict: 'Já existe um convite aberto para este e-mail (use Reenviar) ou a pessoa já está na organização.' })}
        uncertainText="Não foi possível confirmar se o convite foi emitido. Feche e confira a lista antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && uncertain('O resultado do último convite não foi confirmado. Confira a lista antes de convidar de novo.')}
      >
        {act?.kind === 'issue' && <Text>Perfil: {roleText({ role: act.role || null, workspaceId: act.workspaceId || null, workspaceName: null })}.</Text>}
      </StepUpDialog>

      <StepUpDialog
        open={act?.kind === 'resend'}
        title={act?.kind === 'resend' ? `Reenviar o convite para ${act.invitation.email}?` : ''}
        guard={{ operation: 'invitation.resend', target: act?.kind === 'resend' ? act.invitation.invitationId : undefined }}
        confirmLabel="Reenviar"
        stepUp={orgStepUp(org)}
        action={() => (act?.kind === 'resend' ? resendInvitation(org, act.invitation.invitationId) : Promise.reject())}
        onDone={() => actDone('Convite reenviado. O link anterior deixou de valer.')}
        onClose={() => setAct(null)}
        refusalText={(e) => accessRefusal(e, { conflict: 'Este convite já foi aceito, revogado ou substituído.' })}
        uncertainText="Não foi possível confirmar o reenvio. Feche e confira a lista antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && uncertain('O resultado do último reenvio não foi confirmado. Confira a lista.')}
      >
        <Text>Um convite novo, com link e prazo novos, substitui este. O link anterior deixa de valer.</Text>
        {act?.kind === 'resend' && act.invitation.clientScope && (
          <Text variant="body-sm" color="secondary">
            O escopo confirmado não muda: {act.invitation.clientScope.automationName}, {machineScopeText(act.invitation.clientScope.workerName)}.
          </Text>
        )}
      </StepUpDialog>

      <StepUpDialog
        open={act?.kind === 'revoke'}
        title={act?.kind === 'revoke' ? `Revogar o convite para ${act.invitation.email}?` : ''}
        guard={{ operation: 'invitation.revoke', target: act?.kind === 'revoke' ? act.invitation.invitationId : undefined }}
        confirmLabel="Revogar convite"
        tone="danger"
        action={() => (act?.kind === 'revoke' ? revokeInvitation(org, act.invitation.invitationId) : Promise.reject())}
        onDone={() => actDone('Convite revogado. O link deixou de valer.')}
        onClose={() => setAct(null)}
        refusalText={(e) => accessRefusal(e, { conflict: 'O convite já foi aceito.' })}
        uncertainText="Não foi possível confirmar a revogação. Feche e confira a lista."
        onUnauthenticated={expired}
      >
        <Text>O link do e-mail deixa de valer. Para convidar de novo, emita um convite novo.</Text>
      </StepUpDialog>

      <MemberActionDialog
        org={org}
        dialog={forbidden ? null : dialog}
        entry={dialogEntry}
        onStarted={(id) => setDialog((d) => (d ? { ...d, startedId: id } : d))}
        onClose={() => setDialog(null)}
        returnFocus={() => (focusTarget.current ? document.querySelector<HTMLElement>(`[data-membro-acao="${focusTarget.current}"]`) : null)}
        fallbackFocus={() => panelRef.current ?? listRegion()}
      />
      <MfaResetDialog
        org={org}
        dialog={forbidden ? null : mfaDialog}
        entry={mfaDialogEntry}
        onStarted={(id) => setMfaDialog((d) => (d ? { ...d, startedId: id } : d))}
        onClose={() => setMfaDialog(null)}
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
    ),
  });
}
