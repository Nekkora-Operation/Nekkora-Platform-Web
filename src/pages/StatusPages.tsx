import { Button } from 'nekkora-lib';
import { useNavigate } from 'react-router';
import { config } from '../config';
import { AuthScreen } from '../app/AuthScreen';
import { useOrganization } from '../app/organization';
import { orgPath } from '../auth/organization';

/**
 * Entrada sem organização (ex.: /login). V1 NÃO resolve a organização de outra forma (sem campo "Digite sua
 * empresa", sem seletor): esse fluxo precisa de desenho de produto próprio.
 */
export function NoOrganizationPage() {
  return (
    <AuthScreen
      icon="building"
      title="Não foi possível identificar a organização."
      description="Utilize o endereço de acesso fornecido pela sua empresa."
      focusTitle
    >
      <Button variant="secondary" fullWidth href={config.siteUrl} leftIcon="arrow-left">
        Voltar para Nekkora
      </Button>
    </AuthScreen>
  );
}

/** Identificador de organização com formato inválido. Nunca redireciona para outra organização. */
export function OrganizationNotFoundPage() {
  return (
    <AuthScreen
      icon="building"
      title="Organização não encontrada"
      description="Verifique o endereço utilizado ou entre em contato com o responsável pelo acesso."
      focusTitle
    >
      <Button variant="secondary" fullWidth href={config.siteUrl} leftIcon="arrow-left">
        Voltar para Nekkora
      </Button>
    </AuthScreen>
  );
}

/** Rota desconhecida dentro de uma organização: volta para o login DAQUELA organização. */
export function NotFoundInOrganizationPage() {
  const org = useOrganization();
  const navigate = useNavigate();
  return (
    <AuthScreen org={org} icon="search" title="Página não encontrada" description="O endereço acessado não existe." focusTitle>
      <Button fullWidth onClick={() => navigate(orgPath.login(org))}>
        Ir para o login
      </Button>
    </AuthScreen>
  );
}
