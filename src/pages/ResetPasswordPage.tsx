import { useRef, useState, type FormEvent } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router';
import { Button, Link, StateView } from 'nekkora-lib';
import { isApiError } from '../api/http';
import { AuthScreen } from '../app/AuthScreen';
import { useAuthFlow } from '../auth/flow';
import { consumeInitialLinkToken } from '../auth/linkToken';
import { commonMessage, type UserMessage } from '../auth/messages';
import { passwordProblem } from '../auth/passwordPolicy';
import { NewPasswordFields } from '../components/NewPasswordFields';
import { ErrorAlert } from './ErrorAlert';

type State = 'form' | 'success' | 'invalid';

/**
 * /recuperar-senha#token=… (identidade) e /o/{org}/recuperar-senha#token=… (conta de organização; também o caminho
 * antigo /o/{org}/reset-password) — abre direto pelo link do e-mail (sem login). O token fica só em memória (já foi
 * removido da URL na carga da página), nunca é exibido e só é enviado quando a pessoa salva a senha.
 */
export function ResetPasswordPage() {
  const flow = useAuthFlow();
  const org = flow.org;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [token] = useState(() => consumeInitialLinkToken(pathname));
  const [state, setState] = useState<State>(token ? 'form' : 'invalid');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirmation?: string }>({});
  const [error, setError] = useState<UserMessage | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current || !token) return;
    const next: typeof errors = {};
    next.password = passwordProblem(password);
    if (confirmation !== password) next.confirmation = 'As senhas não coincidem.';
    setErrors(next);
    if (next.password || next.confirmation) return; // não envia o que é evidentemente inválido
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await flow.confirmPasswordReset(token, password);
      setPassword('');
      setConfirmation('');
      setState('success');
    } catch (e) {
      // 400 = token inválido, expirado ou já usado: a política de senha já foi conferida acima com as MESMAS regras da API
      // (PasswordPolicy, PLATFORM-SENHA-001), então um 400 aqui não é recusa de política
      if (isApiError(e, 'invalid_request')) setState('invalid');
      else setError(commonMessage(e));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  if (state === 'invalid') {
    return (
      <AuthScreen org={org} icon="alert" title="Este link não é mais válido" stepKey="invalid" focusTitle>
        <StateView
          status="warning"
          title="Solicite uma nova redefinição de senha."
          description="O link pode ter expirado, já ter sido usado ou estar incompleto."
          actions={
            <Button fullWidth onClick={() => navigate(flow.paths.forgotPassword, { replace: true })}>
              Solicitar novo link
            </Button>
          }
        />
      </AuthScreen>
    );
  }

  if (state === 'success') {
    return (
      <AuthScreen org={org} icon="check-circle" title="Senha redefinida" stepKey="success" focusTitle>
        <StateView
          status="success"
          title="Entre com sua nova senha."
          description="Se a verificação em duas etapas estiver ativada, ela continuará sendo solicitada. Por segurança, as sessões abertas foram encerradas."
          actions={
            <Button fullWidth onClick={() => navigate(flow.paths.login, { replace: true })}>
              Voltar para o login
            </Button>
          }
        />
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      org={org}
      icon="lock"
      title="Crie uma nova senha"
      description="Escolha uma senha que você não use em outros serviços."
      actions={
        <Link as={RouterLink} to={flow.paths.login} variant="subtle" leftIcon="arrow-left">
          Voltar para o login
        </Link>
      }
    >
      {error && <ErrorAlert message={error} />}
      <form className="pw-form" onSubmit={submit} noValidate>
        <NewPasswordFields
          label="Nova senha"
          confirmLabel="Confirmar nova senha"
          value={password}
          onChange={setPassword}
          confirmation={confirmation}
          onConfirmationChange={setConfirmation}
          error={errors.password}
          confirmationError={errors.confirmation}
          readOnly={pending}
          autoFocus
        />
        <Button type="submit" fullWidth size="lg" loading={pending}>
          {pending ? 'Salvando…' : 'Salvar nova senha'}
        </Button>
      </form>
    </AuthScreen>
  );
}
