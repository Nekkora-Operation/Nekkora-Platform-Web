import { useRef, useState, type FormEvent } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Input, Link } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';
import { AuthScreen } from '../app/AuthScreen';
import { readNavState } from '../app/notices';
import { identityPath, useAuthFlow } from '../auth/flow';
import { commonMessage, INVALID_CREDENTIALS, SESSION_EXPIRED, SIGNED_OUT_UNCONFIRMED, UNAVAILABLE, type UserMessage } from '../auth/messages';
import { orgPath } from '../auth/organization';
import { features } from '../config';
import { ErrorAlert } from './ErrorAlert';

const NOTICES = {
  'session-expired': { tone: 'info' as const, text: SESSION_EXPIRED },
  'signed-out': { tone: 'success' as const, text: 'Você saiu da sua conta.' },
  'signed-out-unconfirmed': { tone: 'warning' as const, text: SIGNED_OUT_UNCONFIRMED },
  'challenge-expired': { tone: 'info' as const, text: 'A verificação expirou. Entre novamente para continuar.' },
  'session-changed': { tone: 'info' as const, text: 'Sua sessão foi encerrada ou alterada em outra aba. Entre novamente para continuar.' },
};

/**
 * /entrar (identidade Nekkora) e /o/{org}/login (conta de organização) — e-mail + senha. O resultado só define o próximo
 * passo; quem autentica é a API.
 */
export function LoginPage() {
  const flow = useAuthFlow();
  const org = flow.org;
  const navigate = useNavigate();
  const { notice } = readNavState(useLocation().state);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UserMessage | 'credentials' | 'unavailable' | null>(null);
  const inFlight = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return; // sem envio duplicado
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const next = await flow.login(email.trim(), password);
      navigate(next === 'mfa' ? flow.paths.mfa : flow.paths.mfaSetup);
    } catch (e) {
      // 401 (ou 400 de entrada inválida) = mensagem genérica: não revela se o e-mail existe nem o estado da conta
      if (isApiError(e, 'unauthenticated', 'invalid_request')) {
        setError('credentials');
        passwordRef.current?.focus();
      } else if (flow.kind === 'identity' && e instanceof ApiError && e.status === 404) {
        setError('unavailable'); // chave da entrada geral desligada: não é erro de credencial
      } else {
        setError(commonMessage(e));
      }
      inFlight.current = false;
      setPending(false);
    }
  };

  const noticeInfo = notice ? NOTICES[notice] : undefined;

  return (
    <AuthScreen
      org={org}
      title={flow.kind === 'identity' ? 'Entrar na Nekkora' : 'Bem-vinda de volta'}
      description={flow.kind === 'identity' ? 'Use o e-mail e a senha da sua identidade Nekkora.' : 'Acesse sua conta para continuar.'}
      actions={
        flow.kind === 'identity' ? (
          <>
            <span className="pw-muted">Ainda não tem cadastro?</span>
            <Link as={RouterLink} to={identityPath.signup}>
              Criar cadastro
            </Link>
          </>
        ) : (
          <>
            <Link as={RouterLink} to={identityPath.login} variant="subtle">
              Entrar com a identidade Nekkora
            </Link>
            {features.resendVerification && org && (
              <Link as={RouterLink} to={orgPath.resendVerification(org)} variant="subtle">
                Reenviar verificação de e-mail
              </Link>
            )}
          </>
        )
      }
    >
      {noticeInfo && !error && <Alert tone={noticeInfo.tone}>{noticeInfo.text}</Alert>}
      {error === 'credentials' && <Alert tone="danger">{INVALID_CREDENTIALS}</Alert>}
      {error === 'unavailable' && <Alert tone="warning">{UNAVAILABLE}</Alert>}
      {error && error !== 'credentials' && error !== 'unavailable' && <ErrorAlert message={error} />}
      <form className="pw-form" onSubmit={submit} noValidate={false} aria-busy={pending}>
        <Input
          label="E-mail"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          placeholder="voce@empresa.com"
          required
          fullWidth
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          readOnly={pending}
        />
        <Input
          ref={passwordRef}
          label="Senha"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          fullWidth
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          readOnly={pending}
        />
        <div className="pw-form__row">
          <Link as={RouterLink} to={flow.paths.forgotPassword} size="sm">
            Esqueci minha senha
          </Link>
        </div>
        <Button type="submit" fullWidth size="lg" loading={pending}>
          {pending ? 'Entrando…' : 'Entrar'}
        </Button>
      </form>
    </AuthScreen>
  );
}
