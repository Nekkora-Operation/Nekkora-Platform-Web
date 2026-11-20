import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { approveOrganizationRequest, listOrganizationRequests, refuseOrganizationRequest, type OrganizationRequest, type Responsible } from '../../api/licenses';
import { useSession } from '../../area/session';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal, orgStepUp } from '../access/shared';
import { ForbiddenState } from '../admin/shared';
import { DateTimeText, LoadErrorState, PageHeader } from '../product/shared';
import './licenses.css';

type State = { status: 'loading' } | { status: 'ready'; items: OrganizationRequest[] } | { status: 'error'; error: unknown };
type Pending = { kind: 'approve'; request: OrganizationRequest } | { kind: 'refuse'; request: OrganizationRequest };

export const REQUEST_STATE: Record<OrganizationRequest['state'], { label: string; tone: 'info' | 'success' | 'neutral' }> = {
  PENDING: { label: 'Aguardando decisão', tone: 'info' },
  APPROVED: { label: 'Aprovado', tone: 'success' },
  REFUSED: { label: 'Recusado', tone: 'neutral' },
};

/** O que a escolha do responsável significa. Mostrado antes de aprovar: a escolha concede administração e conta no limite. */
export const RESPONSIBLE_TEXT = {
  intro:
    'Escolha quem será o responsável pela nova organização. A escolha concede a administração da nova organização a essa pessoa e define de quem será contado o limite de organizações vazias (sem automações).',
  APPROVER: 'Eu (quem está aprovando). A nova organização fica sob a minha administração e conta no meu limite de organizações vazias.',
  REQUESTER: 'Quem solicitou. A nova organização fica sob a administração dessa pessoa e conta no limite dela. Eu não terei acesso a ela.',
  noOthers: 'Só a pessoa escolhida recebe acesso à nova organização. Ninguém mais entra nela automaticamente, nem quem não foi escolhido aqui.',
} as const;

const DECISION_REFUSAL: Record<string, string> = {
  empty_organization_limit_reached:
    'A pessoa escolhida como responsável já tem o limite de organizações vazias (sem automações). Escolha o outro responsável, ou a pessoa precisa usar ou desativar uma organização vazia. O pedido continua aguardando.',
  organization_request_not_pending: 'Este pedido já foi decidido. Atualize a lista.',
  organization_request_own: 'Você não decide um pedido feito por você.',
  organization_request_approver_without_identity:
    'A sua conta nesta organização não está ligada a uma conta Nekkora geral, então você não pode ser o responsável. Você pode aprovar deixando quem solicitou como responsável.',
  organization_request_responsible_not_eligible: 'A pessoa escolhida não pode mais receber a organização (a conta dela mudou). O pedido continua aguardando.',
  organization_name_taken: 'A pessoa escolhida como responsável já criou uma organização com esse nome. O pedido continua aguardando.',
};

function decisionRefusal(e: unknown): string {
  const reason = isApiError(e, 'conflict') ? (e as { reason?: string }).reason : undefined;
  return reason && DECISION_REFUSAL[reason] ? `${DECISION_REFUSAL[reason]} Nada foi criado.` : accessRefusal(e);
}

/**
 * /o/{org}/administracao/pedidos-de-organizacao — pedidos de criação de organização feitos a esta organização por membros
 * dela (PLATFORM-LICENCIAMENTO-001). Quem administra aprova, ESCOLHENDO o responsável, ou recusa com motivo. A organização só
 * nasce na aprovação, e só o responsável recebe acesso. A API reconfere tudo.
 */
export function OrganizationRequestsPage() {
  const { org, expired } = useSession();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [responsible, setResponsible] = useState<Responsible>('APPROVER');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setState({ status: 'loading' });
    try {
      const data = await listOrganizationRequests(org);
      if (gen === generation.current) setState({ status: 'ready', items: data.items });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      setState({ status: 'error', error: e });
    }
  }, [org, expired]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  if (state.status === 'loading') return <StateView status="loading" title="Carregando pedidos…" />;
  if (state.status === 'error')
    return isApiError(state.error, 'forbidden') ? (
      <ForbiddenState area="os pedidos de organização" onRetry={() => void load()} />
    ) : (
      <LoadErrorState error={state.error} onRetry={() => void load()} />
    );

  const open = (kind: Pending['kind'], request: OrganizationRequest) => {
    setNotice(null);
    setResponsible('APPROVER'); // o padrão é sempre quem aprova; entregar ao solicitante é escolha explícita
    setReason('');
    setPending({ kind, request } as Pending);
  };
  const done = (text: string) => {
    setPending(null);
    setNotice({ tone: 'success', text });
    void load();
  };
  const who = (r: OrganizationRequest) => r.requester.displayName ?? r.requester.email;

  const columns: TableColumn<OrganizationRequest>[] = [
    {
      key: 'nome',
      header: 'Organização pedida',
      render: (r) => (
        <Stack gap={1}>
          <span className="pw-break">{r.name}</span>
          {r.legalName !== r.name && (
            <Text variant="body-sm" color="secondary">
              {r.legalName}
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: 'quem',
      header: 'Quem pediu',
      render: (r) => (
        <Stack gap={1}>
          <span>{who(r)}</span>
          <Text variant="body-sm" color="secondary" className="pw-break">
            {r.requester.email}
          </Text>
        </Stack>
      ),
    },
    { key: 'quando', header: 'Pedido em', render: (r) => <DateTimeText iso={r.requestedAt} /> },
    {
      key: 'situacao',
      header: 'Situação',
      render: (r) => (
        <Stack gap={1}>
          <Badge tone={REQUEST_STATE[r.state].tone} dot>
            {REQUEST_STATE[r.state].label}
          </Badge>
          {r.state === 'APPROVED' && (
            <Text variant="body-sm" color="secondary">
              Responsável: {r.responsible === 'REQUESTER' ? 'quem solicitou' : (r.decidedByDisplayName ?? 'quem aprovou')}
            </Text>
          )}
          {r.state === 'REFUSED' && r.refusalReason && (
            <Text variant="body-sm" color="secondary">
              Motivo: {r.refusalReason}
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: 'acoes',
      header: 'Ações',
      render: (r) =>
        r.state !== 'PENDING' ? null : r.ownRequest ? (
          <Text variant="body-sm" color="secondary">
            Pedido seu: outro administrador decide.
          </Text>
        ) : (
          <div className="pw-form__row">
            <Button size="sm" onClick={() => open('approve', r)} aria-label={`Aprovar o pedido de ${r.name}`}>
              Aprovar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => open('refuse', r)} aria-label={`Recusar o pedido de ${r.name}`}>
              Recusar
            </Button>
          </div>
        ),
    },
  ];

  const request = pending?.request;
  const reasonOk = reason.trim().length >= 10 && reason.trim().length <= 500;

  return (
    <Stack gap={5}>
      <PageHeader
        title="Pedidos de organização"
        subtitle="Membros desta organização que não a administram pedem aqui a criação de uma nova organização. Nada é criado antes da sua aprovação."
        onRefresh={() => void load()}
      />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {state.items.length === 0 ? (
        <StateView status="neutral" title="Nenhum pedido de organização." description="Quando um membro desta organização pedir a criação de uma organização, o pedido aparece aqui." />
      ) : (
        <div className="pw-prod__scroll" role="region" aria-label="Lista de pedidos de organização" tabIndex={0}>
          <Table columns={columns} data={state.items} rowKey="requestId" size="sm" caption="Pedidos de criação de organização, os pendentes primeiro." />
        </div>
      )}

      <StepUpDialog
        open={pending?.kind === 'approve'}
        title={request ? `Aprovar a criação de "${request.name}"?` : ''}
        guard={{ operation: 'organization-request.approve', target: request?.requestId }}
        confirmLabel="Aprovar e criar a organização"
        stepUp={orgStepUp(org)}
        action={() => (request ? approveOrganizationRequest(org, request.requestId, responsible) : Promise.reject())}
        onDone={(decision) =>
          done(
            decision.responsible === 'REQUESTER'
              ? `Pedido aprovado. A organização "${request?.name}" foi criada sob a administração de ${request ? who(request) : 'quem solicitou'}. Você não tem acesso a ela.`
              : `Pedido aprovado. A organização "${request?.name}" foi criada sob a sua administração e aparece em "Trocar organização". Quem solicitou não recebeu acesso: convide a pessoa, se for o caso.`,
          )
        }
        onClose={() => setPending(null)}
        refusalText={decisionRefusal}
        uncertainText="Não foi possível confirmar a aprovação. A organização pode ter sido criada. Feche e confira a lista de pedidos antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && setNotice({ tone: 'warning', text: 'O resultado da última aprovação não foi confirmado. Confira a lista antes de decidir de novo.' })}
      >
        {request && (
          <Stack gap={3}>
            <Text>
              Pedido de {who(request)} ({request.requester.email}).
            </Text>
            <Text>{RESPONSIBLE_TEXT.intro}</Text>
            <fieldset className="pw-lic__choice">
              <legend className="pw-visually-hidden">Responsável pela nova organização</legend>
              <label>
                <input type="radio" name="responsavel" value="APPROVER" checked={responsible === 'APPROVER'} onChange={() => setResponsible('APPROVER')} />
                <span>{RESPONSIBLE_TEXT.APPROVER}</span>
              </label>
              <label>
                <input type="radio" name="responsavel" value="REQUESTER" checked={responsible === 'REQUESTER'} onChange={() => setResponsible('REQUESTER')} />
                <span>{RESPONSIBLE_TEXT.REQUESTER}</span>
              </label>
            </fieldset>
            <Text>{RESPONSIBLE_TEXT.noOthers}</Text>
            <Text variant="body-sm" color="secondary">
              O limite de organizações vazias da pessoa escolhida é conferido de novo agora. Criar a organização não concede licença.
            </Text>
          </Stack>
        )}
      </StepUpDialog>

      <StepUpDialog
        open={pending?.kind === 'refuse'}
        title={request ? `Recusar o pedido de "${request.name}"?` : ''}
        guard={{ operation: 'organization-request.refuse', target: request?.requestId }}
        confirmLabel="Recusar pedido"
        tone="danger"
        stepUp={orgStepUp(org)}
        ready={reasonOk}
        action={() => (request ? refuseOrganizationRequest(org, request.requestId, reason.trim()) : Promise.reject())}
        onDone={() => done('Pedido recusado. Nada foi criado; quem solicitou vê o motivo.')}
        onClose={() => setPending(null)}
        refusalText={decisionRefusal}
        uncertainText="Não foi possível confirmar a recusa. Feche e confira a lista de pedidos."
        onUnauthenticated={expired}
      >
        <Stack gap={2}>
          <label htmlFor="pw-lic-motivo">Motivo da recusa (quem solicitou vai ler)</label>
          <textarea id="pw-lic-motivo" className="pw-lic__reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <Text variant="body-sm" color="secondary">
            De 10 a 500 caracteres.
          </Text>
        </Stack>
      </StepUpDialog>
    </Stack>
  );
}
