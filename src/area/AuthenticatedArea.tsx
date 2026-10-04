import { Navigate, useLocation } from 'react-router';
import { Button, StateView } from 'nekkora-lib';
import { useOrganization } from '../app/organization';
import { orgPath } from '../auth/organization';
import { ExternalHome } from '../pages/HomePage';
import { InternalShell } from './InternalShell';
import { SessionProvider, useSessionLoader } from './session';
import '../pages/HomePage.css';

/**
 * Portão da área autenticada (/o/{org} e rotas internas). Carrega a sessão pela API (/me) e encaminha:
 * - conta interna → shell interno (AppShell, P01, workspaces visíveis) com as rotas internas;
 * - conta externa → início próprio (encaminhamento separado, como antes). As rotas internas NÃO são montadas para ela:
 *   qualquer caminho interno volta ao início dela, sem carregar P01/P02 nem leituras internas.
 */
export function AuthenticatedArea() {
  const org = useOrganization();
  const { pathname } = useLocation();
  const { state, load, expired, signOut, signingOut } = useSessionLoader(org);

  if (state.kind !== 'ready') {
    return (
      <main className="pw-home pw-home--center">
        {state.kind === 'loading' ? (
          <StateView status="loading" title="Carregando…" />
        ) : (
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

  const session = { org, me: state.me, expired, signOut, signingOut };

  if (state.me.accountType !== 'internal') {
    if (pathname !== orgPath.home(org)) return <Navigate to={orgPath.home(org)} replace />;
    return (
      <SessionProvider value={session}>
        <ExternalHome />
      </SessionProvider>
    );
  }

  return (
    <SessionProvider value={session}>
      <InternalShell />
    </SessionProvider>
  );
}
