import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link as RouterLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { Alert, AppShell, Button, Logo, StateView, Text, type AppNavGroup } from 'nekkora-lib';
import { csrfStore } from '../api/csrf';
import { ApiError, isApiError } from '../api/http';
import { identityLogout, identitySession } from '../api/identity';
import { sessionMemory, type NavState } from '../app/notices';
import { identityPath } from '../auth/flow';
import { commonMessage, UNAVAILABLE, type UserMessage } from '../auth/messages';
import '../area/InternalShell.css';
import '../pages/HomePage.css';

export interface IdentityAreaContext {
  restricted: boolean;
  /** 401 numa leitura da identidade: a sessão caiu (expirou, foi revogada ou encerrada). */
  expired: () => void;
  /** A sessão continua, mas a restrição pode ter mudado (ex.: fator trocado). */
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
  signingOut: boolean;
}

const Ctx = createContext<IdentityAreaContext | null>(null);

export function useIdentityArea(): IdentityAreaContext {
  const v = useContext(Ctx);
  if (!v) throw new Error('useIdentityArea fora da área da identidade');
  return v;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; restricted: boolean }
  | { kind: 'anonymous' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: UserMessage };

const MAIN_ID = 'conteudo';

function titleFor(pathname: string): string {
  if (pathname === identityPath.newOrganization) return 'Nova organização';
  if (pathname === identityPath.organizations) return 'Organizações';
  if (pathname === identityPath.replaceFactor) return 'Autenticador';
  if (pathname === identityPath.account) return 'Segurança da conta';
  if (pathname === identityPath.linkAccount) return 'Vincular conta de organização';
  return 'Identidade Nekkora';
}

/**
 * Área da identidade Nekkora (fora de /o/{org}): organizações, criação, vinculação e segurança da conta. A sessão é
 * consultada na API (GET /api/v1/me/session) a cada montagem — estado local nunca libera acesso.
 *
 * Sessão RESTRITA (entrada com código de recuperação, DC-17.13): só a troca do fator e a saída. Qualquer outra rota
 * desta área leva à troca do fator, e o menu não mostra o resto até a API liberar.
 */
export function IdentityArea() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const { pathname } = useLocation();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [signingOut, setSigningOut] = useState(false);
  const ended = useRef(false);

  const load = useCallback(async () => {
    try {
      const { restricted } = await identitySession();
      sessionMemory.markActive();
      setState({ kind: 'ready', restricted });
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) setState({ kind: 'anonymous' });
      else if (e instanceof ApiError && e.status === 404) setState({ kind: 'unavailable' });
      else setState({ kind: 'error', message: commonMessage(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const expired = useCallback(() => {
    if (ended.current) return;
    ended.current = true;
    const nav: NavState = sessionMemory.hadSession() ? { notice: 'session-expired' } : {};
    csrfStore.clear();
    sessionMemory.reset();
    navigateRef.current(identityPath.login, { replace: true, state: nav });
  }, []);

  // sessão trocada ou encerrada em OUTRA aba: o conteúdo desta deixa de valer agora
  useEffect(
    () =>
      csrfStore.onSessionBoundary((remote, scope) => {
        // outra aba só entrou numa organização: a sessão de identidade (cookie próprio) continua valendo aqui
        if (!remote || scope === 'organization' || ended.current) return;
        ended.current = true;
        sessionMemory.reset();
        navigateRef.current(identityPath.login, { replace: true, state: { notice: 'session-changed' } satisfies NavState });
      }),
    [],
  );

  const signOut = useCallback(async () => {
    ended.current = true;
    setSigningOut(true);
    let notice: 'signed-out' | 'signed-out-unconfirmed' = 'signed-out';
    try {
      await identityLogout();
    } catch {
      // a memória local foi limpa, mas o servidor não confirmou o fim da sessão: a pessoa é avisada
      notice = 'signed-out-unconfirmed';
    } finally {
      sessionMemory.reset();
      navigateRef.current(identityPath.login, { replace: true, state: { notice } satisfies NavState });
    }
  }, []);

  if (state.kind === 'anonymous') {
    return <Navigate to={identityPath.login} replace state={sessionMemory.hadSession() ? ({ notice: 'session-expired' } satisfies NavState) : {}} />;
  }
  if (state.kind !== 'ready') {
    return (
      <main className="pw-home pw-home--center">
        {state.kind === 'loading' && <StateView status="loading" title="Carregando…" />}
        {state.kind === 'unavailable' && <StateView status="warning" title="Acesso indisponível" description={UNAVAILABLE} />}
        {state.kind === 'error' && (
          <StateView
            status="error"
            title={state.message.title}
            description={state.message.description}
            meta={state.message.requestId ? `Código de referência: ${state.message.requestId}` : undefined}
            actions={<Button onClick={() => void load()}>Tentar novamente</Button>}
          />
        )}
      </main>
    );
  }

  if (state.restricted && pathname !== identityPath.replaceFactor) return <Navigate to={identityPath.replaceFactor} replace />;

  const nav: AppNavGroup[] = state.restricted
    ? [{ id: 'conta', items: [{ id: 'fator', label: 'Trocar autenticador', href: identityPath.replaceFactor, icon: 'shield', active: true }] }]
    : [
        {
          id: 'geral',
          items: [
            { id: 'orgs', label: 'Organizações', href: identityPath.organizations, icon: 'building', active: pathname.startsWith(identityPath.organizations) },
          ],
        },
        {
          id: 'conta',
          label: 'Conta',
          items: [
            { id: 'seguranca', label: 'Segurança da conta', href: identityPath.account, icon: 'shield', active: pathname.startsWith(identityPath.account) },
            { id: 'vincular', label: 'Vincular conta antiga', href: identityPath.linkAccount, icon: 'key', active: pathname === identityPath.linkAccount },
          ],
        },
      ];

  const context: IdentityAreaContext = {
    restricted: state.restricted,
    expired,
    reload: load,
    signOut,
    signingOut,
  };

  return (
    <Ctx.Provider value={context}>
      <AppShell
        className="pw-shell"
        brand={<Logo variant="full" size={24} />}
        brandHref={state.restricted ? identityPath.replaceFactor : identityPath.organizations}
        linkAs={RouterLink}
        mainId={MAIN_ID}
        nav={nav}
        header={
          <Text variant="h4" as="p" className="pw-shell__title">
            {titleFor(pathname)}
          </Text>
        }
        actions={
          <div className="pw-shell__account">
            <Button variant="ghost" size="sm" leftIcon="arrow-right" loading={signingOut} onClick={() => void signOut()}>
              Sair
            </Button>
          </div>
        }
        sidebarFooter={
          <div className="pw-shell__footer">
            <span className="pw-shell__footer-name">Identidade Nekkora</span>
            <span className="pw-shell__footer-access">{state.restricted ? 'Sessão restrita à troca do autenticador' : 'Sessão de identidade'}</span>
          </div>
        }
      >
        {state.restricted && (
          <Alert tone="warning" title="Você entrou com um código de recuperação." className="pw-shell__alert">
            Até cadastrar um autenticador novo, esta sessão só permite trocar o autenticador ou sair. As demais sessões da
            sua conta foram encerradas e você recebeu um aviso por e-mail.
          </Alert>
        )}
        <Outlet />
      </AppShell>
    </Ctx.Provider>
  );
}
