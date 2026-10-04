import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { logout, me, type Me } from '../api/auth';
import { csrfStore } from '../api/csrf';
import { isApiError } from '../api/http';
import { sessionMemory, type NavState } from '../app/notices';
import { commonMessage, type UserMessage } from '../auth/messages';
import { orgPath } from '../auth/organization';

/**
 * Inatividade do contrato (8.7): a API encerra a sessão após 30 min (conta interna) ou 15 min (portal) sem
 * requisição autenticada. O timer abaixo é SÓ de experiência: passado esse prazo desde a última chamada, pergunta
 * à API (a autoridade) e, se ela responder 401, aplica o fluxo de sessão expirada. Nunca renova nem reautentica.
 */
const INACTIVITY_MS: Record<Me['accountType'], number> = { internal: 30 * 60_000, external: 15 * 60_000 };
const CHECK_MARGIN_MS = 5_000;
const RETRY_MS = 60_000;

export type SessionState = { kind: 'loading' } | { kind: 'ready'; me: Me } | { kind: 'error'; message: UserMessage };

export interface Session {
  org: string;
  me: Me;
  /** Sessão inválida (401 numa LEITURA de sessão): limpa a memória e volta ao login com o aviso. */
  expired: () => void;
  signOut: () => Promise<void>;
  signingOut: boolean;
}

const SessionContext = createContext<Session | null>(null);
export const SessionProvider = SessionContext.Provider;

/** Sessão da área autenticada (só existe dentro dela). */
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession fora da área autenticada');
  return s;
}

/**
 * Carrega a sessão pela API (/me) e cuida da inatividade e da saída. Estado local nunca libera acesso: quem decide é
 * a API. 401 aqui = sessão expirada/revogada (é leitura de sessão; erros de credencial não passam por aqui).
 */
export function useSessionLoader(org: string) {
  // useNavigate muda de identidade a cada navegação (BrowserRouter): a ref mantém expired/signOut estáveis, para as
  // leituras que dependem deles (P01, listas) não serem refeitas a cada troca de tela
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [state, setState] = useState<SessionState>({ kind: 'loading' });
  const [signingOut, setSigningOut] = useState(false);
  const started = useRef(false);
  /** A sessão desta área já terminou (expirada ou saída): 401 concorrentes seguintes não navegam de novo. */
  const ended = useRef(false);
  const watch = useRef<number | undefined>(undefined);

  const expired = useCallback(() => {
    // vários 401 podem chegar juntos (P01, workspaces, lista): só o primeiro aplica o fluxo; os demais apagariam o aviso
    if (ended.current) return;
    ended.current = true;
    window.clearTimeout(watch.current);
    const hadSession = sessionMemory.hadSession();
    csrfStore.clear();
    sessionMemory.reset();
    const nav: NavState = hadSession ? { notice: 'session-expired' } : {};
    navigateRef.current(orgPath.login(org), { replace: true, state: nav });
  }, [org]);

  const arm = useCallback((delay: number, check: () => void) => {
    window.clearTimeout(watch.current);
    watch.current = window.setTimeout(check, delay);
  }, []);

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

  const signOut = useCallback(async () => {
    ended.current = true;
    window.clearTimeout(watch.current);
    setSigningOut(true);
    try {
      await logout(org);
    } catch {
      // mesmo com falha de rede o estado local é descartado; a sessão expira no servidor
    } finally {
      sessionMemory.reset();
      navigateRef.current(orgPath.login(org), { replace: true, state: { notice: 'signed-out' } satisfies NavState });
    }
  }, [org]);

  return { state, load, expired, signOut, signingOut };
}
