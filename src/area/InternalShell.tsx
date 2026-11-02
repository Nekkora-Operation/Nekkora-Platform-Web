import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link as RouterLink, Outlet, useLocation } from 'react-router';
import { Alert, AppShell, Button, Link, Logo, Text, type AppNavGroup } from 'nekkora-lib';
import { isApiError } from '../api/http';
import { getMyPermissions } from '../api/permissions';
import type { MyPermissions, PermissionCode } from '../api/v1';
import { identityPath } from '../auth/flow';
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

const MAIN_ID = 'conteudo';

/** Seção da área interna a que o endereço pertence (menu ativo e título do topo). */
function sectionOf(pathname: string, org: string): 'inicio' | 'execucoes' | 'workspaces' | 'membros' | 'clientes' | 'concessoes' | 'convites' | 'auditoria' | 'agents' | 'workers' | 'supervisao' | null {
  if (pathname === orgPath.home(org)) return 'inicio';
  const rest = pathname.slice(orgPath.home(org).length);
  if (rest === '/execucoes' || rest.startsWith('/execucoes/')) return 'execucoes';
  if (rest === '/workspaces' || rest.startsWith('/workspaces/') || rest.startsWith('/automacoes/') || rest.startsWith('/versoes/')) return 'workspaces';
  if (rest === '/administracao/membros' || rest.startsWith('/administracao/membros/')) return 'membros';
  if (rest === '/administracao/convites') return 'convites';
  if (rest === '/agents') return 'agents';
  if (rest === '/workers') return 'workers';
  if (rest === '/supervisao' || rest.startsWith('/supervisao/')) return 'supervisao';
  if (rest === '/administracao/auditoria') return 'auditoria';
  if (rest === '/administracao/clientes') return 'clientes';
  if (rest === '/administracao/concessoes') return 'concessoes';
  return null;
}

/** Título da página atual, para o topo do shell. */
function titleFor(pathname: string, org: string): string {
  const rest = pathname.slice(orgPath.home(org).length);
  if (rest.startsWith('/execucoes/')) return 'Execução';
  if (rest === '/execucoes') return 'Execuções';
  if (rest.startsWith('/workspaces/')) return 'Workspace';
  if (rest === '/workspaces') return 'Workspaces';
  if (rest.startsWith('/automacoes/')) return 'Automação';
  if (rest.startsWith('/versoes/')) return 'Versão';
  if (rest === '/administracao/membros') return 'Membros';
  if (rest.startsWith('/administracao/membros/')) return 'Acessos do membro';
  if (rest === '/administracao/convites') return 'Convites';
  if (rest === '/agents') return 'Agents';
  if (rest === '/workers') return 'Workers';
  if (rest === '/supervisao') return 'Supervisão';
  if (rest.startsWith('/supervisao/')) return 'Execução local';
  if (rest === '/administracao/auditoria') return 'Auditoria de acessos';
  if (rest === '/administracao/clientes') return 'Clientes';
  if (rest === '/administracao/concessoes') return 'Concessões';
  return 'Início';
}

/**
 * Área interna (conta `internal`): AppShell da lib + P01 + workspaces visíveis.
 *
 * - A P01 orienta a navegação organizacional e o resumo de acesso; ela só APRESENTA (cada rota autoriza no backend).
 *   Falha da P01 não bloqueia a área: as telas consultam a API, que decide.
 * - Workspaces visíveis vêm de `listWorkspaces` (paginada), nunca da P02.
 * - O menu mostra só telas implementadas (Início, Workspaces, Execuções e, pela P01, Administração). Esconder itens não
 *   substitui a autorização do backend.
 * - Conta externa nunca chega aqui (o portão da área a mantém no encaminhamento próprio, sem P01/P02).
 */
export function InternalShell() {
  const { org, me, expired, signOut, signingOut } = useSession();
  const { pathname } = useLocation();
  const [permissions, setPermissions] = useState<PermissionsState>({ status: 'loading' });
  const generation = useRef(0);
  const { workspaces, reloadWorkspaces, loadMoreWorkspaces, restartWorkspaces } = useVisibleWorkspaces(org, expired);
  const section = sectionOf(pathname, org);

  // Navegação entre páginas (não a primeira carga, nem só a troca de filtros na query): o foco vai ao conteúdo
  // principal, para o leitor de tela e o teclado começarem pela nova página.
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    document.getElementById(MAIN_ID)?.focus({ preventScroll: false });
  }, [pathname]);

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
      items: [{ id: 'inicio', label: 'Início', href: orgPath.home(org), icon: 'home', active: section === 'inicio' }],
    },
    {
      id: 'produto',
      label: 'Produto',
      items: [
        { id: 'workspaces', label: 'Workspaces', href: orgPath.workspaces(org), icon: 'workspace', active: section === 'workspaces' },
        { id: 'execucoes', label: 'Execuções', href: orgPath.executions(org), icon: 'executions', active: section === 'execucoes' },
      ],
    },
    {
      id: 'execucao-local',
      label: 'Execução local',
      items: [
        { id: 'supervisao', label: 'Supervisão', href: orgPath.agentRuns(org), icon: 'pulse', active: section === 'supervisao' },
        ...(permissions.status === 'ready' && permissions.data.organization.permissions.includes('agent.manage')
          ? [{ id: 'agents', label: 'Agents', href: orgPath.agents(org), icon: 'agent' as const, active: section === 'agents' }]
          : []),
        ...(permissions.status === 'ready' && permissions.data.organization.permissions.includes('worker.manage')
          ? [{ id: 'workers', label: 'Workers', href: orgPath.workers(org), icon: 'server' as const, active: section === 'workers' }]
          : []),
      ],
    },
  ];
  // Administração (F6a-1): itens pela P01 — membros com org.manage; clientes com org.manage OU external_access.manage;
  // concessões com external_access.manage. Sem P01 (carregando ou em erro) o grupo não aparece; o endereço direto
  // continua funcionando e a API decide.
  if (permissions.status === 'ready') {
    const has = (p: PermissionCode) => permissions.data.organization.permissions.includes(p);
    const admin: AppNavGroup['items'] = [];
    if (has('org.manage')) admin.push({ id: 'membros', label: 'Membros', href: orgPath.members(org), icon: 'users', active: section === 'membros' });
    if (has('org.manage')) admin.push({ id: 'convites', label: 'Convites', href: orgPath.invitations(org), icon: 'mail', active: section === 'convites' });
    if (has('org.manage') || has('external_access.manage'))
      admin.push({ id: 'clientes', label: 'Clientes', href: orgPath.clients(org), icon: 'building', active: section === 'clientes' });
    if (has('external_access.manage'))
      admin.push({ id: 'concessoes', label: 'Concessões', href: orgPath.grants(org), icon: 'key', active: section === 'concessoes' });
    if (has('org.manage'))
      admin.push({ id: 'auditoria', label: 'Auditoria de acessos', href: orgPath.accessEvents(org), icon: 'file', active: section === 'auditoria' });
    if (admin.length) nav.push({ id: 'administracao', label: 'Administração', items: admin });
  }

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
        mainId={MAIN_ID}
        nav={nav}
        header={
          <Text variant="h4" as="p" className="pw-shell__title">
            {titleFor(pathname, org)}
          </Text>
        }
        actions={
          <div className="pw-shell__account">
            <Link as={RouterLink} to={identityPath.organizations} size="sm" variant="subtle">
              Trocar organização
            </Link>
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
