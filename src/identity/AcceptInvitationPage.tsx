import { useEffect, useState } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Link, StateView, Text } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';
import { acceptInvitation, enterOrganization, identitySession, identityStepUp } from '../api/identity';
import { AuthScreen } from '../app/AuthScreen';
import { useOrganization } from '../app/organization';
import { identityPath } from '../auth/flow';
import { consumeInitialLinkToken } from '../auth/linkToken';
import { commonMessage, type UserMessage } from '../auth/messages';
import { orgPath } from '../auth/organization';
import { StepUpDialog } from '../components/StepUpDialog';
import { ErrorAlert } from '../pages/ErrorAlert';

/**
 * Convite aberto e ainda não aceito, SÓ em memória da aba (nunca storage nem URL): sobrevive à ida até a entrada ou ao
 * cadastro dentro da aplicação, para a pessoa voltar e aceitar. Recarregar a página o perde (basta abrir o link de novo).
 */
let pending: { org: string; token: string } | null = null;
export const pendingInvitation = {
  peek: () => pending,
  clear: () => {
    pending = null;
  },
};

type Probe = 'loading' | 'session' | 'restricted' | 'none' | 'unavailable' | { error: UserMessage };
type Result = 'accepted' | 'invalid' | 'already_member' | 'account_exists' | 'account_unavailable';

/**
 * /o/{org}/convite#token=… — aceite pela identidade Nekkora (step-up). Nunca vincula por coincidência de e-mail: o
 * convite só vale para a identidade com o MESMO e-mail, e uma conta antiga com esse e-mail precisa da vinculação.
 */
export function AcceptInvitationPage() {
  const org = useOrganization();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [token] = useState(() => {
    const fromLink = consumeInitialLinkToken(pathname);
    if (fromLink) pending = { org, token: fromLink };
    return fromLink ?? (pending?.org === org ? pending.token : null);
  });
  const [probe, setProbe] = useState<Probe>('loading');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [entering, setEntering] = useState(false);
  const [enterError, setEnterError] = useState<UserMessage | 'no_access' | null>(null);
  const [uncertain, setUncertain] = useState(false);

  useEffect(() => {
    let alive = true;
    identitySession()
      .then(({ restricted }) => alive && setProbe(restricted ? 'restricted' : 'session'))
      .catch((e) => {
        if (!alive) return;
        if (isApiError(e, 'unauthenticated')) setProbe('none');
        else if (e instanceof ApiError && e.status === 404) setProbe('unavailable');
        else setProbe({ error: commonMessage(e) });
      });
    return () => {
      alive = false;
    };
  }, []);

  const enter = async () => {
    setEntering(true);
    setEnterError(null);
    try {
      if ((await enterOrganization(org)) === 'entered') navigate(orgPath.home(org), { replace: true });
      else setEnterError('no_access');
    } catch (e) {
      setEnterError(commonMessage(e));
    } finally {
      setEntering(false);
    }
  };

  if (!token) {
    return (
      <AuthScreen org={org} icon="alert" title="Este link de convite está incompleto" focusTitle>
        <StateView status="warning" title="Abra de novo o link do e-mail do convite." description="O convite só funciona pelo link completo que chegou por e-mail." />
      </AuthScreen>
    );
  }

  if (result === 'accepted') {
    return (
      <AuthScreen org={org} icon="check-circle" title="Convite aceito" focusTitle>
        <Text>Você agora participa desta organização.</Text>
        {enterError === 'no_access' && <Alert tone="warning">Não foi possível entrar agora. Tente pela lista das suas organizações.</Alert>}
        {enterError && enterError !== 'no_access' && <ErrorAlert message={enterError} />}
        <Button fullWidth size="lg" loading={entering} onClick={() => void enter()}>
          Entrar na organização
        </Button>
        <Link as={RouterLink} to={identityPath.organizations} variant="subtle">
          Ver minhas organizações
        </Link>
      </AuthScreen>
    );
  }

  const outcome: Record<Exclude<Result, 'accepted'>, { tone: 'warning' | 'info'; text: string }> = {
    invalid: {
      tone: 'warning',
      text: 'Este convite não vale para a sua identidade: ele pode ter vencido (vale 7 dias), sido revogado, substituído por um reenvio, já aceito, ou ter sido enviado para outro e-mail. Peça um convite novo a quem administra a organização.',
    },
    already_member: { tone: 'info', text: 'Você já participa desta organização.' },
    account_exists: {
      tone: 'info',
      text: 'Já existe uma conta antiga desta organização com o seu e-mail. Para usá-la pela sua identidade, faça a vinculação da conta antiga (ela pede a senha e o código daquela conta).',
    },
    account_unavailable: { tone: 'warning', text: 'A sua conta nesta organização está indisponível (suspensa ou com o vínculo inativo). Procure quem administra a organização.' },
  };

  return (
    <AuthScreen org={org} icon="mail" title="Convite para uma organização" focusTitle>
      {probe === 'loading' && <StateView status="loading" title="Conferindo sua sessão…" />}
      {typeof probe === 'object' && <ErrorAlert message={probe.error} />}
      {probe === 'unavailable' && <Alert tone="warning">Os convites não estão disponíveis no momento.</Alert>}
      {probe === 'restricted' && (
        <Alert tone="warning">
          Sua sessão está restrita à troca do autenticador. <Link as={RouterLink} to={identityPath.replaceFactor}>Troque o autenticador</Link> e volte para aceitar.
        </Alert>
      )}
      {probe === 'none' && (
        <>
          <Text>Para aceitar, entre com a identidade Nekkora do e-mail que recebeu o convite. Se ainda não tem cadastro, crie com esse mesmo e-mail.</Text>
          <Button fullWidth size="lg" onClick={() => navigate(identityPath.login)}>
            Entrar
          </Button>
          <Button fullWidth variant="secondary" onClick={() => navigate(identityPath.signup)}>
            Criar cadastro
          </Button>
          <Text variant="body-sm" color="secondary">
            Depois de entrar, você volta a este convite pelo aviso na lista das suas organizações (nesta aba) ou abrindo de novo o link do e-mail.
          </Text>
        </>
      )}
      {probe === 'session' && (
        <>
          {result && <Alert tone={outcome[result].tone}>{outcome[result].text}</Alert>}
          {result === 'account_exists' && (
            <Link as={RouterLink} to={identityPath.linkAccount}>
              Vincular a conta antiga
            </Link>
          )}
          {result === 'already_member' && (
            <Button fullWidth loading={entering} onClick={() => void enter()}>
              Entrar na organização
            </Button>
          )}
          {uncertain && <Alert tone="warning">Não foi possível confirmar o aceite. Confira a lista das suas organizações antes de tentar de novo.</Alert>}
          {!result && (
            <>
              <Text>Ao aceitar, você passa a participar desta organização com o papel definido por quem convidou.</Text>
              <Button fullWidth size="lg" disabled={uncertain} onClick={() => setConfirming(true)}>
                Aceitar convite
              </Button>
            </>
          )}
        </>
      )}

      <StepUpDialog<string>
        open={confirming}
        title="Aceitar o convite?"
        guard={{ operation: 'invitation.accept', target: org }}
        confirmLabel="Aceitar"
        stepUp={identityStepUp}
        action={() => acceptInvitation(org, token)}
        onDone={() => {
          pendingInvitation.clear();
          setConfirming(false);
          setResult('accepted');
        }}
        onClose={() => setConfirming(false)}
        refusalText={(e) => {
          const r: Result | null = isApiError(e, 'not_found')
            ? 'invalid'
            : isApiError(e, 'already_member')
              ? 'already_member'
              : isApiError(e, 'account_exists')
                ? 'account_exists'
                : isApiError(e, 'account_unavailable')
                  ? 'account_unavailable'
                  : null;
          if (r) {
            pendingInvitation.clear();
            setResult(r);
            setConfirming(false);
          }
          return 'O aceite não foi concluído. Nada foi alterado.';
        }}
        uncertainText="Não foi possível confirmar o aceite. Feche e confira a lista das suas organizações antes de tentar de novo."
        onUnauthenticated={() => setProbe('none')}
        onOutcome={(k) => k === 'uncertain' && setUncertain(true)}
      >
        <Text>O convite vale só para a identidade com o mesmo e-mail do convite.</Text>
      </StepUpDialog>
    </AuthScreen>
  );
}
