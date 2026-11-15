import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Card, Checkbox, CodeInput, Input, QrCode, SectionHeader, Stack, Text } from 'nekkora-lib';
import { isApiError } from '../api/http';
import {
  changeIdentityPassword,
  confirmIdentityEnrollment,
  confirmMfaActivation,
  identityStepUp,
  regenerateRecoveryCodes,
  startIdentityEnrollment,
  startMfaActivation,
} from '../api/identity';
import { identityPath } from '../auth/flow';
import { commonMessage, INVALID_CODE, type UserMessage } from '../auth/messages';
import { manualKeyFromOtpauth } from '../auth/otpauth';
import { meetsPasswordPolicy, PASSWORD_MAX, PASSWORD_MIN } from '../auth/passwordPolicy';
import { StepUpDialog } from '../components/StepUpDialog';
import { ErrorAlert } from '../pages/ErrorAlert';
import { RecoveryCodesPanel } from '../pages/RecoveryCodesPanel';
import { useIdentityArea } from './IdentityArea';
import './identity.css';

/** Códigos recebidos uma única vez: exibidos até a pessoa confirmar que guardou; depois saem da memória. */
function CodesOnce({ codes, onDone, first = false }: { codes: string[]; onDone: () => void; first?: boolean }) {
  const [stored, setStored] = useState(false);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  return (
    <Stack gap={3}>
      <Alert tone="warning" title="Guarde estes códigos agora.">
        Eles não serão exibidos de novo.{first ? '' : ' Os códigos anteriores deixaram de valer.'}
      </Alert>
      <RecoveryCodesPanel codes={codes} context="Identidade Nekkora" />
      <Checkbox label="Guardei meus códigos de recuperação em um local seguro." checked={stored} onChange={(e) => setStored(e.target.checked)} />
      <div>
        <Button onClick={onDone} disabled={!stored}>
          Concluir
        </Button>
      </div>
    </Stack>
  );
}

function PasswordSection() {
  const { expired, mfaEnabled } = useIdentityArea();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirmation?: string }>({});
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [uncertain, setUncertain] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = {
      current: current ? undefined : 'Informe a senha atual.',
      next: meetsPasswordPolicy(next) ? undefined : `A senha nova precisa ter entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres.`,
      confirmation: confirmation === next ? undefined : 'As senhas não coincidem.',
    };
    setErrors(found);
    if (found.current || found.next || found.confirmation) return;
    setDone(false);
    setConfirming(true);
  };

  return (
    <Card variant="outlined" padding="lg">
      <Stack gap={4}>
        <SectionHeader
          as="h2"
          title="Senha"
          description={mfaEnabled ? 'Trocar a senha encerra as suas outras sessões. O autenticador continua o mesmo.' : 'Trocar a senha encerra as suas outras sessões.'}
        />
        {done && <Alert tone="success">Senha alterada. As outras sessões foram encerradas e você recebeu um aviso por e-mail.</Alert>}
        {uncertain && (
          <Alert tone="warning" title="Não foi possível confirmar a troca de senha.">
            A senha pode ter sido trocada. Antes de tentar de novo, saia e entre com a senha nova; se ela não funcionar, use a atual.
          </Alert>
        )}
        <form className="pw-identity__form" onSubmit={submit} noValidate>
          <Input label="Senha atual" type="password" autoComplete="current-password" required fullWidth value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.current} />
          <Input
            label="Senha nova"
            type="password"
            autoComplete="new-password"
            required
            fullWidth
            value={next}
            onChange={(e) => setNext(e.target.value)}
            error={errors.next}
            hint={`Entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres.`}
          />
          <Input
            label="Confirmar senha nova"
            type="password"
            autoComplete="new-password"
            required
            fullWidth
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            error={errors.confirmation}
          />
          <div>
            <Button type="submit" disabled={uncertain}>
              Trocar senha
            </Button>
          </div>
        </form>
      </Stack>
      <StepUpDialog<void>
        open={confirming}
        title="Trocar a senha?"
        guard={{ operation: 'identity.password.change' }}
        confirmLabel="Trocar senha"
        stepUp={identityStepUp}
        action={() => changeIdentityPassword(current, next)}
        onDone={() => {
          setConfirming(false);
          setCurrent('');
          setNext('');
          setConfirmation('');
          setDone(true);
        }}
        onClose={() => setConfirming(false)}
        refusalText={(e) =>
          isApiError(e, 'invalid_request')
            ? 'A senha nova não atende à política. Nada foi alterado.'
            : isApiError(e, 'rate_limited')
              ? 'Muitas tentativas em pouco tempo. Aguarde antes de tentar de novo. Nada foi alterado.'
              : 'A troca não foi aceita: a senha atual pode estar incorreta ou a confirmação venceu. Nada foi alterado.'
        }
        uncertainText="Não foi possível confirmar o resultado. A senha pode ter sido trocada. Feche e confira entrando de novo antes de repetir."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && setUncertain(true)}
      >
        <Text>As suas outras sessões serão encerradas. Esta continua aberta.</Text>
      </StepUpDialog>
    </Card>
  );
}

function RecoveryCodesSection() {
  const { expired } = useIdentityArea();
  const [confirming, setConfirming] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => () => setCodes(null), []);

  return (
    <Card variant="outlined" padding="lg">
      <Stack gap={4}>
        <SectionHeader
          as="h2"
          title="Códigos de recuperação"
          description="Servem para entrar se você perder o autenticador. Gerar um conjunto novo invalida o anterior."
        />
        {uncertain && (
          <Alert tone="warning" title="Não foi possível confirmar se um conjunto novo foi gerado.">
            Se foi, os códigos anteriores deixaram de valer e o novo conjunto não pode ser exibido de novo. Gere outro
            conjunto para ter códigos que você conheça.
          </Alert>
        )}
        {codes ? (
          <CodesOnce codes={codes} onDone={() => setCodes(null)} />
        ) : (
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                setUncertain(false);
                setConfirming(true);
              }}
            >
              Gerar novos códigos
            </Button>
          </div>
        )}
      </Stack>
      <StepUpDialog<string[]>
        open={confirming}
        title="Gerar novos códigos de recuperação?"
        guard={{ operation: 'identity.recovery-codes.regenerate' }}
        confirmLabel="Gerar códigos"
        stepUp={identityStepUp}
        action={regenerateRecoveryCodes}
        onDone={(received) => {
          setConfirming(false);
          setCodes(received);
        }}
        onClose={() => setConfirming(false)}
        refusalText={() => 'A geração não foi aceita. A confirmação pode ter vencido. Os códigos atuais continuam valendo.'}
        uncertainText="Não foi possível confirmar o resultado. Feche esta janela: o aviso na página explica o que fazer."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && setUncertain(true)}
      >
        <Text>Os códigos atuais deixam de valer assim que o conjunto novo for gerado. Ele será exibido uma única vez.</Text>
      </StepUpDialog>
    </Card>
  );
}

/**
 * /conta — segurança da identidade. Com autenticação em duas etapas: senha, códigos de recuperação e autenticador. Sem
 * ela (API 029: é opcional): senha e o convite para ativar — até lá, a senha confirma as ações sensíveis.
 */
export function AccountPage() {
  const navigate = useNavigate();
  const { mfaEnabled } = useIdentityArea();
  if (!mfaEnabled)
    return (
      <Stack gap={5} className="pw-identity">
        <SectionHeader as="h1" title="Segurança da conta" description="Senha e autenticação em duas etapas da sua identidade Nekkora. Valem para todas as suas organizações." />
        <Card variant="outlined" padding="lg">
          <Stack gap={3}>
            <SectionHeader as="h2" title="Autenticação em duas etapas" description="Desativada. Hoje a sua senha confirma as ações sensíveis, como criar organização ou convidar pessoas." />
            <Text>
              Com a autenticação em duas etapas, além da senha você usa um código do aplicativo autenticador do celular para
              entrar e para as ações sensíveis. Depois de ativada, ela passa a ser exigida sempre.
            </Text>
            <div>
              <Button leftIcon="shield" onClick={() => navigate(identityPath.activateMfa)}>
                Ativar autenticação em duas etapas
              </Button>
            </div>
          </Stack>
        </Card>
        <PasswordSection />
      </Stack>
    );
  return (
    <Stack gap={5} className="pw-identity">
      <SectionHeader as="h1" title="Segurança da conta" description="Senha, códigos de recuperação e autenticador da sua identidade Nekkora. Valem para todas as suas organizações." />
      <Alert tone="success">A autenticação em duas etapas está ativa: o código do autenticador é pedido ao entrar e nas ações sensíveis.</Alert>
      <PasswordSection />
      <RecoveryCodesSection />
      <Card variant="outlined" padding="lg">
        <Stack gap={3}>
          <SectionHeader as="h2" title="Aplicativo autenticador" description="Troque o autenticador se mudou de celular ou suspeita que o atual foi exposto." />
          <div>
            <Button variant="secondary" onClick={() => navigate(identityPath.replaceFactor)}>
              Trocar autenticador
            </Button>
          </div>
        </Stack>
      </Card>
    </Stack>
  );
}

type FactorStep = 'intro' | 'configure' | 'confirm' | 'codes' | 'done';

/**
 * /conta/fator — substituição do fator (DC-17.13). Sessão comum: exige step-up (código do autenticador ATUAL) antes de
 * gerar o fator novo. Sessão restrita (entrada com código de recuperação): a própria marca da recuperação autoriza, por
 * até 15 min; depois disso a API recusa e é preciso entrar de novo. Confirmar o fator novo invalida os códigos antigos,
 * encerra as outras sessões e levanta a restrição desta.
 */
export function ReplaceFactorPage() {
  const { restricted, expired, reload } = useIdentityArea();
  const navigate = useNavigate();
  const [step, setStep] = useState<FactorStep>('intro');
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<UserMessage | string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      setOtpauth(null);
      setCodes(null);
    },
    [],
  );

  const refusedProof =
    'A troca não foi autorizada. A confirmação pode ter vencido (na sessão de recuperação, o prazo é de 15 minutos). Saia e entre de novo para recomeçar.';

  const startRestricted = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      setOtpauth(await startIdentityEnrollment('session'));
      setStep('configure');
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      setError(isApiError(e, 'forbidden') ? refusedProof : commonMessage(e));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const confirm = async (value = code) => {
    if (inFlight.current) return;
    if (!/^\d{6}$/.test(value)) {
      setFieldError('Digite os 6 dígitos exibidos no aplicativo.');
      return;
    }
    inFlight.current = true;
    setPending(true);
    setFieldError(undefined);
    setError(null);
    try {
      const received = await confirmIdentityEnrollment('session', value);
      setOtpauth(null);
      setCodes(received);
      setStep('codes');
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      if (isApiError(e, 'forbidden', 'invalid_request')) {
        // código errado, já usado, prova vencida ou fator pendente descartado: recusa genérica da API
        setFieldError(INVALID_CODE);
        setCode('');
      } else {
        // sem resposta: a troca pode ter acontecido — não reenviar; conferir entrando de novo
        setError(
          'Não foi possível confirmar se o autenticador foi trocado. Não tente de novo agora: saia e entre com o autenticador novo; se ele não funcionar, use o atual.',
        );
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const errorView = error && (typeof error === 'string' ? <Alert tone="danger">{error}</Alert> : <ErrorAlert message={error} />);

  return (
    <Stack gap={5} className="pw-identity">
      <SectionHeader
        as="h1"
        title="Trocar o aplicativo autenticador"
        description={
          restricted
            ? 'Cadastre um autenticador novo para voltar a usar a sua conta normalmente.'
            : 'O autenticador atual deixa de valer quando o novo for confirmado.'
        }
      />
      {errorView}

      {step === 'intro' && (
        <Card variant="outlined" padding="lg">
          <Stack gap={3}>
            <Text>
              Ao confirmar o autenticador novo: o atual e os códigos de recuperação atuais deixam de valer, as suas outras
              sessões são encerradas e você recebe um aviso por e-mail. Novos códigos de recuperação serão exibidos uma
              única vez.
            </Text>
            <div>
              <Button loading={pending} leftIcon="smartphone" onClick={() => (restricted ? void startRestricted() : setConfirming(true))}>
                Começar
              </Button>
            </div>
          </Stack>
        </Card>
      )}

      {step === 'configure' && otpauth && (
        <Card variant="outlined" padding="lg">
          <Stack gap={3}>
            <Text>No aplicativo autenticador, adicione uma conta e escaneie o QR Code.</Text>
            <div className="pw-center">
              <QrCode value={otpauth} label="QR Code para configurar o aplicativo autenticador" size={196} />
            </div>
            {manualKeyFromOtpauth(otpauth) && (
              <Text as="p" variant="code" className="pw-key" aria-label={`Chave de configuração: ${manualKeyFromOtpauth(otpauth)}`}>
                {manualKeyFromOtpauth(otpauth)}
              </Text>
            )}
            <div>
              <Button rightIcon="arrow-right" onClick={() => setStep('confirm')}>
                Já adicionei a conta
              </Button>
            </div>
          </Stack>
        </Card>
      )}

      {step === 'confirm' && (
        <Card variant="outlined" padding="lg">
          <form
            className="pw-identity__form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void confirm();
            }}
          >
            <CodeInput
              label="Código do autenticador NOVO"
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
            <div className="pw-form__row">
              <Button type="submit" loading={pending}>
                Confirmar autenticador novo
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStep('configure')}>
                Voltar para o QR Code
              </Button>
            </div>
          </form>
        </Card>
      )}

      {step === 'codes' && codes && (
        <CodesOnce
          codes={codes}
          onDone={() => {
            setCodes(null);
            setStep('done');
            void reload(); // a API levantou a restrição: a área volta ao normal pelo que ela responder
          }}
        />
      )}

      {step === 'done' && (
        <Alert tone="success" title="Autenticador trocado.">
          <Stack gap={2}>
            <span>A partir de agora, use o autenticador novo. As outras sessões foram encerradas.</span>
            <span>
              <Button size="sm" onClick={() => navigate(identityPath.organizations)}>
                Continuar
              </Button>
            </span>
          </Stack>
        </Alert>
      )}

      {/* sem `guard` de propósito: começar a troca não troca nada (quem troca é a confirmação com o primeiro código do
          autenticador novo, que trata o resultado desconhecido na própria tela); repetir o começo só substitui o pedido
          pendente */}
      <StepUpDialog<string>
        open={confirming}
        title="Confirmar com o autenticador atual"
        confirmLabel="Continuar"
        stepUp={identityStepUp}
        action={() => startIdentityEnrollment('session')}
        onDone={(uri) => {
          setConfirming(false);
          setOtpauth(uri);
          setStep('configure');
        }}
        onClose={() => setConfirming(false)}
        refusalText={() => 'Não foi possível começar a troca. Tente de novo.'}
        uncertainText="Não foi possível confirmar. Nada foi trocado ainda: feche e comece de novo."
        onUnauthenticated={expired}
      >
        <Text>Para trocar o autenticador, confirme com o código do autenticador que você usa hoje.</Text>
      </StepUpDialog>
    </Stack>
  );
}

/**
 * /conta/proteger — oferta da autenticação em duas etapas na PRIMEIRA entrada depois do cadastro (API 029: opcional). A
 * configuração é o foco da tela (ação principal); seguir sem ela é possível, com menos destaque, e a ativação continua
 * disponível em Segurança da conta. Conta que já tem o fator não vê a oferta.
 */
export function ProtectAccountPage() {
  const { mfaEnabled } = useIdentityArea();
  const navigate = useNavigate();
  useEffect(() => {
    if (mfaEnabled) navigate(identityPath.organizations, { replace: true });
  }, [mfaEnabled, navigate]);
  if (mfaEnabled) return null;
  return (
    <Stack gap={5} className="pw-identity pw-protect">
      <SectionHeader
        as="h1"
        title="Proteja sua conta"
        description="Ative a verificação em duas etapas: além da senha, um código do aplicativo autenticador do seu celular passa a ser pedido ao entrar e nas ações sensíveis."
      />
      <Card variant="outlined" padding="lg">
        <Stack gap={4}>
          <Stack gap={2}>
            <Text>Recomendado para todas as contas. Leva cerca de 2 minutos:</Text>
            <ol className="pw-protect__steps">
              <li>Confirme a sua senha.</li>
              <li>Escaneie o QR Code com um aplicativo autenticador (por exemplo, Google Authenticator, Authy ou 1Password).</li>
              <li>Digite o código de 6 dígitos e guarde os códigos de recuperação.</li>
            </ol>
          </Stack>
          <div>
            <Button size="lg" leftIcon="shield" onClick={() => navigate(identityPath.activateMfa)}>
              Configurar verificação em duas etapas
            </Button>
          </div>
        </Stack>
      </Card>
      <Stack gap={1} className="pw-protect__skip">
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate(identityPath.organizations, { replace: true })}>
            Seguir sem a verificação em duas etapas
          </Button>
        </div>
        <Text variant="body-sm" color="secondary">
          Você pode ativar depois, quando quiser, em Segurança da conta.
        </Text>
      </Stack>
    </Stack>
  );
}

type ActivationStep = 'intro' | 'configure' | 'confirm' | 'codes' | 'done';

/**
 * /conta/ativar-autenticacao — ativação voluntária da autenticação em duas etapas (API 029). A senha reconfirmada
 * imediatamente antes autoriza gerar o fator; o primeiro código do autenticador confirma. A API encerra TODAS as sessões
 * anteriores (inclusive as de organização) e emite a sessão nova, já com o fator: a partir daí o código é pedido sempre.
 */
export function ActivateMfaPage() {
  const { mfaEnabled, expired, reload } = useIdentityArea();
  const navigate = useNavigate();
  const [step, setStep] = useState<ActivationStep>('intro');
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      setOtpauth(null);
      setCodes(null);
    },
    [],
  );

  const confirm = async (value = code) => {
    if (inFlight.current) return;
    if (!/^\d{6}$/.test(value)) {
      setFieldError('Digite os 6 dígitos exibidos no aplicativo.');
      return;
    }
    inFlight.current = true;
    setPending(true);
    setFieldError(undefined);
    setError(null);
    try {
      const received = await confirmMfaActivation(value);
      setOtpauth(null);
      setCodes(received);
      setStep('codes');
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      if (isApiError(e, 'forbidden', 'invalid_request')) {
        setFieldError(INVALID_CODE);
        setCode('');
      } else {
        // sem resposta: a ativação pode ter acontecido — não reenviar; conferir entrando de novo
        setError(
          'Não foi possível confirmar se a autenticação em duas etapas foi ativada. Não tente de novo agora: saia e entre de novo. Se o código for pedido, ela foi ativada.',
        );
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  if (mfaEnabled && step === 'intro')
    return (
      <Stack gap={5} className="pw-identity">
        <SectionHeader as="h1" title="Autenticação em duas etapas" />
        <Alert tone="success">A autenticação em duas etapas já está ativa nesta conta.</Alert>
        <div>
          <Button variant="secondary" onClick={() => navigate(identityPath.account)}>
            Voltar para Segurança da conta
          </Button>
        </div>
      </Stack>
    );

  return (
    <Stack gap={5} className="pw-identity">
      <SectionHeader as="h1" title="Ativar autenticação em duas etapas" description="Um código do aplicativo autenticador do celular passa a ser pedido ao entrar e nas ações sensíveis." />
      {error && <Alert tone="danger">{error}</Alert>}

      {step === 'intro' && (
        <Card variant="outlined" padding="lg">
          <Stack gap={3}>
            <Text>
              Você vai precisar de um aplicativo autenticador no celular. Ao concluir: as suas outras sessões são encerradas,
              você recebe códigos de recuperação (exibidos uma única vez) e, a partir daí, o código do aplicativo é exigido
              sempre — a senha sozinha não basta mais.
            </Text>
            <div>
              <Button leftIcon="smartphone" onClick={() => setConfirming(true)}>
                Começar
              </Button>
            </div>
          </Stack>
        </Card>
      )}

      {step === 'configure' && otpauth && (
        <Card variant="outlined" padding="lg">
          <Stack gap={3}>
            <Text>No aplicativo autenticador, adicione uma conta e escaneie o QR Code.</Text>
            <div className="pw-center">
              <QrCode value={otpauth} label="QR Code para configurar o aplicativo autenticador" size={196} />
            </div>
            {manualKeyFromOtpauth(otpauth) && (
              <Text as="p" variant="code" className="pw-key" aria-label={`Chave de configuração: ${manualKeyFromOtpauth(otpauth)}`}>
                {manualKeyFromOtpauth(otpauth)}
              </Text>
            )}
            <div>
              <Button rightIcon="arrow-right" onClick={() => setStep('confirm')}>
                Já adicionei a conta
              </Button>
            </div>
          </Stack>
        </Card>
      )}

      {step === 'confirm' && (
        <Card variant="outlined" padding="lg">
          <form
            className="pw-identity__form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void confirm();
            }}
          >
            <CodeInput
              label="Código do aplicativo autenticador"
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
            <div className="pw-form__row">
              <Button type="submit" loading={pending}>
                Ativar
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStep('configure')}>
                Voltar para o QR Code
              </Button>
            </div>
          </form>
        </Card>
      )}

      {step === 'codes' && codes && (
        <CodesOnce
          codes={codes}
          first
          onDone={() => {
            setCodes(null);
            setStep('done');
            void reload(); // a sessão nova já tem o fator: a área passa a mostrar o que a API responder
          }}
        />
      )}

      {step === 'done' && (
        <Alert tone="success" title="Autenticação em duas etapas ativada.">
          <Stack gap={2}>
            <span>A partir de agora, o código do aplicativo é pedido ao entrar e nas ações sensíveis. As outras sessões foram encerradas.</span>
            <span>
              <Button size="sm" onClick={() => navigate(identityPath.organizations)}>
                Continuar
              </Button>
            </span>
          </Stack>
        </Alert>
      )}

      {/* sem `guard`: começar não ativa nada (quem ativa é o primeiro código do autenticador); repetir só substitui o
          pedido pendente */}
      <StepUpDialog<string>
        open={confirming}
        title="Confirme a sua senha"
        confirmLabel="Continuar"
        stepUp={identityStepUp}
        action={startMfaActivation}
        onDone={(uri) => {
          setConfirming(false);
          setOtpauth(uri);
          setStep('configure');
        }}
        onClose={() => setConfirming(false)}
        refusalText={() => 'Não foi possível começar a ativação. Tente de novo.'}
        uncertainText="Não foi possível confirmar. Nada foi ativado ainda: feche e comece de novo."
        onUnauthenticated={expired}
      >
        <Text>Para gerar o QR Code, confirme que é você.</Text>
      </StepUpDialog>
    </Stack>
  );
}
