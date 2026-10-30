import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Input, Select, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { issueInvitation, listInvitations, resendInvitation, revokeInvitation, type Invitation, type RoleCode } from '../../api/access';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { StepUpDialog } from '../../components/StepUpDialog';
import { DateTimeText, LoadErrorState, PageHeader } from '../product/shared';
import { ForbiddenState } from '../admin/shared';
import '../../identity/identity.css';
import { accessRefusal, InvitationStateBadge, isWorkspaceRole, orgStepUp, REVOKE_REASON_LABEL, ROLE_LABEL, ROLE_OPTIONS } from './shared';

type ListState = { status: 'loading' } | { status: 'ready'; items: Invitation[] } | { status: 'error'; error: unknown };

type Pending =
  | { kind: 'issue'; email: string; role: RoleCode | ''; workspaceId: string }
  | { kind: 'resend'; invitation: Invitation }
  | { kind: 'revoke'; invitation: Invitation };

/**
 * /o/{org}/administracao/convites — convites da organização (org.manage). Emitir e reenviar exigem step-up; revogar não.
 * O token só vai no e-mail (link /o/{org}/convite#token=); a lista nunca o mostra. Quem emitiu e perdeu a autoridade tem
 * os convites fechados pelo banco (EMISSOR_SEM_AUTORIDADE).
 */
export function InvitationsPage() {
  const { org, expired } = useSession();
  const { workspaces } = useInternalArea();
  const [scope, setScope] = useState<'pending' | 'all'>('pending');
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleCode | ''>('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [formError, setFormError] = useState<{ email?: string; workspace?: string }>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setList({ status: 'loading' });
    try {
      const data = await listInvitations(org, scope);
      if (gen === generation.current) setList({ status: 'ready', items: data.items });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      setList({ status: 'error', error: e });
    }
  }, [org, scope, expired]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errors = {
      email: /^[^\s@]+@[^\s@]+$/.test(email.trim()) ? undefined : 'Informe um e-mail válido.',
      workspace: isWorkspaceRole(role) && !workspaceId ? 'Escolha o workspace do papel.' : undefined,
    };
    setFormError(errors);
    if (errors.email || errors.workspace) return;
    setNotice(null);
    setPending({ kind: 'issue', email: email.trim(), role, workspaceId });
  };

  const workspaceName = (id: string | null) => (id ? (workspaces.items.find((w) => w.workspaceId === id)?.name ?? `workspace ${id.slice(0, 8)}…`) : null);
  const roleText = (i: Pick<Invitation, 'role' | 'workspaceId'>) =>
    i.role ? `${ROLE_LABEL[i.role] ?? i.role}${i.workspaceId ? ` · ${workspaceName(i.workspaceId)}` : ''}` : 'Sem papel (só o vínculo)';

  const columns: TableColumn<Invitation>[] = [
    { key: 'email', header: 'E-mail', render: (i) => <span className="pw-break">{i.email}</span> },
    { key: 'papel', header: 'Papel', render: roleText },
    {
      key: 'estado',
      header: 'Situação',
      render: (i) => (
        <Stack gap={1}>
          <InvitationStateBadge state={i.state} />
          {i.revokeReason && <Text variant="body-sm" color="secondary">{REVOKE_REASON_LABEL[i.revokeReason]}</Text>}
        </Stack>
      ),
    },
    { key: 'prazo', header: 'Vale até', render: (i) => <DateTimeText iso={i.expiresAt} /> },
    {
      key: 'acoes',
      header: 'Ações',
      render: (i) =>
        i.state === 'PENDENTE' || i.state === 'EXPIRADO' ? (
          <div className="pw-form__row">
            {!i.revokedAt && !i.acceptedAt && (
              <Button size="sm" variant="secondary" onClick={() => setPending({ kind: 'resend', invitation: i })} aria-label={`Reenviar convite para ${i.email}`}>
                Reenviar
              </Button>
            )}
            {i.state === 'PENDENTE' && (
              <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'revoke', invitation: i })} aria-label={`Revogar convite para ${i.email}`}>
                Revogar
              </Button>
            )}
          </div>
        ) : null,
    },
  ];

  const workspaceOptions = workspaces.items.filter((w) => w.status === 'active').map((w) => ({ value: w.workspaceId, label: w.name }));
  const close = () => setPending(null);
  const done = (text: string) => {
    setPending(null);
    setNotice({ tone: 'success', text });
    void load();
  };
  const uncertain = (text: string) => setNotice({ tone: 'warning', text });

  if (list.status === 'error' && isApiError(list.error, 'forbidden')) return <ForbiddenState area="os convites" onRetry={() => void load()} />;

  return (
    <Stack gap={5}>
      <PageHeader title="Convites" subtitle="Convide pessoas para a organização. O link vai só por e-mail e vale 7 dias." onRefresh={() => void load()} />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <Card variant="outlined" padding="lg">
        <form className="pw-identity__form" onSubmit={submit} noValidate>
          <Text as="h2" variant="h4">
            Novo convite
          </Text>
          <Input label="E-mail da pessoa" type="email" required fullWidth value={email} onChange={(e) => setEmail(e.target.value)} error={formError.email} maxLength={254} />
          <Select
            label="Papel (opcional)"
            fullWidth
            value={role}
            onChange={(e) => {
              setRole(e.target.value as RoleCode | '');
              setWorkspaceId('');
            }}
            options={[{ value: '', label: 'Sem papel (só o vínculo)' }, ...ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))]}
          />
          {isWorkspaceRole(role) && (
            <Select
              label="Workspace do papel"
              fullWidth
              required
              value={workspaceId}
              placeholder="Escolha um workspace"
              onChange={(e) => setWorkspaceId(e.target.value)}
              options={workspaceOptions}
              error={formError.workspace}
              hint={workspaces.status === 'ready' && !workspaces.complete ? 'A lista mostra os workspaces já carregados.' : undefined}
            />
          )}
          <Text variant="body-sm" color="secondary">
            A pessoa aceita entrando com a identidade Nekkora do MESMO e-mail. Quem ainda não tem cadastro é levado ao cadastro.
          </Text>
          <div>
            <Button type="submit">Convidar</Button>
          </div>
        </form>
      </Card>

      <div className="pw-form__row">
        <Select
          label="Mostrar"
          value={scope}
          onChange={(e) => setScope(e.target.value as 'pending' | 'all')}
          options={[
            { value: 'pending', label: 'Pendentes' },
            { value: 'all', label: 'Todos (até os 200 mais recentes)' },
          ]}
        />
      </div>

      {list.status === 'loading' && <StateView status="loading" title="Carregando convites…" />}
      {list.status === 'error' && <LoadErrorState error={list.error} onRetry={() => void load()} />}
      {list.status === 'ready' &&
        (list.items.length === 0 ? (
          <StateView status="neutral" title={scope === 'pending' ? 'Nenhum convite pendente.' : 'Nenhum convite emitido.'} />
        ) : (
          <div className="pw-prod__scroll" role="region" aria-label="Lista de convites" tabIndex={0}>
            <Table columns={columns} data={list.items} rowKey="invitationId" size="sm" caption="Convites, do mais recente ao mais antigo." />
          </div>
        ))}

      <StepUpDialog
        open={pending?.kind === 'issue'}
        title={pending?.kind === 'issue' ? `Convidar ${pending.email}?` : ''}
        guard={{ operation: 'invitation.issue', target: pending?.kind === 'issue' ? pending.email.trim().toLowerCase() : undefined }}
        confirmLabel="Enviar convite"
        stepUp={orgStepUp(org)}
        action={() => (pending?.kind === 'issue' ? issueInvitation(org, pending.email, pending.role || undefined, pending.workspaceId || undefined) : Promise.reject())}
        onDone={() => {
          setEmail('');
          setRole('');
          setWorkspaceId('');
          done('Convite enviado. A pessoa recebe o link por e-mail.');
        }}
        onClose={close}
        refusalText={(e) => accessRefusal(e, { conflict: 'Já existe um convite aberto para este e-mail (use Reenviar) ou a pessoa já está na organização.' })}
        uncertainText="Não foi possível confirmar se o convite foi emitido. Feche e confira a lista antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && uncertain('O resultado do último convite não foi confirmado. Confira a lista antes de convidar de novo.')}
      >
        {pending?.kind === 'issue' && <Text>Papel: {roleText({ role: pending.role || null, workspaceId: pending.workspaceId || null })}.</Text>}
      </StepUpDialog>

      <StepUpDialog
        open={pending?.kind === 'resend'}
        title={pending?.kind === 'resend' ? `Reenviar o convite para ${pending.invitation.email}?` : ''}
        guard={{ operation: 'invitation.resend', target: pending?.kind === 'resend' ? pending.invitation.invitationId : undefined }}
        confirmLabel="Reenviar"
        stepUp={orgStepUp(org)}
        action={() => (pending?.kind === 'resend' ? resendInvitation(org, pending.invitation.invitationId) : Promise.reject())}
        onDone={() => done('Convite reenviado. O link anterior deixou de valer.')}
        onClose={close}
        refusalText={(e) => accessRefusal(e, { conflict: 'Este convite já foi aceito, revogado ou substituído.' })}
        uncertainText="Não foi possível confirmar o reenvio. Feche e confira a lista antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && uncertain('O resultado do último reenvio não foi confirmado. Confira a lista.')}
      >
        <Text>Um convite novo, com link e prazo novos, substitui este. O link anterior deixa de valer.</Text>
      </StepUpDialog>

      <StepUpDialog
        open={pending?.kind === 'revoke'}
        title={pending?.kind === 'revoke' ? `Revogar o convite para ${pending.invitation.email}?` : ''}
        guard={{ operation: 'invitation.revoke', target: pending?.kind === 'revoke' ? pending.invitation.invitationId : undefined }}
        confirmLabel="Revogar convite"
        tone="danger"
        action={() => (pending?.kind === 'revoke' ? revokeInvitation(org, pending.invitation.invitationId) : Promise.reject())}
        onDone={() => done('Convite revogado. O link deixou de valer.')}
        onClose={close}
        refusalText={(e) => accessRefusal(e, { conflict: 'O convite já foi aceito.' })}
        uncertainText="Não foi possível confirmar a revogação. Feche e confira a lista."
        onUnauthenticated={expired}
      >
        <Text>O link do e-mail deixa de valer. Para convidar de novo, emita um convite novo.</Text>
      </StepUpDialog>
    </Stack>
  );
}
