import { Link as RouterLink, useLocation } from 'react-router';
import { Alert, Badge, Button, Card, Container, DescriptionList, Heading, Link, Logo, Stack, Text } from 'nekkora-lib';
import { readNavState } from '../app/notices';
import { orgPath, shortOrganizationId } from '../auth/organization';
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
 * Início da área INTERNA (dentro do AppShell). Saudação, dados da conta e resumo de acesso. O resumo vem da P01 (papel
 * organizacional) e da lista de workspaces visíveis (`listWorkspaces`); é só apresentação: quem autoriza é a API.
 */
export function InternalHome() {
  const { org, me } = useSession();
  const { permissions, workspaces } = useInternalArea();

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
      <Heading level={1}>Olá, {me.displayName}</Heading>
      <Card variant="surface" padding="lg">
        <Stack gap={5}>
          <Text color="secondary">Sua sessão no Nekkora Platform está ativa.</Text>
          <DescriptionList
            items={[
              { key: 'email', term: 'E-mail', description: me.email },
              { key: 'tipo', term: 'Tipo de conta', description: <Badge tone="accent">Interna</Badge> },
              { key: 'org', term: 'Organização', description: <code>{org}</code> },
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
