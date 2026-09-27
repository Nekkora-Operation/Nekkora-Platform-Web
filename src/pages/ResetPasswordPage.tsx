import { useRef, useState, type FormEvent } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router';
import { Button, Input, Link, StateView } from 'nekkora-lib';
import { confirmPasswordReset } from '../api/auth';
import { isApiError } from '../api/http';
import { AuthScreen } from '../app/AuthScreen';
import { useOrganization } from '../app/organization';
import { consumeInitialLinkToken } from '../auth/linkToken';
import { commonMessage, type UserMessage } from '../auth/messages';
import { orgPath } from '../auth/organization';
import { meetsPasswordPolicy, PASSWORD_MAX, PASSWORD_MIN, passwordLength } from '../auth/passwordPolicy';
import { ErrorAlert } from './ErrorAlert';

type State = 'form' | 'success' | 'invalid';

/**
 * /o/{org}/reset-password#token=… — abre direto pelo link do e-mail (sem login). O token fica só em memória
 * (já foi removido da URL na carga da página) e nunca é exibido.
 */
export function ResetPasswordPage() {
  const org = useOrganization();
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
    if (!meetsPasswordPolicy(password)) next.password = `A senha precisa ter entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres.`;
    if (confirmation !== password) next.confirmation = 'As senhas não coincidem.';
    setErrors(next);
    if (next.password || next.confirmation) return; // não envia o que é evidentemente inválido
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await confirmPasswordReset(org, token, password);
      setPassword('');
      setConfirmation('');
      setState('success');
    } catch (e) {
      // 400 = token inválido, expirado ou já usado (a política de senha já foi conferida acima)
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
            <Button fullWidth onClick={() => navigate(orgPath.forgotPassword(org), { replace: true })}>
              Solicitar novo link
            </Button>
          }
        />
      </AuthScreen>
    );
  }

  if (state === 'success') {
    return (
      <AuthScreen org={org} icon="check-circle" title="Senha alterada" stepKey="success" focusTitle>
        <StateView
          status="success"
          title="Agora você pode entrar usando sua nova senha."
          description="Por segurança, as sessões abertas foram encerradas. O código do autenticador continua sendo pedido."
          actions={
            <Button fullWidth onClick={() => navigate(orgPath.login(org), { replace: true })}>
              Voltar para o login
            </Button>
          }
        />
      </AuthScreen>
    );
  }

  const length = passwordLength(password);
  const lengthOk = length >= PASSWORD_MIN && length <= PASSWORD_MAX;

  return (
    <AuthScreen
      org={org}
      icon="lock"
      title="Crie uma nova senha"
      description="Escolha uma senha longa, que você não use em outros serviços."
      actions={
        <Link as={RouterLink} to={orgPath.login(org)} variant="subtle" leftIcon="arrow-left">
          Voltar para o login
        </Link>
      }
    >
      {error && <ErrorAlert message={error} />}
      <form className="pw-form" onSubmit={submit}>
        <Input
          label="Nova senha"
          type="password"
          name="new-password"
          autoComplete="new-password"
          required
          fullWidth
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint={`Entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres. Frases longas são mais seguras e fáceis de lembrar.`}
          success={!errors.password && lengthOk ? `Entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres — atendido.` : undefined}
          readOnly={pending}
        />
        <Input
          label="Confirmar nova senha"
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          required
          fullWidth
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          error={errors.confirmation}
          readOnly={pending}
        />
        <Button type="submit" fullWidth size="lg" loading={pending}>
          {pending ? 'Salvando…' : 'Salvar nova senha'}
        </Button>
      </form>
    </AuthScreen>
  );
}
