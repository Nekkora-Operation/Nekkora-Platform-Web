import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, Stack, Text } from 'nekkora-lib';
import { ApiError, isApiError } from '../api/http';
import {
  deactivateOrganization,
  identityStepUp,
  myOrganizationRequests,
  organizationCreation,
  reactivateOrganization,
  type IdentityOrganization,
  type MyOrganizationRequest,
  type OrganizationCreationState,
  type ResponsibleOrganization,
} from '../api/identity';
import { identityPath } from '../auth/flow';
import { StepUpDialog } from '../components/StepUpDialog';
import { useIdentityArea } from './IdentityArea';
import './identity.css';

type Loaded = { creation: OrganizationCreationState; requests: MyOrganizationRequest[] };

/** Por que a pessoa não cria direto agora, em palavras (o `cannotCreateReason` da API). */
export const CANNOT_CREATE: Record<string, { title: string; body: string }> = {
  organization_creation_client_profile: {
    title: 'A sua conta é de Cliente.',
    body: 'Contas de Cliente acompanham o trabalho de uma organização e não criam nem solicitam organizações. Se você também trabalha em outra organização como membro da equipe, peça o convite a quem a administra.',
  },
  organization_creation_requires_request: {
    title: 'Para ter uma nova organização, solicite a quem administra a sua.',
    body: 'Você participa de uma organização sem administrá-la. A criação é pedida a um administrador dela, que aprova e decide quem fica responsável pela nova organização.',
  },
  empty_organization_limit_reached: {
    title: 'Você atingiu o limite de organizações vazias.',
    body: 'Cada pessoa pode ser responsável por até três organizações ativas sem nenhuma automação. Crie uma automação em uma delas ou desative uma organização vazia para criar outra.',
  },
};

/**
 * Limite de FREQUÊNCIA da criação (até três por dia por pessoa): proteção contra abuso, diferente do limite de organizações
 * vazias. O servidor informa em quanto tempo a próxima criação é possível (Retry-After); a tela diz quando.
 */
export function creationRateLimitText(retryAfterSeconds: number | undefined, now: Date = new Date()): string {
  const rule = 'Cada pessoa pode criar até três organizações por dia.';
  const other = 'Este limite é de frequência e não tem relação com o limite de organizações vazias.';
  if (!retryAfterSeconds || retryAfterSeconds <= 0) return `${rule} Você atingiu esse limite; tente de novo mais tarde. ${other} Nada foi criado.`;
  let when: string;
  if (retryAfterSeconds < 90) {
    when = 'em cerca de um minuto';
  } else if (retryAfterSeconds < 3600) {
    when = `em cerca de ${Math.ceil(retryAfterSeconds / 60)} minutos`;
  } else {
    const at = new Date(now.getTime() + retryAfterSeconds * 1000);
    const hour = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    const days = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
    const day = days === 0 ? 'hoje' : days === 1 ? 'amanhã' : `em ${String(at.getDate()).padStart(2, '0')}/${String(at.getMonth() + 1).padStart(2, '0')}`;
    when = `${day}, a partir das ${hour}`;
  }
  return `${rule} Você atingiu esse limite e poderá criar outra ${when}. ${other} Nada foi criado.`;
}

export const DEACTIVATE_TEXT = {
  consequences:
    'Ninguém consegue entrar na organização enquanto ela estiver desativada, e nenhum trabalho novo é iniciado pela Platform. Nada é apagado: histórico, automações, máquinas, licenças e entregas ficam como estão.',
  licenses:
    'Desativar não libera licença: cada licença continua vinculada à mesma automação e o prazo dela continua correndo. Só você, como responsável, pode reativar, por esta lista.',
  blocked:
    'Esta organização foi bloqueada pela Nekkora. A reativação por aqui não remove esse bloqueio: fale com o suporte.',
} as const;

const STATE_REFUSAL: Record<string, string> = {
  organization_not_responsible: 'Só a pessoa responsável pela organização, que ainda a administra, pode fazer isso.',
  organization_work_in_progress:
    'Há trabalho em andamento nesta organização (execução, pedido pendente ou execução com término não confirmado). Aguarde terminar, cancele ou reconcilie antes de desativar.',
  organization_blocked_by_nekkora: DEACTIVATE_TEXT.blocked,
  empty_organization_limit_reached:
    'Esta organização não tem automações e você já tem o limite de organizações vazias ativas. Desative outra organização vazia, ou crie uma automação em uma delas, antes de reativar esta.',
  organization_state_conflict: 'A organização não está mais nesta situação. Atualize a lista.',
};

function stateRefusal(e: unknown): string {
  const reason = e instanceof ApiError && e.code === 'conflict' ? e.reason : undefined;
  if (reason && STATE_REFUSAL[reason]) return `${STATE_REFUSAL[reason]} Nada foi alterado.`;
  if (isApiError(e, 'rate_limited')) return 'Muitas tentativas em pouco tempo. Aguarde e tente de novo. Nada foi alterado.';
  if (isApiError(e, 'service_unavailable')) return 'Serviço temporariamente indisponível. Nada foi alterado.';
  return 'O ato não foi permitido. A confirmação pode ter vencido. Nada foi alterado.';
}

const REQUEST_LABEL: Record<MyOrganizationRequest['state'], { label: string; tone: 'info' | 'success' | 'neutral' }> = {
  PENDING: { label: 'Aguardando decisão', tone: 'info' },
  APPROVED: { label: 'Aprovado', tone: 'success' },
  REFUSED: { label: 'Recusado', tone: 'neutral' },
};

const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');

/**
 * Criação por perfil na lista de organizações (PLATFORM-LICENCIAMENTO-001): por que a pessoa cria, solicita ou não cria; os
 * pedidos que ela fez; e as organizações de que ela é RESPONSÁVEL, que ela pode desativar e reativar (as desativadas não
 * aparecem na lista de entrada). É só apresentação: cada ato é reconferido pela API. Instalação sem o recurso (404): nada
 * é mostrado e a lista continua como sempre.
 */
export function OrganizationCreationPanel({ organizations, onChanged }: { organizations: IdentityOrganization[]; onChanged: () => void }) {
  const { expired } = useIdentityArea();
  const navigate = useNavigate();
  const [data, setData] = useState<Loaded | null>(null);
  const [pending, setPending] = useState<{ kind: 'deactivate' | 'reactivate'; org: ResponsibleOrganization } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const [creation, requests] = await Promise.all([organizationCreation(), myOrganizationRequests()]);
      if (gen === generation.current) setData({ creation, requests });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      setData(null); // recurso indisponível ou falha: a lista de organizações continua valendo sozinha
    }
  }, [expired]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  if (!data) return null;
  const { creation, requests } = data;
  const why = creation.cannotCreateReason ? CANNOT_CREATE[creation.cannotCreateReason] : undefined;
  const nameOf = (id: string) => creation.responsibleFor.find((o) => o.organizationId === id)?.name ?? organizations.find((o) => o.organizationId === id)?.name;
  const emptyNames = creation.emptyOrganizations.organizationIds.map(nameOf).filter(Boolean) as string[];
  const done = (text: string) => {
    setPending(null);
    setNotice({ tone: 'success', text });
    void load();
    onChanged();
  };

  return (
    <Stack gap={5}>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      {why && (
        <Alert tone="info" title={why.title}>
          <Stack gap={2}>
            <span>{why.body}</span>
            {creation.cannotCreateReason === 'empty_organization_limit_reached' && emptyNames.length > 0 && (
              <span>
                Organizações vazias hoje ({creation.emptyOrganizations.used} de {creation.emptyOrganizations.limit}): {emptyNames.join(', ')}.
              </span>
            )}
            {creation.profile === 'MEMBER' && (
              <span>
                {creation.canRequest ? (
                  <Button size="sm" onClick={() => navigate(identityPath.requestOrganization)}>
                    Solicitar organização
                  </Button>
                ) : (
                  'Você já tem três pedidos aguardando decisão. Aguarde uma resposta antes de pedir de novo.'
                )}
              </span>
            )}
          </Stack>
        </Alert>
      )}

      {requests.length > 0 && (
        <section aria-labelledby="pw-org-pedidos">
          <Stack gap={3}>
            <Text as="h2" variant="h4" id="pw-org-pedidos">
              Seus pedidos de organização
            </Text>
            <ul className="pw-identity__orgs" aria-label="Seus pedidos de organização">
              {requests.map((r) => (
                <li key={r.requestId}>
                  <Card variant="outlined" padding="md">
                    <Stack gap={1}>
                      <Text as="h3" variant="h4">
                        {r.name}
                      </Text>
                      <Text variant="body-sm" color="secondary">
                        Pedido a quem administra {r.organizationName ?? 'a organização'} em {dateText(r.requestedAt)}
                      </Text>
                      <div className="pw-identity__badges">
                        <Badge tone={REQUEST_LABEL[r.state].tone} dot>
                          {REQUEST_LABEL[r.state].label}
                        </Badge>
                      </div>
                      {r.state === 'APPROVED' && (
                        <Text variant="body-sm">
                          {r.responsible === 'REQUESTER'
                            ? 'A organização foi criada e você é a pessoa responsável e administradora dela. Ela está na lista acima.'
                            : 'A organização foi criada sob a responsabilidade de quem aprovou. Você não recebeu acesso a ela: se precisar, peça um convite.'}
                        </Text>
                      )}
                      {r.state === 'REFUSED' && r.refusalReason && <Text variant="body-sm">Motivo informado: {r.refusalReason}</Text>}
                    </Stack>
                  </Card>
                </li>
              ))}
            </ul>
          </Stack>
        </section>
      )}

      {creation.responsibleFor.length > 0 && (
        <section aria-labelledby="pw-org-responsavel">
          <Stack gap={3}>
            <Text as="h2" variant="h4" id="pw-org-responsavel">
              Organizações sob sua responsabilidade
            </Text>
            <Text variant="body-sm" color="secondary">
              Você é a pessoa responsável por estas organizações: é de você que se conta o limite de organizações vazias ({creation.emptyOrganizations.used} de{' '}
              {creation.emptyOrganizations.limit} em uso), e só você pode desativá-las e reativá-las.
            </Text>
            <ul className="pw-identity__orgs" aria-label="Organizações sob sua responsabilidade">
              {creation.responsibleFor.map((o) => (
                <li key={o.organizationId}>
                  <Card variant="outlined" padding="md">
                    <div className="pw-identity__org">
                      <div className="pw-identity__org-main">
                        <Text as="h3" variant="h4">
                          {o.name}
                        </Text>
                        <div className="pw-identity__badges">
                          {o.state === 'ACTIVE' && (
                            <Badge tone="success" dot>
                              Ativa
                            </Badge>
                          )}
                          {o.state === 'DEACTIVATED' && (
                            <Badge tone="neutral" dot>
                              Desativada por você{o.deactivatedAt ? ` em ${dateText(o.deactivatedAt)}` : ''}
                            </Badge>
                          )}
                          {o.state === 'BLOCKED' && (
                            <Badge tone="warning" dot>
                              Bloqueada pela Nekkora
                            </Badge>
                          )}
                          {o.empty && <Badge tone="info">Vazia (sem automações)</Badge>}
                        </div>
                        {o.state === 'BLOCKED' && (
                          <Text variant="body-sm" color="secondary">
                            {DEACTIVATE_TEXT.blocked}
                          </Text>
                        )}
                      </div>
                      {o.state === 'ACTIVE' && (
                        <Button variant="ghost" onClick={() => setPending({ kind: 'deactivate', org: o })} aria-label={`Desativar a organização ${o.name}`}>
                          Desativar organização
                        </Button>
                      )}
                      {o.state === 'DEACTIVATED' && o.canReactivate && (
                        <Button variant="secondary" onClick={() => setPending({ kind: 'reactivate', org: o })} aria-label={`Reativar a organização ${o.name}`}>
                          Reativar
                        </Button>
                      )}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          </Stack>
        </section>
      )}

      <StepUpDialog
        open={pending?.kind === 'deactivate'}
        title={pending ? `Desativar a organização "${pending.org.name}"?` : ''}
        guard={{ operation: 'organization.deactivate', target: pending?.org.organizationId }}
        confirmLabel="Desativar organização"
        tone="danger"
        stepUp={identityStepUp}
        action={() => (pending ? deactivateOrganization(pending.org.organizationId) : Promise.reject())}
        onDone={() => done(`Organização "${pending?.org.name}" desativada. Ela continua nesta lista para você reativar quando quiser.`)}
        onClose={() => setPending(null)}
        refusalText={stateRefusal}
        uncertainText="Não foi possível confirmar a desativação. Feche e confira a situação da organização nesta lista antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && setNotice({ tone: 'warning', text: 'O resultado da última desativação não foi confirmado. Confira a lista.' })}
      >
        <Stack gap={2}>
          <Text>{DEACTIVATE_TEXT.consequences}</Text>
          <Text>{DEACTIVATE_TEXT.licenses}</Text>
        </Stack>
      </StepUpDialog>

      <StepUpDialog
        open={pending?.kind === 'reactivate'}
        title={pending ? `Reativar a organização "${pending.org.name}"?` : ''}
        guard={{ operation: 'organization.reactivate', target: pending?.org.organizationId }}
        confirmLabel="Reativar organização"
        stepUp={identityStepUp}
        action={() => (pending ? reactivateOrganization(pending.org.organizationId) : Promise.reject())}
        onDone={() => done(`Organização "${pending?.org.name}" reativada. Ela voltou à lista de organizações em que você pode entrar.`)}
        onClose={() => setPending(null)}
        refusalText={stateRefusal}
        uncertainText="Não foi possível confirmar a reativação. Feche e confira a situação da organização nesta lista."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && setNotice({ tone: 'warning', text: 'O resultado da última reativação não foi confirmado. Confira a lista.' })}
      >
        <Stack gap={2}>
          <Text>A organização volta a ficar disponível para as pessoas que já tinham acesso, com tudo o que havia nela.</Text>
          {pending?.org.empty && (
            <Text>Ela não tem automações: ao voltar, conta de novo no seu limite de organizações vazias. Se o limite estiver cheio, a reativação é recusada.</Text>
          )}
        </Stack>
      </StepUpDialog>
    </Stack>
  );
}
