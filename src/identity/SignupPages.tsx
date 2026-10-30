import { useRef, useState, type FormEvent } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Input, Link, StateView } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';
import { confirmSignup, resendSignupConfirmation, signup } from '../api/identity';
import { AuthScreen } from '../app/AuthScreen';
import { identityPath } from '../auth/flow';
import { consumeInitialLinkToken } from '../auth/linkToken';
import { commonMessage, type UserMessage } from '../auth/messages';
import { meetsPasswordPolicy, PASSWORD_MAX, PASSWORD_MIN, passwordLength } from '../auth/passwordPolicy';
import { ErrorAlert } from '../pages/ErrorAlert';

const SIGNUP_UNAVAILABLE = 'O cadastro não está disponível no momento. Nenhuma conta foi criada.';

const backToLogin = (
  <Link as={RouterLink} to={identityPath.login} variant="subtle" leftIcon="arrow-left">
    Voltar para a entrada
  </Link>
);

/** Rota desligada pela chave da API: 404 em qualquer pedido de cadastro. */
const isDisabled = (e: unknown) => e instanceof ApiError && e.status === 404;

/**
 * Pedido por e-mail com resposta SEMPRE uniforme (202 para e-mail novo, pendente ou já cadastrado). A tela depois do
 * envio é a mesma em todos os casos. `kind` decide só o texto e a rota (pedido ou reenvio).
 */
function useEmailRequest(send: (email: string) => Promise<void>) {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<UserMessage | null>(null);
  const inFlight = useRef(false);

  const submit = async (email: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await send(email.trim());
      setSent(true);
    } catch (e) {
      if (isDisabled(e)) setDisabled(true);
      else if (isApiError(e, 'invalid_request')) setError({ title: 'Confira o e-mail informado.', retryable: true });
      else setError(commonMessage(e));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { pending, sent, setSent, disabled, error, submit };
}

/** /cadastro — pede o cadastro com SÓ o e-mail; senha e nome vêm na confirmação pelo link. */
export function SignupPage() {
  const [email, setEmail] = useState('');
  const request = useEmailRequest(signup);
  const resend = useEmailRequest(resendSignupConfirmation);

  if (request.sent) {
    return (
      <AuthScreen icon="mail" title="Confira seu e-mail" stepKey="sent" focusTitle actions={backToLogin}>
        <StateView
          status="info"
          icon="mail"
          title="Pedido recebido"
          description="Se o endereço puder ser cadastrado, você vai receber uma mensagem com um link para escolher a senha e o nome. Se já houver cadastro com ele, a mensagem explica como entrar. O link vale por 24 horas."
        />
        {resend.sent && <Alert tone="success">Pedido de reenvio recebido. Use sempre o link da mensagem mais recente.</Alert>}
        {resend.error && <ErrorAlert message={resend.error} />}
        <div className="pw-form__row">
          <Button variant="secondary" loading={resend.pending} onClick={() => void resend.submit(email)}>
            Reenviar mensagem
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              request.setSent(false);
              resend.setSent(false);
              setEmail('');
            }}
          >
            Usar outro e-mail
          </Button>
        </div>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      icon="user"
      title="Criar cadastro na Nekkora"
      description="Informe seu e-mail. Enviaremos um link para você concluir o cadastro."
      actions={
        <>
          <span className="pw-muted">Já tem cadastro?</span>
          <Link as={RouterLink} to={identityPath.login}>
            Entrar
          </Link>
        </>
      }
    >
      {request.disabled && <Alert tone="warning">{SIGNUP_UNAVAILABLE}</Alert>}
      {request.error && <ErrorAlert message={request.error} />}
      <form
        className="pw-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void request.submit(email);
        }}
      >
        <Input
          label="E-mail"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder="voce@empresa.com"
          required
          fullWidth
          autoFocus
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          readOnly={request.pending}
        />
        <Button type="submit" fullWidth size="lg" loading={request.pending} disabled={request.disabled}>
          {request.pending ? 'Enviando…' : 'Continuar'}
        </Button>
      </form>
    </AuthScreen>
  );
}

/** Nome da confirmação: até 120 pontos de código, não em branco, sem caractere de controle (contrato). */
function displayNameProblem(value: string): string | undefined {
  if (!value.trim()) return 'Informe seu nome.';
  if ([...value].length > 120) return 'Use no máximo 120 caracteres.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return 'Use só caracteres visíveis.';
  return undefined;
}

type ConfirmState = 'form' | 'success' | 'invalid' | 'disabled';

/**
 * /cadastro/confirmar#token=… — conclui o cadastro (senha e nome). O token sai da URL na carga da página, fica só em
 * memória e só é enviado quando a pessoa confirma: abrir o link ou o prefetch não consome nada. A confirmação NÃO cria
 * sessão nem organização: depois dela, a pessoa entra pela entrada geral e cadastra o autenticador.
 */
export function SignupConfirmPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [token] = useState(() => consumeInitialLinkToken(pathname));
  const [state, setState] = useState<ConfirmState>(token ? 'form' : 'invalid');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<{ displayName?: string; password?: string; confirmation?: string }>({});
  const [error, setError] = useState<UserMessage | null>(null);
  const [pending, setPending] = useState(false);
  const [resendEmail, setResendEmail] = useState('');
  const resend = useEmailRequest(resendSignupConfirmation);
  const inFlight = useRef(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current || !token) return;
    const next = {
      displayName: displayNameProblem(displayName),
      password: meetsPasswordPolicy(password) ? undefined : `A senha precisa ter entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres.`,
      confirmation: confirmation === password ? undefined : 'As senhas não coincidem.',
    };
    setErrors(next);
    if (next.displayName || next.password || next.confirmation) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await confirmSignup(token, password, displayName.trim());
      setPassword('');
      setConfirmation('');
      setState('success');
    } catch (e) {
      // 400 = link inválido para a API (vencido, já usado, revogado, substituído por reenvio). Os campos já foram conferidos.
      if (isApiError(e, 'invalid_request')) setState('invalid');
      else if (isDisabled(e)) setState('disabled');
      else setError(commonMessage(e));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  if (state === 'disabled') {
    return (
      <AuthScreen icon="alert" title="Cadastro indisponível" stepKey="disabled" focusTitle actions={backToLogin}>
        <Alert tone="warning">{SIGNUP_UNAVAILABLE}</Alert>
      </AuthScreen>
    );
  }

  if (state === 'invalid') {
    return (
      <AuthScreen icon="alert" title="Este link não é mais válido" stepKey="invalid" focusTitle actions={backToLogin}>
        <StateView
          status="warning"
          title="Não foi possível concluir o cadastro com este link."
          description="O link pode ter vencido (vale 24 horas), já ter sido usado, estar incompleto ou ter sido substituído por um reenvio. Peça uma nova mensagem e use o link mais recente."
        />
        {resend.sent ? (
          <Alert tone="success">Pedido recebido. Se houver um cadastro pendente para este e-mail, uma nova mensagem será enviada.</Alert>
        ) : (
          <form
            className="pw-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void resend.submit(resendEmail);
            }}
          >
            {resend.disabled && <Alert tone="warning">{SIGNUP_UNAVAILABLE}</Alert>}
            {resend.error && <ErrorAlert message={resend.error} />}
            <Input
              label="E-mail do cadastro"
              type="email"
              name="email"
              autoComplete="email"
              required
              fullWidth
              value={resendEmail}
              onChange={(e) => setResendEmail(e.target.value)}
              readOnly={resend.pending}
            />
            <Button type="submit" fullWidth loading={resend.pending}>
              Enviar nova mensagem
            </Button>
          </form>
        )}
      </AuthScreen>
    );
  }

  if (state === 'success') {
    return (
      <AuthScreen icon="check-circle" title="Cadastro concluído" stepKey="success" focusTitle>
        <StateView
          status="success"
          title="Agora entre com seu e-mail e a senha escolhida."
          description="No primeiro acesso você vai configurar o aplicativo autenticador. O cadastro não cria organização: depois de entrar, você pode criar uma ou aceitar um convite."
          actions={
            <Button fullWidth onClick={() => navigate(identityPath.login, { replace: true })}>
              Entrar
            </Button>
          }
        />
      </AuthScreen>
    );
  }

  const length = passwordLength(password);
  const lengthOk = length >= PASSWORD_MIN && length <= PASSWORD_MAX;

  return (
    <AuthScreen icon="user" title="Conclua seu cadastro" description="Escolha como você quer ser chamada ou chamado e a sua senha." actions={backToLogin}>
      {error && <ErrorAlert message={error} />}
      <form className="pw-form" onSubmit={submit} noValidate>
        <Input
          label="Nome"
          name="name"
          autoComplete="name"
          required
          fullWidth
          autoFocus
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={errors.displayName}
          readOnly={pending}
        />
        <Input
          label="Senha"
          type="password"
          name="new-password"
          autoComplete="new-password"
          required
          fullWidth
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint={`Entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres. Frases longas são mais seguras e fáceis de lembrar.`}
          success={!errors.password && lengthOk ? `Entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres — atendido.` : undefined}
          readOnly={pending}
        />
        <Input
          label="Confirmar senha"
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
          {pending ? 'Concluindo…' : 'Concluir cadastro'}
        </Button>
      </form>
    </AuthScreen>
  );
}
