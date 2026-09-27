import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, CodeInput, Input, Link, StateView } from 'nekkora-lib';
import { verifyMfa } from '../api/auth';
import { csrfStore } from '../api/csrf';
import { isApiError } from '../api/http';
import { AuthScreen } from '../app/AuthScreen';
import { sessionMemory, type NavState } from '../app/notices';
import { useOrganization } from '../app/organization';
import { commonMessage, INVALID_CODE, type UserMessage } from '../auth/messages';
import { orgPath } from '../auth/organization';
import { ErrorAlert } from './ErrorAlert';

/** Tentativas erradas após as quais a API invalida o desafio (contrato §3.3). Aqui só orienta a pessoa. */
const MAX_ATTEMPTS = 5;
const TOTP_DIGITS = 6;
const RECOVERY_FORMAT = /^[A-Z2-7]{16}$/;

type Mode = 'totp' | 'recovery';

/** Desafio perdido (recarregou, expirou, excedeu tentativas): só um novo login continua. */
export function ChallengeExpired({ org }: { org: string }) {
  const navigate = useNavigate();
  return (
    <AuthScreen org={org} icon="shield" title="Verificação encerrada" focusTitle>
      <StateView
        status="info"
        title="Sua verificação expirou ou não pode mais continuar."
        description="Por segurança, entre novamente com seu e-mail e senha."
        actions={
          <Button
            fullWidth
            onClick={() => {
              csrfStore.setChallenge(org, undefined);
              navigate(orgPath.login(org), { replace: true });
            }}
          >
            Voltar para o login
          </Button>
        }
      />
    </AuthScreen>
  );
}

/** /o/{org}/mfa — segundo fator de uma conta com autenticador já configurado. */
export function MfaPage() {
  const org = useOrganization();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('totp');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<UserMessage | null>(null);
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState(0);
  const inFlight = useRef(false);

  if (!csrfStore.challenge(org) || failures >= MAX_ATTEMPTS) return <ChallengeExpired org={org} />;

  const submit = async (value?: string) => {
    if (inFlight.current) return;
    const totp = value ?? code;
    const normalizedRecovery = recovery.replace(/[-\s]/g, '').toUpperCase();
    if (mode === 'totp' && !new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(totp)) {
      setFieldError(`Digite os ${TOTP_DIGITS} dígitos exibidos no aplicativo.`);
      return;
    }
    if (mode === 'recovery' && !RECOVERY_FORMAT.test(normalizedRecovery)) {
      setFieldError('O código de recuperação tem 16 caracteres (ex.: ABCD-EFGH-IJKL-MNOP).');
      return;
    }
    inFlight.current = true;
    setPending(true);
    setFieldError(undefined);
    setError(null);
    try {
      await verifyMfa(org, mode === 'totp' ? { code: totp } : { recoveryCode: recovery.toUpperCase() });
      sessionMemory.markActive();
      const state: NavState = { recoveryCodeUsed: mode === 'recovery' };
      navigate(orgPath.home(org), { replace: true, state });
    } catch (e) {
      if (isApiError(e, 'unauthenticated', 'invalid_request')) {
        setFailures((n) => n + 1);
        setFieldError(INVALID_CODE);
        setCode('');
      } else {
        setError(commonMessage(e));
      }
      inFlight.current = false;
      setPending(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setFieldError(undefined);
    setError(null);
  };

  const remaining = MAX_ATTEMPTS - failures;

  if (mode === 'recovery') {
    return (
      <AuthScreen
        org={org}
        icon="key"
        title="Usar código de recuperação"
        description="Digite um dos códigos que você guardou ao configurar o autenticador. Cada código só pode ser usado uma vez."
        stepKey="recovery"
        focusTitle
        actions={
          <Link as="button" type="button" onClick={() => switchMode('totp')} variant="subtle">
            Voltar para código do autenticador
          </Link>
        }
      >
        {error && <ErrorAlert message={error} />}
        <form className="pw-form" onSubmit={onSubmit}>
          <Input
            label="Código de recuperação"
            mask="****-****-****-****"
            placeholder="XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            fullWidth
            value={recovery}
            onValueChange={(v) => setRecovery(v.toUpperCase())}
            error={fieldError}
            readOnly={pending}
          />
          {failures > 0 && remaining <= 2 && (
            <Alert tone="warning">Restam poucas tentativas. Depois disso será preciso entrar novamente.</Alert>
          )}
          <Button type="submit" fullWidth size="lg" loading={pending}>
            {pending ? 'Verificando…' : 'Usar código de recuperação'}
          </Button>
        </form>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      org={org}
      icon="shield"
      title="Confirme sua identidade"
      description="Digite o código exibido no seu aplicativo autenticador."
      stepKey="totp"
      actions={
        <>
          <span className="pw-muted">Não consegue acessar o autenticador?</span>
          <Link as="button" type="button" onClick={() => switchMode('recovery')}>
            Usar código de recuperação
          </Link>
        </>
      }
    >
      {error && <ErrorAlert message={error} />}
      <form className="pw-form" onSubmit={onSubmit}>
        <CodeInput
          label="Código de autenticação"
          length={TOTP_DIGITS}
          autoFocus
          value={code}
          onValueChange={(v) => {
            setCode(v);
            if (fieldError && v.length < TOTP_DIGITS) setFieldError(undefined);
          }}
          onComplete={(v) => void submit(v)}
          error={fieldError}
          hint="O código muda a cada 30 segundos."
          readOnly={pending}
        />
        {failures > 0 && remaining <= 2 && (
          <Alert tone="warning">Restam poucas tentativas. Depois disso será preciso entrar novamente.</Alert>
        )}
        <Button type="submit" fullWidth size="lg" loading={pending}>
          {pending ? 'Verificando…' : 'Confirmar'}
        </Button>
      </form>
    </AuthScreen>
  );
}
