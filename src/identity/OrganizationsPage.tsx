import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, Link, SectionHeader, Stack, StateView, Text } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';
import { enterOrganization, myOrganizations, type IdentityOrganization, type IdentityOrganizationList } from '../api/identity';
import { identityPath } from '../auth/flow';
import { commonMessage, UNAVAILABLE, type UserMessage } from '../auth/messages';
import { orgPath, shortOrganizationId } from '../auth/organization';
import { ErrorAlert } from '../pages/ErrorAlert';
import { pendingInvitation } from './AcceptInvitationPage';
import { useIdentityArea } from './IdentityArea';
import { activationLabel, ROLE_LABEL } from './labels';
import './identity.css';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: IdentityOrganizationList }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: UserMessage };

/** Organização recém-criada (estado de navegação): destaque e próximo passo. */
export interface OrganizationsNavState {
  created?: string;
}

/**
 * /organizacoes — organizações em que a identidade pode entrar (vínculo ativo, conta elegível, organização ativa).
 * Entrar = troca da sessão de identidade por uma sessão da organização, por gesto explícito (o cookie de organização é
 * um por origem: entrar aqui encerra a sessão de outra organização, inclusive em outra aba).
 */
export function OrganizationsPage() {
  const { expired, restricted } = useIdentityArea();
  const navigate = useNavigate();
  const created = (useLocation().state as OrganizationsNavState | null)?.created;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [entering, setEntering] = useState<string | null>(null);
  const [enterError, setEnterError] = useState<{ org: string; message: UserMessage | 'no_access' } | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setState({ kind: 'loading' });
    try {
      const data = await myOrganizations();
      if (gen === generation.current) setState({ kind: 'ready', data });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      if (e instanceof ApiError && e.status === 404) setState({ kind: 'unavailable' });
      else setState({ kind: 'error', message: commonMessage(e) });
    }
  }, [expired]);

  useEffect(() => {
    if (restricted) return; // a área leva à troca do fator; a API recusaria (403)
    void load();
    return () => {
      generation.current++;
    };
  }, [load, restricted]);

  const enter = async (org: IdentityOrganization) => {
    if (entering) return;
    setEntering(org.organizationId);
    setEnterError(null);
    try {
      const result = await enterOrganization(org.organizationId);
      if (result === 'entered') {
        navigate(orgPath.home(org.organizationId));
        return;
      }
      setEnterError({ org: org.organizationId, message: 'no_access' });
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      setEnterError({ org: org.organizationId, message: commonMessage(e) });
    } finally {
      setEntering(null);
    }
  };

  if (state.kind === 'loading') return <StateView status="loading" title="Carregando organizações…" />;
  if (state.kind === 'unavailable') return <StateView status="warning" title="Organizações indisponíveis" description={UNAVAILABLE} />;
  if (state.kind === 'error')
    return (
      <StateView
        status="error"
        title={state.message.title}
        description={state.message.description}
        meta={state.message.requestId ? `Código de referência: ${state.message.requestId}` : undefined}
        actions={<Button onClick={() => void load()}>Tentar novamente</Button>}
      />
    );

  const { organizations, canCreateOrganization } = state.data;
  const invitation = pendingInvitation.peek();

  return (
    <Stack gap={5} className="pw-identity">
      <div className="pw-identity__header">
        <SectionHeader title="Suas organizações" description="Escolha a organização em que deseja trabalhar. Você pode trocar a qualquer momento." />
        {canCreateOrganization && (
          <Button onClick={() => navigate(identityPath.newOrganization)} leftIcon="plus">
            Criar organização
          </Button>
        )}
      </div>

      {invitation && (
        <Alert tone="info" title="Você abriu um convite nesta aba.">
          <Stack gap={2}>
            <span>Continue para aceitar o convite da organização {shortOrganizationId(invitation.org)}.</span>
            <span>
              <Button size="sm" onClick={() => navigate(orgPath.invitation(invitation.org))}>
                Continuar o aceite
              </Button>
            </span>
          </Stack>
        </Alert>
      )}

      {organizations.length === 0 ? (
        <StateView
          status="neutral"
          icon="building"
          title="Você ainda não participa de nenhuma organização."
          description={
            canCreateOrganization
              ? 'Crie uma organização ou peça a quem administra uma organização que envie um convite para o seu e-mail.'
              : 'Peça a quem administra uma organização que envie um convite para o seu e-mail. O link do convite traz você de volta para cá.'
          }
          actions={
            <>
              {canCreateOrganization && (
                <Button onClick={() => navigate(identityPath.newOrganization)} leftIcon="plus">
                  Criar organização
                </Button>
              )}
              <Link as={RouterLink} to={identityPath.linkAccount}>
                Tenho uma conta antiga numa organização
              </Link>
            </>
          }
        />
      ) : (
        <ul className="pw-identity__orgs" aria-label="Organizações">
          {organizations.map((o) => {
            const activation = activationLabel(o.activationState);
            const err = enterError?.org === o.organizationId ? enterError.message : null;
            return (
              <li key={o.organizationId}>
                <Card variant="outlined" padding="md" className={o.organizationId === created ? 'pw-identity__org--new' : undefined}>
                  <div className="pw-identity__org">
                    <div className="pw-identity__org-main">
                      <Text as="h2" variant="h4">
                        {o.name}
                      </Text>
                      <Text variant="body-sm" color="secondary">
                        <span title={o.organizationId}>{shortOrganizationId(o.organizationId)}</span>
                        {' · '}
                        {o.roles.length ? o.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ') : 'Sem papel na organização'}
                      </Text>
                      <div className="pw-identity__badges">
                        <Badge tone={activation.tone} dot>
                          {activation.label}
                        </Badge>
                        {o.organizationId === created && <Badge tone="info">Criada agora</Badge>}
                      </div>
                      {o.activationState === 'AGUARDANDO_ATIVACAO' && (
                        <Text variant="body-sm" color="secondary">
                          {activation.description}
                        </Text>
                      )}
                    </div>
                    <Button
                      onClick={() => void enter(o)}
                      loading={entering === o.organizationId}
                      disabled={entering !== null && entering !== o.organizationId}
                      aria-label={`Entrar em ${o.name}`}
                    >
                      Entrar
                    </Button>
                  </div>
                  {err === 'no_access' && (
                    <Alert tone="warning" className="pw-identity__org-alert">
                      Não foi possível entrar nesta organização. O acesso pode ter mudado. A lista foi mantida como estava;
                      atualize para ver a situação atual.
                    </Alert>
                  )}
                  {err && err !== 'no_access' && <ErrorAlert message={err} />}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Text variant="body-sm" color="secondary">
        Entrar numa organização encerra a sessão aberta em outra organização neste navegador, inclusive em outras abas.
      </Text>
      <div>
        <Button variant="ghost" size="sm" leftIcon="refresh" onClick={() => void load()}>
          Atualizar lista
        </Button>
      </div>
    </Stack>
  );
}
