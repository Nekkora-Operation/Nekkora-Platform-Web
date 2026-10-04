import { createContext, Fragment, useContext } from 'react';
import { Outlet, useParams } from 'react-router';
import { isValidOrganizationId } from '../auth/organization';
import { OrganizationNotFoundPage } from '../pages/StatusPages';

const OrganizationContext = createContext<string | null>(null);

/** Organização da rota atual. Só existe dentro de /o/:orgId. */
export function useOrganization(): string {
  const org = useContext(OrganizationContext);
  if (!org) throw new Error('useOrganization fora de /o/:orgId');
  return org;
}

/**
 * /o/:orgId/* — resolve o contexto a partir da URL; formato inválido = organização não encontrada. Trocar de
 * organização remonta toda a subárvore (chave): nenhum conteúdo nem resposta atrasada da anterior sobrevive.
 */
export function OrganizationRoute() {
  const { orgId } = useParams();
  if (!isValidOrganizationId(orgId)) return <OrganizationNotFoundPage />;
  const org = orgId.toLowerCase();
  return (
    <OrganizationContext.Provider value={org}>
      <Fragment key={org}>
        <Outlet />
      </Fragment>
    </OrganizationContext.Provider>
  );
}
