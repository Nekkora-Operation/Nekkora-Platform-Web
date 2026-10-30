import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Card, CodeInput, Input, Link, SectionHeader, Stack, Text } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';
import { confirmAccountLink, identityStepUp, startAccountLink } from '../api/identity';
import { identityPath } from '../auth/flow';
import { isValidOrganizationId } from '../auth/organization';
import { commonMessage, type UserMessage } from '../auth/messages';
import { StepUpDialog } from '../components/StepUpDialog';
import { ErrorAlert } from '../pages/ErrorAlert';
import { useIdentityArea } from './IdentityArea';
import './identity.css';

type Step = 'proof' | 'confirm' | 'done';

/**
 * /vincular-conta — liga uma conta ANTIGA de organização (entrada por /o/{org}/login) à identidade. Duas provas, nunca
 * coincidência de e-mail: (1) a senha e o segundo fator DA CONTA ANTIGA; (2) o autenticador da identidade (step-up). A
 * conta é procurada pelo e-mail da própria identidade. Qualquer falha da primeira prova tem a mesma resposta.
 */
export function LinkAccountPage() {
  const { expired } = useIdentityArea();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('proof');
  const [organizationId, setOrganizationId] = useState('');
  const [password, setPassword] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [errors, setErrors] = useState<{ org?: string; password?: string; factor?: string }>({});
  const [error, setError] = useState<UserMessage | string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const inFlight = useRef(false);

  const prove = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    const org = organizationId.trim().toLowerCase();
    const found = {
      org: isValidOrganizationId(org) ? undefined : 'Informe o identificador da organização (formato 8-4-4-4-12).',
      password: password ? undefined : 'Informe a senha da conta antiga.',
      factor: useRecovery ? (recovery.replace(/[-\s]/g, '').length === 16 ? undefined : 'O código de recuperação tem 16 caracteres.') : /^\d{6}$/.test(code) ? undefined : 'Digite os 6 dígitos.',
    };
    setErrors(found);
    if (found.org || found.password || found.factor) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await startAccountLink(org, password, useRecovery ? { recoveryCode: recovery.toUpperCase() } : { code });
      setPassword('');
      setCode('');
      setRecovery('');
      setOrganizationId(org);
      setStep('confirm');
    } catch (err) {
      if (isApiError(err, 'unauthenticated')) {
        // 401 é a resposta única da prova recusada (conta inexistente, senha ou código errados, conta inelegível ou
        // já vinculada) — e também a de sessão de identidade caída; a API não distingue e a interface também não
        setError('Não foi possível confirmar a conta antiga com esses dados. Confira a organização, a senha e o código da conta antiga.');
        setCode('');
      } else if (err instanceof ApiError && err.status === 404) setError('A vinculação de contas não está disponível no momento.');
      else setError(commonMessage(err));
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
        title="Vincular conta antiga"
        description="Se você entrava numa organização com uma conta própria dela (e-mail e senha daquela organização), vincule essa conta à sua identidade Nekkora para entrar por aqui."
      />
      {step === 'proof' && (
        <Card variant="outlined" padding="lg">
          <form className="pw-identity__form" onSubmit={prove} noValidate>
            <Text>
              A conta antiga precisa ter o mesmo e-mail da sua identidade. Informe a senha e o código de autenticação DA
              CONTA ANTIGA — não os da identidade.
            </Text>
            {errorView}
            <Input
              label="Identificador da organização"
              hint="Está no endereço que você usava para entrar: /o/<identificador>/login."
              fullWidth
              required
              spellCheck={false}
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              error={errors.org}
            />
            <Input label="Senha da conta antiga" type="password" autoComplete="off" fullWidth required value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} />
            {useRecovery ? (
              <Input
                label="Código de recuperação da conta antiga"
                mask="****-****-****-****"
                autoComplete="off"
                fullWidth
                value={recovery}
                onValueChange={(v) => setRecovery(v.toUpperCase())}
                error={errors.factor}
              />
            ) : (
              <CodeInput label="Código do autenticador da conta antiga" length={6} value={code} onValueChange={setCode} error={errors.factor} />
            )}
            <Link as="button" type="button" variant="subtle" onClick={() => setUseRecovery((v) => !v)}>
              {useRecovery ? 'Usar o código do autenticador' : 'Usar um código de recuperação da conta antiga'}
            </Link>
            <div>
              <Button type="submit" loading={pending}>
                Conferir conta antiga
              </Button>
            </div>
          </form>
        </Card>
      )}
      {step === 'confirm' && (
        <Card variant="outlined" padding="lg">
          <Stack gap={3}>
            <Alert tone="success">Conta antiga conferida. Nada foi vinculado ainda.</Alert>
            {errorView}
            <Text>A confirmação vale por 5 minutos. Depois disso, será preciso conferir a conta antiga de novo.</Text>
            <div className="pw-form__row">
              <Button onClick={() => setConfirming(true)}>Vincular à minha identidade</Button>
              <Button variant="ghost" onClick={() => setStep('proof')}>
                Recomeçar
              </Button>
            </div>
          </Stack>
        </Card>
      )}
      {step === 'done' && (
        <Alert tone="success" title="Conta vinculada.">
          <Stack gap={2}>
            <span>A partir de agora, entre nessa organização pela sua identidade. A senha e o autenticador antigos daquela conta deixaram de valer.</span>
            <span>
              <Button size="sm" onClick={() => navigate(identityPath.organizations)}>
                Ver minhas organizações
              </Button>
            </span>
          </Stack>
        </Alert>
      )}
      <StepUpDialog<void>
        open={confirming}
        title="Vincular a conta antiga à sua identidade?"
        guard={{ operation: 'account.link', target: organizationId }}
        confirmLabel="Vincular"
        stepUp={identityStepUp}
        action={() => confirmAccountLink(organizationId)}
        onDone={() => {
          setConfirming(false);
          setStep('done');
        }}
        onClose={() => setConfirming(false)}
        refusalText={() =>
          'A vinculação não foi aceita. A conferência da conta antiga pode ter vencido ou a conta mudou. Recomece pela conferência da conta antiga.'
        }
        uncertainText="Não foi possível confirmar o resultado. A conta pode ter sido vinculada. Feche e confira a lista de organizações antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(k) => {
          if (k === 'refused') setStep('proof');
        }}
      >
        <Text>
          No mesmo ato, a entrada antiga daquela conta é fechada: a senha, o autenticador e os códigos antigos deixam de
          valer, e as sessões abertas dela são encerradas. Você recebe um aviso por e-mail. Não é possível desfazer.
        </Text>
      </StepUpDialog>
    </Stack>
  );
}
