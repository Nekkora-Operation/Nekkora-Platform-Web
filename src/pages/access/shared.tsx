import { Badge, type Tone } from 'nekkora-lib';
import { stepUp } from '../../api/auth';
import { ApiError, isApiError } from '../../api/http';
import type { Invitation, RoleCode } from '../../api/access';
import { ROLE_LABEL } from '../../identity/labels';

export { ROLE_LABEL };

/** Step-up da sessão de organização (o TOTP é o do fator da pessoa; na sessão vinculada, o da identidade). */
export const orgStepUp = (org: string) => (code: string) => stepUp(org, code);

export const ROLE_OPTIONS: { value: RoleCode; label: string; scope: 'organization' | 'workspace' }[] = [
  { value: 'ORG_ADMIN', label: ROLE_LABEL.ORG_ADMIN, scope: 'organization' },
  { value: 'WORKSPACE_ADMIN', label: ROLE_LABEL.WORKSPACE_ADMIN, scope: 'workspace' },
  { value: 'OPERATOR', label: ROLE_LABEL.OPERATOR, scope: 'workspace' },
  { value: 'VIEWER', label: ROLE_LABEL.VIEWER, scope: 'workspace' },
];

export const isWorkspaceRole = (r: RoleCode | '' | null | undefined) => r === 'WORKSPACE_ADMIN' || r === 'OPERATOR' || r === 'VIEWER';

const INVITATION_STATE: Record<Invitation['state'], { label: string; tone: Tone }> = {
  PENDENTE: { label: 'Pendente', tone: 'info' },
  EXPIRADO: { label: 'Vencido', tone: 'neutral' },
  ACEITO: { label: 'Aceito', tone: 'success' },
  REVOGADO: { label: 'Revogado', tone: 'neutral' },
};

export function InvitationStateBadge({ state }: { state: Invitation['state'] }) {
  const s = INVITATION_STATE[state];
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

export const REVOKE_REASON_LABEL: Record<NonNullable<Invitation['revokeReason']>, string> = {
  REVOGADO: 'revogado por administração',
  REENVIADO: 'substituído por reenvio',
  EXPIRADO: 'fechado por vencimento',
  EMISSOR_SEM_AUTORIDADE: 'fechado: quem emitiu perdeu a autoridade',
};

/**
 * Recusa de um ato de acesso, sem atribuir causa que a API não deu. 403 cobre: sem permissão, o próprio ator, último
 * administrador, confirmação vencida. 409: o estado atual impede o ato.
 */
export function accessRefusal(e: unknown, specific: { conflict?: string; forbidden?: string; notFound?: string } = {}): string {
  const nothing = 'Nada foi alterado.';
  if (isApiError(e, 'conflict')) return `${specific.conflict ?? 'O estado atual não permite este ato. Atualize a página e confira.'} ${nothing}`;
  if (isApiError(e, 'forbidden'))
    return `${specific.forbidden ?? 'O ato não foi permitido. Suas permissões podem não cobrir este caso ou a confirmação pode ter vencido.'} ${nothing}`;
  if (isApiError(e, 'not_found') || (e instanceof ApiError && e.status === 404))
    return `${specific.notFound ?? 'O item não foi encontrado nesta organização (ou o recurso está indisponível). A lista pode estar desatualizada.'} ${nothing}`;
  if (isApiError(e, 'invalid_request')) return `O pedido não foi aceito. Confira os campos. ${nothing}`;
  if (isApiError(e, 'rate_limited')) return `Muitas tentativas em pouco tempo. Aguarde antes de tentar de novo. ${nothing}`;
  if (isApiError(e, 'service_unavailable')) return `Serviço temporariamente indisponível. ${nothing}`;
  return `O ato não foi concluído. ${nothing}`;
}
