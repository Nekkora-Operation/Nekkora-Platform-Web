import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, Container, Heading, Logo, StateView, Text } from 'nekkora-lib';
import { logout, me, type Me } from '../api/auth';
import { csrfStore } from '../api/csrf';
import { isApiError } from '../api/http';
import { readNavState, sessionMemory, type NavState } from '../app/notices';
import { useOrganization } from '../app/organization';
import { commonMessage, type UserMessage } from '../auth/messages';
import { orgPath, shortOrganizationId } from '../auth/organization';
import './HomePage.css';

type State = { kind: 'loading' } | { kind: 'ready'; me: Me } | { kind: 'error'; message: UserMessage };

/**
 * Inatividade do contrato (8.7): a API encerra a sessão após 30 min (conta interna) ou 15 min (portal) sem
 * requisição autenticada. O timer abaixo é SÓ de experiência: passado esse prazo desde a última chamada, pergunta
 * à API (a autoridade) e, se ela responder 401, aplica o fluxo de sessão expirada. Nunca renova nem reautentica.
 */
const INACTIVITY_MS: Record<Me['accountType'], number> = { internal: 30 * 60_000, external: 15 * 60_000 };
const CHECK_MARGIN_MS = 5_000;
const RETRY_MS = 60_000;

/**
 * /o/{org} — área autenticada (V1: ponto de chegada do login). Quem decide se há sessão é a API (/me); estado
 * local nunca libera acesso. 401 = sessão expirada/revogada: limpa a memória e volta ao login da organização.
 */
export function HomePage() {
  const org = useOrganization();
  const navigate = useNavigate();
  const { recoveryCodeUsed } = readNavState(useLocation().state);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [signingOut, setSigningOut] = useState(false);
  const started = useRef(false);
  const watch = useRef<number | undefined>(undefined);

  const expired = useCallback(() => {
    const hadSession = sessionMemory.hadSession();
    csrfStore.clear();
    sessionMemory.reset();
    const nav: NavState = hadSession ? { notice: 'session-expired' } : {};
    navigate(orgPath.login(org), { replace: true, state: nav });
  }, [navigate, org]);

  const arm = useCallback(
    (delay: number, check: () => void) => {
      window.clearTimeout(watch.current);
      watch.current = window.setTimeout(check, delay);
    },
    [],
  );

  const check = useCallback(async () => {
    try {
      const data = await me(org);
      arm(INACTIVITY_MS[data.accountType] + CHECK_MARGIN_MS, () => void check());
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) expired();
      else arm(RETRY_MS, () => void check()); // falha temporária: a tela segue; a próxima chamada decide
    }
  }, [org, expired, arm]);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const data = await me(org);
      sessionMemory.markActive();
      setState({ kind: 'ready', me: data });
      arm(INACTIVITY_MS[data.accountType] + CHECK_MARGIN_MS, () => void check());
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) expired();
      else setState({ kind: 'error', message: commonMessage(e) });
    }
  }, [org, expired, arm, check]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  useEffect(() => () => window.clearTimeout(watch.current), []);

  const signOut = async () => {
    window.clearTimeout(watch.current);
    setSigningOut(true);
    try {
      await logout(org);
    } catch {
      // mesmo com falha de rede o estado local é descartado; a sessão expira no servidor
    } finally {
      sessionMemory.reset();
      navigate(orgPath.login(org), { replace: true, state: { notice: 'signed-out' } satisfies NavState });
    }
  };

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

  const { displayName, email, accountType } = state.me;

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
          {recoveryCodeUsed && (
            <Alert tone="warning" title="Você entrou com um código de recuperação">
              Esse código não pode ser usado novamente. Se perdeu o acesso ao autenticador, fale com o administrador da
              organização para configurar um novo aparelho.
            </Alert>
          )}
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
