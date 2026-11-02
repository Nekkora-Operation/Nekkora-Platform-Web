import { useState, type FormEvent } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';
import { Alert, Button, Input, Link, SectionHeader, Stack, Text } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';
import { createOrganization, identityStepUp } from '../api/identity';
import { identityPath } from '../auth/flow';
import { StepUpDialog } from '../components/StepUpDialog';
import { useIdentityArea } from './IdentityArea';
import { activationLabel } from './labels';
import type { OrganizationsNavState } from './OrganizationsPage';
import './identity.css';

/** Regra do contrato para name e legalName: 1 a 120 pontos de código, sem espaço nas pontas, sem caractere de controle. */
export function organizationNameProblem(value: string, required: boolean): string | undefined {
  if (!value) return required ? 'Informe o nome da organização.' : undefined;
  if (value !== value.trim()) return 'Retire os espaços do começo e do fim.';
  if ([...value].length > 120) return 'Use no máximo 120 caracteres.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return 'Use só caracteres visíveis.';
  return undefined;
}

function refusalText(e: unknown): string {
  if (isApiError(e, 'rate_limited'))
    return 'Você atingiu o limite de criações de organização por enquanto. Tente de novo mais tarde. Nada foi criado.';
  if (isApiError(e, 'invalid_request')) return 'O nome não foi aceito. Confira os campos. Nada foi criado.';
  if (e instanceof ApiError && e.status === 404) return 'A criação de organizações não está disponível no momento. Nada foi criado.';
  if (isApiError(e, 'service_unavailable')) return 'Serviço temporariamente indisponível. Nada foi criado; tente de novo em instantes.';
  // 403 é recusa genérica do contrato: teto de organizações, identidade inelegível ou confirmação vencida
  return 'A criação não foi permitida. Você pode ter atingido o limite de organizações criadas ou a confirmação pode ter vencido. Nada foi criado.';
}

/**
 * /organizacoes/nova — cria a organização com a identidade como administradora (step-up de até 5 min). Ela nasce
 * AGUARDANDO_ATIVACAO; a ativação é um ato da operação da Nekkora, fora desta interface. `canCreateOrganization` é só
 * indicação: a criação é sempre reconferida pela API.
 */
export function CreateOrganizationPage() {
  const { expired } = useIdentityArea();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [errors, setErrors] = useState<{ name?: string; legalName?: string }>({});
  const [confirming, setConfirming] = useState(false);
  const [uncertain, setUncertain] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = { name: organizationNameProblem(name, true), legalName: organizationNameProblem(legalName, false) };
    setErrors(next);
    if (next.name || next.legalName) return;
    setConfirming(true);
  };

  const waiting = activationLabel('AGUARDANDO_ATIVACAO');

  return (
    <Stack gap={5} className="pw-identity">
      <SectionHeader as="h1" title="Criar organização" description="Você será a administradora ou o administrador da nova organização." />
      {uncertain && (
        <Alert tone="warning" title="Não foi possível confirmar se a organização foi criada.">
          A criação pode ter acontecido. Confira a <Link as={RouterLink} to={identityPath.organizations}>lista de organizações</Link>{' '}
          antes de tentar de novo, para não criar uma organização repetida.
        </Alert>
      )}
      <form className="pw-identity__form" onSubmit={submit} noValidate>
        <Input
          label="Nome da organização"
          name="organization-name"
          required
          fullWidth
          autoFocus
          maxLength={240}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          hint="Até 120 caracteres. É o nome que as pessoas convidadas verão."
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
        <Alert tone="info" title={`A organização nasce "${waiting.label.toLowerCase()}".`}>
          {waiting.description}
        </Alert>
        <div className="pw-form__row">
          <Button type="submit" disabled={uncertain}>
            Continuar
          </Button>
          <Button type="button" variant="ghost" onClick={() => navigate(identityPath.organizations)}>
            Cancelar
          </Button>
        </div>
      </form>

      <StepUpDialog<string>
        open={confirming}
        title={`Criar a organização "${name}"?`}
        guard={{ operation: 'organization.create' }}
        confirmLabel="Criar organização"
        stepUp={identityStepUp}
        action={() => createOrganization(name, legalName || undefined)}
        onDone={(organizationId) => {
          setConfirming(false);
          navigate(identityPath.organizations, { state: { created: organizationId } satisfies OrganizationsNavState });
        }}
        onClose={() => setConfirming(false)}
        refusalText={refusalText}
        uncertainText="Não foi possível confirmar o resultado. A organização pode ter sido criada. Feche e confira a lista de organizações antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(kind) => kind === 'uncertain' && setUncertain(true)}
      >
        <Text>
          A organização é criada com você como administradora ou administrador. Ela fica aguardando a ativação pela
          operação da Nekkora antes de poder executar automações.
        </Text>
      </StepUpDialog>
    </Stack>
  );
}
