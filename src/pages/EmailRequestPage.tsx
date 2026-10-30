import { useRef, useState, type FormEvent } from 'react';
import { Link as RouterLink } from 'react-router';
import { Alert, Button, Input, Link, StateView } from 'nekkora-lib';
import { requestEmailVerification } from '../api/auth';
import { ApiError } from '../api/http';
import { AuthScreen } from '../app/AuthScreen';
import { useAuthFlow } from '../auth/flow';
import { commonMessage, UNAVAILABLE, type UserMessage } from '../auth/messages';
import { ErrorAlert } from './ErrorAlert';

interface Copy {
  title: string;
  description: string;
  submit: string;
  pending: string;
  sentDescription: string;
}

const COPY: Record<'password' | 'verification', Copy> = {
  password: {
    title: 'Esqueceu sua senha?',
    description: 'Informe seu e-mail e enviaremos as instruções, caso exista uma conta elegível.',
    submit: 'Enviar instruções',
    pending: 'Enviando…',
    sentDescription: 'Se existir uma conta elegível para esse endereço, enviaremos as instruções para redefinição da senha.',
  },
  verification: {
    title: 'Reenviar verificação',
    description: 'Informe seu e-mail para receber um novo link de confirmação.',
    submit: 'Enviar link',
    pending: 'Enviando…',
    sentDescription: 'Se existir uma conta elegível que ainda precise de confirmação, enviaremos uma nova mensagem.',
  },
};

/**
 * Pedido por e-mail com resposta SEMPRE genérica: a tela depois do envio é idêntica exista ou não a conta
 * (a API responde 202 em todos os casos). Só erros de transporte (rede, indisponibilidade) aparecem.
 */
function EmailRequestPage({ kind }: { kind: 'password' | 'verification' }) {
  const flow = useAuthFlow();
  const org = flow.org;
  const copy = COPY[kind];
  const [unavailable, setUnavailable] = useState(false);
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<UserMessage | null>(null);
  const inFlight = useRef(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      if (kind === 'password') await flow.requestPasswordReset(email.trim());
      else if (org) await requestEmailVerification(org, email.trim());
      setSent(true);
    } catch (e) {
      // 400 (entrada malformada) não diz nada sobre a conta: mesma resposta genérica
      const message = commonMessage(e);
      if ((e as { code?: string })?.code === 'invalid_request') setSent(true);
      else if (flow.kind === 'identity' && e instanceof ApiError && e.status === 404) setUnavailable(true);
      else setError(message);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const backToLogin = (
    <Link as={RouterLink} to={flow.paths.login} variant="subtle" leftIcon="arrow-left">
      Voltar para o login
    </Link>
  );

  if (sent) {
    return (
      <AuthScreen org={org} icon="mail" title="Confira seu e-mail" stepKey="sent" focusTitle actions={backToLogin}>
        <StateView
          status="info"
          icon="mail"
          title="Solicitação recebida"
          description={copy.sentDescription}
          actions={
            <Button
              variant="ghost"
              onClick={() => {
                setSent(false);
                setEmail('');
              }}
            >
              Usar outro e-mail
            </Button>
          }
        />
      </AuthScreen>
    );
  }

  return (
    <AuthScreen org={org} icon={kind === 'password' ? 'lock' : 'mail'} title={copy.title} description={copy.description} actions={backToLogin}>
      {unavailable && <Alert tone="warning">{UNAVAILABLE}</Alert>}
      {error && <ErrorAlert message={error} />}
      <form className="pw-form" onSubmit={submit}>
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
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          readOnly={pending}
        />
        <Button type="submit" fullWidth size="lg" loading={pending}>
          {pending ? copy.pending : copy.submit}
        </Button>
      </form>
    </AuthScreen>
  );
}

/** /recuperar-senha (identidade, sem token) e /o/{org}/forgot-password */
export function ForgotPasswordPage() {
  return <EmailRequestPage kind="password" />;
}

/** /o/{org}/resend-verification — só com features.resendVerification (divergência D2). */
export function ResendVerificationPage() {
  return <EmailRequestPage kind="verification" />;
}
