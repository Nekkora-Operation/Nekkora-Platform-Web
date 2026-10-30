import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, Navigate, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Link, StateView } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';
import { enterOrganization, identitySession } from '../api/identity';
import { AuthScreen } from '../app/AuthScreen';
import { readNavState } from '../app/notices';
import { useOrganization } from '../app/organization';
import { identityPath, IdentityFlowProvider } from '../auth/flow';
import { peekInitialLinkToken } from '../auth/linkToken';
import { commonMessage, SESSION_EXPIRED, type UserMessage } from '../auth/messages';
import { orgPath } from '../auth/organization';
import { ForgotPasswordPage } from '../pages/EmailRequestPage';
import { ResetPasswordPage } from '../pages/ResetPasswordPage';
import { ErrorAlert } from '../pages/ErrorAlert';
import '../pages/HomePage.css';

type Probe = { kind: 'loading' } | { kind: 'session'; restricted: boolean } | { kind: 'none' } | { kind: 'unavailable' } | { kind: 'error'; message: UserMessage };

/** Consulta a sessão de identidade (a API é a autoridade; nada local decide). */
function useIdentityProbe() {
  const [probe, setProbe] = useState<Probe>({ kind: 'loading' });
  const run = useCallback(async () => {
    setProbe({ kind: 'loading' });
    try {
      const { restricted } = await identitySession();
      setProbe({ kind: 'session', restricted });
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) setProbe({ kind: 'none' });
      else if (e instanceof ApiError && e.status === 404) setProbe({ kind: 'unavailable' });
      else setProbe({ kind: 'error', message: commonMessage(e) });
    }
  }, []);
  useEffect(() => {
    void run();
  }, [run]);
  return { probe, retry: run };
}

/**
 * `/` — encaminha pela sessão de identidade: com sessão, organizações (ou a troca do fator, se restrita); sem sessão, a
 * entrada geral. Entrada geral desligada (404): explica que o acesso é pelo endereço da organização.
 */
export function RootPage() {
  const { probe, retry } = useIdentityProbe();
  if (probe.kind === 'session') return <Navigate to={probe.restricted ? identityPath.replaceFactor : identityPath.organizations} replace />;
  if (probe.kind === 'none') return <Navigate to={identityPath.login} replace />;
  return (
    <main className="pw-home pw-home--center">
      {probe.kind === 'loading' && <StateView status="loading" title="Carregando…" />}
      {probe.kind === 'unavailable' && (
        <StateView
          status="info"
          title="Entre pelo endereço da sua organização."
          description="A entrada pela identidade Nekkora não está disponível neste ambiente. Use o link de acesso que a sua organização forneceu."
        />
      )}
      {probe.kind === 'error' && (
        <StateView
          status="error"
          title={probe.message.title}
          description={probe.message.description}
          actions={<Button onClick={() => void retry()}>Tentar novamente</Button>}
        />
      )}
    </main>
  );
}

/**
 * `/o/{org}/entrar` — reentrada numa organização. Com sessão de identidade, a troca é feita por GESTO explícito (o
 * cookie de organização é um por origem: entrar aqui encerra a sessão de outra organização, inclusive em outra aba —
 * reentrar automaticamente faria abas disputarem a sessão). Sem sessão de identidade: entrada geral ou, para conta
 * antiga não vinculada, a entrada por conta da organização.
 */
export function OrganizationEntryPage() {
  const org = useOrganization();
  const navigate = useNavigate();
  const { notice } = readNavState(useLocation().state);
  const { probe, retry } = useIdentityProbe();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UserMessage | 'no_access' | null>(null);

  const enter = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await enterOrganization(org);
      if (result === 'entered') navigate(orgPath.home(org), { replace: true });
      else setError('no_access');
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) void retry();
      else setError(commonMessage(e));
    } finally {
      setPending(false);
    }
  };

  const noticeText =
    notice === 'session-expired'
      ? SESSION_EXPIRED
      : notice === 'session-changed'
        ? 'A sessão nesta organização foi encerrada ou trocada em outra aba.'
        : notice === 'signed-out'
          ? 'Você saiu da organização.'
          : null;

  if (probe.kind === 'session' && probe.restricted) return <Navigate to={identityPath.replaceFactor} replace />;

  return (
    <AuthScreen org={org} icon="building" title="Entrar na organização" focusTitle>
      {noticeText && <Alert tone="info">{noticeText}</Alert>}
      {probe.kind === 'loading' && <StateView status="loading" title="Conferindo sua sessão…" />}
      {probe.kind === 'error' && <ErrorAlert message={probe.message} />}
      {probe.kind === 'session' && (
        <>
          {error === 'no_access' && (
            <Alert tone="warning">
              Não foi possível entrar nesta organização. O seu acesso pode ter mudado ou a organização pode não estar
              disponível.
            </Alert>
          )}
          {error && error !== 'no_access' && <ErrorAlert message={error} />}
          <p className="pw-muted">Entrar aqui encerra a sessão aberta em outra organização neste navegador, inclusive em outras abas.</p>
          <Button fullWidth size="lg" loading={pending} onClick={() => void enter()}>
            Entrar nesta organização
          </Button>
          <Link as={RouterLink} to={identityPath.organizations} variant="subtle">
            Ver todas as minhas organizações
          </Link>
        </>
      )}
      {(probe.kind === 'none' || probe.kind === 'unavailable') && (
        <>
          {probe.kind === 'none' && (
            <Button fullWidth size="lg" onClick={() => navigate(identityPath.login)}>
              Entrar com a identidade Nekkora
            </Button>
          )}
          <Link as={RouterLink} to={orgPath.login(org)} variant="subtle">
            Entrar com uma conta antiga desta organização
          </Link>
        </>
      )}
    </AuthScreen>
  );
}

/** `/recuperar-senha` — com `#token=` (link do e-mail): nova senha; sem token: pedido por e-mail. */
export function RecoverPasswordRoute() {
  const { pathname } = useLocation();
  const [hasToken] = useState(() => peekInitialLinkToken(pathname));
  return <IdentityFlowProvider>{hasToken ? <ResetPasswordPage /> : <ForgotPasswordPage />}</IdentityFlowProvider>;
}
