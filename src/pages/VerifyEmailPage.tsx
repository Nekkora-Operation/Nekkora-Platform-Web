import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button, StateView } from 'nekkora-lib';
import { confirmEmail } from '../api/auth';
import { isApiError } from '../api/http';
import { AuthScreen } from '../app/AuthScreen';
import { useOrganization } from '../app/organization';
import { consumeInitialLinkToken } from '../auth/linkToken';
import { commonMessage, type UserMessage } from '../auth/messages';
import { orgPath } from '../auth/organization';
import { features } from '../config';

type State = { kind: 'validating' } | { kind: 'confirmed' } | { kind: 'invalid' } | { kind: 'error'; message: UserMessage };

/**
 * /o/{org}/verify-email#token=… — abre direto pelo link. O resultado vem SEMPRE da API: a URL não diz nada.
 * A API v1 não distingue inválido/expirado/já usado (todos 400) — divergência D3.
 */
export function VerifyEmailPage() {
  const org = useOrganization();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [token] = useState(() => consumeInitialLinkToken(pathname));
  const [state, setState] = useState<State>(token ? { kind: 'validating' } : { kind: 'invalid' });
  const started = useRef(false);

  const validate = useCallback(async () => {
    if (!token) return;
    setState({ kind: 'validating' });
    try {
      await confirmEmail(org, token);
      setState({ kind: 'confirmed' });
    } catch (e) {
      if (isApiError(e, 'invalid_request')) setState({ kind: 'invalid' });
      else setState({ kind: 'error', message: commonMessage(e) });
    }
  }, [org, token]);

  useEffect(() => {
    // uma única confirmação por carga (o token é de uso único; efeitos duplicados não podem consumi-lo duas vezes)
    if (started.current) return;
    started.current = true;
    void validate();
  }, [validate]);

  const toLogin = (
    <Button fullWidth onClick={() => navigate(orgPath.login(org), { replace: true })}>
      Ir para o login
    </Button>
  );

  return (
    <AuthScreen org={org} icon="mail" title="Confirmação de e-mail" stepKey={state.kind} focusTitle={state.kind !== 'validating'}>
      {state.kind === 'validating' && <StateView status="loading" title="Validando link…" description="Isso leva só um instante." />}
      {state.kind === 'confirmed' && (
        <StateView status="success" title="E-mail confirmado" description="Tudo certo. Você já pode entrar na sua conta." actions={toLogin} />
      )}
      {state.kind === 'invalid' && (
        <StateView
          status="warning"
          title="Este link não é mais válido"
          description="O link pode ter expirado, já ter sido usado ou estar incompleto."
          actions={
            features.resendVerification ? (
              <Button fullWidth onClick={() => navigate(orgPath.resendVerification(org))}>
                Solicitar novo link
              </Button>
            ) : (
              toLogin
            )
          }
        />
      )}
      {state.kind === 'error' && (
        <StateView
          status="error"
          title={state.message.title}
          description={state.message.description}
          meta={state.message.requestId ? `Código de referência: ${state.message.requestId}` : undefined}
          actions={
            <Button fullWidth onClick={() => void validate()}>
              Tentar novamente
            </Button>
          }
        />
      )}
    </AuthScreen>
  );
}
