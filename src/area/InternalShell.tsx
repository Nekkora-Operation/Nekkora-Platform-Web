import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, Outlet, useLocation } from 'react-router';
import { Alert, AppShell, Button, Link, Logo, Text, type AppNavGroup } from 'nekkora-lib';
import { isApiError } from '../api/http';
import { getMyPermissions } from '../api/permissions';
import { myOrganizations } from '../api/identity';
import type { MyPermissions, PermissionCode } from '../api/v1';
import { identityPath } from '../auth/flow';
import { OperationScopeProvider, type OperationScopeValue } from '../components/operationScope';
import { setPersistentScope } from '../admin/writeStore';
import { orgPath, shortOrganizationId } from '../auth/organization';
import { VersionFooter } from '../components/VersionInfo';
import { useSession } from './session';
import { useVisibleWorkspaces, type VisibleWorkspaces } from './useVisibleWorkspaces';
import './InternalShell.css';

export type PermissionsState = { status: 'loading' } | { status: 'ready'; data: MyPermissions } | { status: 'error' };

export interface InternalArea {
  /** Nome da organização aberta: `undefined` enquanto carrega; `null` se não foi possível obtê-lo. */
  organizationName: string | null | undefined;
  permissions: PermissionsState;
  workspaces: VisibleWorkspaces;
  reloadWorkspaces: () => void;
  /** Pede a próxima página de workspaces visíveis (sob demanda, enquanto houver cursor). */
  loadMoreWorkspaces: () => void;
  /** Recomeça a lista de workspaces (nova primeira página, sem cursor) depois de continuação recusada. */
  restartWorkspaces: () => void;
  /** Lê de novo as permissões da organização (P01), por exemplo depois de uma falha (429, rede). */
  reloadPermissions: () => void;
}

const InternalContext = createContext<InternalArea | null>(null);

export function useInternalArea(): InternalArea {
  const v = useContext(InternalContext);
  if (!v) throw new Error('useInternalArea fora da área interna');
  return v;
}

const MAIN_ID = 'conteudo';

/** Seção da área interna a que o endereço pertence (menu ativo e título do topo). */
function sectionOf(pathname: string, org: string): 'inicio' | 'conta' | 'execucoes' | 'workspaces' | 'membros' | 'clientes' | 'concessoes' | 'convites' | 'auditoria' | 'workers' | 'supervisao' | null {
  if (pathname === orgPath.home(org)) return 'inicio';
  const rest = pathname.slice(orgPath.home(org).length);
  if (rest === '/execucoes' || rest.startsWith('/execucoes/')) return 'execucoes';
  if (rest === '/workspaces' || rest.startsWith('/workspaces/') || rest.startsWith('/automacoes/') || rest.startsWith('/versoes/')) return 'workspaces';
  if (rest === '/administracao/membros' || rest.startsWith('/administracao/membros/')) return 'membros';
  if (rest === '/administracao/convites') return 'convites';
  if (rest === '/workers') return 'workers';
  if (rest === '/supervisao' || rest.startsWith('/supervisao/')) return 'supervisao';
  if (rest === '/administracao/auditoria') return 'auditoria';
  if (rest === '/administracao/clientes') return 'clientes';
  if (rest === '/administracao/concessoes') return 'concessoes';
  if (rest === '/conta') return 'conta';
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
  if (rest === '/workers') return 'Workers';
  if (rest === '/supervisao') return 'Supervisão';
  if (rest.startsWith('/supervisao/')) return 'Execução local';
  if (rest === '/administracao/auditoria') return 'Auditoria de acessos';
  if (rest === '/administracao/clientes') return 'Clientes';
  if (rest === '/administracao/concessoes') return 'Concessões';
  if (rest === '/conta') return 'Minha conta';
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
  // Nome da organização aberta (PLATFORM-LOCAL-001): a sessão de organização não traz o nome (D1/D7), mas a lista da
  // identidade traz. Sem sessão de identidade (entrada antiga por organização) ou em erro, fica o identificador abreviado.
  const [orgName, setOrgName] = useState<string | null | undefined>(undefined);
  // T10 (PLATFORM-AGENT-V2-003): o identificador legível acompanha o nome (organizações de mesmo nome ficam distinguíveis)
  const [orgHandle, setOrgHandle] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setOrgName(undefined);
    setOrgHandle(null);
    myOrganizations()
      .then((list) => {
        const found = list.organizations.find((o) => o.organizationId === org);
        if (alive) {
          setOrgName(found?.name ?? null);
          setOrgHandle(found?.handle ?? null);
        }
      })
      .catch(() => {
        if (alive) setOrgName(null);
      });
    return () => {
      alive = false;
    };
  }, [org]);
  const orgLabel = orgName ?? shortOrganizationId(org);
  const { pathname } = useLocation();
  const [permissions, setPermissions] = useState<PermissionsState>({ status: 'loading' });
  const generation = useRef(0);
  const { workspaces, reloadWorkspaces, loadMoreWorkspaces, restartWorkspaces } = useVisibleWorkspaces(org, expired);
  const section = sectionOf(pathname, org);
  const membershipId = permissions.status === 'ready' ? permissions.data.membershipId : null;
  // registro de operações incertas: vínculo desta organização (outra pessoa ou organização não encontra o registro)
  // definido já na renderização (atribuição idempotente): os efeitos das páginas filhas rodam ANTES dos efeitos deste
  // componente e já precisam do sujeito para restaurar incertezas persistentes
  setPersistentScope(org, membershipId ? `m:${membershipId}` : null);
  useEffect(() => () => setPersistentScope(org, null), [org]);
  const operationScope = useMemo<OperationScopeValue>(() => ({ org, subject: async () => (membershipId ? `m:${membershipId}` : null) }), [org, membershipId]);

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
        // PLATFORM-AGENT-V2-002, T07: Workers é a entrada única (a máquina vinculada é gerida na linha do Worker); /agents leva até lá.
        // R1: quem administra só Agents (agent.manage) também entra, para as ações que tinha na antiga tela de Agents.
        ...(permissions.status === 'ready' &&
        (permissions.data.organization.permissions.includes('worker.manage') || permissions.data.organization.permissions.includes('agent.manage'))
          ? [{ id: 'workers', label: 'Workers', href: orgPath.workers(org), icon: 'server' as const, active: section === 'workers' }]
          : []),
      ],
    },
    {
      id: 'conta',
      label: 'Conta',
      items: [{ id: 'minha-conta', label: 'Minha conta', href: orgPath.account(org), icon: 'user', active: section === 'conta' }],
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
    <InternalContext.Provider value={{ organizationName: orgName, permissions, workspaces, reloadWorkspaces, loadMoreWorkspaces, restartWorkspaces, reloadPermissions: loadPermissions }}>
      <OperationScopeProvider value={operationScope}>
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
            <span className="pw-shell__org" title={org} aria-label={`Organização aberta: ${orgLabel}${orgHandle ? ` (${orgHandle})` : ''}`}>
              {orgLabel}
              {orgHandle && <span className="pw-shell__org-handle"> · {orgHandle}</span>}
            </span>
            <Link as={RouterLink} to={identityPath.organizations} size="sm" variant="subtle">
              Trocar organização
            </Link>
            <Link as={RouterLink} to={orgPath.account(org)} size="sm" variant="subtle" className="pw-shell__name" aria-label={`Minha conta (${me.displayName})`}>
              {me.displayName}
            </Link>
            <Button variant="ghost" size="sm" leftIcon="arrow-right" loading={signingOut} onClick={() => void signOut()}>
              Sair
            </Button>
          </div>
        }
        sidebarFooter={
          <div className="pw-shell__footer">
            <span className="pw-shell__footer-name">{me.displayName}</span>
            <span className="pw-shell__footer-org" title={org}>
              Organização {orgLabel}
            </span>
            {access && <span className="pw-shell__footer-access">{access}</span>}
            <VersionFooter />
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
      </OperationScopeProvider>
    </InternalContext.Provider>
  );
}
