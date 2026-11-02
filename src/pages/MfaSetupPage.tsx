import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Checkbox, CodeInput, Link, QrCode, StateView, Text } from 'nekkora-lib';
import { isApiError } from '../api/http';
import { AuthScreen } from '../app/AuthScreen';
import { sessionMemory } from '../app/notices';
import { useAuthFlow } from '../auth/flow';
import { commonMessage, INVALID_CODE, type UserMessage } from '../auth/messages';
import { manualKeyFromOtpauth } from '../auth/otpauth';
import { ChallengeExpired } from './MfaPage';
import { ErrorAlert } from './ErrorAlert';
import { RecoveryCodesPanel } from './RecoveryCodesPanel';

type Step = 'intro' | 'configure' | 'confirm' | 'codes' | 'done';

const STEP_LABEL: Partial<Record<Step, string>> = {
  configure: 'Passo 1 de 3',
  confirm: 'Passo 2 de 3',
  codes: 'Passo 3 de 3',
};

const MAX_ATTEMPTS = 5;

/**
 * /entrar/configurar-autenticador e /o/{org}/mfa/setup — primeiro fator obrigatório. A pessoa só continua depois de
 * confirmar o autenticador (a API só cria a sessão nesse momento) e reconhecer os códigos de recuperação.
 */
export function MfaSetupPage() {
  const flow = useAuthFlow();
  const org = flow.org;
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('intro');
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [stored, setStored] = useState(false);
  const [storedError, setStoredError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<UserMessage | null>(null);
  const [failures, setFailures] = useState(0);
  const [lost, setLost] = useState(false);
  const inFlight = useRef(false);

  // Enquanto os códigos estão na tela e não foram reconhecidos, avisa antes de fechar/recarregar a aba.
  useEffect(() => {
    if (step !== 'codes') return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [step]);

  // Os códigos só existem nesta tela, em memória; saem dela ao concluir.
  useEffect(() => () => setCodes([]), []);

  const hasChallenge = flow.hasChallenge();
  if (lost || ((step === 'intro' || step === 'configure' || step === 'confirm') && !hasChallenge) || failures >= MAX_ATTEMPTS) {
    return <ChallengeExpired />;
  }

  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const start = () =>
    run(async () => {
      try {
        setOtpauthUri(await flow.startEnrollment());
        setStep('configure');
      } catch (e) {
        if (isApiError(e, 'unauthenticated')) setLost(true);
        else setError(commonMessage(e));
      }
    });

  const confirm = (value = code) =>
    run(async () => {
      if (!/^\d{6}$/.test(value)) {
        setFieldError('Digite os 6 dígitos exibidos no aplicativo.');
        return;
      }
      setFieldError(undefined);
      try {
        const received = await flow.confirmEnrollment(value);
        sessionMemory.markActive();
        setOtpauthUri(null); // o segredo sai da memória assim que o fator é confirmado
        setCodes(received);
        setStep('codes');
      } catch (e) {
        if (isApiError(e, 'unauthenticated', 'invalid_request')) {
          setFailures((n) => n + 1);
          setFieldError(INVALID_CODE);
          setCode('');
        } else {
          setError(commonMessage(e));
        }
      }
    });

  const finishCodes = () => {
    if (!stored) {
      setStoredError('Confirme que guardou os códigos para continuar.');
      return;
    }
    setCodes([]);
    setStep('done');
  };

  const stepLabel = STEP_LABEL[step] && <p className="pw-step">{STEP_LABEL[step]}</p>;

  if (step === 'intro') {
    return (
      <AuthScreen
        org={org}
        icon="shield"
        title="Proteja sua conta"
        description="Para continuar, configure um aplicativo autenticador."
        stepKey="intro"
        focusTitle
      >
        {error && <ErrorAlert message={error} />}
        <div className="pw-stack">
          <p className="pw-muted">
            A cada login, além da senha, você vai digitar um código temporário de 6 dígitos gerado pelo aplicativo
            no seu celular (por exemplo, Google Authenticator, Authy ou 1Password).
          </p>
          <p className="pw-muted">Leva menos de dois minutos.</p>
        </div>
        <Button fullWidth size="lg" loading={pending} onClick={() => void start()} leftIcon="smartphone">
          Configurar autenticador
        </Button>
      </AuthScreen>
    );
  }

  if (step === 'configure' && otpauthUri) {
    const key = manualKeyFromOtpauth(otpauthUri);
    return (
      <AuthScreen
        org={org}
        icon="smartphone"
        title="Configure o autenticador"
        description="No aplicativo autenticador, adicione uma conta e escaneie o QR Code."
        stepKey="configure"
        focusTitle
      >
        {stepLabel}
        <div className="pw-center">
          <QrCode value={otpauthUri} label="QR Code para configurar o aplicativo autenticador" size={196} />
        </div>
        {key && (
          <div className="pw-stack">
            <Text variant="body-sm" color="secondary">
              Não consegue escanear? Digite esta chave de configuração no aplicativo:
            </Text>
            <Text as="p" variant="code" className="pw-key" aria-label={`Chave de configuração: ${key}`}>
              {key}
            </Text>
          </div>
        )}
        <Button fullWidth size="lg" onClick={() => setStep('confirm')} rightIcon="arrow-right">
          Já adicionei a conta
        </Button>
      </AuthScreen>
    );
  }

  if (step === 'confirm') {
    return (
      <AuthScreen
        org={org}
        icon="shield"
        title="Confirme o código"
        description="Digite o código exibido no seu autenticador."
        stepKey="confirm"
        actions={
          <Link as="button" type="button" variant="subtle" onClick={() => setStep('configure')}>
            Voltar para o QR Code
          </Link>
        }
      >
        {stepLabel}
        {error && <ErrorAlert message={error} />}
        <form
          className="pw-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <CodeInput
            label="Código do autenticador"
            length={6}
            autoFocus
            value={code}
            onValueChange={(v) => {
              setCode(v);
              if (fieldError && v.length < 6) setFieldError(undefined);
            }}
            onComplete={(v) => void confirm(v)}
            error={fieldError}
            readOnly={pending}
          />
          <Button type="submit" fullWidth size="lg" loading={pending}>
            {pending ? 'Confirmando…' : 'Confirmar configuração'}
          </Button>
        </form>
      </AuthScreen>
    );
  }

  if (step === 'codes') {
    return (
      <AuthScreen
        org={org}
        icon="key"
        title="Guarde seus códigos de recuperação"
        description="Eles permitem acessar sua conta caso você perca acesso ao aplicativo autenticador. Cada código pode ser usado uma única vez e eles não serão exibidos novamente."
        stepKey="codes"
        focusTitle
      >
        {stepLabel}
        <RecoveryCodesPanel codes={codes} context={flow.codesContext} />
        <Checkbox
          label="Guardei meus códigos de recuperação em um local seguro."
          checked={stored}
          onChange={(e) => {
            setStored(e.target.checked);
            setStoredError(undefined);
          }}
          error={storedError}
        />
        <Button fullWidth size="lg" onClick={finishCodes} disabled={!stored} aria-disabled={!stored}>
          Continuar
        </Button>
      </AuthScreen>
    );
  }

  // done
  return (
    <AuthScreen org={org} icon="check-circle" title="Tudo pronto" stepKey="done" focusTitle>
      <StateView
        status="success"
        title="Autenticador configurado"
        description="A partir de agora, o código do aplicativo será pedido a cada login."
        actions={
          <Button fullWidth size="lg" onClick={() => navigate(flow.home(false), { replace: true })}>
            {flow.kind === 'identity' ? 'Continuar' : 'Continuar para o Platform'}
          </Button>
        }
      />
      <Alert tone="info">Se trocar de celular, use um código de recuperação para entrar e configure o novo aparelho.</Alert>
    </AuthScreen>
  );
}
