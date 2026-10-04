import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link as RouterLink, Outlet, useLocation } from 'react-router';
import { Alert, AppShell, Button, Logo, Text, type AppNavGroup } from 'nekkora-lib';
import { isApiError } from '../api/http';
import { getMyPermissions } from '../api/permissions';
import type { MyPermissions } from '../api/v1';
import { orgPath, shortOrganizationId } from '../auth/organization';
import { useSession } from './session';
import { useVisibleWorkspaces, type VisibleWorkspaces } from './useVisibleWorkspaces';
import './InternalShell.css';

export type PermissionsState = { status: 'loading' } | { status: 'ready'; data: MyPermissions } | { status: 'error' };

export interface InternalArea {
  permissions: PermissionsState;
  workspaces: VisibleWorkspaces;
  reloadWorkspaces: () => void;
  /** Pede a próxima página de workspaces visíveis (sob demanda, enquanto houver cursor). */
  loadMoreWorkspaces: () => void;
  /** Recomeça a lista de workspaces (nova primeira página, sem cursor) depois de continuação recusada. */
  restartWorkspaces: () => void;
}

const InternalContext = createContext<InternalArea | null>(null);

export function useInternalArea(): InternalArea {
  const v = useContext(InternalContext);
  if (!v) throw new Error('useInternalArea fora da área interna');
  return v;
}

/** Título da página atual, para o topo do shell. */
function titleFor(pathname: string, org: string): string {
  return pathname === orgPath.executions(org) ? 'Execuções' : 'Início';
}

/**
 * Área interna (conta `internal`): AppShell da lib + P01 + workspaces visíveis.
 *
 * - A P01 orienta a navegação organizacional e o resumo de acesso; ela só APRESENTA (cada rota autoriza no backend).
 *   Falha da P01 não bloqueia a área: as telas consultam a API, que decide.
 * - Workspaces visíveis vêm de `listWorkspaces` (paginada), nunca da P02.
 * - O menu mostra só telas implementadas (Início e Execuções). Esconder itens não substitui a autorização do backend.
 * - Conta externa nunca chega aqui (o portão da área a mantém no encaminhamento próprio, sem P01/P02).
 */
export function InternalShell() {
  const { org, me, expired, signOut, signingOut } = useSession();
  const { pathname } = useLocation();
  const [permissions, setPermissions] = useState<PermissionsState>({ status: 'loading' });
  const generation = useRef(0);
  const { workspaces, reloadWorkspaces, loadMoreWorkspaces, restartWorkspaces } = useVisibleWorkspaces(org, expired);

  const loadPermissions = useCallback(async () => {
    const gen = ++generation.current;
    setPermissions({ status: 'loading' });
    try {
      const data = await getMyPermissions(org);
      if (gen === generation.current) setPermissions({ status: 'ready', data });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      setPermissions({ status: 'error' });
    }
  }, [org, expired]);

  useEffect(() => {
    void loadPermissions();
    return () => {
      generation.current++;
    };
  }, [loadPermissions]);

  const nav: AppNavGroup[] = [
    {
      id: 'geral',
      items: [{ id: 'inicio', label: 'Início', href: orgPath.home(org), icon: 'home', active: pathname === orgPath.home(org) }],
    },
    {
      id: 'produto',
      label: 'Produto',
      items: [{ id: 'execucoes', label: 'Execuções', href: orgPath.executions(org), icon: 'executions', active: pathname === orgPath.executions(org) }],
    },
  ];

  const access =
    permissions.status === 'ready'
      ? permissions.data.organization.roles.includes('ORG_ADMIN')
        ? 'Administração da organização'
        : permissions.data.hasWorkspaceAssignments
          ? 'Acesso por workspace'
          : 'Sem atribuições de acesso'
      : null;

  return (
    <InternalContext.Provider value={{ permissions, workspaces, reloadWorkspaces, loadMoreWorkspaces, restartWorkspaces }}>
      <AppShell
        className="pw-shell"
        brand={<Logo variant="full" size={24} />}
        brandHref={orgPath.home(org)}
        linkAs={RouterLink}
        nav={nav}
        header={
          <Text variant="h4" as="p" className="pw-shell__title">
            {titleFor(pathname, org)}
          </Text>
        }
        actions={
          <div className="pw-shell__account">
            <span className="pw-shell__name">{me.displayName}</span>
            <Button variant="ghost" size="sm" leftIcon="arrow-right" loading={signingOut} onClick={() => void signOut()}>
              Sair
            </Button>
          </div>
        }
        sidebarFooter={
          <div className="pw-shell__footer">
            <span className="pw-shell__footer-name">{me.displayName}</span>
            <span className="pw-shell__footer-email">{me.email}</span>
            <span className="pw-shell__footer-org" title={org}>
              Organização {shortOrganizationId(org)}
            </span>
            {access && <span className="pw-shell__footer-access">{access}</span>}
          </div>
        }
      >
        {permissions.status === 'error' && (
          <Alert
            tone="warning"
            title="Não foi possível carregar suas permissões."
            action={
              <Button size="sm" variant="secondary" onClick={() => void loadPermissions()}>
                Tentar novamente
              </Button>
            }
            className="pw-shell__alert"
          >
            A navegação segue disponível; o acesso a cada tela continua sendo decidido pela API.
          </Alert>
        )}
        <Outlet />
      </AppShell>
    </InternalContext.Provider>
  );
}
