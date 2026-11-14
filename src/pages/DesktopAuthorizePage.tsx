import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Link, Text } from 'nekkora-lib';
import {
  approveDesktopAuthorization,
  denyDesktopAuthorization,
  parseDesktopRequest,
  pendingDesktopAuthorization,
  startDesktopAuthorization,
  type DesktopPending,
} from '../api/desktop';
import { ApiError, isApiError } from '../api/http';
import { identityLogout } from '../api/identity';
import { AuthScreen } from '../app/AuthScreen';
import { identityPath } from '../auth/flow';
import { commonMessage, type UserMessage } from '../auth/messages';
import { clearDesktopPending, leave, markDesktopPending } from '../desktop/pending';
import { ErrorAlert } from './ErrorAlert';

type View =
  | { kind: 'loading' }
  | { kind: 'confirm'; pending: DesktopPending }
  /** Sem pedido vivo: expirou, já foi usado ou a página foi aberta sem o aplicativo. */
  | { kind: 'no-request' }
  /** O endereço com que a página foi aberta não é um pedido válido do aplicativo. */
  | { kind: 'invalid' }
  /** Sessão nascida de código de recuperação: primeiro a troca do autenticador. */
  | { kind: 'restricted' }
  | { kind: 'unavailable' }
  | { kind: 'leaving'; denied: boolean }
  | { kind: 'error'; message: UserMessage };

/** Um pedido por endereço: o modo estrito do React repete o efeito, e o pedido não pode ser entregue duas vezes. */
const started = new Map<string, Promise<void>>();

/**
 * /entrar/aplicativo — entrada no aplicativo desktop Nekkora Agent. Três momentos, na mesma página:
 *
 * 1. o aplicativo abre o navegador com o pedido na consulta: a página o entrega à API e LIMPA a consulta do endereço;
 * 2. sem sessão, a pessoa passa pelas telas normais de login e segundo fator e volta para cá;
 * 3. com sessão, a página mostra SEMPRE a conta e espera o clique — nunca autoriza sozinha, mesmo com sessão já aberta.
 *
 * Autorizar ou cancelar leva ao retorno local do aplicativo. Quem decide tudo é a API; esta página não vê código nem token.
 */
export function DesktopAuthorizePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [busy, setBusy] = useState<'approve' | 'deny' | 'switch' | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    const show = (v: View) => {
      if (active) setView(v);
    };

    const load = async () => {
      try {
        show({ kind: 'confirm', pending: await pendingDesktopAuthorization() });
      } catch (e) {
        if (isApiError(e, 'unauthenticated')) {
          // sem sessão: login e segundo fator normais; a marca traz a pessoa de volta para cá
          if (active) navigate(identityPath.login, { replace: true });
        } else if (e instanceof ApiError && e.status === 404) {
          clearDesktopPending();
          show({ kind: 'no-request' });
        } else if (isApiError(e, 'forbidden')) {
          show({ kind: 'restricted' });
        } else {
          show({ kind: 'error', message: commonMessage(e) });
        }
      }
    };

    if (location.search) {
      const request = parseDesktopRequest(location.search);
      const key = location.search;
      // a consulta sai do endereço (e do histórico) antes de qualquer outra coisa
      navigate(identityPath.desktop, { replace: true });
      if (!request) {
        show({ kind: 'invalid' });
        return () => {
          active = false;
        };
      }
      let sending = started.get(key);
      if (!sending) {
        sending = startDesktopAuthorization(request);
        started.set(key, sending);
        void sending.then(
          () => setTimeout(() => started.delete(key), 0),
          () => started.delete(key),
        );
      }
      sending.then(
        () => {
          markDesktopPending();
          return load();
        },
        (e: unknown) => {
          clearDesktopPending();
          if (isApiError(e, 'invalid_request')) show({ kind: 'invalid' });
          else if (e instanceof ApiError && e.status === 404) show({ kind: 'unavailable' });
          else show({ kind: 'error', message: commonMessage(e) });
        },
      );
    } else {
      void load();
    }
    return () => {
      active = false;
    };
    // só na chegada: a própria página limpa a consulta, e isso não pode repetir o pedido
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (kind: 'approve' | 'deny') => {
    if (inFlight.current) return; // um clique, uma decisão
    inFlight.current = true;
    setBusy(kind);
    try {
      const to = kind === 'approve' ? await approveDesktopAuthorization() : await denyDesktopAuthorization();
      clearDesktopPending();
      setView({ kind: 'leaving', denied: kind === 'deny' });
      leave.to(to);
    } catch (e) {
      inFlight.current = false;
      setBusy(null);
      if (isApiError(e, 'unauthenticated')) {
        navigate(identityPath.login, { replace: true, state: { notice: 'session-expired' } });
      } else if (e instanceof ApiError && e.status === 404) {
        clearDesktopPending();
        setView({ kind: 'no-request' });
      } else {
        setView({ kind: 'error', message: commonMessage(e) });
      }
    }
  };

  const switchAccount = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy('switch');
    try {
      // sai desta conta; o pedido continua no servidor e a marca traz o novo login de volta para cá
      await identityLogout();
      markDesktopPending();
      navigate(identityPath.login, { replace: true });
    } catch (e) {
      inFlight.current = false;
      setBusy(null);
      setView({ kind: 'error', message: commonMessage(e) });
    }
  };

  if (view.kind === 'confirm') {
    return (
      <AuthScreen
        title={`Entrar no ${view.pending.application}`}
        description="O aplicativo neste computador pediu para entrar com a sua conta Nekkora."
        stepKey="desktop-confirm"
      >
        <div className="pw-stack">
          <Text as="p" color="secondary">
            Você vai entrar com a conta
          </Text>
          <Text as="p" variant="h4" data-testid="desktop-account">
            {view.pending.email}
          </Text>
          {view.pending.navigation && (
            <Text as="p" color="secondary" data-testid="desktop-scope">
              O aplicativo poderá ver o seu nome, as organizações de que você participa e os ambientes e automações a que você tem
              acesso, e renomear automações onde você já tem essa permissão. Ele não recebe nenhuma permissão nova.
            </Text>
          )}
          {view.pending.packages && (
            <Text as="p" color="secondary" data-testid="desktop-scope-packages">
              Também poderá baixar para este computador o pacote das versões publicadas das automações que você já pode executar
              ou gerenciar. Baixar não executa nada.
            </Text>
          )}
          <Text as="p" variant="caption" color="muted">
            {view.pending.navigation
              ? 'Confirme só se foi você quem clicou em Entrar no aplicativo. A organização é escolhida depois, no próprio aplicativo.'
              : 'Confirme só se foi você quem clicou em Entrar no aplicativo. Nenhuma organização é escolhida agora.'}
          </Text>
        </div>
        <div className="pw-form">
          <Button fullWidth size="lg" loading={busy === 'approve'} disabled={busy !== null} onClick={() => void act('approve')}>
            Autorizar entrada
          </Button>
          <Button variant="secondary" fullWidth loading={busy === 'switch'} disabled={busy !== null} onClick={() => void switchAccount()}>
            Usar outra conta
          </Button>
          <Button variant="ghost" fullWidth loading={busy === 'deny'} disabled={busy !== null} onClick={() => void act('deny')}>
            Cancelar
          </Button>
        </div>
      </AuthScreen>
    );
  }

  if (view.kind === 'leaving') {
    return (
      <AuthScreen title={view.denied ? 'Entrada cancelada' : 'Voltando ao aplicativo'} stepKey="desktop-leaving">
        <Alert tone="info">{view.denied ? 'Avisando o aplicativo…' : 'Concluindo a entrada no aplicativo…'}</Alert>
      </AuthScreen>
    );
  }

  if (view.kind === 'loading') {
    return (
      <AuthScreen title="Entrar no aplicativo" stepKey="desktop-loading">
        <Alert tone="info">Conferindo o pedido do aplicativo…</Alert>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen title="Entrar no aplicativo" stepKey={`desktop-${view.kind}`}>
      {view.kind === 'no-request' && (
        <Alert tone="info">Este pedido de entrada não vale mais. Volte ao Nekkora Agent e clique em Entrar para começar de novo.</Alert>
      )}
      {view.kind === 'invalid' && (
        <Alert tone="warning">Não foi possível reconhecer este pedido de entrada. Volte ao Nekkora Agent e clique em Entrar de novo.</Alert>
      )}
      {view.kind === 'unavailable' && <Alert tone="warning">A entrada pelo aplicativo não está disponível no momento.</Alert>}
      {view.kind === 'restricted' && (
        <Alert tone="warning">
          Esta sessão começou com um código de recuperação. Troque o autenticador antes de entrar no aplicativo.{' '}
          <Link as={RouterLink} to={identityPath.replaceFactor}>
            Trocar o autenticador
          </Link>
        </Alert>
      )}
      {view.kind === 'error' && <ErrorAlert message={view.message} />}
    </AuthScreen>
  );
}
