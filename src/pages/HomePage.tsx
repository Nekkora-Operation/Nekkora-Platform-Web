import { Link as RouterLink, useLocation } from 'react-router';
import { Alert, Badge, Button, Card, Container, DescriptionList, Heading, Link, Logo, Stack, Text } from 'nekkora-lib';
import { readNavState } from '../app/notices';
import { identityPath } from '../auth/flow';
import { orgPath, shortOrganizationId } from '../auth/organization';
import { VersionDetails } from '../components/VersionInfo';
import { ActivationNotice, NextStep } from './HomeNextStep';
import { useInternalArea } from '../area/InternalShell';
import { useSession } from '../area/session';
import './HomePage.css';

function RecoveryCodeNotice() {
  const { recoveryCodeUsed } = readNavState(useLocation().state);
  if (!recoveryCodeUsed) return null;
  return (
    <Alert tone="warning" title="Você entrou com um código de recuperação">
      Esse código não pode ser usado novamente. Se perdeu o acesso ao autenticador, fale com o administrador da
      organização para configurar um novo aparelho.
    </Alert>
  );
}

/**
 * Início da conta EXTERNA (encaminhamento separado da área interna; o portal próprio entra na F7). Mesmo conteúdo da
 * V1: sessão ativa, dados da conta e sair.
 */
export function ExternalHome() {
  const { org, me, signOut, signingOut } = useSession();
  const { displayName, email, accountType } = me;
  return (
    <div className="pw-home">
      <header className="pw-home__bar">
        <Logo variant="full" size={26} />
        <div className="pw-home__who">
          <span className="pw-home__org" title={org}>
            {shortOrganizationId(org)}
          </span>
          <Button variant="ghost" size="sm" leftIcon="arrow-right" loading={signingOut} onClick={() => void signOut()}>
            Sair
          </Button>
        </div>
      </header>
      <main>
        <Container size="md" className="pw-home__main">
          <RecoveryCodeNotice />
          <Heading level={1}>Olá, {displayName}</Heading>
          <Card variant="surface" padding="lg">
            <div className="pw-home__card">
              <Text color="secondary">Sua sessão no Nekkora Platform está ativa.</Text>
              <dl className="pw-home__facts">
                <dt>E-mail</dt>
                <dd>{email}</dd>
                <dt>Tipo de conta</dt>
                <dd>
                  <Badge tone="accent">{accountType === 'internal' ? 'Interna' : 'Externa'}</Badge>
                </dd>
                <dt>Organização</dt>
                <dd>
                  <code>{org}</code>
                </dd>
              </dl>
            </div>
          </Card>
        </Container>
      </main>
    </div>
  );
}

/**
 * Início da área INTERNA (dentro do AppShell) — ponto de partida para trabalhar (PLATFORM-LOCAL-002): a organização como
 * contexto (nome e ativação), o próximo passo possível e o resumo de acesso. E-mail e identificadores técnicos ficam em
 * Minha conta. O resumo vem da P01 (papel organizacional) e da lista de workspaces visíveis (`listWorkspaces`); é só
 * apresentação: quem autoriza é a API.
 */
export function InternalHome() {
  const { org, me } = useSession();
  const { organizationName, permissions, workspaces } = useInternalArea();

  const visible =
    workspaces.status === 'loading'
      ? 'Carregando…'
      : workspaces.status === 'error'
        ? 'Não foi possível carregar a lista de workspaces.'
        : workspaces.items.length === 0
          ? 'Nenhum workspace visível para você.'
          : workspaces.complete
            ? `${workspaces.items.length} ${workspaces.items.length === 1 ? 'workspace visível' : 'workspaces visíveis'}`
            : `Pelo menos ${workspaces.items.length} workspaces visíveis (lista parcial)`;

  const access =
    permissions.status === 'loading'
      ? 'Carregando…'
      : permissions.status === 'error'
        ? 'Não foi possível carregar.'
        : permissions.data.organization.roles.includes('ORG_ADMIN')
          ? 'Administração da organização (todos os workspaces)'
          : permissions.data.hasWorkspaceAssignments
            ? 'Por atribuição em workspaces'
            : 'Sem atribuições de acesso';

  return (
    <Stack gap={6}>
      <RecoveryCodeNotice />
      <div className="pw-start__head">
        <Text variant="overline" color="secondary" className="pw-start__org">
          {organizationName === undefined ? 'Organização' : organizationName === null ? 'Organização (nome indisponível)' : organizationName}
        </Text>
        <Heading level={1}>Olá, {me.displayName}</Heading>
      </div>
      <ActivationNotice />
      <NextStep />
      <Card variant="surface" padding="lg">
        <Stack gap={4}>
          <Text as="h2" variant="h4">
            Seu acesso
          </Text>
          <DescriptionList
            items={[
              { key: 'acesso', term: 'Acesso', description: access },
              { key: 'workspaces', term: 'Workspaces', description: visible },
            ]}
          />
        </Stack>
      </Card>
      <Link as={RouterLink} to={orgPath.executions(org)} arrow>
        Ver execuções
      </Link>
    </Stack>
  );
}

/**
 * Minha conta (dentro da organização): os dados da conta, que saíram da página inicial, a organização com o
 * identificador técnico (útil para suporte) e a versão em execução.
 */
export function OrgAccountPage() {
  const { org, me } = useSession();
  const { organizationName } = useInternalArea();
  return (
    <Stack gap={6}>
      <Heading level={1}>Minha conta</Heading>
      <Card variant="surface" padding="lg">
        <Stack gap={4}>
          <Text as="h2" variant="h4">
            Dados da conta
          </Text>
          <DescriptionList
            items={[
              { key: 'nome', term: 'Nome', description: me.displayName },
              { key: 'email', term: 'E-mail', description: me.email },
              { key: 'tipo', term: 'Tipo de conta', description: <Badge tone="accent">Interna</Badge> },
              { key: 'org', term: 'Organização', description: organizationName ?? 'Nome indisponível' },
              { key: 'org-id', term: 'Identificador da organização', description: <code>{org}</code> },
            ]}
          />
          <Link as={RouterLink} to={identityPath.account}>
            Segurança da conta (senha e autenticação)
          </Link>
        </Stack>
      </Card>
      <Card variant="surface" padding="lg">
        <Stack gap={4}>
          <Text as="h2" variant="h4">
            Sobre esta versão
          </Text>
          <VersionDetails />
        </Stack>
      </Card>
    </Stack>
  );
}
