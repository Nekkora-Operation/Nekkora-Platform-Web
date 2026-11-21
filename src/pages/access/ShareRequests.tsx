import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Input, Stack, Text } from 'nekkora-lib';
import {
  approveClientShare,
  cancelClientShare,
  listClientShareRequests,
  refuseClientShare,
  requestClientShare,
  type ClientShareRequestItem,
} from '../../api/clientAccess';
import { isApiError } from '../../api/http';
import { StepUpDialog } from '../../components/StepUpDialog';
import { DateTimeText } from '../product/shared';
import { ClientInviteFields, draftErrors, EMPTY_CLIENT_DRAFT, resolveDraft, type ClientInviteDraft, type ClientInviteOptions } from './ClientInviteFields';
import { CLIENT_SEES, clientRefusal, machineScopeText, permissionsText } from './clientShared';
import { orgStepUp } from './shared';

/**
 * PLATFORM-FLUXO-002 (071): pedidos de compartilhamento de membros (client_share.request). Quem administra a organização e o
 * acesso de clientes aprova (OUTRA pessoa, com a confirmação da hora) — o convite sai nesse ato — ou recusa; nada é enviado antes.
 */
export function ShareRequestsPanel({ org, refresh, onChanged, onUnauthenticated }: { org: string; refresh: number; onChanged: (text: string) => void; onUnauthenticated: () => void }) {
  const [items, setItems] = useState<ClientShareRequestItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [act, setAct] = useState<{ kind: 'approve' | 'refuse'; item: ClientShareRequestItem } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    listClientShareRequests(org, { pendingOnly: true }).then(
      (r) => alive && setItems(r),
      (e: unknown) => {
        if (!alive) return;
        if (isApiError(e, 'unauthenticated')) return onUnauthenticated();
        setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, refresh, reload]);

  if (failed) return <Alert tone="warning">Não foi possível carregar os pedidos de compartilhamento.</Alert>;
  if (!items || items.length === 0) return null;
  const scope = (i: ClientShareRequestItem) => `${i.automation.name} · ${i.workspace.name} · ${machineScopeText(i.machine?.name)}`;
  return (
    <Card variant="outlined" padding="md">
      <section aria-labelledby="pedidos-compartilhamento">
        <Stack gap={3}>
          <Text as="h2" variant="h4" id="pedidos-compartilhamento">
            Pedidos de compartilhamento
          </Text>
          <Text variant="body-sm" color="secondary">
            Pedidos de membros da equipe. Nada foi enviado à pessoa: o convite sai quando você aprova (quem pediu não aprova).
          </Text>
          <ul className="pw-access__list" aria-label="Pedidos de compartilhamento aguardando decisão">
            {items.map((i) => (
              <li key={i.shareRequestId} className="pw-access__item pw-access__item--stack">
                <div className="pw-access__scope">
                  <Text>
                    {i.recipientName} ({i.email})
                  </Text>
                  <Badge tone="info" size="sm">
                    Aguardando aprovação
                  </Badge>
                </div>
                <Text variant="body-sm" color="secondary">
                  {scope(i)} · {permissionsText(i.canViewDashboard, i.canDownloadResults)}
                </Text>
                <Text variant="body-sm" color="secondary">
                  Pedido por {i.requestedBy} em <DateTimeText iso={i.createdAt} />
                </Text>
                <span className="pw-admin__row-actions">
                  <Button size="sm" variant="secondary" onClick={() => setAct({ kind: 'approve', item: i })} aria-label={`Aprovar o compartilhamento com ${i.recipientName}`}>
                    Aprovar e enviar convite
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAct({ kind: 'refuse', item: i })} aria-label={`Recusar o compartilhamento com ${i.recipientName}`}>
                    Recusar
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Stack>
      </section>
      <StepUpDialog
        open={act?.kind === 'approve'}
        title={act ? `Aprovar o compartilhamento de ${act.item.automation.name} com ${act.item.recipientName}?` : ''}
        guard={{ operation: 'client.share.approve', target: act?.item.shareRequestId }}
        confirmLabel="Aprovar e enviar convite"
        stepUp={orgStepUp(org)}
        action={() => (act?.kind === 'approve' ? approveClientShare(org, act.item.shareRequestId) : Promise.reject())}
        onDone={() => {
          setAct(null);
          setReload((n) => n + 1);
          onChanged('Pedido aprovado. O convite foi enviado; o acesso só começa quando a pessoa aceitar.');
        }}
        onClose={() => setAct(null)}
        refusalText={(e) => clientRefusal(e, 'O pedido mudou ou já foi decidido, ou já há um convite aberto para este e-mail.')}
        uncertainText="Não foi possível confirmar a aprovação. Feche e confira os pedidos antes de tentar de novo."
        onUnauthenticated={onUnauthenticated}
      >
        {act && (
          <dl className="pw-people__confirm">
            <dt>Pessoa</dt>
            <dd>
              {act.item.recipientName} ({act.item.email})
            </dd>
            <dt>Automação</dt>
            <dd>{act.item.automation.name}</dd>
            <dt>Ambiente de trabalho</dt>
            <dd>{act.item.workspace.name}</dd>
            <dt>Máquinas</dt>
            <dd>{act.item.machine?.name ?? 'Todas as máquinas desta automação'}</dd>
            <dt>Conteúdos</dt>
            <dd>{permissionsText(act.item.canViewDashboard, act.item.canDownloadResults)}</dd>
            <dt>Pedido por</dt>
            <dd>{act.item.requestedBy}</dd>
          </dl>
        )}
      </StepUpDialog>
      <StepUpDialog
        open={act?.kind === 'refuse'}
        title={act ? `Recusar o pedido de ${act.item.requestedBy}?` : ''}
        guard={{ operation: 'client.share.refuse', target: act?.item.shareRequestId }}
        confirmLabel="Recusar"
        tone="danger"
        action={() => (act?.kind === 'refuse' ? refuseClientShare(org, act.item.shareRequestId) : Promise.reject())}
        onDone={() => {
          setAct(null);
          setReload((n) => n + 1);
          onChanged('Pedido recusado. Nada foi enviado à pessoa.');
        }}
        onClose={() => setAct(null)}
        refusalText={(e) => clientRefusal(e, 'O pedido mudou ou já foi decidido.')}
        uncertainText="Não foi possível confirmar a recusa. Feche e confira os pedidos."
        onUnauthenticated={onUnauthenticated}
      >
        <Text>Nada é enviado à pessoa. O pedido fica no histórico.</Text>
      </StepUpDialog>
    </Card>
  );
}

const STATUS_LABEL: Record<ClientShareRequestItem['status'], { label: string; tone: 'info' | 'success' | 'neutral' | 'warning' }> = {
  PENDENTE: { label: 'Aguardando aprovação', tone: 'info' },
  APROVADO: { label: 'Aprovado; convite enviado', tone: 'success' },
  RECUSADO: { label: 'Recusado', tone: 'warning' },
  CANCELADO: { label: 'Cancelado', tone: 'neutral' },
};

/**
 * Compartilhar uma automação a partir da página dela (071). Administradora: o mesmo formulário de "Pessoas e acessos" (convite
 * direto); membro com client_share.request: um PEDIDO, que outra pessoa aprova antes de qualquer convite. Mostra também os
 * pedidos desta automação feitos por quem está vendo (ou todos, para quem administra), com cancelar os próprios pendentes.
 */
export function ShareAutomationPanel({
  org,
  automationId,
  automationName,
  onUnauthenticated,
}: {
  org: string;
  automationId: string;
  automationName: string;
  onUnauthenticated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ClientInviteDraft>(EMPTY_CLIENT_DRAFT);
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string; automation?: string; content?: string }>({});
  const [options, setOptions] = useState<ClientInviteOptions | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [requests, setRequests] = useState<ClientShareRequestItem[]>([]);
  const [reload, setReload] = useState(0);
  const [cancel, setCancel] = useState<ClientShareRequestItem | null>(null);

  useEffect(() => {
    let alive = true;
    listClientShareRequests(org, { automationId }).then(
      (r) => alive && setRequests(r),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [org, automationId, reload]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const d = draftErrors(draft);
    const next = { ...d, email: /^[^\s@]+@[^\s@]+$/.test(email.trim()) ? undefined : 'Informe um e-mail válido.' };
    setErrors(next);
    if (next.name || next.email || next.automation || next.content || !options || !resolveDraft(draft, options)) return;
    setConfirming(true);
  };
  const resolved = options ? resolveDraft(draft, options) : null;

  return (
    <Card variant="outlined" padding="lg">
      <Stack gap={3}>
        <Text as="h2" variant="h4">
          Compartilhar com pessoa externa
        </Text>
        <Text variant="body-sm" color="secondary">
          A pessoa vê o dashboard de execução e/ou os arquivos de retorno desta automação. Seu pedido só vira convite depois que quem
          administra a organização aprovar.
        </Text>
        {notice && (
          <Alert tone="success" role="status">
            {notice}
          </Alert>
        )}
        {!open ? (
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(true);
                setNotice(null);
              }}
            >
              Pedir compartilhamento
            </Button>
          </div>
        ) : (
          <form className="pw-identity__form pw-people__invite" onSubmit={submit} noValidate aria-label="Pedir compartilhamento">
            <ClientInviteFields
              lead={
                <>
                  <Input label="Nome da pessoa" required fullWidth value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} error={errors.name} maxLength={200} />
                  <Input label="E-mail da pessoa" type="email" required fullWidth value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} maxLength={254} />
                </>
              }
              org={org}
              draft={draft}
              onChange={setDraft}
              errors={errors}
              onOptions={setOptions}
              onUnauthenticated={onUnauthenticated}
              lockAutomationId={automationId}
            />
            {options && !options.automations.some((a) => a.automationId === automationId) && (
              <Alert tone="warning">Você não pode compartilhar esta automação.</Alert>
            )}
            <div className="pw-form__row">
              <Button type="submit">Revisar pedido</Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  setDraft(EMPTY_CLIENT_DRAFT);
                  setEmail('');
                  setErrors({});
                }}
              >
                Cancelar
              </Button>
            </div>
          </form>
        )}
        {requests.length > 0 && (
          <section aria-label={`Pedidos de compartilhamento de ${automationName}`}>
            <Text as="h3" variant="h4">
              Pedidos desta automação
            </Text>
            <ul className="pw-access__list">
              {requests.map((r) => (
                <li key={r.shareRequestId} className="pw-access__item pw-access__item--stack">
                  <div className="pw-access__scope">
                    <Text>
                      {r.recipientName} ({r.email})
                    </Text>
                    <Badge tone={STATUS_LABEL[r.status].tone} size="sm">
                      {STATUS_LABEL[r.status].label}
                    </Badge>
                  </div>
                  <Text variant="body-sm" color="secondary">
                    {permissionsText(r.canViewDashboard, r.canDownloadResults)} · {machineScopeText(r.machine?.name)}
                  </Text>
                  {r.status === 'PENDENTE' && (
                    <span>
                      <Button size="sm" variant="ghost" onClick={() => setCancel(r)} aria-label={`Cancelar o pedido para ${r.recipientName}`}>
                        Cancelar pedido
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </Stack>
      <StepUpDialog
        open={confirming}
        title={`Pedir o compartilhamento de ${automationName} com ${draft.name.trim()}?`}
        guard={{ operation: 'client.share.request', target: `${automationId}:${email.trim().toLowerCase()}` }}
        confirmLabel="Enviar pedido"
        action={() =>
          requestClientShare(org, {
            email: email.trim(),
            name: draft.name.trim(),
            automationId,
            workerId: draft.workerId || null,
            canViewDashboard: draft.canViewDashboard,
            canDownloadResults: draft.canDownloadResults,
          })
        }
        onDone={() => {
          setConfirming(false);
          setOpen(false);
          setDraft(EMPTY_CLIENT_DRAFT);
          setEmail('');
          setNotice('Pedido enviado para aprovação. Nada foi enviado à pessoa ainda.');
          setReload((n) => n + 1);
        }}
        onClose={() => setConfirming(false)}
        refusalText={(e) => clientRefusal(e, 'Já existe um pedido igual aguardando aprovação.')}
        uncertainText="Não foi possível confirmar o pedido. Feche e confira a lista de pedidos antes de tentar de novo."
        onUnauthenticated={onUnauthenticated}
      >
        <dl className="pw-people__confirm">
          <dt>Pessoa</dt>
          <dd>
            {draft.name.trim()} ({email.trim()})
          </dd>
          <dt>Automação</dt>
          <dd>{automationName}</dd>
          <dt>Máquinas</dt>
          <dd>{resolved?.machineName ?? 'Todas as máquinas desta automação'}</dd>
          <dt>Conteúdos</dt>
          <dd>{permissionsText(draft.canViewDashboard, draft.canDownloadResults)}</dd>
        </dl>
        <Text variant="body-sm" color="secondary">
          {CLIENT_SEES}
        </Text>
      </StepUpDialog>
      <StepUpDialog
        open={!!cancel}
        title={cancel ? `Cancelar o pedido para ${cancel.recipientName}?` : ''}
        guard={{ operation: 'client.share.cancel', target: cancel?.shareRequestId }}
        confirmLabel="Cancelar pedido"
        tone="danger"
        action={() => (cancel ? cancelClientShare(org, cancel.shareRequestId) : Promise.reject())}
        onDone={() => {
          setCancel(null);
          setReload((n) => n + 1);
        }}
        onClose={() => setCancel(null)}
        refusalText={(e) => clientRefusal(e, 'O pedido já foi decidido.')}
        uncertainText="Não foi possível confirmar o cancelamento."
        onUnauthenticated={onUnauthenticated}
      >
        <Text>O pedido deixa de valer; nada foi enviado à pessoa.</Text>
      </StepUpDialog>
    </Card>
  );
}
