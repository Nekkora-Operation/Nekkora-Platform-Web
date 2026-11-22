import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Input, SectionHeader, Select, Stack, StateView, Text } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';
import { identityStepUp, myOrganizations, organizationCreation, requestOrganization, type IdentityOrganization, type OrganizationCreationState } from '../api/identity';
import { identityPath } from '../auth/flow';
import { StepUpDialog } from '../components/StepUpDialog';
import { organizationNameProblem } from './CreateOrganizationPage';
import { useIdentityArea } from './IdentityArea';
import { CANNOT_CREATE } from './OrganizationCreationPanel';
import './identity.css';

type State = { kind: 'loading' } | { kind: 'ready'; creation: OrganizationCreationState; organizations: IdentityOrganization[] } | { kind: 'unavailable' };

function refusalText(e: unknown): string {
  const reason = e instanceof ApiError && (e.code === 'conflict' || e.code === 'forbidden') ? e.reason : undefined;
  if (reason === 'organization_creation_client_profile') return `${CANNOT_CREATE.organization_creation_client_profile.body} Nada foi pedido.`;
  if (reason === 'organization_request_not_available')
    return 'O pedido não pôde ser feito nesta organização: você não é mais membro dela, passou a administrar uma organização (e cria direto), ou já tem três pedidos aguardando decisão. Nada foi pedido.';
  if (isApiError(e, 'invalid_request')) return 'O nome não foi aceito. Confira os campos. Nada foi pedido.';
  if (isApiError(e, 'rate_limited')) return 'Muitas tentativas em pouco tempo. Aguarde e tente de novo. Nada foi pedido.';
  if (e instanceof ApiError && e.status === 404) return 'O pedido de organizações não está disponível no momento. Nada foi pedido.';
  if (isApiError(e, 'service_unavailable')) return 'Serviço temporariamente indisponível. Nada foi pedido.';
  return 'O pedido não foi permitido. A confirmação pode ter vencido. Nada foi pedido.';
}

/**
 * /organizacoes/solicitar — o membro que não administra nenhuma organização pede a criação de uma organização ao
 * administrador de uma organização em que é membro (PLATFORM-LICENCIAMENTO-001). Pedir não cria nada: a organização nasce
 * na aprovação, e quem aprova decide quem fica responsável. A API decide quem pode pedir.
 */
export function RequestOrganizationPage() {
  const { expired } = useIdentityArea();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [organizationId, setOrganizationId] = useState('');
  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [errors, setErrors] = useState<{ organization?: string; name?: string; legalName?: string }>({});
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const [creation, list] = await Promise.all([organizationCreation(), myOrganizations()]);
        if (!alive.current) return;
        setState({ kind: 'ready', creation, organizations: list.organizations });
        if (list.organizations.length === 1) setOrganizationId(list.organizations[0].organizationId);
      } catch (e) {
        if (!alive.current) return;
        if (isApiError(e, 'unauthenticated')) return expired();
        setState({ kind: 'unavailable' });
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [expired]);

  if (state.kind === 'loading') return <StateView status="loading" title="Carregando…" />;
  if (state.kind === 'unavailable')
    return (
      <StateView
        status="warning"
        title="O pedido de organizações não está disponível agora."
        actions={<Button onClick={() => navigate(identityPath.organizations)}>Voltar para as organizações</Button>}
      />
    );

  const { creation, organizations } = state;
  if (creation.profile !== 'MEMBER') {
    const why = creation.cannotCreateReason ? CANNOT_CREATE[creation.cannotCreateReason] : undefined;
    return (
      <StateView
        status="neutral"
        title={creation.canCreate ? 'Você pode criar a organização diretamente.' : (why?.title ?? 'O pedido de organização não se aplica à sua conta.')}
        description={creation.canCreate ? 'Quem ainda não participa de nenhuma organização, ou administra alguma, cria sem precisar pedir.' : why?.body}
        actions={
          <Button onClick={() => navigate(creation.canCreate ? identityPath.newOrganization : identityPath.organizations)}>
            {creation.canCreate ? 'Criar organização' : 'Voltar para as organizações'}
          </Button>
        }
      />
    );
  }

  const chosen = organizations.find((o) => o.organizationId === organizationId);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = {
      organization: chosen ? undefined : 'Escolha a organização a que você vai pedir.',
      name: organizationNameProblem(name, true),
      legalName: organizationNameProblem(legalName, false),
    };
    setErrors(next);
    if (next.organization || next.name || next.legalName) return;
    setConfirming(true);
  };

  return (
    <Stack gap={5} className="pw-identity">
      <SectionHeader as="h1" title="Solicitar organização" description="O pedido vai para quem administra a organização que você escolher. Nada é criado antes da aprovação." />
      {sent && (
        <Alert tone="success" title="Pedido enviado.">
          Quem administra {chosen?.name ?? 'a organização'} vai aprovar ou recusar. Acompanhe em "Seus pedidos de organização", na lista de organizações.
        </Alert>
      )}
      {!creation.canRequest && (
        <Alert tone="warning">Você já tem três pedidos aguardando decisão. Aguarde uma resposta antes de pedir de novo.</Alert>
      )}
      <form className="pw-identity__form" onSubmit={submit} noValidate>
        <Select
          label="Pedir a quem administra"
          fullWidth
          value={organizationId}
          onChange={(e) => setOrganizationId(e.target.value)}
          options={[{ value: '', label: 'Escolha a organização' }, ...organizations.map((o) => ({ value: o.organizationId, label: o.handle ? `${o.name} (${o.handle})` : o.name }))]}
          error={errors.organization}
          hint="Só aparecem as organizações de que você participa."
        />
        <Input
          label="Nome da nova organização"
          name="organization-name"
          required
          fullWidth
          maxLength={240}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          hint="Até 120 caracteres."
        />
        <Input
          label="Razão social (opcional)"
          name="legal-name"
          fullWidth
          maxLength={240}
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          error={errors.legalName}
        />
        <Alert tone="info" title="Quem aprova decide quem fica responsável.">
          O administrador pode ficar ele mesmo como responsável pela nova organização, ou deixá-la sob a sua responsabilidade. Se ele ficar responsável,
          você não recebe acesso automaticamente: precisa ser convidado. Se a organização ficar com você, ela conta no seu limite de organizações vazias.
        </Alert>
        <div className="pw-form__row">
          <Button type="submit" disabled={!creation.canRequest || sent}>
            Continuar
          </Button>
          <Button type="button" variant="ghost" onClick={() => navigate(identityPath.organizations)}>
            {sent ? 'Voltar para as organizações' : 'Cancelar'}
          </Button>
        </div>
      </form>

      <StepUpDialog<string>
        open={confirming}
        title={`Pedir a criação da organização "${name}"?`}
        guard={{ operation: 'organization.request', target: organizationId }}
        confirmLabel="Enviar pedido"
        stepUp={identityStepUp}
        action={() => requestOrganization(organizationId, name, legalName || undefined)}
        onDone={() => {
          setConfirming(false);
          setSent(true);
        }}
        onClose={() => setConfirming(false)}
        refusalText={refusalText}
        uncertainText="Não foi possível confirmar se o pedido foi registrado. Feche e confira seus pedidos na lista de organizações antes de pedir de novo."
        onUnauthenticated={expired}
      >
        <Text>
          O pedido vai para quem administra {chosen?.name ?? 'a organização escolhida'}. Nada é criado agora.
        </Text>
      </StepUpDialog>
    </Stack>
  );
}
