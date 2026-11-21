import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Input, Link, StateView } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';
import { confirmSignup, resendSignupConfirmation, signup, signupPreview } from '../api/identity';
import { AuthScreen } from '../app/AuthScreen';
import { identityPath } from '../auth/flow';
import { onboarding } from '../auth/onboarding';
import { consumeInitialLinkToken } from '../auth/linkToken';
import { commonMessage, type UserMessage } from '../auth/messages';
import { passwordProblem } from '../auth/passwordPolicy';
import { NewPasswordFields } from '../components/NewPasswordFields';
import { ErrorAlert } from '../pages/ErrorAlert';
import { pendingInvitation } from './AcceptInvitationPage';

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
  // 071: vindo do convite, o e-mail já é o do convite (não é pedido de novo; a confirmação continua pelo link do e-mail)
  const inviteEmail = (useLocation().state as { inviteEmail?: string } | null)?.inviteEmail ?? null;
  const [email, setEmail] = useState(inviteEmail ?? '');
  // o convite aberto nesta aba: o servidor confere que é para o mesmo e-mail e guarda o nome dele como sugestão
  const request = useEmailRequest((e) => {
    const p = inviteEmail ? pendingInvitation.peek() : null;
    return signup(e, p ? { organizationId: p.org, token: p.token } : undefined);
  });
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
      title={inviteEmail ? 'Criar seu acesso' : 'Criar cadastro na Nekkora'}
      description={
        inviteEmail
          ? `Vamos enviar um link para ${inviteEmail} para confirmar que o e-mail é seu. Depois você só escolhe a senha.`
          : 'Informe seu e-mail. Enviaremos um link para você concluir o cadastro.'
      }
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
          autoFocus={!inviteEmail}
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          readOnly={request.pending || !!inviteEmail}
          hint={inviteEmail ? 'E-mail do convite.' : undefined}
        />
        <Button type="submit" fullWidth size="lg" loading={request.pending} disabled={request.disabled} autoFocus={!!inviteEmail}>
          {request.pending ? 'Enviando…' : inviteEmail ? 'Enviar o link de confirmação' : 'Continuar'}
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
  // 071: o nome informado no convite já vem preenchido (o servidor o guardou no pedido de cadastro); a pessoa pode ajustar
  const [prefill, setPrefill] = useState<{ name: string } | null>(null);
  const [displayName, setDisplayName] = useState('');
  useEffect(() => {
    if (!token) return;
    let alive = true;
    signupPreview(token).then(
      (p) => {
        if (!alive || !p.displayName) return;
        setPrefill({ name: p.displayName });
        setDisplayName((d) => d || p.displayName!);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [token]);
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
      password: passwordProblem(password),
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
      onboarding.markSignupCompleted();
      setState('success');
    } catch (e) {
      // 400 = link inválido para a API (vencido, já usado, revogado, substituído por reenvio). Os campos já foram conferidos
      // com as MESMAS regras da API (PasswordPolicy, PLATFORM-SENHA-001: 12 a 20 pontos de código com maiúscula, minúscula,
      // número e símbolo; nome sem controle, até 120), então um 400 aqui não é recusa de política. Se as regras mudarem,
      // as duas pontas mudam juntas (passwordPolicy.ts espelha a API).
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
          description={
            prefill
              ? 'Ao entrar, vamos sugerir ativar a verificação em duas etapas (opcional, recomendada). Depois, abra de novo o link do convite para aceitar.'
              : 'Ao entrar, vamos sugerir ativar a verificação em duas etapas (opcional, recomendada). O cadastro não cria organização: depois de entrar, você pode criar uma ou aceitar um convite.'
          }
          actions={
            <Button fullWidth onClick={() => navigate(identityPath.login, { replace: true })}>
              Entrar
            </Button>
          }
        />
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      icon="user"
      title="Conclua seu cadastro"
      description={prefill?.name ? 'Seu nome veio do convite. Só falta escolher a senha.' : 'Escolha como você quer ser chamada ou chamado e a sua senha.'}
      actions={backToLogin}
    >
      {error && <ErrorAlert message={error} />}
      <form className="pw-form" onSubmit={submit} noValidate>
        <Input
          label="Nome"
          name="name"
          autoComplete="name"
          required
          fullWidth
          autoFocus={!prefill?.name}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={errors.displayName}
          readOnly={pending}
        />
        <NewPasswordFields
          label="Senha"
          confirmLabel="Confirmar senha"
          value={password}
          onChange={setPassword}
          confirmation={confirmation}
          onConfirmationChange={setConfirmation}
          error={errors.password}
          confirmationError={errors.confirmation}
          readOnly={pending}
          autoFocus={!!prefill?.name}
          userInputs={[displayName]}
        />
        <Button type="submit" fullWidth size="lg" loading={pending}>
          {pending ? 'Concluindo…' : 'Concluir cadastro'}
        </Button>
      </form>
    </AuthScreen>
  );
}
